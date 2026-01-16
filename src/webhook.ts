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
  const message = body.message
  if(message === undefined) {
    log.I('What did it send to me? ', [body])
    return new Response('')
  }

  log.I('Message ', [message.message_id], ' in chat ', [message.chat.id])

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

  await Db.timedTran(pool, async(db) => {
    const dst = Db.t.messages
    const schema = Db.d.messages
    const src = Db.makeTable<typeof schema>('src')
    const cols = Db.keys(schema)

    const record: Db.ForInput<typeof schema> = {
      chatId: message.chat.id,
      messageId: message.message_id,
      date: fromMessageDate(message.date).toJSON(),
      type: 'user',
      raw: JSON.stringify(message),
    }

    await Db.queryRaw(db,
      'insert into', dst, Db.args(cols.map(it => dst[it].nameOnly)),
      'select', Db.list(cols.map(it => src[it])),
      'from', Db.arraysTable([record], schema), 'as', src,
      'on conflict', Db.args([dst.chatId.nameOnly, dst.messageId.nameOnly]), 'do nothing',
    )
  })
  log.I('Added message')

  const photoTask = (async() => {
    const photo = message.photo?.at(-1)
    if(!photo) return

    const l = log.addedCtx('photo ', [photo.file_unique_id])

    try {
      await downloadPhoto(pool, l, message.chat.id, photo)
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
        await reply(
          db,
          l,
          fromMessageDate(message.date),
          message.chat.id,
          completion
        )
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

async function downloadPhoto(
  pool: Db.DbPool,
  log: L.Log,
  chatId: number,
  photo: Types.PhotoSize
) {
  log.I('Downloading')

  await Db.timedTran(pool, async(db) => {
    const t = Db.t.photos
    const schema = Db.d.photos

    const existing = await Db.query(db,
      'select', [t.fileUniqueId],
      'from', t,
      'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
      'and', Db.eq(t.fileUniqueId, Db.param(photo.file_unique_id)),
    ).then(it => it.at(0))

    if(existing) {
      log.I(' Already exists')
      return
    }

    await Db.insertMany(db, t, schema, [{
      chatId,
      fileUniqueId: photo.file_unique_id,
      raw: JSON.stringify(photo),
      status: 'downloading',
      bytes: Buffer.from([]),
      downloadStartDate: T.Now.instant().toJSON(),
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
        'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
        'and', Db.eq(t.fileUniqueId, Db.param(photo.file_unique_id)),
      )
    }
    catch(error) {
      log.I('Failed to download file ', [error])

      await Db.queryRaw(db,
        'update', t,
        'set', Db.list([
          Db.set(t.status, Db.param('error' as const)),
        ]),
        'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
        'and', Db.eq(t.fileUniqueId, Db.param(photo.file_unique_id)),
      )
    }
  })
}

async function reply(
  conn: Db.DbTransaction,
  log: L.Log,
  messageDate: T.Instant,
  chatId: number,
  completion: { sent: boolean },
) {
  log.I('Locking ', [chatId])
  try {
    const maxWait = messageDate.add({ seconds: 20 })
    const waitFor = Math.floor(maxWait.since(T.Now.instant()).total('milliseconds'))
    if(waitFor <= 10) {
      log.E('Not sending message - timed out 1')
      return
    }

    const lockId = BigInt(chatId)

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
    // If the lock is locked by someone else all this time, the message
    // is no longer relevant, so we can exit. Future messages are running
    // the same logic, so they will respond eventually (or be irrelevant)
    // even if the lock is for an old message.
    return
  }
  log.I('Locked ', [chatId])
  // Lock aquired - no new replies will be inserted.

  const firstLatest = await Db.query(conn,
    'select', [
      Db.t.messages.messageId,
      Db.t.messages.raw,
      Db.named('hasResponse', Db.not(Db.isNull(Db.t.responses.sequenceNumber))),
    ],
    'from', Db.t.messages,

    'left join', Db.t.responses,
    'on', Db.eq(Db.t.messages.chatId, Db.t.responses.respondsToChatId),
    // Find a response that has seen this message. Not = since the following is possible:
    // 1. user sends message 1
    // 2. bot starts generating response 1
    // 3. user sends message 2
    // 4. Bot locks waiting for response 1
    // 5. User sends message 3
    // 6. Bot locks waiting for response 1
    // 7. Response 1 is generated and sent. Points at message 1
    // 8. Response 2 logic runs, the latest message it sees is its own response.
    // 9. Response 2 is generated and sent. Points at its own response
    // 10. Response 3 logic runs, the latest user message doesn't have a direct response,
    // since response 2 points at response 1. But response 2 did include messages
    // 1-3 in history, so another response should not be generated.
    'and', Db.t.messages.messageId, '<=', Db.t.responses.respondsToMessageId,

    'where', Db.eq(Db.t.messages.chatId, Db.param(BigInt(chatId))),
    'and', Db.eq(Db.t.messages.type, Db.param('user' as const)),

    'order by', Db.t.messages.messageId, 'desc',
    'limit 1',
  ).then(it => it.at(0))
  if(firstLatest === undefined) {
    log.unreachable()
    return
  }
  if(firstLatest.hasResponse) {
    log.I('Latest message ', [firstLatest.messageId], ' is already answered')
    return
  }
  log.I('Answering message ', [firstLatest.messageId])
  // Now we know that there is something to reply to.

  // Postpone responding for 10 seconds if some attachments are loading.
  // If newer messages arrive, we may not send their images, but we don't
  // want the bot to get stuck forever if there's an active discussion.
  const maxWaitForAttachments = fromMessageDate((firstLatest.raw).date)
    .add({ seconds: 10 })
  while(true) {
    const now = T.Now.instant()
    if(T.Instant.compare(now, maxWaitForAttachments) >= 0) {
      log.W('Time for images expired. Sending as-is')
      break
    }

    const t = Db.t.photos
    const totalLoading = await Db.query(conn,
      'select', [
        Db.named(
          'totalLoading',
          Db.func<typeof Db.dbTypes.bigint>('count', '*')
        ),
      ],
      'from', t,
      'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
      'and', t.downloadStartDate, '>', Db.param(now.subtract({ seconds: 20 }).toJSON()),
      'and', Db.eq(t.status, Db.param('downloading' as const)),
    ).then(it => it.at(0)?.totalLoading ?? 0n)

    if(totalLoading === 0n) {
      log.I('All images ready')
      break
    }

    log.I('Images being loaded: ', [totalLoading], '. Rechecking in ', [1], 's')

    let until = now.add({ seconds: 1 })
    if(T.Instant.compare(maxWaitForAttachments, until) < 0) until = maxWaitForAttachments
    await U.delay(until)
  }

  const t = Db.t.messages
  const messagesRaw = await Db.query(conn,
    'select', [t.raw],
    'from', t,
    'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
    'order by', t.messageId, 'asc', // date resolution is too low
  )
  if(messagesRaw.length === 0) {
    log.unreachable()
    return
  }

  const messages = messagesRaw.map(({ raw: msg }) => {
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

  {
    // Insertion order is from latest to earliest.
    const fileUniqueIds = new Set<string>()
    for(let off = 0; off < Math.min(20, messages.length); off++) {
      const { photos } = messages[messages.length - 1 - off]
      for(let j = photos.length - 1; j > -1; j--) {
        fileUniqueIds.add(photos[j].file_unique_id)
      }
    }

    const t = Db.t.photos
    const arrayP = Db.param([...fileUniqueIds])
    const photoRows = await Db.query(conn,
      'select', [t.status, t.bytes, t.fileUniqueId, t.raw],
      'from', t,
      'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
      'and', t.fileUniqueId, '=', Db.func('any', arrayP),
      'and', Db.eq(t.status, Db.param('done' as const)),
      'order by', Db.func('array_position', arrayP, t.fileUniqueId),
      'limit 5',
    )
    const photoRowsById = new Map(photoRows.map(it => [it.fileUniqueId, it]))

    for(const message of messages) {
      for(const photo of message.photos) {
        const photoRow = photoRowsById.get(photo.file_unique_id)
        if(photoRow !== undefined) {
          photo.status = photoRow.status
          photo.data = photoRow.bytes
        }
      }
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

  const saveP = Db.insertMany(
    conn,
    Db.t.responses,
    Db.omit(Db.d.responses, ['sequenceNumber']),
    [{
      respondsToChatId: chatId,
      respondsToMessageId: messages.at(-1)!.msg.message_id,
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
    const responseResult = await sendMessage(chatId, output, log)
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
        date: fromMessageDate(newMessage.date).toJSON(),
        type: 'assistant',
        raw: JSON.stringify(newMessage),
      }],
      {}
    )
  })()

  await U.all([saveP, sendResponseP])
  log.I('Done responding')
}

type TelegramWrapper<T> = { ok: true, result: T } | { ok: false, description: string }

const systemPrompt = `
You are a group chat participant, a typical 20-something year old. Write a reply if you think users would appreciate it or if they ask you (@balbes52_bot, Балбес, etc.). Reply <empty> (with angle brackets) if you think users are talkning between themselves and would not appreciate your interruption.

Don't write essays. Nobody wants to read a lot.
Users don't see empty messages. If there's an error, tell them that.
If the users are hinting or saying that they don't want to continue the conversation, stop. Don't respond that you are stopping, just say <empty>. It's better to not respond and make users ping you than you sending too many messages.

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

function fromMessageDate(messageDate: number) {
  return T.Instant.fromEpochMilliseconds(messageDate * 1000)
}
