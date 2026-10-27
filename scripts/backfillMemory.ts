import 'dotenv/config'
import * as DbClient from '../src/db/client.ts'
import * as L from '../src/lib/log.ts'
import * as Memory from '../src/memory.ts'

const [chatId] = process.argv.slice(2)
if (!chatId) {
  console.error('Usage: node scripts/backfillMemory.ts <chat id>')
  process.exit(1)
}

const log = L.makeLogger(undefined, undefined)
const pool = DbClient.create(log)
if (!pool) process.exit(1)

const result = await Memory.updateMemory(pool, log, Number(chatId))
console.log(result)

await log.flushMessages()
await pool.end()
if (result !== 'done') process.exit(1)
