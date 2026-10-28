import { OpenRouter } from '@openrouter/sdk'

import * as Db from './db/index.ts'
import * as L from './lib/log.ts'
import * as T from './lib/temporal.ts'
import * as Logic from './logic.ts'
import type * as Types from './types.ts'

export const memoryModel = 'anthropic/claude-haiku-5.5'

const maxChunkMessages = 200
// Images are dropped if they don't fit, but at least this many messages are summarized.
const minChunkMessages = 20
const imageQuota = { count: 30, size: 10_000_000 }

export async function getLatestMemory(conn: Db.DbConnOrPool, chatId: number) {
  const t = Db.t.chatUserMemory
  return await Db.query(conn,
    'select', [t.lastMessageId, t.users, t.summary],
    'from', t,
    'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
    'order by', t.lastMessageId, 'desc',
    'limit 1',
  ).then(it => it.at(0))
}

// Generates new memory rows until the latest one reaches the bot's context window.
export async function updateMemory(
  pool: Db.DbPool,
  baseLog: L.Log,
  chatId: number,
): Promise<'locked' | 'done' | 'error'> {
  const log = baseLog.addedCtx('memory')

  const lockId = BigInt(chatId)
  const lock = Db.t.chatMemoryLocks
  // Outside of the lock transaction, or the first run in a chat would block others on the insert.
  await Db.queryRaw(pool,
    'insert into', lock, Db.args([lock.id.nameOnly]),
    'values', Db.args([Db.param(lockId)]),
    'on conflict', Db.args([lock.id.nameOnly]), 'do nothing',
  )

  return await Db.tran(pool, async(forLock): Promise<'locked' | 'done' | 'error'> => {
    log.I('Locking ', [chatId])
    try {
      await Db.queryRaw(forLock,
        'select', [lock.id],
        'from', lock,
        'where', Db.eq(lock.id, Db.param(lockId)),
        'for update nowait',
      )
    }
    catch(error) {
      if((error as { code?: string }).code !== '55P03') throw error
      // Whoever holds the lock loops until memory is up to date.
      log.I('Already running')
      return 'locked'
    }
    log.I('Locked ', [chatId])

    const openRouter = new OpenRouter({ apiKey: process.env.OPENROUTER_KEY! })

    let result: 'done' | 'error' = 'done'
    for(let iteration = 0;; iteration++) {
      const [latest, windowStart] = await Promise.all([
        getLatestMemory(pool, chatId),
        Logic.getContextStartMessageId(pool, chatId),
      ])
      if(windowStart === undefined) {
        log.I('Whole chat is in the context window')
        break
      }
      if(latest !== undefined && latest.lastMessageId >= windowStart) {
        log.I('Memory is up to date')
        break
      }

      const l = log.addedCtx('iteration ', [iteration])
      try {
        const ok = await generateMemory(pool, openRouter, l, chatId, latest)
        if(!ok) {
          result = 'error'
          break
        }
      }
      catch(error) {
        l.E([error])
        result = 'error'
        break
      }
    }

    // Only for the latest row, since that's the only one the bot sees.
    try {
      await generateSummary(pool, openRouter, log.addedCtx('summary'), chatId)
    }
    catch(error) {
      log.E('While generating summary: ', [error])
      result = 'error'
    }

    return result
  })
}

async function generateMemory(
  pool: Db.DbPool,
  openRouter: OpenRouter,
  log: L.Log,
  chatId: number,
  latest: Awaited<ReturnType<typeof getLatestMemory>>,
) {
  const messages = await fetchChunk(pool, log, chatId, latest?.lastMessageId)
  if(messages.length === 0) {
    log.unreachable()
    return false
  }
  const lastMessage = messages.at(-1)!.msg
  log.I('Summarizing ', [messages.length], ' messages from ', [messages[0].msg.message_id], ' to ', [lastMessage.message_id])

  const users: Types.ChatMemoryUsers = { ...latest?.users }
  for(const { msg } of messages) {
    if(msg.from === undefined || msg.from.username === Logic.botUsername) continue
    const id = String(msg.from.id)
    users[id] = {
      username: msg.from.username,
      firstName: msg.from.first_name,
      description: users[id]?.description ?? '',
    }
  }
  const usersList = Object.entries(users).map(([userId, it]) => ({ userId, ...it }))

  const memory = Db.t.chatUserMemory
  const rowWhere = [
    'where', Db.eq(memory.chatId, Db.param(BigInt(chatId))),
    'and', Db.eq(memory.lastMessageId, Db.param(BigInt(lastMessage.message_id))),
  ]

  // Copy of the previous row, so that the chunk is skipped if generation fails.
  await Db.insertMany(
    pool,
    memory,
    Db.omit(Db.d.chatUserMemory, ['createdAt']),
    [{
      chatId,
      lastMessageId: lastMessage.message_id,
      users: JSON.stringify(latest?.users ?? {}),
      summary: latest?.summary ?? '',
      raw: JSON.stringify({ isPreVersion: true }),
    }],
    {},
  )
  log.I('Inserted pre-version up to ', [lastMessage.message_id])

  const transcript: Logic.ChatContentItems[] = []
  for(const message of messages) {
    const sender = message.msg.from === undefined
      ? 'unknown'
      : Logic.isMessageFromBot(message) ? 'bot' : 'userId ' + message.msg.from.id
    transcript.push({ type: 'text', text: `\n--- message from ${sender} ---\n` })

    const output: Logic.OpenRouterMessage[] = []
    await Logic.messageToModelInput(message, false, false, output, log)
    for(const it of output) {
      if(typeof it.content === 'string') transcript.push({ type: 'text', text: it.content })
      else if(Array.isArray(it.content)) transcript.push(...it.content as Logic.ChatContentItems[])
    }
  }

  log.I('Generating descriptions')
  const descriptionsResponse = await openRouter.chat.send({
    chatRequest: {
      model: memoryModel,
      maxCompletionTokens: 16000,
      provider: { dataCollection: 'deny' },
      stream: false,
      responseFormat: {
        type: 'json_schema',
        jsonSchema: {
          name: 'descriptions',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              users: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    userId: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['userId', 'description'],
                  additionalProperties: false,
                },
              },
            },
            required: ['users'],
            additionalProperties: false,
          },
        },
      },
      messages: [
        { role: 'system', content: descriptionsPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Chat members:\n' + JSON.stringify(usersList, undefined, 2) + '\n\nMessages:\n' },
            ...transcript,
          ],
        },
      ],
    },
  })
  log.I('Received descriptions: ', [descriptionsResponse, 'details'])
  await Logic.insertGeneration(pool, {
    type: 'memoryDescriptions',
    chatId,
    firstMessageId: messages[0].msg.message_id,
    lastMessageId: lastMessage.message_id,
    response: descriptionsResponse,
  })

  let newDescriptions: { userId: string, description: string }[] = []
  if(descriptionsResponse.choices[0].finishReason === 'content_filter') {
    log.W('Content filtered. Keeping previous descriptions')
  }
  else {
    const descriptionsContent = descriptionsResponse.choices[0].message.content
    if(typeof descriptionsContent !== 'string') {
      log.W('Weird content')
      return false
    }
    try {
      newDescriptions = JSON.parse(descriptionsContent).users
      if(!Array.isArray(newDescriptions)) throw new Error('users is not an array')
    }
    catch(error) {
      log.W('Could not parse descriptions: ', [error])
      return false
    }
  }

  for(const { userId, description } of newDescriptions) {
    const user = users[userId]
    if(user === undefined) {
      log.W('Unknown user ', [userId])
      continue
    }
    if(typeof description === 'string' && description.trim() !== '') {
      user.description = description.trim()
    }
  }
  for(const [userId, user] of Object.entries(users)) {
    if(user.description === '') delete users[userId]
  }

  await Db.queryRaw(pool,
    'update', memory, 'set', Db.list([
      Db.setJson(memory.users, users),
      // The summary stays copied from the previous row until generateSummary() runs.
      Db.setJson(memory.raw, { descriptions: descriptionsResponse, isPreVersion: false, needsSummary: true }),
    ]),
    ...rowWhere,
  )
  log.I('Updated memory up to ', [lastMessage.message_id])

  return true
}

async function generateSummary(
  pool: Db.DbPool,
  openRouter: OpenRouter,
  log: L.Log,
  chatId: number,
) {
  const memory = Db.t.chatUserMemory
  const latest = await Db.query(pool,
    'select', [memory.lastMessageId, memory.users, memory.raw],
    'from', memory,
    'where', Db.eq(memory.chatId, Db.param(BigInt(chatId))),
    'order by', memory.lastMessageId, 'desc',
    'limit 1',
  ).then(it => it.at(0))
  const raw = latest?.raw as { needsSummary?: boolean } | undefined
  if(latest === undefined || !raw?.needsSummary) {
    log.I('Summary is up to date')
    return
  }

  const messages = Db.t.messages
  const lastMessageDate = await Db.query(pool,
    'select', [messages.date],
    'from', messages,
    'where', Db.eq(messages.chatId, Db.param(BigInt(chatId))),
    'and', Db.eq(messages.messageId, Db.param(latest.lastMessageId)),
  ).then(it => it.at(0)?.date)
  const now = lastMessageDate !== undefined ? T.Instant.from(lastMessageDate) : T.Now.instant()

  const rowWhere = [
    'where', Db.eq(memory.chatId, Db.param(BigInt(chatId))),
    'and', Db.eq(memory.lastMessageId, Db.param(latest.lastMessageId)),
  ]

  // Not retried if generation fails. The row keeps the previous summary.
  await Db.queryRaw(pool,
    'update', memory, 'set', Db.list([
      Db.setJson(memory.raw, { ...raw, needsSummary: false }),
    ]),
    ...rowWhere,
  )

  log.I('Generating summary for ', [latest.lastMessageId])
  const summaryResponse = await openRouter.chat.send({
    chatRequest: {
      model: memoryModel,
      maxCompletionTokens: 4000,
      provider: { dataCollection: 'deny' },
      stream: false,
      messages: [
        { role: 'system', content: summaryPrompt },
        {
          role: 'user',
          content: 'Chat members:\n'
            + JSON.stringify(Object.entries(latest.users).map(([userId, it]) => ({ userId, ...it })), undefined, 2),
        },
      ],
    },
  })
  log.I('Received summary: ', [summaryResponse, 'details'])
  await Logic.insertGeneration(pool, {
    type: 'memorySummary',
    chatId,
    lastMessageId: latest.lastMessageId.toString(),
    response: summaryResponse,
  })

  if(summaryResponse.choices[0].finishReason === 'content_filter') {
    log.W('Content filtered. Keeping previous summary')
    return
  }

  const summary = summaryResponse.choices[0].message.content
  if(typeof summary !== 'string' || summary.trim() === '') {
    log.W('Weird summary content')
    return
  }

  await Db.queryRaw(pool,
    'update', memory, 'set', Db.list([
      Db.set(memory.summary, Db.param(summary.trim())),
      Db.setJson(memory.raw, { ...raw, needsSummary: false, summary: summaryResponse }),
    ]),
    ...rowWhere,
  )
  log.I('Updated summary for ', [latest.lastMessageId])
}

// Messages after `afterMessageId` with photo and video thumbnails loaded.
async function fetchChunk(
  pool: Db.DbPool,
  log: L.Log,
  chatId: number,
  afterMessageId: bigint | undefined,
) {
  const t = Db.t.messages
  const rows = await Db.query(pool,
    'select', [t.raw, Db.named('from', t.type)],
    'from', t,
    'where', Db.eq(t.chatId, Db.param(BigInt(chatId))),
    ...(afterMessageId !== undefined ? ['and', t.messageId, '>', Db.param(afterMessageId)] : []),
    'order by', t.messageId,
    'limit ' + maxChunkMessages,
  )

  const messages = rows.map(({ raw, from }): Logic.RootMessageWithAttachments => ({
    ...Logic.dbMessageToMessageWithAttachments(raw, true),
    type: 'root',
    from,
    generation: [],
    reactions: [],
  }))

  const messagePhotos = (message: Logic.RootMessageWithAttachments) => {
    const result: Logic.Photo[] = [...message.photos]
    if(message.video?.thumbnail) result.push(message.video.thumbnail)
    if(message.videoNote?.thumbnail) result.push(message.videoNote.thumbnail)
    return result
  }

  const files = Db.t.files
  const fileRows = await Db.query(pool,
    'select', [
      files.fileUniqueId,
      Db.named('byteLength', Db.func<typeof Db.dbTypes.integer>('octet_length', files.bytes)),
    ],
    'from', files,
    'where', Db.eq(files.chatId, Db.param(BigInt(chatId))),
    'and', Db.inArr(files.fileUniqueId, messages.flatMap(it => messagePhotos(it).map(it => it.file_unique_id))),
    'and', Db.eq(files.status, Db.param('done' as const)),
  )
  const byteLengthById = new Map(fileRows.map(it => [it.fileUniqueId, it.byteLength]))

  const selected: Logic.RootMessageWithAttachments[] = []
  const photosToLoad: Logic.Photo[] = []
  const remaining = { ...imageQuota }
  for(const message of messages) {
    const photos = messagePhotos(message).filter(it => byteLengthById.has(it.file_unique_id))
    const size = photos.reduce((sum, it) => sum + byteLengthById.get(it.file_unique_id)!, 0)

    if(photos.length <= remaining.count && size <= remaining.size) {
      remaining.count -= photos.length
      remaining.size -= size
      photosToLoad.push(...photos)
    }
    else if(selected.length >= minChunkMessages) {
      break
    }
    selected.push(message)
  }
  log.I('Selected ', [selected.length], ' messages, ', [photosToLoad.length], ' images')

  if(photosToLoad.length > 0) {
    const bytesRows = await Db.query(pool,
      'select', [files.fileUniqueId, files.bytes],
      'from', files,
      'where', Db.eq(files.chatId, Db.param(BigInt(chatId))),
      'and', Db.inArr(files.fileUniqueId, photosToLoad.map(it => it.file_unique_id)),
      'and', Db.eq(files.status, Db.param('done' as const)),
    )
    const dataUrlById = new Map<string, string>()
    for(const row of bytesRows) {
      const dataUrl = await Logic.bytesToDataUrl(log, row.bytes)
      if(dataUrl !== undefined) dataUrlById.set(row.fileUniqueId, dataUrl)
    }
    for(const photo of photosToLoad) {
      const dataUrl = dataUrlById.get(photo.file_unique_id)
      if(dataUrl !== undefined) {
        photo.status = 'done'
        photo.dataUrl = dataUrl
      }
    }
  }

  return selected
}

const botIds = `${Logic.botName}, @${Logic.botUsername}`

const descriptionsPrompt = `
You maintain long-term memory about the members of a Telegram group chat.

You are given:
1. The chat members with their current descriptions.
2. The next batch of chat messages. Each message starts with a "--- message from ... ---" header with the sender's user id, followed by the message content and then its metadata (sender, message id, time). Replies and forwards are prefixed with "> ".

Update the description of the members using the new messages. A description tracks the member across the entire chat history:
- Facts: name, age, location, job/study, family, relationships, pets, hobbies, possessions, health, etc.
- Personality: interests, opinions, sense of humor, how they talk, how they treat others.
- Relationships with other chat members.
- *Important* plans, intentions and ongoing situations, with dates. When the outcome of a plan becomes known, keep the plan and record the result (e.g. "planned driving exam on 2026-03-02 — failed, retaking in April").
- Notable events that happened to them, with dates.

Rules:
- Do not record everyday stuff and anything that would not be important long-term.
- Keep important stuff from the previous description. Integrate new information instead of appending duplicates. Mark information that is no longer true as past instead of deleting it (e.g. "worked at X until 2026-05").
- Prune random information that is no longer relevant (like who ate what a month ago).
- Use absolute dates based on message timestamps, never "yesterday" or "recently".
- Only record what the messages support.
- Messages from the bot (${botIds}) are context only. Do not create a description for the bot, and do not record what the bot says as facts about members. The bot's replies should not be summarized.
- If the new messages add nothing about a member, don't update their description.
- Write in English, in terse note style.

Return a description for every listed member, identified by userId.

`.trim() + '\n'

const summaryPrompt = `
You are given long-term descriptions of the members of a Telegram group chat. Write a terse summary (one paragraph) of relevant info about active chat members.

- Prioritize ongoing and upcoming plans, key personality traits and interests.
- Skip resolved or stale things unless they define the person.
- Keep dates and times for plans and events.
- Telegraphic style, no filler.

Add a couple of potential topics the bot can discuss (e.g. questions to ask).

Write in English. Output only the summary.
`.trim() + '\n'
