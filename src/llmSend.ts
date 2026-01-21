// "If you want something done right, do it yourself"
// Openrouter does not return good errors, and types are bad.
// Probably because of beta, but I don't have time to wait for them to fix it.
import { OpenRouter } from '@openrouter/sdk'
import * as L from './lib/log.ts'
import * as Db from './db/index.ts'

export type Params = {
  model: string
  reasoning?: {
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  }
  max_completion_tokens?: number
  response_format?: {
    type: 'json_schema',
    json_schema: {
      name: string
      schema: JsonSchema
    }
  }
  messages: OpenRouterMessage[]
}

export type OpenrouterResponse = {
  choices: ResponseChoice[]
}
export type ResponseChoice = ResponseStop | ResponseToolCalls | ResponseLength | ResponseContentFilter | ResponseError
export type ResponseStop = {
  finish_reason: 'stop'
  message: {
    role: 'assistant'
    content: string
    reasoning: string | null
  }
}
export type ResponseToolCalls = {
  finish_reason: 'tool_calls'
  message: {
    role: 'assistant'
    tool_calls: {
      id: string
      function: {
        name: string
        arguments: string
      }
    }
  }
}
export type ResponseLength = {
  finish_reason: 'length'
  message: {
    role: 'assistant'
    content: string
    refusal: unknown | null
    reasoning: string | null
  }
}
export type ResponseContentFilter = {
  finish_reason: 'content_filter'
  message: {
    refusal: string | null
  }
}
export type ResponseError = {
  finish_reason: 'error'
}


export type OpenRouterMessage = OpenRouter['chat']['send'] extends (a: { messages: Array<infer Message> }) => infer U1 ? Message : never

export async function send(log: L.Log, db: Db.DbPool, params: Params) {
  let response: Awaited<ReturnType<typeof fetch>>
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.OPENROUTER_KEY!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: {
          data_collection: 'deny',
        },
        ...params,
        ...(() => {
          const reasoning = params.reasoning
          if(!reasoning) return {}

          return {
            reasoning: {
              summary: 'disabled',
              ...reasoning,
            }
          }
        }),
      })
    })
  }
  catch(error) {
    log.E('Request failed: ', [error])
    return undefined
  }

  if(!response.ok) {
    log.E('Received error ', [response.status])
    const bodyResult = await readBody(response)

    await Db.insertMany(
      db,
      Db.t.debug,
      Db.omit(Db.d.debug, ['sequenceNumber', 'createdAt']),
      [{
        raw: JSON.stringify({
          reason: 'status-code',
          status: response.status,
          params,
          bodyFull: bodyResult.ok,
        }),
        body: bodyResult.body,
      }],
      {}
    )

    return undefined
  }

  const bodyResult = await readBody(response)
  if(!bodyResult.ok) {
    log.E('Response body cutoff')
    await Db.insertMany(
      db,
      Db.t.debug,
      Db.omit(Db.d.debug, ['sequenceNumber', 'createdAt']),
      [{
        raw: JSON.stringify({
          reason: 'cutoff',
          status: response.status,
          params,
          bodyFull: bodyResult.ok,
        }),
        body: bodyResult.body,
      }],
      {}
    )

    return undefined
  }

  try {
    const oResponse: OpenrouterResponse = JSON.parse(bodyResult.body.toString('utf8'))
    const choice = oResponse.choices[0]
    if(oResponse.choices.length === 0) throw new Error('No choice')
    if(choice.finish_reason === 'stop' || choice.finish_reason === 'tool_calls' || choice.finish_reason === 'length') {
      return oResponse
    }
    else throw Error('Finish reason')
  }
  catch(error) {
    log.E('Failed to parse response: ', [error])
    await Db.insertMany(
      db,
      Db.t.debug,
      Db.omit(Db.d.debug, ['sequenceNumber', 'createdAt']),
      [{
        raw: JSON.stringify({
          reason: 'parse',
          status: response.status,
          params,
          bodyFull: bodyResult.ok,
        }),
        body: bodyResult.body,
      }],
      {}
    )
    return undefined
  }
}

async function readBody(response: Response): Promise<{ ok: true; body: Buffer } | { ok: false; body: Buffer }> {
    const chunks: Uint8Array[] = [];

    try {
      const reader = response.body!.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      return { ok: true, body: Buffer.concat(chunks) };
    } catch {
      return { ok: false, body: Buffer.concat(chunks) };
    }
  }


export type JsonString = {
  type: 'string'
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: string
  enum?: string[]
}
export type JsonNumber = {
  type: 'number' | 'integer'
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
}
export type JsonBoolean = { type: 'boolean' }
export type JsonNull = { type: 'null' }

export type JsonArray = {
  type: 'array'
  items?: JsonSchema
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
}

export type JsonObject = {
  type: 'object'
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
}

export type JsonSchema =
  | JsonString
  | JsonNumber
  | JsonBoolean
  | JsonNull
  | JsonArray
  | JsonObject
