export type Chat = {
  id: number
}
export type User = {
  id: number
  first_name: string
  last_name?: string
  username?: string
}

export type Message = {
  message_id: number
  chat: Chat
  from?: User
  date: number
  edit_date?: number
  reply_to_message?: Message

  text?: string
  caption?: string

  photo?: PhotoSize[]
  video?: Video
  video_note?: VideoNote
  voice?: Voice
  audio?: Audio
  document?: Document
  location?: Location
  sticker?: Sticker

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

export type ChatFullInfo = {
  title?: string
  description?: string
  active_usernames?: string[]
}

export type Video = {
  duration: number // seconds
  thumbnail?: PhotoSize
  file_name?: string
}

export type VideoNote = {
  duration: number // seconds
  thumbnail?: PhotoSize
}

export type Voice = {
  duration: number // seconds
}

export type Location = {
  latitude: number
  longitude: number
}

export type Audio = {
  duration: number
  performer?: string
  title?: string
  file_name?: string
}

export type Document = {
  file_name?: string
  mime_type?: string
}

export type Sticker = {
  thumbnail?: PhotoSize
  emoji?: string
}
