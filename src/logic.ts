import streamConsumers from 'node:stream/consumers'
import util from 'node:util'

import { waitUntil, attachDatabasePool } from '@vercel/functions'
import { OpenRouter } from '@openrouter/sdk'
import { FileTypeParser } from 'file-type';

import * as Db from './db/index.ts'
import * as T from './lib/temporal.ts'
import * as L from './lib/log.ts'
import * as U from './lib/util.ts'
import type * as Types from './types.ts'

export const botName = 'балбес'
export const botUsername = 'balbes52_bot'

export async function getChatDataFromDb(conn: Db.DbConnOrPool, chatId: number) {
  const t = Db.t.chatFullInfo
  return await Db.query(conn,
    'select', [t.updatedAt, t.raw],
    'from', t,
    'where', Db.eq(t.id, Db.param(BigInt(chatId))),
  ).then(it => it.at(0))
}

export async function getChatFullInfo(
  conn: Db.DbConnOrPool,
  baseLog: L.Log,
  chatId: number
): Promise<Types.ChatFullInfo | undefined> {
  const log = baseLog.addedCtx('chat full info')

  try {
    log.I('Getting chat info')
    const chatData = await getChatDataFromDb(conn, chatId)

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

export async function startPhotoTask(
  pool: Db.DbPool,
  baseLog: L.Log,
  chatId: number,
  photo: Types.PhotoSize | undefined
) {
  if(!photo) return

  const log = baseLog.addedCtx('photo ', [photo.file_unique_id])

  const shouldDownload = await Db.timedTran(pool, async(db) => {
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
      return false
    }

    await Db.insertMany(db, t, schema, [{
      chatId,
      fileUniqueId: photo.file_unique_id,
      raw: JSON.stringify(photo),
      status: 'downloading',
      bytes: Buffer.from([]),
      downloadStartDate: T.Now.instant().toJSON(),
    }], {})

    return true
  })

  if(shouldDownload) {
    waitUntil((async() => {
      try {
        await downloadPhoto(pool, log, chatId, photo)
      }
      catch(err) {
        log.E('While downloading: ', [err])
      }
    })())
  }
}

export async function downloadPhoto(
  pool: Db.DbPool,
  log: L.Log,
  chatId: number,
  photo: Types.PhotoSize
) {
  log.I('Downloading')

  const t = Db.t.photos

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

    await Db.queryRaw(pool,
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

    await Db.queryRaw(pool,
      'update', t,
      'set', Db.list([
        Db.set(t.status, Db.param('error' as const)),
      ]),
      'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
      'and', Db.eq(t.fileUniqueId, Db.param(photo.file_unique_id)),
    )
  }
}

export async function reply(
  pool: Db.DbPool,
  forLock: Db.DbTransaction,
  log: L.Log,
  messageDate: T.Instant,
  chatId: number,
  completion: { sent: boolean },
) {
  const chatInfoP = getChatFullInfo(pool, log, chatId)

  log.I('Locking ', [chatId])
  try {
    const maxWait = messageDate.add({ seconds: 20 })
    const waitFor = Math.floor(maxWait.since(T.Now.instant()).total('milliseconds'))
    if(waitFor <= 10) {
      log.E('Not sending message - timed out 1')
      completion.sent = true
      return
    }

    const lockId = BigInt(chatId)

    const lock = Db.t.chatLocks
    await Db.queryRaw(forLock, 'set lock_timeout = ' + waitFor)
    await Db.queryRaw(forLock,
      'insert into', lock, Db.args([lock.id.nameOnly]),
      'values', Db.args([Db.param(lockId)]),
      'on conflict', Db.args([lock.id.nameOnly]), 'do nothing',
    )
    await Db.queryRaw(forLock,
      'select', [lock.id],
      'from', lock,
      'where', Db.eq(lock.id, Db.param(lockId)),
      'for update',
    )
  }
  catch(error) {
    log.E('Not sending message - could not aquire chat lock: ', [error])
    completion.sent = true
    // If the lock is locked by someone else all this time, the message
    // is no longer relevant, so we can exit. Future messages are running
    // the same logic, so they will respond eventually (or be irrelevant)
    // even if the lock is for an old message.
    return
  }
  log.I('Locked ', [chatId])
  // Lock aquired - no new replies will be inserted.

  const firstLatest = await Db.query(pool,
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
    completion.sent = true
    return
  }
  log.I('Answering message ', [firstLatest.messageId])
  // Now we know that there is something to reply to.

  const cancelTypingStatus = startTypingTask(chatId, log)

  const openRouter = new OpenRouter({ apiKey: process.env.OPENROUTER_KEY! });

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
    const totalLoading = await Db.query(pool,
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

  const allMessages = await fetchMessages(pool, log, chatId)

  /*
  const summaries = await Db.query(pool,
    'select', [
      Db.t.chatSummary.firstMessageId,
      Db.t.chatSummary.lastMessageId,
      Db.t.chatSummary.numMessages,
      Db.t.chatSummary.raw,
    ],
    'from', Db.t.chatSummary,
    'where', Db.eq(Db.t.chatSummary.chatId, Db.param(BigInt(chatId))),
    'order by', Db.t.chatSummary.firstMessageId,
  )
  for(let i = 0; i < 10; i++) {
    log.I('Checking summary')
    const toSummarize = (() => {
      const last = summaries.at(-1)
      if(last !== undefined && last.numMessages < 50) {
        log.I('Trying to redo last one')

        const firstIndex = allMessages.findIndex(it => {
          return it.msg.message_id >= last.firstMessageId
        })

        if(firstIndex === -1) {
          log.W('Message not found')
          return
        }
        // if summarizing up to 20 messages ago is not 10 more than the current summary.
        if((allMessages.length - 20) - firstIndex < last.numMessages + 10) {
          log.I('Not enough new messages')
          return
        }

        return {
          backup: last,
          firstIndex,
          endIndex: Math.min(firstIndex + 50, allMessages.length - 20),
        }
      }
      else {
        log.I('Trying to create new one')
        const firstIndex = allMessages.findIndex(it => {
          return !last || it.msg.message_id > last.lastMessageId
        })
        if(firstIndex === -1) {
          log.W('Message not found')
          return
        }

        const endIndex = Math.min(firstIndex + 50, allMessages.length - 20)
        if(endIndex - firstIndex < 10) {
          log.I('Not enough new messages')
          return
        }

        return {
          firstIndex,
          endIndex
        }
      }
    })()
    if(toSummarize === undefined) break

    log.I('Will be generating')

    if(toSummarize.backup !== undefined) {
      log.I('Backing up previous')
      await doBackup(pool, {
        version: 1,
        type: 'summary',
        summary: toSummarize.backup,
      })
    }

    const subset = allMessages.slice(toSummarize.firstIndex, toSummarize.endIndex)

    log.I(
      'Started generating between ',
      [subset[0].msg.message_id],
      ' to ',
      [subset[subset.length - 1].msg.message_id],
    )
    const response = await openRouter.chat.send({
      model: 'mistralai/mistral-small-creative',
      messages: [
        {
          role: 'system',
          content: 'Take the conversation below and produce a terse 10-sentence summary. Output in English.\n',
        },
        {
          role: 'user',
          content: subset.map(it => {
            return {
              type: 'text',
              text: 'User: ' + userToString(it.msg.from, true) + '\n'
                + 'Text: ' + (it.msg.text ?? '<attachment>').trim() + '\n',
            }
          }),
        },
      ],
    })
    log.I('Done generating')

    const content = response.choices[0].message.content
    if(typeof content !== 'string' || content === '') {
      log.W('Weird content')
      await doBackup(pool, response)
      break
    }

    const row: (typeof summaries)[number] = {
      firstMessageId: BigInt(subset[0].msg.message_id),
      lastMessageId: BigInt(subset[subset.length - 1].msg.message_id),
      numMessages: subset.length,
      raw: response,
    }
    if(toSummarize.backup !== undefined) summaries.pop()
    summaries.push(row)

    await Db.tran(pool, async(db) => {
      const t = Db.t.chatSummary
      if(toSummarize.backup !== undefined) {
        await Db.queryRaw(db,
          'delete from', t,
          'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
          'and', Db.eq(t.firstMessageId, Db.param(toSummarize.backup.firstMessageId)),
        )
      }
      await Db.insertMany(
        db,
        t,
        Db.d.chatSummary,
        [{ ...row, raw: JSON.stringify(row.raw) }],
        { chatId: BigInt(chatId) }
      )
    })
  }
  log.I('Done summarizing')
  */

  const messages = allMessages.slice(Math.max(
    /*
    (() => {
      const lastMessageId = summaries.at(-1)?.lastMessageId
      if(lastMessageId === undefined) return 0
      return allMessages.findIndex(it => it.msg.message_id > lastMessageId)
    })(),
    */
    allMessages.length - 30,
  ))
  const respondsToMessageId = messages.at(-1)!.msg.message_id

  const openrouterMessages: OpenRouterMessage[] = await messagesToModelInput({
    /*
    // 500 messages is enough?
    summaries: summaries.slice(summaries.length - 10).map(it => {
      return (it.raw as OpenRouterResponse).choices[0].message.content as string
    }),
    */
    messages,
    chatInfo: await chatInfoP,
    log,
    caching: true,
  })
  console.log(util.inspect(openrouterMessages, { depth: Infinity, maxArrayLength: Infinity }))

  let forceSend = false
  let reply: string | undefined
  let reasoning: string = ''
  let reactionsToSend: { emoji: string, messageId: number, shortExplanation: string }[] = []
  for(let iteration = 0;; iteration++) {
    if(iteration > 3) {
      log.W('Too many steps')
      reply = ''
      break
    }

    log.I('Sending conversation')

    const response = await sendPrompt(openRouter, openrouterMessages, systemPrompt)
    log.I('Responded')

    if(!reasoning) reasoning = response.choices[0].message.reasoning ?? ''

    await Db.insertMany(
      pool,
      Db.t.responses,
      Db.omit(Db.d.responses, ['sequenceNumber']),
      [{
        respondsToChatId: chatId,
        respondsToMessageId,
        raw: JSON.stringify(response),
      }],
      {}
    )

    const finishReason = response.choices[0].finishReason
    if(finishReason === 'tool_calls') {
      openrouterMessages.push(response.choices[0].message)

      const results = await Promise.all(response.choices[0].message.toolCalls!.map(async(tool, i) => {
        const args = JSON.parse(tool.function.arguments)
        const l = log.addedCtx('tool ', [i])
        l.I('Function ', tool.function.name, ' with ', [args])

        if(tool.function.name === 'message_reaction') {
          let { emoji, messageId: messageIdRaw } = args

          const messageId = parseInt(messageIdRaw)
          if(isFinite(messageId)) {
            if(emoji === '😂') emoji = '🤣'

            if(validEmojis.includes(emoji)) {
              reactionsToSend.push({ emoji, messageId, shortExplanation: '' })
              return {
                role: 'tool' as const,
                toolCallId: tool.id,
                content: 'done',
              }
            }
            else {
              l.W('Tried to output ', [emoji], ' but it is not allowed')
              return {
                role: 'tool' as const,
                toolCallId: tool.id,
                content: 'Error: pick one of ' + validEmojis.join(', '),
              }
            }
          }
          else {
            l.W('Malformed reaction')
            // Don't bother it
            return {
              role: 'tool' as const,
              toolCallId: tool.id,
              content: 'done',
            }
          }
        }
        else if(tool.function.name === 'search') {
          try {
            l.I('Searching')

            const searchResult = await openRouter.chat.send({
              model: 'openai/gpt-5-nano',
              plugins: [
                {
                  id: "web",
                  maxResults: 3,
                  searchPrompt: '',
                },
              ],
              messages: [
                {
                  role: 'system',
                  content: 'You need to perform a search and repeat the search results as-is. Search queries are given below',
                },
                {
                  role: 'user',
                  content: tool.function.arguments,
                },
              ],
            })
            l.I('Done searching')

            await Db.insertMany(
              pool,
              Db.t.responses,
              Db.omit(Db.d.responses, ['sequenceNumber']),
              [{
                respondsToChatId: chatId,
                respondsToMessageId,
                raw: JSON.stringify(searchResult),
              }],
              {},
            )

            const content = searchResult.choices[0].message.content
            if(typeof content === 'string') {
              forceSend = true
              return {
                role: 'tool' as const,
                toolCallId: tool.id,
                content,
              }
            }
            else {
              l.I('Weird content')
              return {
                role: 'tool' as const,
                toolCallId: tool.id,
                content: 'Error: could not parse content',
              }
            }
          }
          catch(error) {
            l.E('Search failed: ', [error])
            return {
              role: 'tool' as const,
              toolCallId: tool.id,
              content: 'Error: ' + (('' + error).split('\n')[0] ?? 'unknown'),
            }
          }
        }
        else {
          l.W('Unknown tool ', [tool])
          return {
            role: 'tool' as const,
            toolCallId: tool.id,
            content: 'Error: unknown tool',
          }
        }
      }))

      for(const result of results) openrouterMessages.push(result)
    }
    else if(finishReason === 'stop' || finishReason === 'length') {
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
    else {
      log.W('Unknown finishReason: ', [finishReason])
      reply = ''
      break
    }
  }

  cancelTypingStatus()

  const sendingP = (async() => {
    // Sometimes it gets confused and outputs both a message and this.
    reply = reply.replaceAll('<NO_OUTPUT>', '').trim()

    if(reply === '' || reply === '<>' || reply.length > 4000) {
      log.I('Skipping response')
      completion.sent = true
      return
    }

    if(!forceSend) {
      // NOTE: we need at least 1 message from the bot,
      // and it's easier to wait until we have one for sure.
      // It is also more strict this way, since the bot is clearly writing
      // something, but outside observer still decides that his thoughts
      // are not his.
      const isAware = await evaluateIfAware(
        messages.slice(messages.length - 9).map(it => it.msg),
        reasoning,
        reply,
        { pool, openRouter, log, chatId, messageId: respondsToMessageId },
      )
      if(!isAware) return

      /*
      const isUseful = await evaluateIsUseful(
        messages.slice(messages.length - 9).map(it => it.msg),
        reply,
        { pool, openRouter, log, chatId, messageId: respondsToMessageId },
      )
      if(!isUseful) return
      */
    }
    else {
      log.I('Force sending')
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
      pool,
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
    await updateReactionRows(pool, reactions.map(it => {
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
            first_name: botName,
            username: botUsername,
          },
          new_reaction: [{ type: 'emoji', emoji: it.emoji }],
        } satisfies Types.MessageReactionUpdated),
        reason: it.shortExplanation ?? '',
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

export const systemPrompt = `
You are a group chat participant, a typical 20-something year old. Write a reply if you think users would appreciate it or if they ask you (@${botUsername}, ${botName}, etc.).

Rules:
- Write short messages.
- To skip responding, output <NO_OUTPUT>.
- If you can capture your response as a single emoji, use 'message_reaction' tool. If you think a reaction is enough, use 'message_reaction' tool and respond with <NO_OUTPUT> together to only do a reaction.
`.trim() + '\n'

export async function sendPrompt(
  openRouter: OpenRouter,
  messages: OpenRouterMessage[],
  systemPrompt: string,
) {
  return await openRouter.chat.send({
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
          //description: 'Adds an emoji reaction to a message. Short explanation is for you',
          //description: 'Adds an emoji reaction to a message. Valid emojis: ' + validEmojis.join(''),
          parameters: {
            type: 'object',
            properties: {
              messageId: { type: 'string' },
              emoji: { type: 'string' },
              //shortExplanation: { type: 'string' },
            },
            required: ['emoji', 'messageId'],
          }
        },
      },
      {
        type: 'function',
        function: {
          name: 'search',
          description: 'Perform Search. **Important**: Will fail without express user consent "yes, search". Request before use, warn that search is expensive',
          parameters: {
            type: "object",
            properties: {
              queries: {
                type: "array",
                items: {
                  type: "string",
                },
              },
            },
            required: ["queries"],
          },
        },
      }
    ],
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  })
}


/*
async function evaluateIsUseful(
  lastMessages: Types.Message[],
  modelReply: string,
  ctx: {
    openRouter: OpenRouter,
    pool: Db.DbPool,
    log: L.Log,
    chatId: number,
    messageId: number,
  }
): Promise<boolean> {
  const log = ctx.log.addedCtx('filter')

  log.I('Checking')

  const botMessages = 1 + lastMessages.filter(it => it.from?.username === botUsername).length
  if(botMessages / (lastMessages.length + 1) <= 0.21) {
    log.I('First message in a while. Allowing')
    return true
  }

  const toSend = lastMessages.map(it => {
    return {
      name: userToString(it.from, false),
      text: it.text ?? it.caption ?? '',
    }
  })
  toSend.push({
    name: '@' + botUsername,
    text: modelReply,
  })

  let controlResponse: Awaited<ReturnType<typeof sendControlPrompt>>
  try {
    controlResponse = await sendControlPrompt(ctx.openRouter, toSend)
  }
  catch(error) {
    log.E('During LLM control: ', [error], '. Allowing')
    return true
  }

  try {
    await Db.insertMany(
      ctx.pool,
      Db.t.postFilterResponses,
      Db.omit(Db.d.postFilterResponses, ['sequenceNumber']),
      [{
        raw: JSON.stringify(controlResponse),
        respondsToChatId: ctx.chatId,
        respondsToMessageId: ctx.messageId,
      }],
      {}
    )
  }
  catch(error) {
    log.E('During db save: ', [error])
    log.I('Could not save: ', [controlResponse])
  }

  const content = controlResponse.choices[0].message.content
  if(typeof content !== 'string') {
    log.W('Weird content. Allowing')
    return true
  }

  if(content === '') {
    // Probably ran out of tokens or could not decide.
    // Which probably means the reply is useful.
    log.I('Content is empty. Allowind')
    return true
  }

  const digit = content.match(/\d/)?.[0] || ''
  if(!digit) {
    log.W('Could not parse. Allowing')
    return true
  }

  const score = parseInt(digit)
  log.I('Score: ', [score])

  if(score < 5) {
    log.I('Allowing')
    return true
  }

  // maps 5-9 in the 4-10 range so that 0 and 1 probabilities don't happen.
  const probability = Math.pow((score - 4) / (10 - 4), 0.5)
  const rand = Math.random()
  log.I('Random chance: ', [rand], ', threshold: ', [probability])
  if(rand < probability) {
    log.I('Randomly denying')
    return false
  }
  else {
    log.I('Randomly allowing')
    return true
  }
}

export const controlPrompt = `
Determinte the score for messages from ${'`'}@${botUsername}${'`'} based on whether it responds too often or parrots previous messages.

Respond with a number from 1 to 9, where 1 indicates the frequency is good and no parroting, and 9 indicates too frequent and a lot of parroting.

**Important Rule**: If other users asked ${'`'}@${botUsername}${'`'}/${'`'}${botName}${'`'} to respond in a recent message, output a score of 1 immediately. No exceptions.

Think in english.

`.trim() + '\n'

export async function sendControlPrompt(
  openRouter: OpenRouter,
  messages: { name: string, text: string }[],
) {
  return await openRouter.chat.send({
    //model: 'allenai/olmo-3-7b-think', // did not work at all
    // model: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', // token hungry
    //model: 'google/gemini-2.5-flash-lite-preview-09-2025', // wrong, latency
    //model: 'google/gemini-2.5-flash-lite', // wrong, latency
    //model: 'nousresearch/hermes-4-70b', // wrong
    //model: 'qwen/qwen3-235b-a22b-thinking-2507', // did not work at all
    //model: 'deepseek/deepseek-chat-v3.1', // did not work at all
    model: 'deepcogito/cogito-v2-preview-llama-109b-moe', // mostly good, we'll see
    //model: 'minimax/minimax-m2.1', // good
    maxCompletionTokens: 1000,
    reasoning: {
      effort: 'medium',
    },
    provider: {
      dataCollection: 'deny',
    },
    stream: false,
    messages: [
      { role: 'system', content: controlPrompt },
      ...messages.map(message => {
        return {
          role: 'user' as const,
          content: [{
            type: 'text' as const,
            text: 'User: ' + message.name + '\nText: ' + message.text.trim() + '\n\n',
          }],
        }
      }),
    ],
  })
}
*/

// Sometimes the model thinks it is one of the users.
// This detects that and returns `false`.
async function evaluateIfAware(
  lastMessages: Types.Message[],
  modelReasoning: string,
  modelOutput: string,
  ctx: {
    openRouter: OpenRouter,
    pool: Db.DbPool,
    log: L.Log,
    chatId: number,
    messageId: number,
  }
) {
  const log = ctx.log.addedCtx('nonsense filter')
  log.I('Checking')

  if(!modelReasoning) {
    log.I('No reasoning. Allowing')
    return true
  }

  const toSend = lastMessages.map(it => {
    return {
      name: userToString(it.from, false),
      text: it.text ?? it.caption ?? '',
    }
  })
  toSend.push({
    name: '@' + botUsername,
    text: modelOutput,
  })

  let controlResponse: Awaited<ReturnType<typeof sendNonsenseCheckPrompt>>
  try {
    controlResponse = await sendNonsenseCheckPrompt(ctx.openRouter, toSend, modelReasoning)
  }
  catch(error) {
    log.E('During LLM control: ', [error], '. Allowing')
    return true
  }

  try {
    await Db.insertMany(
      ctx.pool,
      Db.t.responses,
      Db.omit(Db.d.responses, ['sequenceNumber']),
      [{
        raw: JSON.stringify(controlResponse),
        respondsToChatId: ctx.chatId,
        respondsToMessageId: ctx.messageId,
      }],
      {}
    )
  }
  catch(error) {
    log.E('During db save: ', [error])
    log.I('Could not save: ', [controlResponse])
  }

  let content = controlResponse.choices[0].message.content
  if(typeof content !== 'string') {
    log.W('Weird content. Allowing')
    return true
  }

  if(content === '') {
    // Probably ran out of tokens or could not decide.
    // Which probably means the reply is useful.
    log.I('Content is empty. Allowind')
    return true
  }

  content = content.toLowerCase()

  // Don't include bot username as part of your name :)
  if(
    content.includes(botUsername.toLowerCase())
      || content.includes(botName.toLowerCase())
  ) {
    log.I('Contains username. Allowing')
    return true
  }

  log.W('Model got confused. Denying')

  return false
}

export async function sendNonsenseCheckPrompt(
  openRouter: OpenRouter,
  messages: { name: string, text: string }[], // includes model output
  modelReasoning: string,
) {
  const prompt = `
Below is an excerpt from a conversation between a group of users, along with a sample of reasoning provided by one of them. Identify which user the reasoning belongs to.

**Important**: If reasoning includes user name, it cannot belong to that user.

Output Structure: {"user":"<identifier of the user the reasoning belongs to>"}

`.trim() + '\n'

  return await openRouter.chat.send({
    model: 'deepcogito/cogito-v2-preview-llama-109b-moe', // mostly good, we'll see
    maxCompletionTokens: 1000,
    reasoning: {
      effort: 'medium',
    },
    provider: {
      dataCollection: 'deny',
    },
    stream: false,
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

/// ???????????
export type OpenRouterMessage = OpenRouter['chat']['send'] extends (a: { messages: Array<infer Message> }) => infer U1 ? Message : never
// 🤡🤡🤡🤡🤡🤡🤡🤡🤡🤡
export type OpenRouterResponse = OpenRouter['chat']['send'] extends {
  (a: { messages: any, stream: false }): infer R
  (a: { messages: any, stream: true }): infer U1
  (a: { messages: any, stream: boolean }): infer U2
} ? Awaited<R> : never

type Photo = {
  file_unique_id: string
  status: 'done' | 'downloading' | 'error' | 'not-available'
  data: Buffer
  info: Types.PhotoSize
}
type Video = {
  info: Types.Video
  thumbnail: Photo | undefined
}
type VideoNote = {
  info: Types.VideoNote
  thumbnail: Photo | undefined
}
type Reaction = {
  info: Types.MessageReactionUpdated
  reason: string
}

type MessageWithAttachments = {
  msg: Types.Message
  reactions: Reaction[]
  photos: Photo[]
  video: Video | undefined
  videoNote: VideoNote | undefined
}

export async function fetchMessages(
  conn: Db.DbConnOrPool,
  log: L.Log,
  chatId: number,
  ctx?: { lastMessage?: number, skipImages?: boolean }
): Promise<MessageWithAttachments[]> {
  const t = Db.t.messages
  const messagesRaw = await Db.query(conn,
    'select', [
      t.raw,
      Db.named(
        'reactions',
        Db.scalar<typeof Db.dbTypes.jsonArray>(Db.par(
          'select', Db.func('array_agg', [
            Db.func('jsonb_build_object',
              '\'raw\'', Db.t.reactions.raw,
              '\'reason\'', Db.t.reactions.reason,
            ), 'order by', Db.t.reactions.hash,
          ]),
          'from', Db.t.reactions,
          'where', Db.eq(Db.t.reactions.chatId, t.chatId),
          'and', Db.eq(Db.t.reactions.messageId, t.messageId),
        )),
      ),
    ],
    'from', t,
    'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
    ...(ctx?.lastMessage !== undefined ? ['and', t.messageId, '<=', Db.param(ctx.lastMessage)] : []),
    'order by', t.messageId, 'asc', // date resolution is too low
  )
  if(messagesRaw.length === 0) {
    log.unreachable()
    return []
  }

  const messages = messagesRaw.map(({ raw: msg, reactions }) => {
    return {
      msg,
      reactions: (reactions ?? []).map((it: any) => {
        return {
          info: it.raw as Types.MessageReactionUpdated,
          reason: it.reason as string,
        }
      }),
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
      })(),
      video: ((): Video | undefined => {
        const video = msg.video
        if(!video) return undefined

        return {
          info: video,
          thumbnail: (() => {
            const photo = video.thumbnail
            if(!photo) return undefined
            return {
              file_unique_id: photo.file_unique_id,
              status: 'not-available',
              data: Buffer.from([]),
              info: photo,
            }
          })(),
        }
      })(),
      videoNote: ((): VideoNote | undefined => {
        const videoNote = msg.video_note
        if(!videoNote) return undefined

        return {
          info: videoNote,
          thumbnail: (() => {
            const photo = videoNote.thumbnail
            if(!photo) return undefined
            return {
              file_unique_id: photo.file_unique_id,
              status: 'not-available',
              data: Buffer.from([]),
              info: photo,
            }
          })(),
        }
      })(),
    }
  })

  if(ctx?.skipImages !== true) {
    // Insertion order is from latest to earliest.
    const fileUniqueIds = new Set<string>()
    for(let off = 0; off < Math.min(20, messages.length); off++) {
      const { photos, video, videoNote } = messages[messages.length - 1 - off]
      for(let j = photos.length - 1; j > -1; j--) {
        fileUniqueIds.add(photos[j].file_unique_id)
      }
      if(video?.thumbnail) fileUniqueIds.add(video.thumbnail.file_unique_id)
      if(videoNote?.thumbnail) fileUniqueIds.add(videoNote.thumbnail.file_unique_id)
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
      if(message.video?.thumbnail) {
        const photo = message.video.thumbnail
        const photoRow = photoRowsById.get(photo.file_unique_id)
        if(photoRow !== undefined) {
          photo.status = photoRow.status
          photo.data = photoRow.bytes
        }
      }
      if(message.videoNote?.thumbnail) {
        const photo = message.videoNote.thumbnail
        if(!photo) continue
        const photoRow = photoRowsById.get(photo.file_unique_id)
        if(photoRow !== undefined) {
          photo.status = photoRow.status
          photo.data = photoRow.bytes
        }
      }
    }
  }

  return messages
}

type LlmMessage = {
  role: 'user'
  content: Array<
    { type: 'text', text: string, cacheControl?: { type: 'ephemeral' } }
      | { type: 'image_url', imageUrl: { url: string } }
  >
} | {
  role: 'assistant'
  content: Array<
    { type: 'text', text: string, cacheControl?: { type: 'ephemeral' } }
  >
} | {
  role: 'system'
  content: Array<
    { type: 'text', text: string, cacheControl?: { type: 'ephemeral' } }
  >
}

export async function messagesToModelInput(
  {
    //summaries,
    messages, log, chatInfo, caching,
  }: {
    //summaries: string[],
    messages: MessageWithAttachments[],
    chatInfo: Types.ChatFullInfo | undefined,
    log: L.Log
    caching: boolean
  }
): Promise<LlmMessage[]> {
  const openrouterMessages: LlmMessage[] = []
  const photoQuota = { remainingCount: 5, remainingSize: 5_000_000 }

  if(chatInfo) {
    openrouterMessages.push({
      role: 'user',
      content: [{
        type: 'text',
        text: JSON.stringify({
          chatTitle: chatInfo.title ?? null,
          chatDescription: chatInfo.description ?? null,
          users: chatInfo.active_usernames?.map(it => '@' + it),
        }),
      }],
    })
  }

  /*
  for(const summary of summaries) {
    openrouterMessages.push({
      role: 'system',
      content: [{type: 'text', text: summary.trim() + '\n'}],
    })
  }
*/

  for(const { msg, photos, video, videoNote, reactions } of messages) {
    if(msg.new_chat_title !== undefined) {
      openrouterMessages.push({
        role: 'user',
        content: [{
          type: 'text',
          text: JSON.stringify({ newChatTitle: msg.new_chat_title }),
        }],
      })
      continue
    }
    else if(msg.new_chat_members !== undefined) {
      openrouterMessages.push({
        role: 'user',
        content: [{
          type: 'text',
          text: JSON.stringify({
            newChatMembers: msg.new_chat_members.map(it => userToString(it, true)),
          }),
        }],
      })
      continue
    }
    else if(msg.left_chat_member !== undefined) {
      openrouterMessages.push({
        role: 'user',
        content: [{
          type: 'text',
          text: JSON.stringify({
            leftChatMember: userToString(msg.left_chat_member, true),
          }),
        }],
      })
      continue
    }

    openrouterMessages.push({
      role: 'system',
      content: [{
        type: 'text',
        text: '\n---\n' + messageHeaders(msg, reactions),
      }],
    })

    if(msg.from?.username === botUsername) {
      openrouterMessages.push({
        role: 'assistant',
        content: [{ type: 'text', text: msg.text ?? '<ERROR: NO TEXT>' }],
      })
      continue
    }

    let text = ''
    if(msg.reply_to_message) {
      const replyText = messageHeaders(msg.reply_to_message, undefined)
        + messageText(msg.reply_to_message)

      text += replyText.split('\n').map(it => '> ' + it).join('\n')
      text += '\n'
    }
    text += messageText(msg).trim()

    const content: Extract<LlmMessage, { role: 'user' }>['content'] = []
    content.push({ type: 'text', text })

    for(const photo of photos) {
      content.push(await photoToMessagePart(log, photo, '<image not available>', photoQuota))
    }
    if(video) {
      content.push({
        type: 'text',
        text: '<Video '
          + (video.info.file_name ?? 'no name')
          + ', '
          + video.info.duration
          + 'sec not available>\nThumbnail: '
      })
      if(video.thumbnail) {
        content.push(await photoToMessagePart(
          log,
          video.thumbnail,
          '<thumbnail not available>',
          photoQuota
        ))
      }
    }
    if(videoNote) {
      content.push({
        type: 'text',
        text: `<Circular video, ${videoNote.info.duration}sec>\nThumbnail: `
      })
      if(videoNote.thumbnail) {
        content.push(await photoToMessagePart(
          log,
          videoNote.thumbnail,
          '<thumbnail not available>',
          photoQuota
        ))
      }
    }
    if(msg.voice) {
      content.push({
        type: 'text' as const,
        text: `<voice, ${msg.voice.duration}sec not available>`,
      })
    }
    if(msg.audio) {
      content.push({
        type: 'text' as const,
        text: '<audio, '
          + (msg.audio.title ?? msg.audio.file_name ?? 'unknown')
          + ' by '
          + (msg.audio.performer ?? 'unknown')
          + ', '
          + msg.audio.duration
          + 'sec not available>',
      })
    }
    if(msg.document) {
      content.push({
        type: 'text' as const,
        text: '<document '
          + (msg.document.mime_type ?? 'application/octet-stream')
          + ' '
          + (msg.document.file_name ?? 'no name')
          + ' not available>',
      })
    }
    if(msg.location) {
      content.push({
        type: 'text' as const,
        text: `<location lat: ${msg.location.latitude}, lon: ${msg.location.longitude}>`,
      })
    }
    if(msg.sticker) {
      content.push({
        type: 'text' as const,
        text: `<sticker ${msg.sticker.emoji ?? 'not available'}>`,
      })
    }

    openrouterMessages.push({ role: 'user', content })
  }

  // Crashes openrouter
  ;(() => {
    if(!caching) return

    for(let j = openrouterMessages.length - 1; j > -1; j--) {
      const message = openrouterMessages[j]
      if(typeof message.content === 'string') {
        message.content = [{
          type: 'text',
          text: message.content,
          cacheControl: { type: 'ephemeral' },
        }]
        log.I('Inserted cache')
        return
      }
      else if(Array.isArray(message.content)) {
        for(let k = message.content.length - 1; k > -1; k--) {
          const piece = message.content[k]
          if(piece.type === 'text') {
            piece.cacheControl = { type: 'ephemeral' }
            log.I('Inserted cache')
            return
          }
        }
      }
    }

    log.I('No cache')
  })()

  return openrouterMessages
}

async function photoToMessagePart(
  log: L.Log,
  photo: Photo,
  fallback: string,
  quota: { remainingCount: number, remainingSize: number }
) {
  if(photo.status === 'done' && quota.remainingCount > 0 && quota.remainingSize >= photo.data.length) {
    const type = await new FileTypeParser().fromBuffer(photo.data)
    if(type !== undefined) {
      quota.remainingCount--
      quota.remainingSize -= photo.data.length
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
    text: fallback,
  }

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
  reactions: Reaction[] | undefined
) {
  let headers = ''
  if(msg.from) {
    headers += '# ' + userToString(msg.from, true) + '\n'
  }
  else {
    // Never seen this field missing.
    headers += '# ' + userToString(undefined, true) + '\n'
  }
  headers += '- messageId: ' + msg.message_id + '\n'
  headers += '- At: ' + dateToString(fromMessageDate(msg.date)) + '\n'
  /*
  if(msg.edit_date !== undefined) {
    headers += '- Edited At: ' + dateToString(fromMessageDate(msg.edit_date))
  }
  */

  if(reactions) {
    const reactionsObj: string[] = []

    for(const reaction of reactions) {
      const emojis: string[] = []
      for(const point of reaction.info.new_reaction) {
        if(point.type === 'emoji') emojis.push(point.emoji)
      }
      if(emojis.length === 0) continue

      let name: string
      if(reaction.info.user) {
        name = userToString(reaction.info.user, false)
      }
      else {
        // reaction.actor_chat is not null, but that is the same as admin
        name = userToString(undefined, false)
      }

      let result = emojis.join('')
      if(reaction.reason) result += ' - ' + reaction.reason
      reactionsObj.push('    - ' + name + ': ' + result)
    }

    if(Object.keys(reactionsObj).length > 0) {
      headers += '- Reactions:\n'
      headers += reactionsObj.join('\n') + '\n'
    }
  }

  headers += '- Text:\n'

  return headers
}

export function messageText(msg: Types.Message) {
  return (msg.text ?? msg.caption ?? '<no message>').trim()
}

export function userToString(user: Types.User | undefined, full: boolean) {
  if(
    user === undefined
      || user.username === undefined // telegram channel repost
      || user.username === 'GroupAnonymousBot' // channel admin
  ) {
    return 'God User'
  }
  if(full) {
    const fullName = user.first_name + ' ' + (user.last_name ?? '')
    return fullName.trim() + ' (@' + user.username + ')'
  }
  else {
    return '@' + user.username
  }
}

function dateToString(date: T.Instant) {
  const dt = date.toZonedDateTimeISO('Europe/Moscow').toPlainDateTime()
  return dt.toLocaleString(undefined, { weekday: 'short' })
    + ' '
    + dt.toString().replace('T', ' ')
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

async function doBackup(pool: Db.DbConnOrPool, data: unknown) {
  await Db.insertMany(
    pool,
    Db.t.backup,
    Db.omit(Db.d.backup, ['sequenceNumber', 'date']),
    [{
      raw: JSON.stringify(data, (_, v) => typeof v === 'bigint' ? v.toString() : v),
    }],
    {}
  )
}

const validEmojis = ["❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡"]
