import { AsyncLocalStorage } from 'node:async_hooks';

const stopSignal = new AsyncLocalStorage<AbortSignal>();

/**
 * Runs `fn` with a stop signal that every sleep() and until() inside it obeys: once it fires they
 * throw instead of waiting out their time, so a stopped run ends in moments, not minutes.
 */
export const stoppable = <T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> => stopSignal.run(signal, fn);

/** Throws if the run this code belongs to was stopped. */
export const checkStopped = () => stopSignal.getStore()?.throwIfAborted();

/** Waits `ms`. Inside stoppable(), throws as soon as the run is stopped. */
export function sleep(ms: number): Promise<void> {
  const signal = stopSignal.getStore();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** Polls `test` until it returns true or `timeout` ms pass. Resolves to whether it came true. */
export async function until(test: () => boolean | Promise<boolean>, timeout: number, interval = 100): Promise<boolean> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await test()) return true;
    await sleep(interval);
  }
  return Boolean(await test());
}

/**
 * Runs `fn` over `items` with at most `limit` running at once. Results keep the input order. After a
 * failure no new item starts; the ones running finish, then the first error is thrown.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed: { error: unknown } | null = null;
  const worker = async () => {
    while (next < items.length && !failed) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        failed ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failed) throw (failed as { error: unknown }).error;
  return results;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  const tenths = Math.round(ms / 100) / 10;
  if (tenths < 60) return `${tenths.toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** A probability as "1 in N". */
export function formatOdds(chance: number): string {
  if (!chance) return 'never';
  const n = 1 / chance;
  return `1 in ${n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(1)}`;
}

export const formatPercent = (value: number, digits = 2) => `${(value * 100).toFixed(digits)}%`;

/** A multiplier the way slots print them: 2.4×, 1,250×. */
export const formatMultiplier = (value: number) => `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}×`;

/** An RGS amount (integer, six decimals) as money: 1200000 → "1.20". */
export const formatAmount = (amount: number) => (amount / 1_000_000).toFixed(2);

export const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

export const clip = (text: unknown, length = 160) => {
  const value = String(text).replace(/\s+/g, ' ').trim();
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
};

/** The message of anything thrown. */
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
