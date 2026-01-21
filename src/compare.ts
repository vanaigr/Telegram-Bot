import 'dotenv/config'
import fs from 'node:fs'
import util from 'node:util'
import * as DbClient from './db/client.ts'
import * as Db from './db/index.ts'
import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import type * as Types from './types.ts'
import * as Logic from './logic.ts'
import * as LlmSend from './llmSend.ts'
//import { OpenRouter } from '@openrouter/sdk'

/*
const chatId = -1002830050312
const lastMessage = 4164 // keep
//const lastMessage = 4183 // filter
*/

// Direct reply
//const chatId = -1003381622274
//const lastMessage = 209

const chatId = -1002830050312
const lastMessage = 4359

const log = L.makeLogger(undefined, undefined)

const pool = DbClient.create(log)
if(!pool) throw new Error()

//const openRouter = new OpenRouter({ apiKey: process.env.OPENROUTER_KEY! });

/*
const q = '`'
const prompt = `
You are given this input:
1. Existing ${q}user_summary${q}: the current stored profile for the user (personality, goals, background, preferences).
2. **Message History**: an ordered list of recent messages.

Task: produce an updated ${q}user_summary${q} and an updated ${q}conversation_summary${q} that incorporates new information from the message history.

Rules:
- At most 5 bullet points per user.
- Focus on medium and long-term goals, personality traits, background, **not** particulars.
- Assign each user profile bullet an importance score from 1 (least important) to 9 (most important) based on long-term relevance.

Think in English. Output in English.
`
*/

/*
const prompt = `
Take the conversation below and produce a compressed version of the conversation. Skip unimportant details, focus on chat participant goals and personalities. Output in english.
`.trim() + '\n'

const continuePrompt = `
Take previous summary and new conversation below and incorporate the conversation into the summary, while keeping it the same length. Focus on chat participant goals and personalities. Output in english.
`.trim() + '\n'
*/

try {
  let messages = await Logic.fetchMessages(pool, log, chatId, {
    skipImages: true,
    lastMessage,
  })
  //fs.writeFileSync('compaction.json', JSON.stringify(messages))
  //debugPrint(messages)

  const lastMessages = messages.slice(messages.length - 9)
  const toSend = lastMessages.map(it => {
    return {
      name: Logic.userToString(it.msg.from, true),
      text: it.msg.text ?? it.msg.caption ?? '',
    }
  })
  toSend.push({
    name: '@' + Logic.botUsername,
    ///
  })

  debugPrint(toSend)

  const result = await sendNonsenseCheckPrompt(
    //openRouter,
    toSend,
    ///
  )
  debugPrint(result)
  await debugSave({ chatId, lastMessage, result })

  /*
  const openrouterMessages = await Logic.messagesToModelInput({
    messages,
    chatInfo: (await Logic.getChatDataFromDb(pool, chatId))!.raw,
    log,
    caching: false,
  })
  debugPrint(openrouterMessages)
  */

  /*
  const messages = JSON.parse(fs.readFileSync('compaction.json').toString()) as Awaited<ReturnType<typeof Logic.fetchMessages>>
  const firstMessages = messages.slice(0, 100)
  const toSend = firstMessages.map(it => {
    const username = Logic.userToString(it.msg.from, true)
    return {
      name: username,
      text: it.msg.text ?? '<attachment>',
    }
  })
  const inputMessages: Logic.OpenRouterMessage[] = [
    { role: 'system', content: prompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: '**New messages**:\n' },
        ...toSend.map(it => {
          return {
            type: 'text' as const,
            text: 'User: ' + it.name + '\nText: ' + it.text.trim() + '\n',
          }
        })
      ],
    }
  ]
  debugPrint(inputMessages)
  */

  /*
  const messages = JSON.parse(fs.readFileSync('compaction.json').toString()) as Awaited<ReturnType<typeof Logic.fetchMessages>>
  const firstMessages = messages.slice(50, 100)
  const toSend = firstMessages.map(it => {
    const username = Logic.userToString(it.msg.from, true)
    return {
      name: username,
      text: it.msg.text ?? '<attachment>',
    }
  })
  const inputMessages: Logic.OpenRouterMessage[] = [
    { role: 'system', content: continuePrompt },
    { role: 'user', content: '**Summary up to this point**:\n' + summary.trim() + '\n' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '**New messages**:\n' },
        ...toSend.map(it => {
          return {
            type: 'text' as const,
            text: 'User: ' + it.name + '\nText: ' + it.text.trim() + '\n',
          }
        })
      ],
    }
  ]
  debugPrint(inputMessages)
  */

  /*
  if(true) {
    const response = await LlmSend.send(log, pool, {
      model: 'openai/gpt-5-mini',
      messages: inputMessages,
    })
    if(response) {
      debugPrint(response)
      await debugSave(response)
    }
  }
  */

  /*
  const response = await openRouter.chat.send({
    model: 'openai/gpt-5-mini',
    maxCompletionTokens: 5000,
    provider: {
      dataCollection: 'deny',
    },
    reasoning: {
      effort: 'medium',
    },
    stream: false,
    responseFormat: {
      type: 'json_schema',
      jsonSchema: {
        name: 'output',
        schema: {
          type: 'object',
          properties: {
            user_summary: {
              type: "object",
              additionalProperties: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    bullet: { "type": "string" },
                    importance: { "type": "number" },
                  },
                  required: ["bullet", "importance"],
                  additionalProperties: false,
                },
              },
            },
            //conversation_summary: {
            //  type: "string"
            //},
          },
          //required: ['conversation_summary'],
        },
      },
    },
    messages: inputMessages,
  })
  debugPrint(response)
  await debugSave({ type: 'compact', response })
  */

  /*
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


export async function sendNonsenseCheckPrompt(
  messages: { name: string, text: string }[], // includes model output
  modelReasoning: string,
) {
  const prompt = `
Below is an excerpt from a conversation between a group of users, along with a sample of reasoning provided by one of them. Identify which user the reasoning belongs to.

**Important**: If reasoning includes user name, it cannot belong to that user.

Output Structure: {"user":"<identifier of the user the reasoning belongs to>"}
`.trim() + '\n'

  return await LlmSend.send(log, pool!, {
    model: 'deepcogito/cogito-v2-preview-llama-109b-moe', // mostly good, we'll see
    max_completion_tokens: 1000,
    reasoning: {
      effort: 'medium',
    },
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: '**Messages**:\n"""\n' },
      ...messages.map(message => {
        return {
          role: 'user' as const,
          content: [{
            type: 'text' as const,
            text: 'User: ' + message.name + '\nText: ' + message.text.trim() + '\n\n',
          }],
        }
      }),
      { role: 'user', content: '"""\n**Reasoning**:\n"""\n' },
      { role: 'user', content: modelReasoning },
      { role: 'user', content: '\n"""' },
    ],
  })
}
