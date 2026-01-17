import 'dotenv/config'
import util from 'node:util'
import * as DbClient from './db/client.ts'
import * as Db from './db/index.ts'
import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import type * as Types from './types.ts'
import * as Logic from './logic.ts'

const log = L.makeLogger(undefined, undefined)

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
