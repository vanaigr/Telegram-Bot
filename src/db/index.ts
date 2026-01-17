import util from 'node:util';
import type { Pool, PoolClient } from 'pg';

import * as Q from './sql.ts';
import * as U from '../lib/util.ts';
export * from './sql.ts';
import * as Schema from './tables.ts';
import * as Types from '../types.ts'

const modifiedSchema = {
  ...Schema.tables,
  messages: {
    ...Schema.tables.messages,
    raw: Schema.makeDbType<string, Types.Message>('json'),
  },
  reactions: {
    ...Schema.tables.reactions,
    raw: Schema.makeDbType<string, Types.MessageReactionUpdated>('json'),
  },
  chatFullInfo: {
    ...Schema.tables.chatFullInfo,
    raw: Schema.makeDbType<string, Types.ChatFullInfo>('json'),
  },
}

export const dbTypes = Schema.dbTypes;

export const t = Object.fromEntries(
  Object.entries(modifiedSchema).map((it) => [it[0], Q.makeTable<any, any>(it[0])]),
) as { [K in keyof typeof modifiedSchema]: Q.TableExact<(typeof modifiedSchema)[K], Record<never, never>> };
export const d = modifiedSchema;


export type DbTransaction = PoolClient;
export type DbPool = Pool;
export type DbConnOrPool = DbTransaction | DbPool;

export function queryRawFull(prisma: DbConnOrPool, ...fragments: Q.SqlPart[]) {
  const sql = toSql(fragments);
  return prisma.query(sql.query, sql.args);
}
export function queryRaw<O = unknown>(prisma: DbConnOrPool, ...fragments: Q.SqlPart[]) {
  const sql = toSql(fragments);
  try {
    return prisma.query(sql.query, sql.args).then((it) => it.rows) as Promise<O>;
  }
  catch(error) {
    console.error('Failing query:', sql)
    throw error
  }
}
export function query<Cs extends readonly Q.ScalarExprDefinition<string, Q.AnyDbTypeInfo>[]>(
  prisma: DbConnOrPool,
  initialFragment: Q.SqlPart,
  outColumns: Cs,
  ...fragments: Q.SqlPart[]
) {
  const columsSql = columns<Cs>(...outColumns);
  return queryRaw<(typeof columsSql)['rows']>(prisma, initialFragment, columsSql, ...fragments);
}

export function func<R = unknown>(
  name: Q.SqlPart,
  ...argValues: Q.SqlPart[]
): Q.ScalarExpr<R> {
  return Q.scalar<R>(name, args(argValues))
}

export function timedTran<O>(pool: Pool, func: (db: DbTransaction) => O) {
  return U.timedAsync(() => tran(pool, func));
}

export async function tran<O>(pool: Pool, func: (db: DbTransaction) => O) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await func(client);
    await client.query('commit');
    return result;
  } catch (err) {
    // TODO: what if this crashes? We release a client that still runs a
    // transaction into the pool?
    // This is in their example: https://node-postgres.com/features/transactions
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export function ifNotNul<IT, OT, R>(
  sql: Q.ScalarExpr<Q.DbTypeInfo<IT, OT>>,
  then: Q.ScalarExpr<Q.DbTypeInfo<never, R>>,
) {
  return Q.scalar<Q.DbTypeInfo<IT, R | (null extends OT ? null : never)>>(
    `case when (`,
    sql,
    `) is null then null else (`,
    then,
    `) end`,
  );
}
export function max<I, T>(inner: Q.ScalarExpr<Q.DbTypeInfo<I, T>>) {
  return Q.scalar<Q.DbTypeInfo<I, T | null>>(`max((`, inner, `))`);
}
export function sum<I, T>(inner: Q.ScalarExpr<Q.DbTypeInfo<I, T>>) {
  return Q.scalar<Q.DbTypeInfo<I, T | null>>(`sum((`, inner, `))`);
}
export function min<I, T>(inner: Q.ScalarExpr<Q.DbTypeInfo<I, T>>) {
  return Q.scalar<Q.DbTypeInfo<I, T | null>>(`min((`, inner, `))`);
}
export function eq<T>(
  a: Q.ScalarExpr<Q.DbTypeInfo<never, T>>,
  b: Q.ScalarExpr<Q.DbTypeInfo<never, T>>,
) {
  return Q.scalar<Q.DbTypeInfo<boolean, boolean | (null extends T ? null : never)>>(a, '=', b);
}

export function not<T extends boolean | null>(a: Q.ScalarExpr<Q.DbTypeInfo<never, T>>) {
  return Q.scalar<Q.DbTypeInfo<boolean, boolean | (null extends T ? null : never)>>('not', a)
}

export function isNull<T>(a: Q.ScalarExpr<T>) {
  return Q.scalar<Q.DbTypeInfo<boolean, boolean>>(par(a, 'is null'))
}

export function setJson<T>(a: Q.Column<unknown, Q.DbTypeInfo<string, T>>, value: T) {
  return [a.nameOnly, '=', Q.param(JSON.stringify(value)), '::json'];
}

export function set<T>(
  a: Q.Column<unknown, Q.DbTypeInfo<T, unknown>>,
  value: Q.ScalarExpr<Q.DbTypeInfo<never, T>>,
) {
  return [a.nameOnly, '=', value];
}

// TODO: deduplicate Param objects, and not values
type ConvertedSql = { pieces: string[]; args: Map<unknown, number>; argsEnd: number };
export function toSql(fragments: Q.SqlPart[]) {
  const result: ConvertedSql = {
    pieces: [],
    args: new Map(),
    argsEnd: 1,
  };
  for (const it of fragments) toSqlValue(it, result);

  return {
    query: result.pieces.join(' '),
    args: [...result.args.keys()],
  };
}
export function toSqlValue(it: Q.SqlPart, result: ConvertedSql) {
  if (typeof it === 'string') {
    result.pieces.push(it);
    return;
  } else if (Array.isArray(it)) {
    for (const inner of it) toSqlValue(inner, result);
    return;
  } else if (Q.$sql in it) {
    const sql = it[Q.$sql];
    if (sql.type === 'column') {
      if (sql.tableName !== undefined) {
        result.pieces.push(JSON.stringify(sql.tableName) + '.' + JSON.stringify(sql.columnName));
        return;
      } else {
        result.pieces.push(JSON.stringify(sql.columnName));
        return;
      }
    } else if (sql.type === 'param') {
      let argI = result.args.get(sql.value);
      if (argI === undefined) {
        result.args.set(sql.value, (argI = result.argsEnd++));
      }
      result.pieces.push('$' + argI);
      return;
    } else if (sql.type === 'table') {
      if (sql.schema !== undefined) {
        result.pieces.push(JSON.stringify(sql.schema), '.');
      }
      result.pieces.push(JSON.stringify(sql.name));
      return;
    } else if (sql.type === 'expression') {
      toSqlValue(sql.sql, result);
      return;
    } else if (sql.type === 'definition') {
      toSqlValue(['(', sql.sql, ') as', JSON.stringify(sql.name)], result);
      return;
    } else {
      type _ = (typeof sql extends never ? { ok: true } : { err: typeof sql })['ok'];
    }
  } else {
    type _ = (typeof it extends never ? { ok: true } : { err: typeof it })['ok'];
  }

  throw new Error(`Unexpected object ${util.inspect(it)} when building sql`);
}

export type Columns<Cs extends readonly Q.ScalarExprDefinition<unknown, Q.AnyDbTypeInfo>[]> = {
  [Q.$sql]: Q.RawSql;
  defs: Cs;
  rows: Q.Row<Cs>[];
};
export function columns<Cs extends readonly Q.ScalarExprDefinition<string, Q.AnyDbTypeInfo>[]>(
  ...cols: Cs
): Columns<Cs> {
  return {
    [Q.$sql]: {
      type: 'expression',
      sql: list(cols.map((it) => Q.define(it))),
    },
    defs: cols,
    rows: [],
  };
}

export function inArr<I, R>(
  scalar: Q.ScalarExpr<Q.DbTypeInfo<I, R>>,
  values: I[],
  cast: Q.SqlPart = '',
): Q.SqlPart {
  return [scalar, '= ANY(', Q.param(values), cast, ')'];
}

export function arraysTable<TableSchema extends Record<string, Q.AnyDbTypeInfo>>(
  records: readonly Q.ForInput<TableSchema>[],
  tableType: TableSchema,
): Q.SqlPart {
  const t = Q.makeTable<TableSchema>('x');
  return par(
    'select * from unnest',
    args(
      keys(tableType).map((name) => {
        return [Q.param(records.map((it) => it[name])), '::', tableType[name].dbText, '[]'];
      }),
    ),
    'as',
    t,
    args(keys(tableType).map((name) => t[name].nameOnly)),
  );
}

export async function insertMany<
  TableSchema extends Record<string, Q.AnyDbTypeInfo>,
  Scalars extends Partial<Q.ForInput<TableSchema>> = never,
>(
  db: DbConnOrPool,
  dst: Q.Table<TableSchema, Record<string, Q.AnyDbTypeInfo>>,
  tableSchema: TableSchema,
  records: Q.ForInput<Omit<TableSchema, keyof Scalars>>[],
  // TypeScript 🗿
  scalars: Scalars,
) {
  if (records.length === 0) return;

  const tableKeys = keys(tableSchema);
  const recordsKeys = tableKeys.filter((it) => scalars === undefined || !(it in scalars));
  const scalarKeys = keys(scalars);

  const recordsTableType = pick(tableSchema, recordsKeys) as Omit<TableSchema, keyof Scalars>;

  const src = Q.makeTable<TableSchema>('src');
  return await queryRaw(
    db,
    'insert into',
    dst,
    args([
      ...recordsKeys.map((it) => dst[it].nameOnly),
      ...scalarKeys.map((it) => dst[it].nameOnly),
    ]),
    'select',
    list([...recordsKeys.map((it) => src[it]), ...scalarKeys.map((it) => Q.param(scalars![it]))]),
    'from',
    arraysTable(records, recordsTableType),
    'as',
    src,
  );
}

export async function upsertMany<TableSchema extends Record<string, Q.AnyDbTypeInfo>>(
  db: DbTransaction,
  dst: Q.TableExact<TableSchema, Record<never, never>>,
  tableSchema: TableSchema,
  records: Q.ForInput<TableSchema>[],
  props: { conflict: (keyof TableSchema)[]; update: (keyof TableSchema)[] },
) {
  const src = Q.makeTable<TableSchema>('src');
  const newValues = Q.makeTable<TableSchema>('excluded');
  await queryRaw(
    db,
    'insert into',
    dst,
    args(strKeys(tableSchema).map((it) => dst[it].nameOnly)),
    'select',
    list(strKeys(tableSchema).map((it) => src[it])),
    'from',
    arraysTable(records, tableSchema),
    'as',
    src,
    'on conflict',
    args(props.conflict.map((it) => dst[it].nameOnly)),
    'do update set',
    list(props.update.map((it) => [dst[it].nameOnly, '=', newValues[it]])),
  );
}

export function join<T, V>(arr: readonly T[], delim: V): (T | V)[] {
  const result: (T | V)[] = [];
  for (let i = 0; i < arr.length; i++) {
    if (i !== 0) result.push(delim);
    result.push(arr[i]);
  }
  return result;
}
export function list<T extends readonly unknown[]>(arr: T): (T[number] | ',')[] {
  return join<T[number], ','>(arr, ',');
}
export function args<T extends unknown[]>(arr: T): (T[number] | ',' | '(' | ')')[] {
  return ['(', ...join<T[number], ','>(arr, ','), ')'];
}
export function par<T extends unknown[]>(...it: T): ['(', T, ')'] {
  return ['(', it, ')'];
}

export function strKeys<T>(t: T) {
  const result: (keyof T & string)[] = [];
  for (const k in t) {
    if (typeof k !== 'string') continue;
    result.push(k);
  }
  return result;
}

export function keys<T>(t: T) {
  const result: (keyof T)[] = [];
  for (const k in t) result.push(k);
  return result;
}

export function pick<T, const K extends keyof T>(t: T, keys: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    result[key] = t[key];
  }
  return result;
}

export function omit<T, const K extends keyof T>(t: T, keys: readonly K[]): Omit<T, K> {
  const result = { ...t };
  for (const key of keys) {
    delete result[key];
  }
  return result;
}

export function omitAny<T, const K extends keyof any>(t: T, keys: readonly K[]): Omit<T, K> {
  const result = { ...t };
  for (const key of keys) {
    delete (result as any)[key];
  }
  return result;
}
