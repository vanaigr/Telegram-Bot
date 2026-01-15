import util from 'node:util';
import { Temporal as T } from 'temporal-polyfill';

export const Instant = T.Instant;
export type Instant = T.Instant;

export const ZonedDateTime = T.ZonedDateTime;
export type ZonedDateTime = T.ZonedDateTime;

export const PlainDateTime = T.PlainDateTime;
export type PlainDateTime = T.PlainDateTime;

export const PlainDate = T.PlainDate;
export type PlainDate = T.PlainDate;

export const PlainTime = T.PlainTime;
export type PlainTime = T.PlainTime;

export const Duration = T.Duration;
export type Duration = T.Duration;

export const Now = T.Now;

export function min<T extends { epochNanoseconds: bigint }>(init: T, ...vs: (T | undefined)[]): T {
  for (const it of vs) {
    if (it != null && init.epochNanoseconds > it.epochNanoseconds) init = it;
  }
  return init;
}

export function max<T extends { epochNanoseconds: bigint }>(init: T, ...vs: (T | undefined)[]): T {
  for (const it of vs) {
    if (it != null && init.epochNanoseconds < it.epochNanoseconds) init = it;
  }
  return init;
}

export function startOfHour(it: ZonedDateTime): ZonedDateTime {
  return it.round({ smallestUnit: 'hour', roundingMode: 'floor' });
}
export function startOfWeek(it: ZonedDateTime): ZonedDateTime {
  return it.subtract({ days: it.dayOfWeek - 1 }).startOfDay();
}
export function startOfMonth(it: ZonedDateTime): ZonedDateTime {
  return it.subtract({ days: it.day - 1 }).startOfDay();
}
export function startOfQuarter(it: ZonedDateTime): ZonedDateTime {
  const q1 = it.with({ month: 1, day: 1 }).startOfDay();
  const q2 = it.with({ month: 4, day: 1 }).startOfDay();
  const q3 = it.with({ month: 7, day: 1 }).startOfDay();
  const q4 = it.with({ month: 10, day: 1 }).startOfDay();

  const e = it.epochNanoseconds;
  if (e >= q4.epochNanoseconds) return q4;
  else if (e >= q3.epochNanoseconds) return q3;
  else if (e >= q2.epochNanoseconds) return q2;
  else return q1;
}
export function startOfYear(it: ZonedDateTime): ZonedDateTime {
  return it.subtract({ days: it.dayOfYear - 1 }).startOfDay();
}

(T.Instant.prototype as any)[util.inspect.custom] = function () {
  return `<Instant ${JSON.stringify(this)}>`;
};
(T.ZonedDateTime.prototype as any)[util.inspect.custom] = function () {
  return `<ZonedDateTime ${JSON.stringify(this)}>`;
};
(T.Duration.prototype as any)[util.inspect.custom] = function () {
  return `<Duration ${JSON.stringify(this)}>`;
};
(T.PlainDateTime.prototype as any)[util.inspect.custom] = function () {
  return `<PlainDateTime ${JSON.stringify(this)}>`;
};
(T.PlainDate.prototype as any)[util.inspect.custom] = function () {
  return `<PlainDate ${JSON.stringify(this)}>`;
};
(T.PlainTime.prototype as any)[util.inspect.custom] = function () {
  return `<PlainTime ${JSON.stringify(this)}>`;
};
