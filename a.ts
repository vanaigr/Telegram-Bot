import { entitiesToMd, mdToEntities } from './src/logic.ts'
import * as L from './src/lib/log.ts'
import * as U from './src/lib/util.ts'

const log = L.makeLogger(undefined, undefined)

const chatId = -1003381622274

const markdown = '**This is *bold and italic*, with __underline__ and **~~stirkethrough~~\n\nInside a spoiler ||inline code and *more emphasis*||\n\nQuoted [code](https://example.com/) block\n\n`preformatted \"code block\"`\n`second line`\n\nAnd an expandable quote:\n> Nested blockquite with **bold**,\n`code`\n> , and ~~mistakes~~.'
const result = mdToEntities(markdown, log)
console.log(result)

await U.request({
  url: new URL(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN!}/sendMessage`),
  log: log.addedCtx('sendMessage'),
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    chat_id: chatId,
    text: result.text,
    entities: result.entities,
  }),
}).then(it => console.log(it))


/*
;(async() => {
  await 0

  console.log(entitiesToMd(text, entities, log))

})()
*/

process.exit(1)

const text = "This is bold and italic, with underline and stirkethrough\n\nInside a spoiler inline code and more emphasis\n\nQuoted code block\n\npreformatted \"code block\"\nsecond line\n\nAnd an expandable quote:\nNested blockquite with bold, code, and mistakes."

const entities =
[
    {
      "type": "bold",
      "length": 8,
      "offset": 0
    },
    {
      "type": "bold",
      "length": 22,
      "offset": 8
    },
    {
      "type": "italic",
      "length": 15,
      "offset": 8
    },
    {
      "type": "bold",
      "length": 14,
      "offset": 30
    },
    {
      "type": "underline",
      "length": 9,
      "offset": 30
    },
    {
      "type": "strikethrough",
      "length": 13,
      "offset": 44
    },
    {
      "type": "spoiler",
      "length": 16,
      "offset": 76
    },
    {
      "type": "italic",
      "length": 13,
      "offset": 92
    },
    {
      "type": "spoiler",
      "length": 13,
      "offset": 92
    },
    {
      "url": "https://example.com/",
      "type": "text_link",
      "length": 4,
      "offset": 114
    },
    {
      "type": "code",
      "length": 25,
      "offset": 126
    },
    {
      "type": "code",
      "length": 11,
      "offset": 152
    },
    {
      "type": "blockquote",
      "length": 29,
      "offset": 190
    },
    {
      "type": "bold",
      "length": 4,
      "offset": 213
    },
    {
      "type": "code",
      "length": 4,
      "offset": 219
    },
    {
      "type": "blockquote",
      "length": 15,
      "offset": 223
    },
    {
      "type": "strikethrough",
      "length": 8,
      "offset": 229
    }
  ]
