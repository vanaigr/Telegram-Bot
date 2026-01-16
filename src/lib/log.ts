import fsp from 'node:fs/promises';
import util from 'node:util';

import * as T from './temporal.ts';

export type ContextValue = readonly [context: Message, 'context'];
export type Value =
  | readonly [value: unknown, type?: never]
  | ContextValue
  | readonly [value: unknown, 'details']
  | readonly [message: Message, 'extra-details']
  | readonly [message: Message, 'message'];

export type Message = readonly (string | Value)[];
export type MutableMessage = (string | Value)[];

export type Log = {
  parent: Log | undefined;
  prefix: Message;

  addedCtx: (...context: Message) => Log;
  I: (...message: Message) => void;
  W: (...message: Message) => void;
  E: (...message: Message) => void;
  unreachable: (...message: Message) => void;

  flushMessages: () => Promise<void>;
};

export type Channel = 'I' | 'W' | 'E';

type LoggerProvider = never

export type OtelLogger = ReturnType<LoggerProvider['getLogger']>;
const severityTexts = { E: 'ERROR', I: 'INFO', W: 'WARN' } as const;

type FileLog = {
  current: Promise<unknown> | undefined;
  pending: string;
  path: string;
};
function writeFileLog(it: FileLog) {
  if (it.current || !it.pending) return;

  it.current = (async () => {
    const file = await fsp.open(it.path, 'a');
    try {
      const pending = it.pending;
      it.pending = '';
      await file.write(pending);
    } finally {
      await file.close();
    }

    it.current = undefined;
    return writeFileLog(it);
  })();
}

export function makeStubLogger(): Log {
  return LoggerWrapper.root(
    () => {},
    async () => {},
  );
}

export function makeLogger(
  logPath: string | undefined,
  otel: { logger: OtelLogger; flush: () => Promise<void> } | undefined,
): Log {
  const fileLog = (() => {
    if (logPath === undefined) return;

    return {
      current: undefined,
      pending: '',
      path: logPath,
    };
  })();

  const log = (channel: Channel, logger: Log, message: Message) => {
    //const dt = T.Now.zonedDateTimeISO();

    const fullMessage: MutableMessage = [];
    //fullMessage.push([[dtToString(dt)], 'context']);
    const fillLoggers = (it: Log) => {
      if (it.parent) fillLoggers(it.parent);
      for (const ctx of it.prefix) fullMessage.push(ctx);
    };
    fillLoggers(logger);
    for (const fragment of message) fullMessage.push(fragment);

    console.log(messageToString(fullMessage, { colors: false, details: false }));

    const textMessage = messageToString(fullMessage, { colors: false, details: true });

    if (fileLog) {
      fileLog.pending += textMessage + '\n';
      writeFileLog(fileLog);
    }

    /*
    if (otel) {
      otel.logger.emit({
        timestamp: dt.epochMilliseconds,
        severityText: severityTexts[channel],
        body: textMessage,
      });
    }
    */
  };

  const flush = async () => {
    await Promise.allSettled([otel?.flush(), fileLog?.current]);
  };

  return LoggerWrapper.root(wrapLog(log), flush);
}

type LogFunc = (channel: Channel, logger: Log, message: Message) => void;
type FlushFunc = () => Promise<void>;
export class LoggerWrapper {
  parent: Log | undefined;
  prefix: Message;
  logFunc: LogFunc;
  flushFunc: FlushFunc;

  constructor(parent: Log | undefined, prefix: Message, logFunc: LogFunc, flushFunc: FlushFunc) {
    this.parent = parent;
    this.prefix = prefix;
    this.logFunc = logFunc;
    this.flushFunc = flushFunc;
  }

  static root(logFunc: LogFunc, flushFunc: FlushFunc) {
    return new LoggerWrapper(undefined, [], logFunc, flushFunc);
  }

  addedCtx(...moreContext: Message) {
    return new LoggerWrapper(this, [[moreContext, 'context']], this.logFunc, this.flushFunc);
  }
  I(...message: Message) {
    this.logFunc('I', this, [' I: ', ...message]);
  }
  W(...message: Message) {
    this.logFunc('W', this, [' W: ', ...message]);
  }
  E(...message: Message) {
    this.logFunc('E', this, [' E: ', ...message]);
  }
  unreachable(...message: Message) {
    this.logFunc('E', this, makeUnreachable(...message));
  }

  flushMessages() {
    return this.flushFunc();
  }
}

export function makeUnreachable(...message: Message): Message {
  return [' Unreachable (', ...message, ') ', new Error().stack ?? '<No stack>'];
}

function wrapLog(logFunc: LogFunc): LogFunc {
  return (...args) => {
    try {
      logFunc(...args);
    } catch (err) {
      try {
        console.error('Log crashed');
        console.error('Args:', args);
        console.error('Error:', err);
      } catch (_) {}
    }
  };
}

export type MessageOpts = { colors: boolean; details: boolean };
export function messageToString(message: Message, opts: MessageOpts) {
  let result = '';
  for (const fragment of message) {
    if (typeof fragment === 'string') {
      result += fragment;
    } else {
      const type = fragment[1];
      if (type === undefined) {
        result += util.inspect(fragment[0], {
          colors: opts.colors,
          depth: opts.details ? null : 10,
          maxArrayLength: opts.details ? null : 20,
          maxStringLength: opts.details ? null : undefined,
        });
      } else if (type === 'context') {
        result += '[' + messageToString(fragment[0], opts) + ']';
      } else if (type === 'details') {
        if (opts.details) {
          result += util.inspect(fragment[0], {
            colors: opts.colors,
            depth: null,
            maxArrayLength: null,
            maxStringLength: null,
          });
        }
      } else if (type === 'extra-details') {
        if (opts.details) {
          result += messageToString(fragment[0], opts);
        }
      } else if (type === 'message') {
        result += messageToString(fragment[0], opts);
      } else {
        result +=
          '<unknown>' +
          util.inspect(fragment, {
            colors: opts.colors,
            depth: null,
          });
      }
    }
  }
  return result;
}

function dtToString(dt: T.ZonedDateTime) {
  const date = dt.toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
  const time = dt.toLocaleString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  let off = dt.offset;
  if (off.endsWith(':00')) {
    off = off.substring(0, off.length - 3);
    const offInt = parseInt(off);
    if (isFinite(offInt)) {
      off = offInt.toString();
    }
  }
  return `${date} ${time} ${off}`;
}
