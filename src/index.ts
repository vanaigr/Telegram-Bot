import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import util from 'node:util'
import streamConsumers from 'stream/consumers';

import { FileTypeParser } from 'file-type';
import { Temporal as T } from 'temporal-polyfill'
import TelegramBot from 'node-telegram-bot-api'
import dotenv from 'dotenv'
import { OpenRouter } from '@openrouter/sdk'
import sqlite from 'better-sqlite3'

type Lock = {
    running: Promise<unknown> | undefined,
    lock: <T>(run: () => T | Promise<T>) => Promise<T>
}
const lock: Lock = {
    running: undefined,
    async lock(run) {
        while(this.running) {
            await this.running
        }

        const start = Promise.withResolvers<void>()

        const doRun = (async() => {
            await start.promise
            try { return await run() }
            finally { this.running = undefined }
        })()
        this.running = doRun

        start.resolve()

        return await doRun
    }
}

async function main() {
  dotenv.config({ quiet: true })

  console.log('Migrating db')
  await migrateDb()
  console.log('Migration done')

  const openRouter = new OpenRouter({ apiKey: process.env.OPENROUTER_KEY! });
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: true });
  const ctx: Ctx = { openRouter, bot, responding: undefined }

  bot.on('message', async(msg) => {
    try {
      console.log('in', msg.date)
      await runTransaction(db => {
        db.prepare('insert into messages(date, chatId, type, raw, needsResponse) values ( ?, ?, ?, ?, ?)')
          .run(
            msg.date,
            msg.chat.id,
            'user',
            JSON.stringify(msg),
            1,
          )
      })

      if(msg.photo) downloadPhotos(ctx, msg.photo)

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

  console.log('started')

  respond(ctx)
}

/*
You are a group chat participant. Write a reply if you think users would appreciate it or if they ask you (@balbes52_bot, Балбес, etc.). Reply <empty> (with angle brackets) if you think users are talkning between themselves and would not appreciate your interruption.

You are a group chat participant. Write a reply if users ask you something (@balbes52_bot, Балбес, etc.). Reply <empty> (with angle brackets) otherwise. Plan out your reply.
*/
const systemPrompt = `
You are a group chat participant. Write a reply if you think users would appreciate it or if they ask you (@balbes52_bot, Балбес, etc.). Reply <empty> (with angle brackets) if you think users are talkning between themselves and would not appreciate your interruption.

Don't write essays. Nobody wants to read a lot.

Commands that you can do (if users ask):
/stop - Temporarily suspends you

`.trim()

type Ctx = {
  openRouter: OpenRouter
  bot: TelegramBot
  responding: Promise<unknown> | undefined
}

/// ???????????
type OpenRouterMessage = OpenRouter['chat']['send'] extends (a: { messages: Array<infer Message> }) => infer U1 ? Message : never

type Photo = {
  file_unique_id: string
  status: string
  data: Buffer
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
        photos: (msg.photo ?? []).map((orig): Photo => ({
          file_unique_id: orig.file_unique_id,
          status: 'not-available',
          data: Buffer.from([]),
        }))
      }
    })

    const last = messages[messages.length - 1]
    if(last.msg.photo && last.msg.photo.length > 0) {
      const file = db.prepare('select file_unique_id, status, data from photos where file_unique_id = ?')
        .get(last.msg.photo[0].file_unique_id) as any
      if(file === undefined || file.status === 'downloading') {
        console.log(' not sending, image still downloading')
        return
      }

      last.photos[0] = file
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
      const text = 'At '
        + T.Instant.fromEpochMilliseconds(msg.date * 1000)
          .toZonedDateTimeISO(T.Now.timeZoneId())
          .toPlainDateTime().toString()
        + '\n'
        + (msg.text ?? '<no message>')

      return {
        role: 'user',
        name: (msg.from?.first_name + ' ' + msg.from?.last_name).trim() + '(@' + msg.from?.username + ')',
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
                    detail: 'auto' as const,
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
    //model: 'moonshotai/kimi-k2-0905',
    //model: 'moonshotai/kimi-k2-thinking',
    //model: 'x-ai/grok-4.1-fast',
    model: 'google/gemini-2.5-flash-lite',
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

async function downloadPhotos(
  ctx: Ctx,
  photos: TelegramBot.PhotoSize[]
) {
  try {
    const photo = photos.at(0)
    if(photo) {
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
  }
  catch(error) {
    console.log('could not download photo', error)
  }
}

async function migrateDb() {
  await runTransaction(db => {
    let v: number = (db.pragma('user_version') as any)[0].user_version
    if(v === 0) {
      console.log(' migration 0')

      db.exec(`
create table messages(
  sequenceNumber integer primary key autoincrement,

  date number, -- epoch seconds
  chatId number,
  type text,
  raw text,
  needsResponse number
)
      `)

      db.exec(`
create table responses(
  sequenceNumber integer primary key autoincrement,
  respondToSequenceNumber number,
  raw text
)
      `)

      v = 1
    }

    if(v === 1) {
      console.log(' migration 1')

      db.exec(`
create table photos(
  file_unique_id text primary key,
  size text,
  status text,
  data blob
)
      `)

      v = 2
    }

    db.pragma('user_version = ' + v)
  })
}

function connect(): sqlite.Database {
  return new sqlite('./bot.db')
}
async function runTransaction<R>(
  transaction: (db: sqlite.Database) => R
) {
  const db = connect()
  try {
    db.exec('begin')
    try {
      const result = await transaction(db)
      db.exec('commit')
      return result
    }
    catch(error) {
      db.exec('rollback')
      throw error
    }
  }
  finally {
    db.close()
  }
}

await main()
