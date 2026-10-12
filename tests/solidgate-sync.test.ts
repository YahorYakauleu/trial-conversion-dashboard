import { describe, expect, it } from 'vitest';
import { openStore } from '../src/db.js';
import { DAY } from '../src/metrics.js';
import type { ReportFilter, SgSubscription } from '../src/providers/solidgate-client.js';
import { syncSolidgateAccount } from '../src/providers/solidgate.js';

const NOW = Date.parse('2026-10-12T10:00:00Z') / 1000;
const HISTORY_FROM = Date.parse('2026-09-01T00:00:00Z') / 1000;
const acc = { account: 'sgH2H', publicKey: 'pk', secretKey: 'sk' };
const trialSub: SgSubscription = {
  id: 'sg_1',
  status: 'active',
  started_at: '2026-10-01 10:00:00',
  updated_at: '2026-10-04 10:00:00',
  product: { id: 'p', trial: true, trial_period: 4320 },
  invoices: {},
};

function fakeList(subs: SgSubscription[]) {
  const calls: { from: number; to: number; filter: ReportFilter }[] = [];
  const list = async function* (_keys: unknown, from: number, to: number, filter: ReportFilter) {
    calls.push({ from, to, filter });
    if (from === HISTORY_FROM) yield* subs;
  };
  return { list, calls };
}

describe('syncSolidgateAccount', () => {
  it('бэкфилл: подписки, созданные с HISTORY_FROM, окнами по дню; затем изменения за сутки', async () => {
    const store = openStore(':memory:');
    const { list, calls } = fakeList([trialSub, { ...trialSub, id: 'no_trial', product: { id: 'p2', trial: false } }]);
    const items = await syncSolidgateAccount(store, acc, { historyFrom: HISTORY_FROM }, NOW, list);

    const backfill = calls.filter((c) => c.filter === 'created_at');
    expect(backfill[0]).toEqual({ from: HISTORY_FROM, to: HISTORY_FROM + DAY, filter: 'created_at' });
    expect(backfill.at(-1)!.to).toBe(NOW);
    expect(calls.filter((c) => c.filter === 'updated_at')[0].from).toBe(NOW - DAY);
    expect(items).toBe(1);
    expect(store.getTrial('solidgate', 'sg_1')).not.toBeNull();
    expect(store.getState('solidgate', 'sgH2H', 'cursor')).toBe(NOW);
  });

  it('ежедневно — только изменения с cursor − 1 день', async () => {
    const store = openStore(':memory:');
    store.setState('solidgate', 'sgH2H', 'cursor', NOW - DAY);
    const { list, calls } = fakeList([]);
    await syncSolidgateAccount(store, acc, { historyFrom: HISTORY_FROM }, NOW, list);
    expect(calls).toEqual([
      { from: NOW - 2 * DAY, to: NOW - DAY, filter: 'updated_at' },
      { from: NOW - DAY, to: NOW, filter: 'updated_at' },
    ]);
  });
});
