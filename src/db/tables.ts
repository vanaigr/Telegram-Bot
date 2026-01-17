/* eslint-disable */
// prettier-ignore
// @generated

const t_integer = makeDbType<number, number>("integer")
const t_integerNullable = makeDbType<number | null, number | null>("integer")
const t_integerArray = makeDbType<Array<number>, Array<number>>("integer[]")
const t_bigint = makeDbType<number | bigint, bigint>("bigint")
const t_bigintNullable = makeDbType<number | bigint | null, bigint | null>("bigint")
const t_bigintArray = makeDbType<Array<number | bigint>, Array<bigint>>("bigint[]")
const t_doublePrecision = makeDbType<number, number>("double precision")
const t_doublePrecisionNullable = makeDbType<number | null, number | null>("double precision")
const t_doublePrecisionArray = makeDbType<Array<number>, Array<number>>("double precision[]")
const t_decimal = makeDbType<number | string, string>("decimal")
const t_decimalNullable = makeDbType<number | string | null, string | null>("decimal")
const t_decimalArray = makeDbType<Array<number | string>, Array<string>>("decimal[]")
const t_text = makeDbType<string, string>("text")
const t_textNullable = makeDbType<string | null, string | null>("text")
const t_textArray = makeDbType<Array<string>, Array<string>>("text[]")
const t_boolean = makeDbType<boolean, boolean>("boolean")
const t_booleanNullable = makeDbType<boolean | null, boolean | null>("boolean")
const t_booleanArray = makeDbType<Array<boolean>, Array<boolean>>("boolean[]")
const t_timestamp = makeDbType<string, string>("timestamp")
const t_timestampNullable = makeDbType<string | null, string | null>("timestamp")
const t_timestampArray = makeDbType<Array<string>, Array<string>>("timestamp[]")
const t_json = makeDbType<string, object>("json")
const t_jsonNullable = makeDbType<string | null, object | null>("json")
const t_jsonArray = makeDbType<Array<string>, Array<object>>("json[]")
const t_bytea = makeDbType<Buffer, Buffer>("bytea")
const t_byteaNullable = makeDbType<Buffer | null, Buffer | null>("bytea")
const t_byteaArray = makeDbType<Array<Buffer>, Array<Buffer>>("bytea[]")
const t_messageType = makeDbType<"user" | "assistant", "user" | "assistant">("\"messageType\"")
const t_messageTypeNullable = makeDbType<"user" | "assistant" | null, "user" | "assistant" | null>("\"messageType\"")
const t_messageTypeArray = makeDbType<Array<"user" | "assistant">, Array<"user" | "assistant">>("\"messageType\"[]")
const t_downloadStatus = makeDbType<"downloading" | "error" | "done", "downloading" | "error" | "done">("\"downloadStatus\"")
const t_downloadStatusNullable = makeDbType<"downloading" | "error" | "done" | null, "downloading" | "error" | "done" | null>("\"downloadStatus\"")
const t_downloadStatusArray = makeDbType<Array<"downloading" | "error" | "done">, Array<"downloading" | "error" | "done">>("\"downloadStatus\"[]")
export type DbType<Input, Output> = { dbText: string, type?: (i: Input) => Output }
export function makeDbType<Input, Output>(dbText: string): DbType<Input, Output> { return { dbText } }
export const dbTypes = {
    "integer": t_integer,
    "integerNullable": t_integerNullable,
    "integerArray": t_integerArray,
    "bigint": t_bigint,
    "bigintNullable": t_bigintNullable,
    "bigintArray": t_bigintArray,
    "doublePrecision": t_doublePrecision,
    "doublePrecisionNullable": t_doublePrecisionNullable,
    "doublePrecisionArray": t_doublePrecisionArray,
    "decimal": t_decimal,
    "decimalNullable": t_decimalNullable,
    "decimalArray": t_decimalArray,
    "text": t_text,
    "textNullable": t_textNullable,
    "textArray": t_textArray,
    "boolean": t_boolean,
    "booleanNullable": t_booleanNullable,
    "booleanArray": t_booleanArray,
    "timestamp": t_timestamp,
    "timestampNullable": t_timestampNullable,
    "timestampArray": t_timestampArray,
    "json": t_json,
    "jsonNullable": t_jsonNullable,
    "jsonArray": t_jsonArray,
    "bytea": t_bytea,
    "byteaNullable": t_byteaNullable,
    "byteaArray": t_byteaArray,
    "messageType": t_messageType,
    "messageTypeNullable": t_messageTypeNullable,
    "messageTypeArray": t_messageTypeArray,
    "downloadStatus": t_downloadStatus,
    "downloadStatusNullable": t_downloadStatusNullable,
    "downloadStatusArray": t_downloadStatusArray,
} as const
export const tables = {
    "messages": {
        "chatId": t_bigint,
        "messageId": t_bigint,
        "date": t_timestamp,
        "type": t_messageType,
        "raw": t_json,
    },
    "reactions": {
        "chatId": t_bigint,
        "messageId": t_bigint,
        "hash": t_text,
        "raw": t_json,
    },
    "messagesBackup": {
        "sequenceNumber": t_integer,
        "chatId": t_bigint,
        "messageId": t_bigint,
        "date": t_timestamp,
        "type": t_messageType,
        "raw": t_json,
    },
    "responses": {
        "sequenceNumber": t_integer,
        "raw": t_json,
        "respondsToChatId": t_bigint,
        "respondsToMessageId": t_bigint,
    },
    "chatFullInfo": {
        "id": t_bigint,
        "updatedAt": t_timestamp,
        "raw": t_json,
    },
    "photos": {
        "chatId": t_bigint,
        "fileUniqueId": t_text,
        "raw": t_json,
        "status": t_downloadStatus,
        "bytes": t_bytea,
        "downloadStartDate": t_timestamp,
    },
    "chatLocks": {
        "id": t_bigint,
    },
    "chatWhitelist": {
        "id": t_bigint,
    },
} as const