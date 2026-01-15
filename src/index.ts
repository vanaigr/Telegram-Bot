import TelegramBot from 'node-telegram-bot-api'
import dotenv from 'dotenv'

dotenv.config({ quiet: true })

const bot = new TelegramBot(process.env.BOT_TOKEN!, { polling: true });
/*
bot.onText(/^(.+)/, (msg, match) => {
    console.log('received', msg, match)
    const chatId = msg.chat.id
    bot.sendMessage(chatId, match![1]!)
})
*/

bot.on('message', (msg) => {
    console.log('received', msg.text)
    const chatId = msg.chat.id;
    if(msg.text) {
        bot.sendMessage(chatId, msg.text);
    }
});

console.log('started')
