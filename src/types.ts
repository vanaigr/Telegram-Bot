export type Chat = {
  id: number
}
export type User = {
  id: number
  first_name: string
  last_name?: string
  username: string
}

export type Message = {
  message_id: number
  chat: Chat
  from?: User
  text?: string
  caption?: string
  photo?: PhotoSize[]
  video?: unknown
  audio?: unknown
  reply_to_message?: Message
  edit_date?: number
  date: number


  new_chat_members?: User[]
  left_chat_member?: User
  new_chat_title?: string
}

export type PhotoSize = {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export type File = {
  file_id: string
  file_unique_id: string
  file_size: number
  file_path: string
}

export type MessageReactionUpdated = {
  chat: Chat
  message_id: number
  user?: User
  actor_chat?: Chat
  date: number
  new_reaction: ReactionType[]
}

export type ReactionType = { type: 'emoji', emoji: string }
  | { type: 'custom_emoji', custom_emoji_id: string }
  | { type: 'paid' }
