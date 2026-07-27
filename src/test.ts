import 'dotenv/config'

import util from 'node:util'
import fs from 'node:fs'
import path from 'node:path'

import * as DbClient from './db/client.ts'
import * as Db from './db/index.ts'
import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import type * as Types from './types.ts'
import * as Logic from './logic.ts'
import { OpenRouter } from '@openrouter/sdk'

import Tokenizer, { models } from "ai-tokenizer"
import * as Encodings from "ai-tokenizer/encoding"

const encoding = Encodings[models['google/gemini-2.5-flash-preview-09-2025'].encoding]
const tokenizer = new Tokenizer(encoding)

console.log(tokenizer.encode('тест'))

throw 52

const log = L.makeLogger(undefined, undefined)

const pool = DbClient.create(log)
if(!pool) throw new Error()

const dumpPath = path.join(import.meta.dirname, '..', 'tmp', 'messages.json')

if(false) {
  const messages = (
    await Db.query(pool,
      'select', [Db.t.messages.raw],
      'from', Db.t.messages,
    )
  )
  .map(it => {
    const isBotMessage = it.raw.from?.username === 'balbes52_bot'
    const messageText = it.raw.text ?? it.raw.caption ?? ''

    return {
      user: isBotMessage ? '' : messageText,
      reply: isBotMessage ? messageText : '',
    }
  })

  fs.writeFileSync(dumpPath, JSON.stringify(messages))
}

let messages = JSON.parse(fs.readFileSync(dumpPath).toString()) as { user: string, reply: string }[]

function tokenize(text: string) {
    return text
      .replaceAll(/[.,\-:—!?«»*&]/g, ' ')
      .replaceAll(/\s+/g, ' ')
      .trim()
      .split(' ')
      .map(it => it.toLowerCase())
}
/*
function toPairs(words: string[]) {
  const result: string[] = []
  for(let i = 1; i < words.length; i++) {
    result.push(words[i - 1] + ' ' + words[i])
  }
  return result
}

const userWords = messages.map(it => toPairs(tokenize(it.user)))
const replyWords = messages.map(it => toPairs(tokenize(it.reply)))



class KeywordFinder {
  constructor({ minCount = 3, smoothing = 1 } = {}) {
    this.minCount = minCount;
    this.smoothing = smoothing;
    this.relCounts = new Map();
    this.irrCounts = new Map();
    this.nRel = 0;
    this.nIrr = 0;
  }

  static _tokenize(s) {
    return s.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
  }

  add(tokens0: string[], relevant: boolean) {
    const tokens = new Set(tokens0);  // doc frequency
    const target = relevant ? this.relCounts : this.irrCounts;
    if (relevant) this.nRel++; else this.nIrr++;
    for (const t of tokens) target.set(t, (target.get(t) || 0) + 1);
    return this;  // chainable
  }

  score(word) {
    const a = this.relCounts.get(word) || 0;
    const b = this.irrCounts.get(word) || 0;
    const s = this.smoothing;
    const pRel = (a + s) / (this.nRel + 2 * s);
    const pIrr = (b + s) / (this.nIrr + 2 * s);
    return { word, score: Math.log(pRel / pIrr), relDocs: a, irrDocs: b };
  }

  _allScores() {
    const words = new Set([...this.relCounts.keys(), ...this.irrCounts.keys()]);
    const out = [];
    for (const w of words) {
      const a = this.relCounts.get(w) || 0;
      const b = this.irrCounts.get(w) || 0;
      if (a + b < this.minCount) continue;
      out.push(this.score(w));
    }
    return out;
  }

  topRelevant(n = 50) {
    return this._allScores().sort((x, y) => y.score - x.score).slice(0, n);
  }

  topIrrelevant(n = 50) {
    return this._allScores().sort((x, y) => x.score - y.score).slice(0, n);
  }

  stats() {
    return {
      relevantDocs: this.nRel,
      irrelevantDocs: this.nIrr,
      vocabularySize: new Set([...this.relCounts.keys(), ...this.irrCounts.keys()]).size,
    };
  }

  reset() {
    this.relCounts.clear();
    this.irrCounts.clear();
    this.nRel = 0;
    this.nIrr = 0;
    return this;
  }
}

const ddo = new KeywordFinder()

for(const it of userWords) ddo.add(it, false)
for(const it of replyWords) ddo.add(it, true)

console.log(ddo.topRelevant())
console.log(ddo.score('план капкан'))
console.log(replyWords.map((it, i) => [it, messages[i].reply]).filter(it => it[0].includes('в м')))
*/

/*
const frequencyByPair = new Map<string, number>()
for(const words of messageWords) {
  for(let i = 1; i < words.length; i++) {
    const str = words[i - 1] + ' ' + words[i]
    frequencyByPair.set(
      str,
      (frequencyByPair.get(str) ?? 0) + 1,
    )
  }
}

const frequentPairs = [...frequencyByPair]
  .sort((a, b) => -(a[1] - b[1]))
  //.slice(0, 10)

console.log(util.inspect(frequentPairs, { maxArrayLength: Infinity}))
console.log(frequencyByPair.get('план капкан'))
*/


const order = 2
const chain = new Map<string, (string | undefined)[]>()

for(const { reply } of messages) {
  const tokens = tokenize(reply)
  if(tokens.length < order) continue

  const padded = Array<string | undefined>(order).fill(undefined).concat(...tokens).concat([undefined])
  for(let i = 0; i < padded.length - order; i++) {
    const state = padded.slice(i, i + order)
    const stateKey = state.join(' ')

    const arr = (chain.get(stateKey) ?? [])
    arr.push(padded[i + order])
    chain.set(stateKey, arr)
  }
}

{
  const maxWords = 50
  const state = Array<string | undefined>(order).fill(undefined)
  const out: string[] = []
  for(let i = 0; i < maxWords; i++) {
    const choices = chain.get(state.join(' ')) ?? []
    const word = choices[Math.floor(Math.random() * choices.length)]
    if(word === undefined) break

    out.push(word)
    state.shift()
    state.push(word)
  }

  console.log(out.join(' '))
}


await pool.end()

/*
const pool = DbClient.create(log)
if(!pool) throw new Error()


  const t = Db.t.messages
  const messagesRaw = await Db.query(pool,
    'select', [
      t.raw,
      Db.named(
        'reactions',
        Db.scalar<typeof Db.dbTypes.jsonArray>(Db.par(
          'select', Db.func('array_agg', [
            Db.t.reactions.raw, 'order by', Db.t.reactions.hash,
          ]),
          'from', Db.t.reactions,
          'where', Db.eq(Db.t.reactions.chatId, t.chatId),
          'and', Db.eq(Db.t.reactions.messageId, t.messageId),
        )),
      ),
    ],
    'from', t,
    'where', Db.eq(t.chatId, Db.param(BigInt(1720000708))),
    'order by', t.messageId, 'asc', // date resolution is too low
  )

  const messages = messagesRaw.map(({ raw: msg, reactions }) => {
    return {
      msg,
      reactions: reactions as Types.MessageReactionUpdated[],
      photos: (() => {
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

const o = messages.map(({ msg, reactions }) => {
  return JSON.stringify(Logic.messageHeaders(msg, reactions)) + '\n' + Logic.messageText(msg)
})

console.log(util.inspect(o, { maxArrayLength: Infinity, depth: Infinity }))
*/
