import util from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import G from '@prisma/generator-helper';
import P from '@prisma/internals';

type DbTypeInfo = { dbText: string; inputType: string; outputType: string, escape?: boolean };
const nonNullBuiltinTypes: DbTypeInfo[] = [
  {
    dbText: 'integer',
    inputType: 'number',
    outputType: 'number',
  },
  {
    dbText: 'bigint',
    inputType: 'number | bigint',
    outputType: 'bigint',
  },
  {
    dbText: 'double precision',
    inputType: 'number',
    outputType: 'number',
  },
  {
    dbText: 'decimal',
    inputType: 'number | string',
    outputType: 'string',
  },
  {
    dbText: 'text',
    inputType: 'string',
    outputType: 'string',
  },
  {
    dbText: 'boolean',
    inputType: 'boolean',
    outputType: 'boolean',
  },
  {
    dbText: 'timestamp',
    inputType: 'string',
    outputType: 'string',
  },
  {
    dbText: 'json',
    inputType: 'string',
    outputType: 'object',
  },
  {
    dbText: 'bytea',
    inputType: 'Buffer',
    outputType: 'Buffer',
  },
];

function hash(...values: unknown[]) {
  return values
    .map((it) => '' + it)
    .map((it) => it.length + '$' + it)
    .join('');
}

G.generatorHandler({
  onManifest: () => {
    return {
      defaultOutput: './tables.ts',
      prettyName: 'SQL type definitions',
    };
  },
  onGenerate: async (opts) => {
    const dm = opts.dmmf.datamodel;

    const dbTypes = [...nonNullBuiltinTypes];

    const prismaTypeToDbTypeName: Record<string, string> = {
      Int: 'integer',
      BigInt: 'bigint',
      Float: 'double precision',
      Decimal: 'decimal',
      String: 'text',
      Boolean: 'boolean',
      DateTime: 'timestamp',
      Json: 'json',
      Bytes: 'bytea',
    };

    for (const it of dm.enums) {
      const name = it.dbName ?? it.name;
      const type = [...it.values.map((it) => JSON.stringify(it.dbName ?? it.name))].join(' | ');
      prismaTypeToDbTypeName[name] = name;
      dbTypes.push({
        dbText: name,
        inputType: type,
        outputType: type,
        escape: true
      });
    }

    // NOTE: variables are needed for optimizing the bundle size.
    // Not that it's important, but it's easier to read
    const dbTypesVariablesCode = [];
    const dbTypesObjectCode = [];
    const dbTypesVariableName = new Map<string, string>();
    for (const type of dbTypes) {
      const parts = type.dbText
        .split(' ')
        .map((it) => it.trim())
        .filter((it) => it !== '');

      const propertyName = [
        parts[0]!,
        ...parts.slice(1).map((it) => it[0]!.toUpperCase() + it.substring(1).toLowerCase()),
      ].join('');
      const propertyNameNullable = propertyName + 'Nullable';
      const propertyNameArray = propertyName + 'Array';

      const escapedDbText = type.escape ? JSON.stringify(type.dbText) : type.dbText

      // NOTE: postres doesn't support nonnull array elements, so dbText has to be for nullable type
      const dbTypeCode = `makeDbType<${type.inputType}, ${type.outputType}>(${JSON.stringify(escapedDbText)})`;
      const dbTypeNullableCode = `makeDbType<${type.inputType} | null, ${type.outputType} | null>(${JSON.stringify(escapedDbText)})`;
      const dbTypeArrayCode = `makeDbType<Array<${type.inputType}>, Array<${type.outputType}>>(${JSON.stringify(escapedDbText + '[]')})`;

      const variableName = 't_' + propertyName;
      const variableNameNullable = 't_' + propertyNameNullable;
      const variableNameArray = 't_' + propertyNameArray;

      dbTypesVariablesCode.push(`const ${variableName} = ${dbTypeCode}`);
      dbTypesVariablesCode.push(`const ${variableNameNullable} = ${dbTypeNullableCode}`);
      dbTypesVariablesCode.push(`const ${variableNameArray} = ${dbTypeArrayCode}`);

      dbTypesObjectCode.push(toProp(propertyName, variableName));
      dbTypesObjectCode.push(toProp(propertyNameNullable, variableNameNullable));
      dbTypesObjectCode.push(toProp(propertyNameArray, variableNameArray));

      dbTypesVariableName.set(hash(type.dbText, 'nonnull'), variableName);
      dbTypesVariableName.set(hash(type.dbText, 'null'), variableNameNullable);
      dbTypesVariableName.set(hash(type.dbText, 'array'), variableNameArray);
    }

    const tablesCode: string[] = [];
    for (const table of dm.models) {
      const fieldsCode: string[] = [];
      for (const field of table.fields) {
        const name = field.dbName ?? field.name;

        let typeName: string;
        if (field.kind === 'scalar') {
          typeName = field.type;
        } else if (field.kind === 'enum') {
          typeName = field.type;
        } else if (field.kind === 'object') {
          continue; // relationship
        } else {
          throw new Error(
            'Table: ' +
              JSON.stringify(table) +
              '\nField: ' +
              JSON.stringify(field) +
              '\nObviously no stack trace. This is #1',
          );
        }

        const dbTypeName = prismaTypeToDbTypeName[typeName]!;
        if (dbTypeName == null) {
          throw new Error(
            'Table: ' +
              JSON.stringify(table) +
              '\nField: ' +
              JSON.stringify(field) +
              '\nObviously no stack trace. This is #2',
          );
        }

        let kind: string;
        if (field.isList) {
          kind = 'array';
        } else if (field.isRequired) {
          kind = 'nonnull';
        } else {
          kind = 'null';
        }

        const variableName = dbTypesVariableName.get(hash(dbTypeName, kind));
        if (variableName == null) {
          throw new Error(
            'Table: ' +
              JSON.stringify(table) +
              '\nField: ' +
              JSON.stringify(field) +
              '\nObviously no stack trace. This is #3',
          );
        }

        fieldsCode.push(toProp(name, variableName));
      }

      const tableName = table.dbName ?? table.name;
      tablesCode.push(toProp(tableName, toObj(fieldsCode)));
    }

    const defs = [
      '/* eslint-disable */',
      '// prettier-ignore',
      '// @generated',
      '',
      ...dbTypesVariablesCode,
      'export type DbType<Input, Output> = { dbText: string, type?: (i: Input) => Output }',
      'export function makeDbType<Input, Output>(dbText: string): DbType<Input, Output> { return { dbText } }',
      'export const dbTypes = ' + toObj(dbTypesObjectCode) + ' as const',
      'export const tables = ' + toObj(tablesCode) + ' as const',
    ];

    const outputPath =
      typeof opts.generator.output === 'string'
        ? (opts.generator.output as unknown as string)
        : P.parseEnvValue(opts.generator.output as any);

    await fsp.mkdir(path.dirname(outputPath), { recursive: true });

    await fsp.writeFile(outputPath, defs.join('\n'));
  },
});

function toProp(name: string, value: string) {
  return JSON.stringify(name) + ': ' + value;
}

function toObj(props: string[]) {
  return (
    '{\n' +
    props
      .map((it) => {
        return `${it
          .split('\n')
          .map((it) => `    ${it}`)
          .join('\n')},\n`;
      })
      .join('') +
    '}'
  );
}

function toArr(props: string[], newlines: boolean = true) {
  if (newlines) {
    return (
      '[\n' +
      props
        .map((it) => {
          return `${it
            .split('\n')
            .map((it) => `    ${it}`)
            .join('\n')},\n`;
        })
        .join('') +
      ']'
    );
  } else {
    return '[' + props.join(', ') + ']';
  }
}
