import { waitUntil, attachDatabasePool } from '@vercel/functions'

import * as DbClient from './db/client.ts'
import * as Db from './db/index.ts'
import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import type * as Types from './types.ts'
import * as Logic from './logic.ts'

export async function POST(req: Request): Promise<Response> {
  const log = L.makeLogger(undefined, undefined)

  log.I('Received webhook')
  //log.I([req.headers])
  const token = req.headers.get('x-telegram-bot-api-secret-token')
  if(token === '' || token !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    log.W('Unexpected webhook token ', [token])
    return new Response('', { status: 401 })
  }

  const body = await req.json()
  //log.I('Body: ', [body])

  if(body.message !== undefined) {
    return await handleMessage(log, body.message, false)
  }
  else if(body.edited_message !== undefined) {
    return await handleMessage(log, body.message, true)
  }
  else if(body.message_reaction !== undefined) {
    return await handleReaction(log, body.message_reaction)
  }
  else {
    log.I('What did it send to me? ', [body])
    return new Response('')
  }
}

async function handleReaction(log: L.Log, reaction: Types.MessageReactionUpdated) {
  log.I('Reaction ', [reaction.chat.id], 'on message ', [reaction.message_id], ' in ', [reaction.chat.id])

  const pool = DbClient.create(log)
  if(!pool) {
    return new Response(JSON.stringify({}), { status: 500 })
  }
  attachDatabasePool(pool)

  const whitelistResponse = await handleWhitelisted(pool, log, reaction.chat.id)
  if(whitelistResponse) return whitelistResponse

  let hash: string
  if(reaction.user) {
    hash = U.getHash('user', reaction.user.id)
  }
  else if(reaction.actor_chat) {
    hash = U.getHash('chat', reaction.actor_chat.id)
  }
  else {
    log.I('Unsupported reaction sender: ', [reaction])
    return new Response('')
  }

  log.I('Updating reaction')

  await Logic.updateReactionRows(pool, [{
    chatId: reaction.chat.id,
    messageId: reaction.message_id,
    hash,
    raw: JSON.stringify(reaction),
  }])

  log.I('done')

  return new Response('')
}

async function handleMessage(log: L.Log, message: Types.Message, edit: boolean) {
  log.I('Message ', [message.message_id], ' in chat ', [message.chat.id])

  const pool = DbClient.create(log)
  if(!pool) {
    return new Response(JSON.stringify({}), { status: 500 })
  }
  attachDatabasePool(pool)

  const whitelistResponse = await handleWhitelisted(pool, log, message.chat.id)
  if(whitelistResponse) return whitelistResponse

  await Db.timedTran(pool, async(db) => {
    const dst = Db.t.messages
    const schema = Db.d.messages
    const src = Db.makeTable<typeof schema>('src')
    const cols = Db.keys(schema)

    const record: Db.ForInput<typeof schema> = {
      chatId: message.chat.id,
      messageId: message.message_id,
      date: Logic.fromMessageDate(message.date).toJSON(),
      type: 'user',
      raw: JSON.stringify(message),
    }
    const excluded = Db.makeTable<typeof schema>('excluded')

    if(edit) {
      log.I('Backing up previous message')
      const backupDst = Db.t.messagesBackup
      const backupSchema = Db.omit(Db.d.messagesBackup, ['sequenceNumber'])
      const backupCols = Db.keys(backupSchema)
      await Db.queryRaw(db,
        'insert into', backupDst, Db.args(backupCols.map(it => backupDst[it].nameOnly)),
        'select', Db.list(backupCols.map(it => dst[it])),
        'from', dst,
        'where', Db.eq(dst.chatId, Db.param(BigInt(message.chat.id))),
        'and', Db.eq(dst.messageId, Db.param(BigInt(message.message_id))),
      )
    }

    await Db.queryRaw(db,
      'insert into', dst, Db.args(cols.map(it => dst[it].nameOnly)),
      'select', Db.list(cols.map(it => src[it])),
      'from', Db.arraysTable([record], schema), 'as', src,
      'on conflict', Db.args([dst.chatId.nameOnly, dst.messageId.nameOnly]),
      'do update set', Db.list(cols.map(it => [dst[it].nameOnly, '=', excluded[it]])),
    )
  })
  log.I('Added message')

  const photoTask = (async() => {
    const photo = message.photo?.at(-1)
    if(!photo) return

    const l = log.addedCtx('photo ', [photo.file_unique_id])

    try {
      await Logic.downloadPhoto(pool, l, message.chat.id, photo)
    }
    catch(error) {
      l.E([error])
    }
  })()
  waitUntil(photoTask)

  if(!edit) {
    const replyTask = (async() => {
      const l = log.addedCtx('reply')

      const completion = { sent: false }
      try {
        await Db.tran(pool, async(db) => {
          await Logic.reply(
            db,
            l,
            Logic.fromMessageDate(message.date),
            message.chat.id,
            completion
          )
        })
      }
      catch(error) {
        l.E([error])
      }

      if(!completion.sent) {
        const emojis = ['🙂', '💀', '☠']
        const text = 'Бот шандарахнулся ' + emojis[Math.floor(Math.random() * emojis.length)]
        await Logic.sendMessage(message.chat.id, text, log)
      }
    })()
    waitUntil(replyTask)
  }

  return new Response(JSON.stringify({}))
}

async function handleWhitelisted(pool: Db.DbPool, log: L.Log, chatId: number) {
  const whitelisted = await Db.query(pool,
    'select', [Db.t.chatWhitelist.id],
    'from', Db.t.chatWhitelist,
    'where', Db.eq(Db.t.chatWhitelist.id, Db.param(BigInt(chatId))),
  ).then(it => it.at(0)?.id !== undefined)

  if(!whitelisted) {
    log.W('Chat ', [chatId], ' is not whitelisted')

    const emojis = ['🙂', '😳', '👉👈', '😡']
    const text = 'А вы кто ' + emojis[Math.floor(Math.random() * emojis.length)] + '?'
    await Logic.sendMessage(chatId, text, log)

    return new Response(JSON.stringify({}))
  }
}
