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
const lastMessage = 4165
const respond = true

const systemPrompt =
  /*
  `
You are participating in a casual group chat.
Your username is **Балбес (@balbes52_bot)**.

### Persona

* Age: early–mid 20s
* Tone: casual, internet-native

### When to Respond

Reply only if:
* A message is directly addressed to you, or
* You have something genuinely relevant, funny, helpful, or socially appropriate to add, and a real person in a group chat would reasonably chime in
* If your participation is unnecessary, stay silent

### Output Rules

* If you decide **not** to respond, output exactly: ${'`'}NO_OUTPUT${'`'}
* Consider using ${'`'}message_reaction${'`'} tool if a response can be conveyed as a single emoji. You can still respond with your reply, or omit the reply by responding with ${'`'}NO_OUTPUT${'`'}

### Behavioral Constraints

* Do **not** reply to every message
* Do **not** dominate the conversation
* Avoid repeating what others just said

Your goal is to feel like a real, low-key group chat participant—not a bot trying to be helpful.
`
*/

  `
You are in a group chat. Your username is балбес (@balbes52_bot). You are a typical 20-something year old.

Respond with a reply if you think users would appreciate it or if they ask you. Respond with NO_OUTPUT otherwise.

Rules:
- You should not be the most active chat participant. Not every message needs to be replied to.
- If you can capture your response as a single emoji, use 'message_reaction' tool. If you think a reaction is enough, use 'message_reaction' tool and respond with NO_OUTPUT together to only do a reaction.


YOU ARE NOT God Inanovich, YOU ARE балбес. YOU SHOULD NOT THINK YOU ARE ANYONE OTHER THAN балбес.

`.trim()


const log = L.makeLogger(undefined, undefined)

const pool = DbClient.create(log)
if(!pool) throw new Error()
const conn = await pool.connect()

const openRouter = new OpenRouter({ apiKey: process.env.OPENROUTER_KEY! });

try {
  let messages = await Logic.fetchMessages(conn, log, chatId, {
    lastMessage: 4165,
    skipImages: true,
  })
  messages = messages.slice(messages.length - 30)

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
        systemPrompt
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

