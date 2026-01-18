import 'dotenv/config'
import util from 'node:util'
import * as DbClient from './db/client.ts'
import * as Db from './db/index.ts'
import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import type * as Types from './types.ts'
import * as Logic from './logic.ts'
import { OpenRouter } from '@openrouter/sdk'

const chatId = -1002830050312
const lastMessage = 4191
const respond = false

const log = L.makeLogger(undefined, undefined)

const pool = DbClient.create(log)
if(!pool) throw new Error()
const conn = await pool.connect()

const openRouter = new OpenRouter({ apiKey: process.env.OPENROUTER_KEY! });

try {
  let messages = await Logic.fetchMessages(conn, log, chatId, { lastMessage, skipImages: true })
  //messages = messages.slice(messages.length - 20)

  const openrouterMessages = await Logic.messagesToModelInput({
    messages,
    chatInfo: (await Logic.getChatDataFromDb(conn, chatId))!.raw,
    log,
    caching: false,
  })

  debugPrint(openrouterMessages)

  if(respond) {
    let response: any
    try {
      response = await Logic.sendPrompt(
        openRouter,
        openrouterMessages,
        Logic.systemPrompt
      )
    }
    catch(error) {
      console.error('during response generation')
      throw error
    }

    debugPrint(response)

    await debugSave({ chatId, lastMessage, response })
  }

  conn.release()
  await pool.end()
}
catch(error) {
  console.error(error)
}

  function debugPrint(value: unknown) {
    console.log(util.inspect(value, { depth: Infinity, maxArrayLength: Infinity }))
  }
  async function debugSave(value: unknown) {
    const t = Db.t.debug
    await Db.queryRaw(pool!,
      'insert into', t, Db.args([t.raw.nameOnly]),
      'values', Db.args([Db.param(JSON.stringify(value))]),
    )
  }

