export const $sql = Symbol('Sql fragment info');
export const $tableInfo = Symbol('Table info');
export const $scalarExpr = Symbol('Scalar expression');
export const $scalarExprDefinition = Symbol('Scalar expression definition');
export const $tableColumns = Symbol('table columns phantom data');

export type SqlPart =
  | string
  | { [$sql]: ParamSql | ColumnSql | RawSql }
  | DefinitionSql
  | TableSql
  | SqlPart[];

export type ParamSql = {
  type: 'param';
  value: unknown;
};
export type ColumnSql = {
  type: 'column';
  tableName: string | undefined;
  columnName: string;
};
export type RawSql = {
  type: 'expression';
  sql: SqlPart;
};
type TableSql = {
  [$sql]: {
    type: 'table';
    name: string;
    schema: string | undefined;
  };
};
type ExprSql = ParamSql | ColumnSql | RawSql;

export type DefinitionSql = {
  [$sql]: {
    type: 'definition';
    sql: SqlPart;
    name: string;
  };
};

export type DbTypeInfo<Input, Output> = { dbText: string; type?: (i: Input) => Output };
export type AnyDbTypeInfo = DbTypeInfo<never, unknown>;

export type DbTypeInput<Info extends AnyDbTypeInfo> =
  Info extends DbTypeInfo<infer Input, infer Output> ? Input : never;
export type DbTypeOutput<Info extends AnyDbTypeInfo> =
  Info extends DbTypeInfo<infer Input, infer Output> ? Output : never;

export type ForInput<TableSchema extends Record<string, AnyDbTypeInfo>> = {
  -readonly [K in keyof TableSchema]: DbTypeInput<TableSchema[K]>;
};
export type ForOutput<TableSchema extends Record<string, AnyDbTypeInfo>> = {
  -readonly [K in keyof TableSchema]: DbTypeOutput<TableSchema[K]>;
};

type TableInfo = {
  name: string;
  alias: string;
  schema: string | undefined;
};
type TableBase = TableSql & {
  [$tableInfo]: TableInfo;
  [$tableColumns]: (it: never) => unknown;
};
export type Table<
  T extends Record<string, AnyDbTypeInfo>,
  Extra extends Record<string, AnyDbTypeInfo>,
> = TableBase & { [K in keyof T]: Column<K, T[K]> } & { [K in keyof Extra]: Column<K, Extra[K]> };

export type TableExact<
  T extends Record<string, AnyDbTypeInfo>,
  Extra extends Record<string, AnyDbTypeInfo>,
> = TableBase & { [$tableColumns]: (it: T) => T } & { [K in keyof T]: Column<K, T[K]> } & {
  [K in keyof Extra]: Column<K, Extra[K]>;
};

export type Column<Name, Type> = { [$sql]: ColumnSql; name: Name } & ScalarExpr<Type> &
  ScalarExprDefinition<Name, Type> & { nameOnly: { [$sql]: ColumnSql } };

export type ScalarExpr<Type> = {
  [$sql]: ExprSql;
  [$scalarExpr]: { phantomType?: () => Type };
};
export type ScalarExprDefinition<Name, Type> = ScalarExpr<Type> & {
  [$scalarExprDefinition]: {
    name: Name;
  };
};

const proxy = {
  get(it: object, name: PropertyKey, receiver: unknown) {
    if (it && typeof name === 'string' && !(name in it)) {
      const tableInfo: TableInfo = Reflect.get(it, $tableInfo, receiver);

      return {
        [$sql]: {
          type: 'column',
          tableName: tableInfo.alias,
          columnName: name,
        },

        [$scalarExprDefinition]: {
          name: name,
        },
        [$scalarExpr]: {},

        name,
        nameOnly: {
          [$sql]: {
            type: 'column',
            tableName: undefined,
            columnName: name,
          },
        },
      } satisfies Column<unknown, unknown>;
    }
    return Reflect.get(it, name, receiver);
  },
};
export function makeTable<
  T extends Record<string, AnyDbTypeInfo>,
  Extra extends Record<string, AnyDbTypeInfo> = Record<never, never>,
>(tableName: string, schemaName?: string): TableExact<T, Extra> {
  return new Proxy(
    {
      [$sql]: {
        type: 'table',
        name: tableName,
        schema: schemaName,
      },
      [$tableInfo]: {
        name: tableName,
        schema: schemaName,
        alias: tableName,
      },
      [$tableColumns]: (it) => it,
    } satisfies TableBase,
    proxy,
  ) as any;
}

export function makeTableAlias<
  const NN extends string,
  const T extends Table<Record<string, AnyDbTypeInfo>, Record<string, AnyDbTypeInfo>>,
>(table: T, alias: NN): T {
  const info = table[$tableInfo];

  return new Proxy(
    {
      [$sql]: {
        type: 'table',
        name: alias,
        schema: info.schema,
      },
      [$tableInfo]: {
        name: info.name,
        alias,
        schema: info.schema,
      },
      [$tableColumns]: (it) => it,
    } satisfies TableBase,
    proxy,
  ) as any;
}

export function tableFromDefs<
  Cs extends readonly ScalarExprDefinition<unknown, AnyDbTypeInfo>[],
  E extends Record<string, AnyDbTypeInfo> = Record<never, never>,
>(tableName: string, columns: Cs) {
  return makeTable<Row<Cs>, E>(tableName);
}

export function scalar<T>(...sql: SqlPart[]): ScalarExpr<T> {
  return { [$sql]: { type: 'expression', sql }, [$scalarExpr]: {} };
}

export function named<T, const NN>(name: NN, it: ScalarExpr<T>): ScalarExprDefinition<NN, T> {
  return {
    [$sql]: it[$sql],
    [$scalarExpr]: it[$scalarExpr],
    [$scalarExprDefinition]: { name },
  };
}

export function wrap<N, T, NT>(
  it: ScalarExprDefinition<N, T>,
  transform: (it: ScalarExpr<T>) => ScalarExpr<NT>,
): ScalarExprDefinition<N, NT> {
  const transformed = transform(it);
  return {
    [$sql]: transformed[$sql],
    [$scalarExpr]: transformed[$scalarExpr],
    [$scalarExprDefinition]: it[$scalarExprDefinition],
  };
}

export function defName<N>(it: ScalarExprDefinition<N, unknown>): N {
  return it[$scalarExprDefinition].name;
}

export function nullable<T>(it: ScalarExpr<T>): ScalarExpr<T | null> {
  return it;
}

export function param<T>(value: T): { [$sql]: ParamSql } & ScalarExpr<DbTypeInfo<T, T>> {
  return { [$sql]: { type: 'param', value }, [$scalarExpr]: {} };
}

export function define(it: ScalarExprDefinition<string, unknown>): DefinitionSql {
  return {
    [$sql]: {
      type: 'definition',
      sql: it,
      name: it[$scalarExprDefinition].name,
    },
  };
}

export type Row<Cs extends readonly ScalarExprDefinition<unknown, AnyDbTypeInfo>[]> = {
  -readonly [K in Cs[number] as [K] extends [infer It]
    ? It extends ScalarExprDefinition<infer N, unknown>
      ? N extends string
        ? N
        : never
      : never
    : never]: K extends ScalarExprDefinition<unknown, infer V>
    ? V extends AnyDbTypeInfo
      ? DbTypeOutput<V>
      : never
    : never;
};
