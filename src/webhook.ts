import { waitUntil, attachDatabasePool } from '@vercel/functions';
import * as L from './lib/log.ts'


export async function POST(req: Request) {
  const log = L.makeLogger(undefined, undefined)

  log.I('Received webhook')
  const token = req.headers.get('x-telegram-bot-api-secret-token')
  if(token === '' || token !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    log.W('Unexpected webhook token ', [token], ' expected ', [process.env.TELEGRAM_WEBHOOK_SECRET])
    return new Response('', { status: 401 })
  }

  const body = await req.json()

  body.message

  return new Response(JSON.stringify({}))
}
