import streamConsumers from 'node:stream/consumers';
import { FileTypeParser } from 'file-type';
import TelegramBot from 'node-telegram-bot-api'
import { OpenRouter } from '@openrouter/sdk'
import * as Db from './db/index.ts'
import * as L from './lib/log.ts'
import * as T from './lib/temporal.ts'

type Ctx = {
  openRouter: OpenRouter
  bot: TelegramBot
  responding: Promise<unknown> | undefined
  pool: Db.DbPool
}

export async function runBot(pool: Db.DbPool, log: L.Log) {
  const openRouter = new OpenRouter({ apiKey: process.env.OPENROUTER_KEY! });
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: true });
  const ctx: Ctx = { pool, openRouter, bot, responding: undefined }

  bot.on('message', async(msg) => {
    try {
      {
        const t = Db.t.messages
        const d = Db.omit(Db.d.messages, ['sequenceNumber'])

        const cols = Db.keys(d)
        const src = Db.makeTable<typeof d>('src')

        const messageRow: Db.ForInput<typeof d> = {
          date: T.Instant.fromEpochMilliseconds(msg.date * 1000).toJSON(),
          chatId: msg.chat.id,
          type: 'user',
          raw: JSON.stringify(msg),
          needsResponse: true,
        }

        await Db.queryRaw(pool,
          'insert into', t, Db.args(cols.map(col => t[col].nameOnly)),
          'select', cols.map(col => src[col]),
          'from', Db.arraysTable([messageRow], d), 'as', src,
        )
      }

      const photo = getPhoto(msg.photo)
      if(photo) downloadPhoto(ctx, photo)

      if(msg.text && msg.text.startsWith('/stop')) {
        const emojis = ['👍', '🙂', '💀', '☠']
        bot.sendMessage(
          msg.chat.id,
          'Бот убит ' + emojis[Math.floor(Math.random() * emojis.length)]
        );
        await bot.close()
        console.log('Dying')
        process.exit(1)
      }

      await respond(ctx)
    }
    catch(error) {
      console.error(error)
    }
  });
}

/*
You are a group chat participant. Write a reply if you think users would appreciate it or if they ask you (@balbes52_bot, Балбес, etc.). Reply <empty> (with angle brackets) if you think users are talkning between themselves and would not appreciate your interruption.

You are a group chat participant. Write a reply if users ask you something (@balbes52_bot, Балбес, etc.). Reply <empty> (with angle brackets) otherwise. Plan out your reply.
*/
const systemPrompt = `
You are a group chat participant, a typical 20-something year old. Write a reply if you think users would appreciate it or if they ask you (@balbes52_bot, Балбес, etc.). Reply <empty> (with angle brackets) if you think users are talkning between themselves and would not appreciate your interruption.

Don't write essays. Nobody wants to read a lot.
Users don't see empty messages. If there's an error, tell them that.

If users ask to translate or extract text from an image, you need to **transcribe** the text in the image exactly. Do not make up anything.

Commands that you can do (if users ask):
/stop - Temporarily suspends you

`.trim()

/// ???????????
type OpenRouterMessage = OpenRouter['chat']['send'] extends (a: { messages: Array<infer Message> }) => infer U1 ? Message : never

type Photo = {
  file_unique_id: string
  status: string
  data: Buffer

  info: TelegramBot.PhotoSize
}

function respond(ctx: Ctx) {
  const respondPrev = ctx.responding
  const respondNext = (async() => {
    try { await respondPrev } catch(err) {}

    const whenError = { chatId: undefined as number | undefined }
    try {
      await doResponse(ctx, whenError)
    }
    catch(error) {
      console.error(error)
      if(whenError.chatId !== undefined) {
        const emojis = ['🙂', '💀', '☠', '🌀']
        await ctx.bot.sendMessage(
          whenError.chatId,
          'Бот шандарахнулся ' + emojis[Math.floor(Math.random() * emojis.length)]
        );
      }
    }
  })()
  ctx.responding = respondNext

  return respondNext
}

async function doResponse(ctx: Ctx, whenError: { chatId: number | undefined }) {
  const data = await runTransaction(db => {
    const now = T.Now.instant().epochMilliseconds / 1000

    const unresponded = (db.prepare('select sequenceNumber, date, chatId from messages where needsResponse = 1 and date > ? order by date limit 1').get(now - 30) as any)
    if(unresponded === undefined) return

    whenError.chatId = unresponded.chatId

    const messages = (db.prepare('select raw from messages where date <= ? and chatId = ? order by date')
      .all(unresponded.date, unresponded.chatId) as any[])
    .map(it => {
      const msg = JSON.parse(it.raw) as TelegramBot.Message
      return {
        msg,
        photos: ((): Photo[] => {
          const photo = getPhoto(msg.photo)
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
      const file = db.prepare('select status, data from photos where file_unique_id = ?')
        .get(last.photos[0].file_unique_id) as any
      if(file === undefined || file.status === 'downloading') {
        console.log(' not sending, image still downloading')
        return
      }

      last.photos[0] = {
        ...last.photos[0],
        status: file.status,
        data: file.data,
      }
    }

    return {
      respondToSequenceNumber: unresponded.sequenceNumber,
      chatId: unresponded.chatId,
      messages
    }
  })
  if(data === undefined) {
    console.log('nothing to respond to')
    return
  }
  console.log('responding to', data.respondToSequenceNumber)

  const messages = await Promise.all(data.messages.map(async({ msg, photos }): Promise<OpenRouterMessage> => {
    if(msg.from?.username === 'balbes52_bot') {
      return {
        role: 'assistant',
        content: msg.text,
      }
    }
    else {
      const text = 'From: ' + (msg.from?.first_name + ' ' + msg.from?.last_name).trim() + '(@' + msg.from?.username + ')\n'
        + 'At: '
        + T.Instant.fromEpochMilliseconds(msg.date * 1000)
          .toZonedDateTimeISO(T.Now.timeZoneId())
          .toPlainDateTime().toString()
        + '\n'
        + 'Text: ' + (msg.text ?? '<no message>')

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
                console.log('  could not detect file type for', photo.file_unique_id)
              }
            }

            return {
              type: 'text' as const,
              text: '<image not available>',
            }
          })),
        ]
      }
    }
  }))

  const response = await ctx.openRouter.chat.send({
    //model: 'openai/gpt-5-mini', // слишком стерильный
    //model: 'openai/chatgpt-4o-latest', // тоже наверно
    //model: 'x-ai/grok-4.1-fast', // not super coherent
    //model: 'google/gemini-2.5-flash-lite',
    model: 'google/gemini-3-flash-preview',

    //model: 'moonshotai/kimi-k2-0905',
    //model: 'moonshotai/kimi-k2-thinking',
    //model: 'openai/gpt-oss-120b',
    provider: {
      dataCollection: 'deny',
      /*
        order: [
          'atlas-cloud/fp8',
          //'google-vertex',
        ],
        */
    },
    reasoning: {
      effort: 'medium',
    },
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  })
  console.log('response to', data.respondToSequenceNumber, 'generated')

  await runTransaction(db => {
    db.prepare('update messages set needsResponse = ? where sequenceNumber = ?')
      .run(0, data.respondToSequenceNumber)

    db.prepare('insert into responses(respondToSequenceNumber, raw) values (?, ?)')
      .run(data.respondToSequenceNumber, JSON.stringify(response))
  })

  const output = response.choices[0].message.content!.toString().trim()
  if(output === '<empty>' || output === '<>' || output === '') {
    return
  }

  const responseDate = T.Now.instant().epochMilliseconds / 1000
  await runTransaction(db => {
    db.prepare('insert into messages(date, chatId, type, raw, needsResponse) values (?, ?, ?, ?, ?)')
      .run(
        responseDate,
        data.chatId,
        'assistant',
        JSON.stringify({
          from: {
            username: 'balbes52_bot',
          },
          date: responseDate,
          text: output,
        }),
        0,
      )
  })

  console.log('sending message to', data.chatId)
  await ctx.bot.sendMessage(
    data.chatId,
    response.choices[0].message.content as string
  );
  console.log('message sent to', data.chatId)
}

async function downloadPhoto(
  ctx: Ctx,
  photo: TelegramBot.PhotoSize
) {
  try {
    console.log('downloading', photo.file_unique_id)

    const download = await runTransaction(db => {
      const existing = db.prepare('select file_unique_id from photos where file_unique_id = ?').get(photo.file_unique_id)
      if(existing !== undefined) return false

      db.prepare('insert into photos(file_unique_id, size, status, data) values (?, ?, ?, ?)')
        .run(
          photo.file_unique_id,
          JSON.stringify(photo.file_size),
          'downloading',
          Buffer.from([]),
        )

      return true
    })
    if(!download) {
      console.log(' already exists', photo.file_unique_id)
      return
    }

    try {
      const stream = ctx.bot.getFileStream(photo.file_id)
      const data = await streamConsumers.buffer(stream);
      console.log('  downloaded', photo.file_unique_id)

      await runTransaction(db => {
        db.prepare('update photos set status = ?, data = ? where file_unique_id = ?')
          .run(
            'done',
            data,
            photo.file_unique_id,
          )
      })
    }
    catch(error) {
      await runTransaction(db => {
        db.prepare('update photos set status = ? where file_unique_id = ?')
          .run(
            'error',
            photo.file_unique_id,
          )
      })
      throw error
    }

    respond(ctx)
  }
  catch(error) {
    console.log('could not download photo', error)
  }
}
