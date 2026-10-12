import { describe, expect, it } from 'vitest';
import { openStore } from '../src/db.js';
import { isSyncRunning, runSync, type Source } from '../src/sync.js';

const source = (provider: Source['provider'], account: string, run: Source['run']): Source => ({ provider, account, run });

describe('runSync', () => {
  it('ошибка одного источника не мешает остальным и пишется в журнал', async () => {
    const store = openStore(':memory:');
    await runSync(store, [
      source('stripe', 'org', async () => {
        throw new Error('rate limited');
      }),
      source('solidgate', 'sg', async () => 7),
    ]);
    expect(store.latestRuns()).toEqual([
      { provider: 'solidgate', account: 'sg', last_status: 'ok', last_error: null, last_success_at: expect.any(Number) },
      { provider: 'stripe', account: 'org', last_status: 'error', last_error: 'rate limited', last_success_at: null },
    ]);
  });

  it('kind = backfill без курсора и daily с курсором', async () => {
    const store = openStore(':memory:');
    store.setState('solidgate', 'sg', 'cursor', 1);
    await runSync(store, [source('stripe', 'org', async () => 0), source('solidgate', 'sg', async () => 0)]);
    const kinds = store.db.prepare('SELECT provider, kind FROM sync_runs ORDER BY id').all().map((r) => ({ ...r }));
    expect(kinds).toEqual([
      { provider: 'stripe', kind: 'backfill' },
      { provider: 'solidgate', kind: 'daily' },
    ]);
  });

  it('второй запуск во время синка отклоняется', async () => {
    const store = openStore(':memory:');
    let release!: () => void;
    const first = runSync(store, [
      source('stripe', 'org', () => new Promise((resolve) => (release = () => resolve(0)))),
    ]);
    expect(isSyncRunning()).toBe(true);
    expect(await runSync(store, [])).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(isSyncRunning()).toBe(false);
  });
});
