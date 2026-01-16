A Telegram bot that spices up group chats with fun, witty replies. It can read conversation history and see image attachments.

The bot uses OpenRouter to generate responses and is deployed on Vercel (serverless functions) + Prisma (postgres).

> [!NOTE]
> The bot is private (I’m not a millionaire paying for everyone’s usage),
> but setting up your own version should be pretty straightforward.
> See instructions below.

## Setup

### Repo

Requires node >= 24 (mine is `24.12.0`) and pnpm >= 10 (mine is `10.26.1`)

1. Fork the repo to your GitHub account
2. Clone the repo
3. Run `pnpm install`

### Vercel

1. Create a new project
2. Add your GitHub repo to the project
3. Run `pnpm exec vercel login`. Login and select existing project

### Prisma

1. Add a Prisma database in the project's storage settings
2. Add Prisma connection string as `DATABASE_URL` env var in Vercel
3. Run `DATABASE_URL=<your db url> pnpm exec prisma generate`
4. Run `DATABASE_URL=<your db url> pnpm exec prisma db push`

### OpenRouter

1. Create a new API key
2. Add the key as `OPENROUTER_KEY` env var in Vercel

### Telegram

1. Create a new bot following instructions here: https://core.telegram.org/bots#how-do-i-create-a-bot
2. Once you have a key, add it as `TELEGRAM_BOT_TOKEN` env var in Vercel
3. Generate random bytes with `node -e 'console.log(require("crypto").randomBytes(150).toString("base64url"))'` and add them as `TELEGRAM_WEBHOOK_SECRET` env var in Vercel
4. Edit `scripts/setupWebhook.ts` to point at your project
5. Run `TELEGRAM_BOT_TOKEN=<your token> TELEGRAM_WEBHOOK_SECRET=<your secret> node scripts/setupWebhook.ts` to set up Telegram webhook

## Deploying the bot

1. Run `pnpm exec vercel --prod` to deploy your bot.
2. Add the bot to any of your chats.
3. Give the bot admin rights (you can disable all privileges). The bot will work without being an admin, but will only see messages that look like commands (e.g. `/c`)
4. Send a message in the chat
5. Open Vercel logs and search for the 'Chat <chat id> is not whitelisted' line. Copy chat id
6. Add chat id to `chatWhitelist` table in the db (with e.g. Dbeaver, using `DATABASE_URL`)

After these steps, the bot should be working

## Misc

1. Bot cannot see messages before it was added.
2. $0.001 per message on average.
3. Theoretically doesn't use your conversations for prompt training.
4. Stores all conversations and attachments in the db, you may run out of the 500mb eventually. Just delete old images I guess.
