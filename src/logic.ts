import streamConsumers from 'stream/consumers'

import { waitUntil, attachDatabasePool } from '@vercel/functions'
import { OpenRouter } from '@openrouter/sdk'
import { FileTypeParser } from 'file-type';

import * as Db from './db/index.ts'
import * as T from './lib/temporal.ts'
import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import type * as Types from './types.ts'

export async function getChatFullInfo(
  conn: Db.DbConnOrPool,
  baseLog: L.Log,
  chatId: number
): Promise<Types.ChatFullInfo | undefined> {
  const log = baseLog.addedCtx('chat full info')

  try {
    log.I('Getting chat info')
    const t = Db.t.chatFullInfo
    const chatData = await Db.query(conn,
      'select', [t.updatedAt, t.raw],
      'from', t,
      'where', Db.eq(t.id, Db.param(BigInt(chatId))),
    ).then(it => it.at(0))

    if(chatData === undefined) {
      log.I('No chat data')
      return await updateFullChat(conn, log, chatId)
    }
    else {
      log.I('Got chat data')
      const nextUpdate = T.Instant.from(chatData.updatedAt).add({ minutes: 10 })
      if(T.Instant.compare(nextUpdate, T.Now.instant()) < 0) {
        log.I('Refreshing chat info')
        waitUntil(updateFullChat(conn, log, chatId))
      }
      return chatData.raw
    }
  }
  catch(error) {
    log.E([error])
  }

  log.I('Could not get info')
}

async function updateFullChat(conn: Db.DbConnOrPool, log: L.Log, chatId: number) {
  log.I('Fetching chat info')
  const newChatInfo = await getChat(chatId, log)
  if(!newChatInfo) return
  log.I('Received')

  const dst = Db.t.chatFullInfo
  const schema = Db.d.chatFullInfo
  const cols = Db.keys(schema)
  const src = Db.makeTable<typeof schema>('src')
  const excluded = Db.makeTable<typeof schema>('excluded')

  const row: Db.ForInput<typeof schema> = {
    id: chatId,
    updatedAt: T.Now.instant().toJSON(),
    raw: JSON.stringify(newChatInfo)
  }

  // NOTE: there may be race conditions, but it doesn't matter since
  // this doesn't update often.
  const result = await Db.query(conn, [
    'insert into', dst, Db.args(cols.map(it => dst[it].nameOnly)),
    'select', Db.list(cols.map(it => src[it])),
    'from', Db.arraysTable([row], schema), 'as', src,
    'where', Db.eq(dst.id, src.id),
    'on conflict', Db.args([dst.id.nameOnly]),
    'do update set', Db.list([
      Db.set(dst.updatedAt, excluded.updatedAt),
      [dst.raw.nameOnly, '=', excluded.raw],
    ]),
    'returning'], [dst.raw],
  ).then(it => it[0].raw)
  log.I('Updated db')
  return result
}

export async function updateReactionRows(
  conn: Db.DbConnOrPool,
  reactions: Db.ForInput<typeof Db.d.reactions>[],
) {
  if(reactions.length === 0) return

  const dst = Db.t.reactions
  const schema = Db.d.reactions
  const cols = Db.keys(schema)
  const src = Db.makeTable<typeof schema>('src')
  const excluded = Db.makeTable<typeof schema>('excluded')

  await Db.queryRaw(conn,
    'insert into', dst, Db.args(cols.map(it => dst[it].nameOnly)),
    'select', Db.list(cols.map(it => src[it])),
    'from', Db.arraysTable(reactions, schema), 'as', src,
    'on conflict', Db.args([dst.chatId.nameOnly, dst.messageId.nameOnly, dst.hash.nameOnly]),
    'do update set', Db.list([
      [dst.raw.nameOnly, '=', excluded.raw],
    ]),
  )
}

export async function downloadPhoto(
  pool: Db.DbPool,
  log: L.Log,
  chatId: number,
  photo: Types.PhotoSize
) {
  log.I('Downloading')

  await Db.timedTran(pool, async(db) => {
    const t = Db.t.photos
    const schema = Db.d.photos

    const existing = await Db.query(db,
      'select', [t.fileUniqueId],
      'from', t,
      'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
      'and', Db.eq(t.fileUniqueId, Db.param(photo.file_unique_id)),
    ).then(it => it.at(0))

    if(existing) {
      log.I(' Already exists')
      return
    }

    await Db.insertMany(db, t, schema, [{
      chatId,
      fileUniqueId: photo.file_unique_id,
      raw: JSON.stringify(photo),
      status: 'downloading',
      bytes: Buffer.from([]),
      downloadStartDate: T.Now.instant().toJSON(),
    }], {})

    try {
      log.I('Getting file url')

      const fileInfoUrl = new URL(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN!}/getFile`
      )
      fileInfoUrl.searchParams.set('file_id', photo.file_id)
      const fileInfoResult = await U.request<TelegramWrapper<Types.File>>({
        url: fileInfoUrl,
        log,
      })
      if(fileInfoResult.status !== 'ok') throw new Error()
      if(!fileInfoResult.data.ok) {
        log.E([fileInfoResult.data])
        throw new Error()
      }
      const fileInfo = fileInfoResult.data.result

      log.I('Getting File')

      const fileUrl = new URL(
        `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN!}/`
          + encodeURIComponent(fileInfo.file_path)
      )

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
        'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
        'and', Db.eq(t.fileUniqueId, Db.param(photo.file_unique_id)),
      )
    }
    catch(error) {
      log.I('Failed to download file ', [error])

      await Db.queryRaw(db,
        'update', t,
        'set', Db.list([
          Db.set(t.status, Db.param('error' as const)),
        ]),
        'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
        'and', Db.eq(t.fileUniqueId, Db.param(photo.file_unique_id)),
      )
    }
  })
}

export async function reply(
  conn: Db.DbTransaction,
  log: L.Log,
  messageDate: T.Instant,
  chatId: number,
  completion: { sent: boolean },
) {
  const chatInfoP = getChatFullInfo(conn, log, chatId)

  log.I('Locking ', [chatId])
  try {
    const maxWait = messageDate.add({ seconds: 20 })
    const waitFor = Math.floor(maxWait.since(T.Now.instant()).total('milliseconds'))
    if(waitFor <= 10) {
      log.E('Not sending message - timed out 1')
      return
    }

    const lockId = BigInt(chatId)

    const lock = Db.t.chatLocks
    await Db.queryRaw(conn, 'set lock_timeout = ' + waitFor)
    await Db.queryRaw(conn,
      'insert into', lock, Db.args([lock.id.nameOnly]),
      'values', Db.args([Db.param(lockId)]),
      'on conflict', Db.args([lock.id.nameOnly]), 'do nothing',
    )
    await Db.queryRaw(conn,
      'select', [lock.id],
      'from', lock,
      'where', Db.eq(lock.id, Db.param(lockId)),
      'for update',
    )
  }
  catch(error) {
    log.E('Not sending message - could not aquire chat lock: ', [error])
    // If the lock is locked by someone else all this time, the message
    // is no longer relevant, so we can exit. Future messages are running
    // the same logic, so they will respond eventually (or be irrelevant)
    // even if the lock is for an old message.
    return
  }
  log.I('Locked ', [chatId])
  // Lock aquired - no new replies will be inserted.

  const firstLatest = await Db.query(conn,
    'select', [
      Db.t.messages.messageId,
      Db.t.messages.raw,
      Db.named('hasResponse', Db.not(Db.isNull(Db.t.responses.sequenceNumber))),
    ],
    'from', Db.t.messages,

    'left join', Db.t.responses,
    'on', Db.eq(Db.t.messages.chatId, Db.t.responses.respondsToChatId),
    // Find a response that has seen this message. Not = since the following is possible:
    // 1. user sends message 1
    // 2. bot starts generating response 1
    // 3. user sends message 2
    // 4. Bot locks waiting for response 1
    // 5. User sends message 3
    // 6. Bot locks waiting for response 1
    // 7. Response 1 is generated and sent. Points at message 1
    // 8. Response 2 logic runs, the latest message it sees is its own response.
    // 9. Response 2 is generated and sent. Points at its own response
    // 10. Response 3 logic runs, the latest user message doesn't have a direct response,
    // since response 2 points at response 1. But response 2 did include messages
    // 1-3 in history, so another response should not be generated.
    'and', Db.t.messages.messageId, '<=', Db.t.responses.respondsToMessageId,

    'where', Db.eq(Db.t.messages.chatId, Db.param(BigInt(chatId))),
    'and', Db.eq(Db.t.messages.type, Db.param('user' as const)),

    'order by', Db.t.messages.messageId, 'desc',
    'limit 1',
  ).then(it => it.at(0))
  if(firstLatest === undefined) {
    log.unreachable()
    return
  }
  if(firstLatest.hasResponse) {
    log.I('Latest message ', [firstLatest.messageId], ' is already answered')
    return
  }
  log.I('Answering message ', [firstLatest.messageId])
  // Now we know that there is something to reply to.

  const cancelTypingStatus = startTypingTask(chatId, log)

  // Postpone responding for 10 seconds if some attachments are loading.
  // If newer messages arrive, we may not send their images, but we don't
  // want the bot to get stuck forever if there's an active discussion.
  const maxWaitForAttachments = fromMessageDate((firstLatest.raw).date)
    .add({ seconds: 10 })
  while(true) {
    const now = T.Now.instant()
    if(T.Instant.compare(now, maxWaitForAttachments) >= 0) {
      log.W('Time for images expired. Sending as-is')
      break
    }

    const t = Db.t.photos
    const totalLoading = await Db.query(conn,
      'select', [
        Db.named(
          'totalLoading',
          Db.func<typeof Db.dbTypes.bigint>('count', '*')
        ),
      ],
      'from', t,
      'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
      'and', t.downloadStartDate, '>', Db.param(now.subtract({ seconds: 20 }).toJSON()),
      'and', Db.eq(t.status, Db.param('downloading' as const)),
    ).then(it => it.at(0)?.totalLoading ?? 0n)

    if(totalLoading === 0n) {
      log.I('All images ready')
      break
    }

    log.I('Images being loaded: ', [totalLoading], '. Rechecking in ', [1], 's')

    let until = now.add({ seconds: 1 })
    if(T.Instant.compare(maxWaitForAttachments, until) < 0) until = maxWaitForAttachments
    await U.delay(until)
  }

  const t = Db.t.messages
  const messagesRaw = await Db.query(conn,
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
    'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
    'order by', t.messageId, 'asc', // date resolution is too low
  )
  if(messagesRaw.length === 0) {
    log.unreachable()
    return
  }

  const messages = messagesRaw.map(({ raw: msg, reactions }) => {
    return {
      msg,
      reactions: reactions as Types.MessageReactionUpdated[],
      photos: ((): Photo[] => {
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

  {
    // Insertion order is from latest to earliest.
    const fileUniqueIds = new Set<string>()
    for(let off = 0; off < Math.min(20, messages.length); off++) {
      const { photos } = messages[messages.length - 1 - off]
      for(let j = photos.length - 1; j > -1; j--) {
        fileUniqueIds.add(photos[j].file_unique_id)
      }
    }

    const t = Db.t.photos
    const arrayP = Db.param([...fileUniqueIds])
    const photoRows = await Db.query(conn,
      'select', [t.status, t.bytes, t.fileUniqueId, t.raw],
      'from', t,
      'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
      'and', t.fileUniqueId, '=', Db.func('any', arrayP),
      'and', Db.eq(t.status, Db.param('done' as const)),
      'order by', Db.func('array_position', arrayP, t.fileUniqueId),
      'limit 5',
    )
    const photoRowsById = new Map(photoRows.map(it => [it.fileUniqueId, it]))

    for(const message of messages) {
      for(const photo of message.photos) {
        const photoRow = photoRowsById.get(photo.file_unique_id)
        if(photoRow !== undefined) {
          photo.status = photoRow.status
          photo.data = photoRow.bytes
        }
      }
    }
  }

  const openrouterMessages: OpenRouterMessage[] = []

  const chatInfo = await chatInfoP
  if(chatInfo) {
    openrouterMessages.push({
      role: 'user',
      content: JSON.stringify({
        chatTitle: chatInfo.title ?? null,
        chatDescription: chatInfo.description ?? null,
        users: chatInfo.active_usernames.map(it => '@' + it),
      }),
    })
  }

  for(const { msg, photos, reactions } of messages) {
    if(msg.from?.username === 'balbes52_bot') {
      openrouterMessages.push({
        role: 'assistant',
        content: msg.text,
      })
      continue
    }
    else if(msg.new_chat_title !== undefined) {
      openrouterMessages.push({
        role: 'user',
        content: JSON.stringify({ newChatTitle: msg.new_chat_title }),
      })
      continue
    }
    else if(msg.new_chat_members !== undefined) {
      openrouterMessages.push({
        role: 'user',
        content: JSON.stringify({
          newChatMembers: msg.new_chat_members.map(it => userToString(it)),
        }),
      })
      continue
    }
    else if(msg.left_chat_member !== undefined) {
      openrouterMessages.push({
        role: 'user',
        content: JSON.stringify({
          leftChatMember: userToString(msg.left_chat_member),
        }),
      })
      continue
    }

    let text = ''
    text += JSON.stringify(messageHeaders(msg, reactions)) + '\n'
    if(msg.reply_to_message) {
      text += '> ' + JSON.stringify(messageHeaders(msg.reply_to_message, undefined))
      const replyText = messageText(msg.reply_to_message)
      text += replyText.split('\n').map(it => '> ' + it).join('\n')
      text += '\n'
    }
    text += messageText(msg) + '\n'

    return {
      role: 'user',
      content: [
        { type: 'text', text },
        ...await Promise.all(photos.map(async(photo) => {
          if(photo.status === 'done') {
            const type = await new FileTypeParser().fromBuffer(photo.data)
            if(type !== undefined) {
              const dataUrl = `data:${type.mime};base64,${photo.data.toString("base64")}`;
              return {
                type: 'image_url' as const,
                imageUrl: {
                  url: dataUrl,
                  detail: 'auto' as const,
                },
              }
            }
            else {
              log.W('Could not detect file type for', photo.file_unique_id)
            }
          }

          return {
            type: 'text' as const,
            text: '<image not available>',
          }
        })),
        ...(() => {
          const audio = msg.audio
          if(audio === undefined) return []
          return [{
            type: 'text' as const,
            text: '<audio not available>',
          }]
        })(),
        ...(() => {
          const video = msg.video
          if(video === undefined) return []
          return [{
            type: 'text' as const,
            text: '<video not available>',
          }]
        })(),
      ]
    }
  }

  let reply: string | undefined
  let reactionsToSend: { emoji: string, messageId: number }[] = []
  const openRouter = new OpenRouter({ apiKey: process.env.OPENROUTER_KEY! });
  while(true) {
    log.I('Sending conversation')

    const response = await openRouter.chat.send({
      //model: 'openai/gpt-5-mini', // слишком стерильный
      //model: 'openai/chatgpt-4o-latest', // тоже наверно
      //model: 'x-ai/grok-4.1-fast', // not super coherent
      //model: 'google/gemini-2.5-flash-lite',
      model: 'google/gemini-3-flash-preview',
      //model: 'moonshotai/kimi-k2-0905',
      //model: 'moonshotai/kimi-k2-thinking',
      //model: 'openai/gpt-oss-120b', // explodes
      provider: {
        dataCollection: 'deny',
      },
      reasoning: {
        effort: 'medium',
      },
      tools: [
        {
          type: 'function',
          function: {
            name: 'message_reaction',
            description: 'Adds an emoji reaction to a message',
            //description: 'Adds an emoji reaction to a message. Valid emojis: ' + validEmojis.join(', '),
            parameters: {
              type: 'object',
              properties: {
                emoji: { type: 'string' },
                messageId: { type: 'string' },
              },
              required: ['emoji', 'messageId'],
            }

          },
        }
      ],
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        ...openrouterMessages,
      ],
    })
    log.I('Responded')

    await Db.insertMany(
      conn,
      Db.t.responses,
      Db.omit(Db.d.responses, ['sequenceNumber']),
      [{
        respondsToChatId: chatId,
        respondsToMessageId: messages.at(-1)!.msg.message_id,
        raw: JSON.stringify(response),
      }],
      {}
    )

    const finishReason = response.choices[0].finishReason
    if(finishReason === 'tool_calls') {
      openrouterMessages.push(response.choices[0].message)

      for(const tool of response.choices[0].message.toolCalls!) {
        const args = JSON.parse(tool.function.arguments)
        log.I('Tool call ', tool.function.name, ' with ', [args])

        if(tool.function.name === 'message_reaction') {
          const { emoji, messageId: messageIdRaw } = args

          openrouterMessages.push({
            role: 'tool',
            toolCallId: tool.id,
            //name: tool.function.name,
            content: 'done',
          })

          const messageId = parseInt(messageIdRaw)
          if(isFinite(messageId)) {
            if(validEmojis.includes(emoji)) {
              reactionsToSend.push({ emoji, messageId })
            }
            else {
              reactionsToSend.push({ emoji: '❤', messageId })
            }
          }
          else {
            log.W('Malformed reaction: ', [JSON.parse(tool.function.arguments)])
          }
        }
      }
    }
    else if(finishReason === 'stop') {
      const content = response.choices[0].message.content
      if(typeof content === 'string') {
        reply = content
      }
      else {
        log.W('Weird content ', [content])
        reply = ''
      }
      break
    }
  }

  cancelTypingStatus()

  const sendingP = (async() => {
    if(reply === '<empty>' || reply === '<>' || reply === '') {
      log.I('Empty response')
      completion.sent = true
      return
    }

    log.I('Sending response')
    const responseResult = await sendMessage(chatId, reply, log)
    if(responseResult.status !== 'ok') {
      return
    }
    if(!responseResult.data.ok) {
      log.E([responseResult.data.description])
      return
    }
    const newMessage = responseResult.data.result
    completion.sent = true

    log.I('Inserting response')
    await Db.insertMany(
      conn,
      Db.t.messages,
      Db.d.messages,
      [{
        chatId: newMessage.chat.id,
        messageId: newMessage.message_id,
        date: fromMessageDate(newMessage.date).toJSON(),
        type: 'assistant',
        raw: JSON.stringify(newMessage),
      }],
      {}
    )
  })()

  const reactions = [...new Map(reactionsToSend.map(it => [it.messageId, it])).values()]

  const dbReactionsP = (async() => {
    const now = Math.floor(T.Now.instant().epochMilliseconds / 1000)
    await updateReactionRows(conn, reactions.map(it => {
      return {
        chatId,
        messageId: it.messageId,
        hash: U.getHash('bot'),
        raw: JSON.stringify({
          chat: { id: chatId },
          message_id: it.messageId,
          date: now,
          user: {
            id: -1,
            first_name: 'балбес',
            username: 'balbes52_bot',
          },
          new_reaction: [{ type: 'emoji', emoji: it.emoji }],
        } satisfies Types.MessageReactionUpdated),
      }
    }))
  })()

  const reactingP = (async() => {
    await U.all(reactions.map(async(reaction) => {
      await setMessageReaction(chatId, reaction.messageId, reaction.emoji, log)
    }))
    completion.sent = true
  })()

  await U.all([sendingP, reactingP, dbReactionsP])

  log.I('Done responding')
}

type TelegramWrapper<T> = { ok: true, result: T } | { ok: false, description: string }

const systemPrompt = `
You are a group chat participant, a typical 20-something year old. Write a reply if you think users would appreciate it or if they ask you (@balbes52_bot, Балбес, etc.). Reply <empty> (with angle brackets) if you think users are talkning between themselves and would not appreciate your interruption.

Rules:
1. Don't write essays. Nobody wants to read a lot.
2. Users don't see empty messages. If there's an error, tell them that.
3. If the users are hinting or saying that they don't want to continue the conversation, stop. Don't respond that you are stopping, just say <empty>. It's better to not respond and make users ping you than you sending too many messages.
4. If you can capture your response as a single emoji, use 'message_reaction' tool. If you think a reaction is enough, use the tool and respond with <empty>.

`.trim() + '\n'

/// ???????????
type OpenRouterMessage = OpenRouter['chat']['send'] extends (a: { messages: Array<infer Message> }) => infer U1 ? Message : never

type Photo = {
  file_unique_id: string
  status: 'done' | 'downloading' | 'error' | 'not-available'
  data: Buffer
  info: Types.PhotoSize
}

export async function sendMessage(chatId: number, text: string, log: L.Log) {
  return await U.request<TelegramWrapper<Types.Message>>({
    url: new URL(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN!}/sendMessage`),
    log: log.addedCtx('sendMessage'),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  })
}

async function sendChatAction(chatId: number, log: L.Log) {
  return await U.request<TelegramWrapper<{}>>({
    url: new URL(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN!}/sendChatAction`),
    log: log.addedCtx('sendChatAction'),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      action: 'typing',
    }),
  })
}

async function setMessageReaction(chatId: number, messageId: number, emoji: string, log: L.Log) {
  const l = log.addedCtx('setMessageReaction(', [chatId], ', ', [messageId], ', ', [emoji], ')')

  const result = await U.request<TelegramWrapper<{}>>({
    url: new URL(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN!}/setMessageReaction`),
    log: l,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reaction: [{
        type: 'emoji',
        emoji,
      }],
    }),
  })
  if(result.status !== 'ok') return false
  if(!result.data.ok) {
    l.E('Response error: ', [result.data.description])
    return false
  }
  return true
}

async function getChat(chatId: number, log: L.Log) {
  const l = log.addedCtx('getChat(', [chatId], ')')

  const result = await U.request<TelegramWrapper<Types.ChatFullInfo>>({
    url: new URL(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN!}/getChat`),
    log: log.addedCtx('sendChatAction'),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      action: 'typing',
    }),
  })
  if(result.status !== 'ok') return undefined
  if(!result.data.ok) {
    l.E('Response error: ', [result.data.description])
    return undefined
  }
  return result.data.result
}

export function fromMessageDate(messageDate: number) {
  return T.Instant.fromEpochMilliseconds(messageDate * 1000)
}

export function messageHeaders(
  msg: Types.Message,
  reactions: Types.MessageReactionUpdated[] | undefined
) {
  const headers: Record<string, unknown> = {}
  headers.messageId = msg.message_id
  if(msg.from) {
    headers.from = userToString(msg.from)
  }
  else {
    headers.from = userToString(adminUser)
  }

  headers.at = dateToString(fromMessageDate(msg.date))

  if(reactions) {
    const reactionsObj: Record<string, unknown> = {}

    for(const reaction of reactions) {
      const result: string[] = []
      for(const point of reaction.new_reaction) {
        if(point.type === 'emoji') result.push(point.emoji)
      }
      if(result.length === 0) continue

      let name: string
      if(reaction.user) {
        name = userToString(reaction.user)
      }
      else {
        name = userToString({
          id: -1,
          username: "GroupAnonymousBot",
          first_name: "Group"
        })
      }

      reactionsObj[name] = result.join('')
    }

    if(Object.keys(reactionsObj).length > 0) {
      headers.reactions = reactionsObj
    }
  }

  if(msg.edit_date !== undefined) {
    headers.editedAt = dateToString(fromMessageDate(msg.edit_date))
  }

  return headers
}

export function messageText(msg: Types.Message) {
  return (msg.text ?? msg.caption ?? '<no message>').trim()
}

function userToString(user: Types.User) {
  const fullName = user.first_name + ' ' + (user.last_name ?? '')
  return fullName.trim() + ' (@' + user.username + ')'
}

function dateToString(date: T.Instant) {
  return date.toZonedDateTimeISO('Europe/Moscow').toPlainDateTime().toString()
}

function startTypingTask(chatId: number, log: L.Log) {
  let timeoutId: NodeJS.Timeout

  async function send() {
    const result = await sendChatAction(chatId, log)
    if(result.status !== 'ok') return
    if(!result.data.ok) {
      log.I('Typing status failed: ', result.data.description)
    }
  }

  function recursiveSend() {
    timeoutId = setTimeout(() => {
      send()
      recursiveSend()
    }, 4000)
  }
  send()
  recursiveSend()

  return () => {
    clearTimeout(timeoutId)
  }
}

const validEmojis = ["❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡"]

const adminUser: Types.User = {
  id: -1,
  username: "GroupAnonymousBot",
  first_name: "Group"
}
