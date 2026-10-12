import { describe, expect, it } from 'vitest';
import { openStore } from '../src/db.js';
import { DAY } from '../src/metrics.js';
import { isSyncRunning, needsStartupSync, runSync, type Source } from '../src/sync.js';

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

describe('needsStartupSync', () => {
  const NOW = 1_800_000_000;
  const sources = [source('stripe', 'corp', async () => 0), source('solidgate', 'sgH2H', async () => 0)];

  it('нужен, если первая выгрузка какого-то источника не закончена', () => {
    const store = openStore(':memory:');
    store.setState('stripe', 'corp', 'cursor', NOW - 3600);
    expect(needsStartupSync(store, sources, NOW)).toBe(true);
  });

  it('нужен, если последний успешный синк любого источника старше суток', () => {
    const store = openStore(':memory:');
    store.setState('stripe', 'corp', 'cursor', NOW - 3600);
    store.setState('solidgate', 'sgH2H', 'cursor', NOW - DAY - 1);
    expect(needsStartupSync(store, sources, NOW)).toBe(true);
  });

  it('не нужен, если все синкались меньше суток назад', () => {
    const store = openStore(':memory:');
    store.setState('stripe', 'corp', 'cursor', NOW - DAY);
    store.setState('solidgate', 'sgH2H', 'cursor', NOW - 60);
    expect(needsStartupSync(store, sources, NOW)).toBe(false);
  });
});
