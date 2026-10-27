import 'dotenv/config'

const [chatId, messageId] = process.argv.slice(2)
if (!chatId || !messageId) {
  console.error('Usage: node scripts/deleteMessage.ts <chat id> <message id>')
  process.exit(1)
}

const url = new URL(`https://api.telegram.org/bot${encodeURIComponent(process.env.TELEGRAM_BOT_TOKEN!)}/deleteMessage`)
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    chat_id: chatId,
    message_id: Number(messageId),
  }),
})
const result = await response.json()

console.log(result)
if (!result.ok) process.exit(1)
