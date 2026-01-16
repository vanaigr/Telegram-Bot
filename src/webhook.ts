import streamConsumers from 'stream/consumers'

import { waitUntil, attachDatabasePool } from '@vercel/functions'
import { OpenRouter } from '@openrouter/sdk'
import { FileTypeParser } from 'file-type';

import * as DbClient from './db/client.ts'
import * as Db from './db/index.ts'
import * as T from './lib/temporal.ts'
import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import type * as Types from './types.ts'

export async function POST(req: Request) {
  const begin = T.Now.instant()

  const log = L.makeLogger(undefined, undefined)

  log.I('Received webhook')
  //log.I([req.headers])
  const token = req.headers.get('x-telegram-bot-api-secret-token')
  if(token === '' || token !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    log.W('Unexpected webhook token ', [token])
    return new Response('', { status: 401 })
  }

  const body = await req.json()
  //log.I('Body: ', [body])
  const message = body.message as Types.Message

  const pool = DbClient.create(log)
  if(!pool) {
    return new Response(JSON.stringify({}), { status: 500 })
  }
  attachDatabasePool(pool)

  const whitelisted = await Db.query(pool,
    'select', [Db.t.chatWhitelist.id],
    'from', Db.t.chatWhitelist,
    'where', Db.eq(Db.t.chatWhitelist.id, Db.param(BigInt(message.chat.id))),
  ).then(it => it.at(0)?.id !== undefined)

  if(!whitelisted) {
    log.W('Chat ', [message.chat.id], ' is not whitelisted')

    const emojis = ['🙂', '😳', '👉👈', '😡']
    const text = 'А вы кто ' + emojis[Math.floor(Math.random() * emojis.length)] + '?'
    await sendMessage(message.chat.id, text, log)

    return new Response(JSON.stringify({}))
  }

  const needsResponse = await Db.timedTran(pool, async(db) => {
    const dst = Db.t.messages
    const schema = Db.d.messages
    const src = Db.makeTable<typeof schema>('src')
    const cols = Db.keys(schema)

    const record: Db.ForInput<typeof schema> = {
      chatId: message.chat.id,
      messageId: message.message_id,
      date: T.Instant.fromEpochMilliseconds(message.date * 1000).toJSON(),
      type: 'user',
      raw: JSON.stringify(message),
      needsResponse: true,
    }

    const result = await Db.queryRaw<{ needsResponse: boolean }[]>(db,
      'insert into', dst, Db.args(cols.map(it => dst[it].nameOnly)),
      'select', Db.list(cols.map(it => src[it])),
      'from', Db.arraysTable([record], schema), 'as', src,
      'on conflict', Db.args([dst.chatId.nameOnly, dst.messageId.nameOnly]), 'do nothing',
      'returning', dst.needsResponse.nameOnly,
    )
    return result.at(0)?.needsResponse ?? false
  })
  log.I('Added message')
  if(!needsResponse) {
    log.I('Already responded')
    return
  }

  const photoTask = (async() => {
    const photo = message.photo?.at(-1)
    if(!photo) return

    const l = log.addedCtx('photo ', [photo.file_unique_id])

    try {
      await downloadPhoto(pool, l, photo)
    }
    catch(error) {
      l.E([error])
    }
  })()
  waitUntil(photoTask)

  const replyTask = (async() => {
    const l = log.addedCtx('reply')

    const completion = { sent: false }
    try {
      await Db.tran(pool, async(db) => {
        await reply(db, l, begin, photoTask, message, completion)
      })
    }
    catch(error) {
      l.E([error])
      if(!completion.sent) {
        const emojis = ['🙂', '💀', '☠']
        const text = 'Бот шандарахнулся ' + emojis[Math.floor(Math.random() * emojis.length)]
        await sendMessage(message.chat.id, text, log)
      }
    }
    // not returning db since it doesn't mater + its state is changed
  })()
  waitUntil(replyTask)

  return new Response(JSON.stringify({}))
}

async function downloadPhoto(pool: Db.DbPool, log: L.Log, photo: Types.PhotoSize) {
  log.I('Downloading')

  await Db.timedTran(pool, async(db) => {
    const t = Db.t.photos
    const schema = Db.d.photos

    const existing = await Db.query(db,
      'select', [t.file_unique_id],
      'from', t,
      'where', Db.eq(t.file_unique_id, Db.param(photo.file_unique_id)),
    ).then(it => it.at(0))

    if(existing) {
      log.I(' Already exists')
      return
    }

    await Db.insertMany(db, t, schema, [{
      file_unique_id: photo.file_unique_id,
      raw: JSON.stringify(photo),
      status: 'downloading',
      bytes: Buffer.from([]),
    }], {})

    try {
      log.I('Getting file url')

      const fileInfoUrl = new URL(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN!}/getFile`
      )
      fileInfoUrl.searchParams.set('file_id', photo.file_id)
      const fileInfoResult = await U.request<TelegramWrapper<Types.File>>({
        url: fileInfoUrl,
        log,
      })
      if(fileInfoResult.status !== 'ok') throw new Error()
      if(!fileInfoResult.data.ok) {
        log.E([fileInfoResult.data])
        throw new Error()
      }
      const fileInfo = fileInfoResult.data.result

      log.I('Getting File')

      const fileUrl = new URL(
        `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN!}/`
          + encodeURIComponent(fileInfo.file_path)
      )

      const response = await fetch(fileUrl)
      if (!response.ok) {
        const bodyMessage: L.Message = await response.text().then(
          (it) => ['Body: ', [it]],
          (e) => ['Body error: ', [e]],
        );
        log.E('Response status: ', [response.status], '\n', ...bodyMessage);
        throw new Error()
      }

      log.I('Getting file')
      const buffer = await streamConsumers.buffer(response.body!)

      log.I('Done downloading')

      await Db.queryRaw(db,
        'update', t,
        'set', Db.list([
          Db.set(t.status, Db.param('done' as const)),
          Db.set(t.bytes, Db.param(buffer)),
        ]),
        'where', Db.eq(t.file_unique_id, Db.param(photo.file_unique_id)),
      )
    }
    catch(error) {
      log.I('Failed to download file ', [error])

      await Db.queryRaw(db,
        'update', t,
        'set', Db.list([
          Db.set(t.status, Db.param('error' as const)),
        ]),
        'where', Db.eq(t.file_unique_id, Db.param(photo.file_unique_id)),
      )
    }
  })
}

async function reply(
  conn: Db.DbTransaction, // not actually a transaction
  log: L.Log,
  begin: T.Instant,
  photoTask: Promise<unknown>,
  message: Types.Message,
  completion: { sent: boolean },
) {
  const maxWait = begin.add({ seconds: 15 })
  try {
    const waitFor = Math.floor(maxWait.since(T.Now.instant()).total('milliseconds'))
    if(waitFor <= 10) {
      log.E('Not sending message - timed out 1')
      return
    }

    const lockId = BigInt(message.chat.id)

    const lock = Db.t.chatLocks
    await Db.queryRaw(conn, 'set lock_timeout = ' + waitFor)
    await Db.queryRaw(conn,
      'insert into', lock, Db.args([lock.id.nameOnly]),
      'values', Db.args([Db.param(lockId)]),
      'on conflict', Db.args([lock.id.nameOnly]), 'do nothing',
    )
    await Db.queryRaw(conn,
      'select', [lock.id],
      'from', lock,
      'where', Db.eq(lock.id, Db.param(lockId)),
      'for update',
    )
  }
  catch(error) {
    log.E('Not sending message - could not aquire chat lock: ', [error])
    return
  }

  const timedOut = {}
  const timeout = U.delay(maxWait).then(() => timedOut)
  const result = await Promise.race([timeout, photoTask])
  if(result === timedOut) {
    log.E('Not sending message - timed out 2')
    return
  }

  const t = Db.t.messages
  const messagesRaw = await Db.query(conn,
    'select', [t.raw],
    'from', t,
    'where', t.date, '<=', Db.param(T.Instant.fromEpochMilliseconds(message.date * 1000).toJSON()),
    'and', Db.eq(t.chatId, Db.param(BigInt(message.chat.id))),
    'order by', t.messageId, 'asc', // date resolution is too low
  )
  if(messagesRaw.length === 0) {
    log.unreachable()
    return
  }

  const messages = messagesRaw.map(({ raw }) => {
    const msg = raw as Types.Message

    return {
      msg,
      photos: ((): Photo[] => {
        const photo = msg.photo?.at(-1)
        if(!photo) return []

        return [
          {
            file_unique_id: photo.file_unique_id,
            status: 'not-available',
            data: Buffer.from([]),
            info: photo,
          }
        ]
      })()
    }
  })

  const last = messages[messages.length - 1]
  if(last.photos.length > 0) {
    const t = Db.t.photos
    const photoRow = await Db.query(conn,
      'select', [t.status, t.bytes, t.file_unique_id, t.raw],
      'from', t,
      'where', Db.eq(t.file_unique_id, Db.param(last.photos[0].file_unique_id)),
    ).then(it => it.at(0))
    if(photoRow === undefined || photoRow.status === 'downloading') {
      log.unreachable([photoRow])
      return
    }

    last.photos[0] = {
      ...last.photos[0],
      status: photoRow.status,
      data: photoRow.bytes,
    }
  }

  const openrouterMessages = await Promise.all(messages.map(async({ msg, photos }): Promise<OpenRouterMessage> => {
    if(msg.from?.username === 'balbes52_bot') {
      return {
        role: 'assistant',
        content: msg.text,
      }
    }

    const text = 'From: ' + (msg.from?.first_name + ' ' + msg.from?.last_name).trim() + '(@' + msg.from?.username + ')\n'
      + 'At: '
      + T.Instant.fromEpochMilliseconds(msg.date * 1000)
        .toZonedDateTimeISO(T.Now.timeZoneId())
        .toPlainDateTime().toString()
      + '\n'
      + 'Text: ' + (msg.text ?? msg.caption ?? '<no message>')

    return {
      role: 'user',
      content: [
        { type: 'text', text },
        ...await Promise.all(photos.map(async(photo) => {
          if(photo.status === 'done') {
            const type = await new FileTypeParser().fromBuffer(photo.data)
            if(type !== undefined) {
              const dataUrl = `data:${type.mime};base64,${photo.data.toString("base64")}`;
              return {
                type: 'image_url' as const,
                imageUrl: {
                  url: dataUrl,
                  detail: 'high' as const,
                },
              }
            }
            else {
              log.W('Could not detect file type for', photo.file_unique_id)
            }
          }

          return {
            type: 'text' as const,
            text: '<image not available>',
          }
        })),
      ]
    }
  }))

  log.I('Sending conversation')
  const openRouter = new OpenRouter({ apiKey: process.env.OPENROUTER_KEY! });
  const response = await openRouter.chat.send({
    //model: 'openai/gpt-5-mini', // слишком стерильный
    //model: 'openai/chatgpt-4o-latest', // тоже наверно
    //model: 'x-ai/grok-4.1-fast', // not super coherent
    //model: 'google/gemini-2.5-flash-lite',
    model: 'google/gemini-3-flash-preview',
    //model: 'moonshotai/kimi-k2-0905',
    //model: 'moonshotai/kimi-k2-thinking',
    //model: 'openai/gpt-oss-120b', // explodes
    provider: {
      dataCollection: 'deny',
    },
    reasoning: {
      effort: 'medium',
    },
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      ...openrouterMessages,
    ],
  })
  log.I('Responded')

  const updateP = Db.queryRaw(conn,
    'update', Db.t.messages,
    'set', Db.set(Db.t.messages.needsResponse, Db.param(false)),
    'where', Db.eq(Db.t.messages.chatId, Db.param(BigInt(message.chat.id))),
    'and', Db.eq(Db.t.messages.messageId, Db.param(BigInt(message.message_id))),
  )

  const saveP = Db.insertMany(
    conn,
    Db.t.responses,
    Db.omit(Db.d.responses, [ 'sequenceNumber' ]),
    [{
      respondsToChatId: message.chat.id,
      respondsToMessageId: message.message_id,
      raw: JSON.stringify(response),
    }],
    {}
  )

  const sendResponseP = (async() => {
    const output = response.choices[0].message.content!.toString().trim()
    if(output === '<empty>' || output === '<>' || output === '') {
      log.I('Empty response')
      return
    }

    log.I('Sending response')
    const responseResult = await sendMessage(message.chat.id, output, log)
    if(responseResult.status !== 'ok') {
      return
    }
    if(!responseResult.data.ok) {
      log.E([responseResult.data.description])
      return
    }
    const newMessage = responseResult.data.result

    completion.sent = true

    log.I('Inserting response')
    await Db.insertMany(
      conn,
      Db.t.messages,
      Db.d.messages,
      [{
        chatId: newMessage.chat.id,
        messageId: newMessage.message_id,
        date: T.Instant.fromEpochMilliseconds(newMessage.date * 1000).toJSON(),
        type: 'assistant',
        raw: JSON.stringify(newMessage),
        needsResponse: false,
      }],
      {}
    )
  })()

  await U.all([updateP, saveP, sendResponseP])
  log.I('Done responding')
}

type TelegramWrapper<T> = { ok: true, result: T } | { ok: false, description: string }

const systemPrompt = `
You are a group chat participant, a typical 20-something year old. Write a reply if you think users would appreciate it or if they ask you (@balbes52_bot, Балбес, etc.). Reply <empty> (with angle brackets) if you think users are talkning between themselves and would not appreciate your interruption.

Don't write essays. Nobody wants to read a lot.
Users don't see empty messages. If there's an error, tell them that.

If users ask to translate or extract text from an image, you need to **transcribe** the text in the image exactly. Do not make up anything.

`.trim()

/// ???????????
type OpenRouterMessage = OpenRouter['chat']['send'] extends (a: { messages: Array<infer Message> }) => infer U1 ? Message : never

type Photo = {
  file_unique_id: string
  status: 'done' | 'downloading' | 'error' | 'not-available'
  data: Buffer
  info: Types.PhotoSize
}

async function sendMessage(chatId: number, text: string, log: L.Log) {
  return await U.request<TelegramWrapper<Types.Message>>({
    url: new URL(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN!}/sendMessage`),
    log: log.addedCtx('sendMessage'),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  })
}
