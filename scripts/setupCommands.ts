import 'dotenv/config'

const url = new URL(`https://api.telegram.org/bot${encodeURIComponent(process.env.TELEGRAM_BOT_TOKEN!)}/setMyCommands`)
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    commands: [
      {
        command: 'start',
        description: 'Включает автоматические сообщения.',
      },
      {
        command: 'stop',
        description: 'Выключает автоматические сообщения.',
      },
      {
        command: 'whisper',
        description: 'Прячет сообщение от бота.',
      },
      {
        command: 'amnesia',
        description: 'Прячет все предыдущие сообщения от бота (заметки остаются).',
      },
      {
        command: 'notes',
        description: 'Показывает заметки.',
      },
      {
        command: 'hi',
        description: '`/hi mark n?` генерирует сообщение цепью Макрова на основе предыдущих сообщений бота. `n` - (опциональный) длина сообщения в +-символах.',
      },
    ] satisfies BotCommand[],
  }),
})
const result = await response.json()

type BotCommand = {
  command: string
  description: string
}

console.log(result)
