import * as DbClient from './db/client.ts'
import * as Db from './db/index.ts'
import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import * as Logic from './logic.ts' // circular import

import Tokenizer, { models } from "ai-tokenizer"
import * as Encodings from "ai-tokenizer/encoding"

export async function reply(pool: Db.DbPool, log: L.Log, chatId: number, maxTokens: number) {
  const messages = (
    await Db.query(pool,
      'select', [Db.t.messages.raw],
      'from', Db.t.messages,
      'where', Db.eq(Db.t.messages.chatId, Db.param(BigInt(chatId))),
      'and', Db.not(Db.eq(Db.t.messages.type, Db.param('mark'))),
    )
  )
    .map(it => {
      const isBotMessage = it.raw.from?.username === 'balbes52_bot'
      const messageText = it.raw.text ?? it.raw.caption ?? ''

      return isBotMessage ? messageText : ''
    })

  log.I('Retrieved ', [messages.length], ' messages')

  const order = 10
  const chain = new Map<string, (string | undefined)[]>()
  const tokenCounts: number[] = []

  for(const reply of messages) {
    const tokens = tokenize(reply)
    if(tokens.length < order) continue
    tokenCounts.push(tokens.length)

    const padded = Array<string | undefined>(order).fill(undefined).concat(...tokens).concat([undefined])
    for(let i = 0; i < padded.length - order; i++) {
      const state = padded.slice(i, i + order)
      const stateKey = state.join('')

      const arr = (chain.get(stateKey) ?? [])
      arr.push(padded[i + order])
      chain.set(stateKey, arr)
    }
  }

  log.I('Created chain map')

  if(!isFinite(maxTokens)) maxTokens = tokenCounts[Math.floor(Math.random() * tokenCounts.length)]

  log.I('Generating up to ', [maxTokens], ' tokens')

  const reply = (() => {
    const state = Array<string | undefined>(order).fill(undefined)
    const out: string[] = []
    for(let i = 0; i < maxTokens; i++) {
      const choices = chain.get(state.join('')) ?? []
      const word = choices[Math.floor(Math.random() * choices.length)]
      if(word === undefined) break

      out.push(word)
      state.shift()
      state.push(word)
    }

    return out.join('')
  })()

  log.I('Generated. Sending')

  await (async() => {
    const responseResult = await Logic.sendMessageOrPhoto(
      chatId,
      { text: reply, entities: [], photo: undefined },
      log,
    )

    if(responseResult.status !== 'ok') {
      return
    }
    if(!responseResult.data.ok) {
      log.E([responseResult.data.description])
      return
    }
    const newMessage = responseResult.data.result

    await (async() => {
      log.I('Inserting response')
      await Db.insertMany(
        pool,
        Db.t.messages,
        Db.d.messages,
        [{
          chatId: newMessage.chat.id,
          messageId: newMessage.message_id,
          date: Logic.fromMessageDate(newMessage.date).toJSON(),
          type: 'mark',
          raw: JSON.stringify(newMessage),
          generation: JSON.stringify([]),
        }],
        {}
      )
    })()
  })()
}

const encoding = Encodings[models['google/gemini-2.5-flash-preview-09-2025'].encoding]
const tokenizer = new Tokenizer(encoding)
const byteDecoding: (Uint8Array<ArrayBufferLike> | undefined)[] = []
{
  const textEncoder = new TextEncoder()
  for(const key in encoding.decoder) {
    const keyNum = parseInt(key)
    if(!isFinite(keyNum)) continue
    const value = encoding.decoder[key]
    byteDecoding[keyNum] = typeof value === 'string'
      ? textEncoder.encode(value)
      : value
  }
}


function tokenize(text: string) {
  const textDecoder = new TextDecoder('utf-8')

  return tokenizer
    .encode(text)
    .map(it => textDecoder.decode(byteDecoding[it], { stream: true }))
    .join('')
  //return text.split(/[.,\-:—!?«»*&\s]/g)
  //return [...(text.match(/\r\n|\n|[\p{L}\p{N}_']+|[^\s]/gu) ?? [])];
}
