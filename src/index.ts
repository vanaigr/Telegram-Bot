import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import util from 'node:util'
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
            msg.text ? 1 : 0,
          )
      })


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

function respond(ctx: Ctx) {
  const respondPrev = ctx.responding
  const respondNext = (async() => {
    try { await respondPrev } catch(err) {}

    const data = await runTransaction(db => {
      const now = T.Now.instant().epochMilliseconds / 1000

      const unresponded = (db.prepare('select sequenceNumber, date, chatId from messages where needsResponse = 1 and date > ? order by date limit 1').get(now - 30) as any)
      if(unresponded === undefined) return

      const messages = (db.prepare('select raw from messages where date <= ? and chatId = ? order by date')
        .all(unresponded.date, unresponded.chatId) as any[])
        .map(it => JSON.parse(it.raw) as TelegramBot.Message)

      return {
        respondToSequenceNumber: unresponded.sequenceNumber,
        chatId: unresponded.chatId,
        messages
      }
    })
    if(data === undefined) return
    console.log('responding to', data.respondToSequenceNumber)

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
        ...data.messages.map((it): OpenRouterMessage => {
          if(it.from?.username === 'balbes52_bot') {
            return {
              role: 'assistant',
              content: it.text,
            }
          }
          else {
            return {
              role: 'user',
              name: (it.from?.first_name + ' ' + it.from?.last_name).trim() + '(@' + it.from?.username + ')',
              content: 'At '
                + T.Instant.fromEpochMilliseconds(it.date * 1000)
                  .toZonedDateTimeISO(T.Now.timeZoneId())
                  .toPlainDateTime().toString()
                + '\n'
                + (it.text ?? '<no message>'),
            }
          }
        }),
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

  })().catch(err => console.error(err))
  ctx.responding = respondNext

  return respondNext
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

      db.pragma('user_version = 1')
      v = 1
    }
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
