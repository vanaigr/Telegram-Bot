import 'dotenv/config';
import path from 'node:path';

import * as Db from './db/index.ts';
import * as DbClient from './db/client.ts';
import * as U from './lib/util.ts'
import * as L from './lib/log.ts'

let log: L.Log

try {
  const logPathRaw = process.env.LOG_PATH;
  const logPath = U.envVarValid(logPathRaw)
    ? path.resolve(path.join(import.meta.dirname, '..'), logPathRaw)
    : undefined;

  log = L.makeLogger(logPath, undefined);

  if (logPath !== undefined) {
    log.I('Logging to file: ', [logPath]);
  }
} catch (err) {
  console.error('Logger crashed');
  process.exit(1);
}

process.on('unhandledRejection', (err) => {
  log.E('IMPORTANT: Unhandled rejection ', [err]);
});
process.on('uncaughtException', (err) => {
  log.E('IMPORTANT: Uncaught exception ', [err]);
});

let exitCode = 0;
try {
  exitCode = await main();
} catch (err) {
  exitCode = 1;
  log.E('Main task crashed ', [err]);
} finally {
  // TODO: shutdown sparkplug and envelope clients.
  await log.flushMessages();
  process.exit(exitCode); // eslint-disable-line local/no-process-exit
}

async function main() {
  const pool = DbClient.create(log);
  if (pool === undefined) {
    return 1;
  }

  log.I('Started');

  log.I([await Db.query(pool, 'select', [Db.t.messages.sequenceNumber], 'from', Db.t.messages)])

  return 0
}
