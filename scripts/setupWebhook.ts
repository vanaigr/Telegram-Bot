import 'dotenv/config'

const url = new URL(`https://api.telegram.org/bot${encodeURIComponent(process.env.TELEGRAM_BOT_TOKEN!)}/setWebhook`)
url.searchParams.set('url', 'https://telegram-bot-eight-dun.vercel.app/api/webhook')
url.searchParams.set('secret_token', process.env.TELEGRAM_WEBHOOK_SECRET!)

console.log(await fetch(url, { method: 'POST' }).then(it => it.json()))
