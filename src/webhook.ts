import streamConsumers from 'stream/consumers';

import { waitUntil, attachDatabasePool } from '@vercel/functions';

import * as DbClient from './db/client.ts'
import * as Db from './db/index.ts'
import * as T from './lib/temporal.ts'
import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import type * as Types from './types.ts'

export async function POST(req: Request) {
  const log = L.makeLogger(undefined, undefined)

  log.I('Received webhook')
  const token = req.headers.get('x-telegram-bot-api-secret-token')
  if(token === '' || token !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    log.W('Unexpected webhook token ', [token], ' expected ', [process.env.TELEGRAM_WEBHOOK_SECRET])
    return new Response('', { status: 401 })
  }

  const body = await req.json()
  const message = body.message as Types.Message

  const pool = DbClient.create(log)
  if(!pool) {
    return new Response(JSON.stringify({}), { status: 500 })
  }
  attachDatabasePool(pool)

  Db.timedTran(pool, async(db) => {
    const dst = Db.t.messages
    const schema = Db.d.messages
    const src = Db.makeTable<typeof schema>('src')
    const cols = Db.keys(schema)

    const record: Db.ForInput<typeof schema> = {
      chatId: message.chat.id,
      messageId: message.message_id,
      date: T.Instant.fromEpochMilliseconds(message.date * 1000).toJSON(),
      type: 'user',
      raw: JSON.stringify(message),
      needsResponse: true,
    }

    await Db.queryRaw(db,
      'insert into', dst, Db.args(cols.map(it => dst[it].nameOnly)),
      'select', Db.list(cols.map(it => src[it].nameOnly)),
      'from', Db.arraysTable([record], schema), 'as', src,
      'on conflict do nothing'
    )
  })

  const photoTask = (async() => {
    const photo = message.photo?.at(-1)
    if(!photo) return

    log.addedCtx('photo ', [photo.file_unique_id])

    try {
      await downloadPhoto(pool, log, photo)
    }
    catch(error) {
      log.E([error])
    }
  })()

  waitUntil(photoTask)

  return new Response(JSON.stringify({}))
}

async function downloadPhoto(pool: Db.DbPool, log: L.Log, photo: Types.PhotoSize) {
  log.I('Downloading')

  await Db.timedTran(pool, async(db) => {
    const t = Db.t.photos
    const schema = Db.d.photos

    const existing = await Db.query(db,
      'select', [t.file_unique_id],
      'from', t,
      'where', Db.eq(t.file_unique_id, Db.param(photo.file_unique_id)),
    ).then(it => it.at(0))

    if(existing) {
      log.I(' Already exists')
      return
    }

    await Db.insertMany(db, t, schema, [{
      file_unique_id: photo.file_unique_id,
      raw: JSON.stringify(photo),
      status: 'downloading',
      bytes: Buffer.from([]),
    }], {})

    log.I('Getting file url')
    try {
      const fileInfoUrl = new URL(`https://api.telegram.org/file/bot${encodeURIComponent(process.env.TELEGRAM_BOT_TOKEN!)}/getFile`)
      fileInfoUrl.searchParams.set('file_id', photo.file_id)
      const fileInfoResult = await U.request<Types.File>({ url: fileInfoUrl, log, method: 'GET' })
      if(fileInfoResult.status !== 'ok') throw new Error()
      const fileInfo = fileInfoResult.data

      const fileUrl = `https://api.telegram.org/file/bot${encodeURIComponent(process.env.TELEGRAM_BOT_TOKEN!)}/` + fileInfo.file_path

      const response = await fetch(fileUrl)
      if (!response.ok) {
        const bodyMessage: L.Message = await response.text().then(
          (it) => ['Body: ', [it]],
          (e) => ['Body error: ', [e]],
        );
        log.E('Response status: ', [response.status], '\n', ...bodyMessage);
        throw new Error()
      }

      log.I('Getting file')
      const buffer = await streamConsumers.buffer(response.body!)

      log.I('Done downloading')

      await Db.queryRaw(db,
        'update', t,
        'set', Db.list([
          Db.set(t.status, Db.param('done' as const)),
          Db.set(t.bytes, Db.param(buffer)),
        ]),
        'where', Db.eq(t.file_unique_id, Db.param(photo.file_unique_id)),
      )
    }
    catch(error) {
      log.I('Failed to download file ', [error])

      await Db.queryRaw(db,
        'update', t,
        'set', Db.list([
          Db.set(t.status, Db.param('error' as const)),
        ]),
        'where', Db.eq(t.file_unique_id, Db.param(photo.file_unique_id)),
      )
    }
  })
}
