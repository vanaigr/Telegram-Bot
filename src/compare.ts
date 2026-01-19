import 'dotenv/config'
import fs from 'node:fs'
import util from 'node:util'
import * as DbClient from './db/client.ts'
import * as Db from './db/index.ts'
import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import type * as Types from './types.ts'
import * as Logic from './logic.ts'
import { OpenRouter } from '@openrouter/sdk'

/*
const chatId = -1002830050312
const lastMessage = 4164 // keep
//const lastMessage = 4183 // filter
*/

// Direct reply
//const chatId = -1003381622274
//const lastMessage = 209

const chatId = -1002830050312
const lastMessage = 4216
const reasoningToMessageId = lastMessage

const respond = false

const log = L.makeLogger(undefined, undefined)

const pool = DbClient.create(log)
if(!pool) throw new Error()

const openRouter = new OpenRouter({ apiKey: process.env.OPENROUTER_KEY! });

try {
  let messages = await Logic.fetchMessages(pool, log, chatId, {
    lastMessage,
    skipImages: true,
  })
  //messages = messages.slice(messages.length - 20)
  debugPrint(messages)

  const reasoningObj = await Db.query(pool,
    'select', [Db.t.responses.raw],
    'from', Db.t.responses,
    'where', Db.eq(Db.t.responses.respondsToChatId, Db.param(BigInt(chatId))),
    'and', Db.eq(
      Db.t.responses.respondsToMessageId,
      Db.param(BigInt(reasoningToMessageId))
    ),
    'order by', Db.t.responses.sequenceNumber, 'asc',
    'limit 1',
  ).then(it => it[0].raw)

  messages = messages.slice(messages.length - 10)

  const checkMessages = messages.map(it => {
    return {
      name: Logic.userToString(it.msg.from, false),
      text: it.msg.text ?? it.msg.caption ?? '',
    }
  })

  const reasoningMessage = (reasoningObj as any).choices[0].message
  const reasoning = (reasoningMessage.reasoning || reasoningMessage.content) as string

  debugPrint(checkMessages)
  debugPrint(reasoning)

  const response = await Logic.sendNonsenseCheckPrompt(
    openRouter,
    checkMessages,
    reasoning,
  )
  debugPrint(response)
  await debugSave({ chatId, lastMessage, response })

  /*
  const openrouterMessages = await Logic.messagesToModelInput({
    messages,
    chatInfo: (await Logic.getChatDataFromDb(conn, chatId))!.raw,
    log,
    caching: false,
  })
  debugPrint(openrouterMessages)
  */

  /*
  let controlMessages = messages.map(it => ({
    name: Logic.userToString(it.msg.from, false),
    // it.msg.from?.username === 'balbes52_bot'
    //     ? 'Target User'
    //     : 'User ' + usernames.indexOf(Logic.userToString(it.msg.from, false)),
    text: it.msg.text ?? it.msg.caption ?? '',
  }))
  controlMessages = controlMessages.slice(controlMessages.length - 9)
  controlMessages.push({
    name: '@balbes52_bot',
    text: 'Здарова. Че как?',
  })
  fs.writeFileSync('messages.json', JSON.stringify(controlMessages))
  */

  /*
  let controlMessages = JSON.parse(fs.readFileSync('messages.json').toString())
  controlMessages = controlMessages.slice(controlMessages.length - 10)

  debugPrint(controlMessages)

  if(true) {
    const controlResponse = await Logic.sendControlPrompt(openRouter, controlMessages)
    debugPrint(controlResponse)
    await debugSave({ chatId, lastMessage, controlResponse })
  }
  */

  /*
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
  */
}
catch(error) {
  console.error(error)
}

await pool.end()

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

