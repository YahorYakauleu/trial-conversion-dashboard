import { afterEach, describe, expect, it, vi } from 'vitest';
import { forEachWindow, RATE_LIMIT_PAUSES_MS } from '../src/days.js';

describe('forEachWindow', () => {
  afterEach(() => vi.useRealTimers());

  it('окно, упёршееся в лимит запросов (429), повторяется после паузы; прогресс — после успешной пачки', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: number[] = [];
    const progress: number[] = [];
    let limited = 2;
    const done = forEachWindow(0, 2, 1, 2, async (w) => {
      calls.push(w);
      if (w === 1 && limited-- > 0) throw Object.assign(new Error('Request rate limit exceeded'), { statusCode: 429 });
    }, (next) => progress.push(next));
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_PAUSES_MS[0] + RATE_LIMIT_PAUSES_MS[1]);
    await done;
    expect(calls).toEqual([0, 1, 1, 1]);
    expect(progress).toEqual([2]);
  });

  it('другие ошибки и лимит, не прошедший за все паузы, — пробрасываются', async () => {
    await expect(forEachWindow(0, 1, 1, 1, async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn(async () => { throw Object.assign(new Error('Request rate limit exceeded'), { statusCode: 429 }); });
    const done = expect(forEachWindow(0, 1, 1, 1, fn)).rejects.toThrow('rate limit');
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_PAUSES_MS.reduce((a, b) => a + b, 0));
    await done;
    expect(fn).toHaveBeenCalledTimes(RATE_LIMIT_PAUSES_MS.length + 1);
  });
});
