
export type Message = {
  message_id: number
  chat: {
    id: number
  }
  from?: {
    first_name: string
    last_name?: string
    username: string
  }
  text?: string
  caption?: string
  photo?: PhotoSize[]
  reply_to_message?: Message
  date: number
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
