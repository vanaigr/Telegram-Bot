import 'dotenv/config'
import * as T from './lib/temporal.ts'
import fs from 'node:fs'
import util from 'node:util'
import * as DbClient from './db/client.ts'
import * as Db from './db/index.ts'
import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import type * as Types from './types.ts'
import * as Logic from './logic.ts'
import * as LlmSend from './llmSend.ts'
import { OpenRouter } from '@openrouter/sdk'

const log = L.makeLogger(undefined, undefined)

const pool = DbClient.create(log)
if(!pool) throw new Error()

await Logic.reply(
  pool,
  await pool.connect(),
  log,
  T.Now.instant(),
  -1002830050312,
  { sent: false },
)
