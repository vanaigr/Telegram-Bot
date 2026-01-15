import fs from 'node:fs'
import fsp from 'node:fs/promises'
import util from 'node:util'
import { Temporal as T } from 'temporal-polyfill'
import TelegramBot from 'node-telegram-bot-api'
import dotenv from 'dotenv'
import * as OpenRouter from '@openrouter/sdk'

type Lock = {
    running: Promise<unknown> | undefined,
    lock: <T>(run: () => T | Promise<T>) => Promise<T>
}
const lock: Lock = {
    running: undefined,
    async lock(run) {
        while(this.running) {
            await this.running
        }

        const start = Promise.withResolvers<void>()

        const doRun = (async() => {
            await start.promise
            try { return await run() }
            finally { this.running = undefined }
        })()
        this.running = doRun

        start.resolve()

        return await doRun
    }
}

function main() {
    dotenv.config({ quiet: true })

    const openRouter = new OpenRouter.OpenRouter({ apiKey: process.env.OPENROUTER_KEY! });

    const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: true });
    /*
bot.onText(/^(.+)/, (msg, match) => {
    console.log('received', msg, match)
    const chatId = msg.chat.id
    bot.sendMessage(chatId, match![1]!)
})
*/

    bot.on('message', async(msg) => {
        try {
            if(msg.text && msg.text.startsWith('/stop')) {
                bot.sendMessage(msg.chat.id, 'Бот убит 👍');
                await bot.close()
                console.log('Dying')
                process.exit(1)
            }

            console.log('in', msg)
            await handleMessage(openRouter, bot, msg)
        }
        catch(error) {
            console.error(error)
        }
    });

    console.log('started')
}

/*
You are a group chat participant. Write a reply if you think users would appreciate it or if they ask you (@balbes52_bot, Балбес, etc.). Reply <empty> (with angle brackets) if you think users are talkning between themselves and would not appreciate your interruption.
*/
const systemPrompt = `
You are a group chat participant. Write a reply if users ask you something (@balbes52_bot, Балбес, etc.). Reply <empty> (with angle brackets) otherwise. Plan out your reply.

Commands that you can do (if users ask):
/stop - Temporarily suspends you

`.trim()

main()

async function handleMessage(
    openRouter: OpenRouter.OpenRouter,
    bot: TelegramBot,
    msg: TelegramBot.Message
) {
    const chatId = msg.chat.id;
    if(!msg.text) return

    const chatFilename = './chat-' + chatId + '.jsonl'

    const chatText = await lock.lock(async() => {
        let chatText: string
        try { chatText = (await fsp.readFile(chatFilename)).toString() }
        catch(err) { chatText = '' }

        chatText += JSON.stringify(msg) + '\n'

        await fsp.writeFile(chatFilename, chatText)

        return chatText
    })

    const messages = chatText.split('\n')
    .filter(it => it)
    .map(it => JSON.parse(it) as TelegramBot.Message)

    /// ???????????
    type OpenRouterMessage = typeof openRouter.chat.send extends (a: { messages: Array<infer Message> }) => infer U1 ? Message : never

    const response = await openRouter.chat.send({
        //model: 'moonshotai/kimi-k2-0905',
        model: 'openai/gpt-oss-120b',
        reasoning: {
          effort: 'medium',
        },
        stream: false,
        messages: [
            { role: 'system', content: systemPrompt },
            ...messages.map((it): OpenRouterMessage => {
                if(it.from?.username === 'balbes52_bot') {
                    return {
                        role: 'assistant',
                        content: it.text,
                    }
                }
                else {
                    return {
                        role: 'user',
                        name: it.from?.first_name + ' ' + it.from?.last_name + '(@' + it.from?.username + ')',
                        content: 'At '
                            + T.Instant.fromEpochMilliseconds(it.date * 1000)
                                .toZonedDateTimeISO(T.Now.timeZoneId())
                                .toPlainDateTime().toString()
                            + '\n'
                            + (it.text ?? '<no message>'),
                    }
                }
            }),
        ],
    })

    console.log('response', util.inspect(response, { depth: Infinity }))
    if(response.choices[0].message.content!.toString().trim() === '<empty>') {
        return
    }

    await lock.lock(async() => {
        let chatText: string
        try { chatText = (await fsp.readFile(chatFilename)).toString() }
        catch(err) { chatText = '' }

        chatText += JSON.stringify({
            from: {
                username: 'balbes52_bot',
            },
            date: T.Now.instant().epochMilliseconds / 1000,
            text: response.choices[0].message.content ?? '',
        }) + '\n'

        await fsp.writeFile(chatFilename, chatText)
    })

    bot.sendMessage(chatId, response.choices[0].message.content as string);
}
