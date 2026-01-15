
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
