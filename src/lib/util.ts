import * as L from './log.ts'
import * as T from './temporal.ts'

export async function timedAsync<const R, const A extends unknown[]>(
  fn: (...args: A) => R,
  ...args: A
): Promise<[Awaited<R>, number]> {
  const b = performance.now();
  const result = await fn(...args);
  const e = performance.now();
  return [result, Math.round((e - b) * 100) / 100];
}

export function envVarValid(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

type RequestParam = Omit<RequestInit, 'signal' | 'log' | 'url'> & { url: URL; log: L.Log };
export async function request<R = unknown>({ url, log, ...options }: RequestParam) {
  try {
    const resp = await fetch(url, { ...options });
    if (!resp.ok) {
      const bodyMessage: L.Message = await resp.text().then(
        (it) => ['Body: ', [it]],
        (e) => ['Body error: ', [e]],
      );
      log.E('Response status: ', [resp.status], '\n', ...bodyMessage);
      return status('error.response');
    }
    return result('ok', (await resp.json()) as R);
  } catch (err) {
    log.E('Unexpected response error: ', [err]);
    return status('error.response');
  }
}

export type Result<S, D> = { status: S; data: D };
export function result<const S, D>(status: S, data: D): Result<S, D> {
  return { status, data };
}
export function status<const S, D>(status: S): Result<S, undefined> {
  return { status, data: undefined };
}

export function delay(until: T.Instant) {
  return new Promise((s) => {
    const check = () => {
      const diff = until.since(T.Now.instant());
      if (diff.sign <= 0) {
        s(undefined);
        return;
      }
      setTimeout(check, diff.total('milliseconds'));
    };
    check();
  });
}

// NOTE: use this instead of `Promise.all` since in the case of an
// unexpected error, you rarely want other tasks to still be executing.
export async function all<T extends readonly unknown[] | []>(
  values: T,
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  await Promise.allSettled(values);
  // eslint-disable-next-line local/no-promise-all
  return await Promise.all(values);
}
