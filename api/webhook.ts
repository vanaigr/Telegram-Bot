import { waitUntil, attachDatabasePool } from '@vercel/functions';

export async function POST(req: Request) {
  const body = await req.json()
  console.log(body)
  return new Response(JSON.stringify({}))
}
