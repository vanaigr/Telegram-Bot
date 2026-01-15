import { Pool, Query, types } from 'pg';
import type { Log } from '../lib/log.ts';

declare module 'pg' {
  interface Query {
    text: string;
    values: unknown[];
  }
}

types.setTypeParser(types.builtins.INT8, (it) => BigInt(it));
types.setTypeParser(types.builtins.TIMESTAMPTZ, (it) => it.replace(' ', 'T'));
types.setTypeParser(types.builtins.TIMESTAMP, (it) => it.replace(' ', 'T') + 'Z');

export function create(log: Log, debug: boolean = false) {
  const dbUrlName = 'DATABASE_URL';
  const connectionString = process.env[dbUrlName];
  if (!connectionString) {
    log.I('Connection string is not specified. Please add ', [dbUrlName], ' env variable');
    return;
  }

  const db = new Pool({
    connectionString,
  });

  if (debug) {
    const originalSubmit = Query.prototype.submit;
    Query.prototype.submit = function (this: Query, ...args) {
      const text = this.text;
      const values = this.values;

      console.log('-----------------------------');
      console.log(text);
      console.log('<->');
      console.log(values);
      console.log('-----------------------------');

      return originalSubmit.apply(this, args);
    };
  }

  return db;
}
