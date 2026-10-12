import { describe, expect, it } from 'vitest';
import { openStore } from '../src/db.js';
import { DAY } from '../src/metrics.js';
import type { ReportFilter, SgCardOrder, SgSubscription } from '../src/providers/solidgate-client.js';
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

function fakeList(subs: SgSubscription[], orders: SgCardOrder[] = []) {
  const calls: { from: number; to: number; filter: ReportFilter }[] = [];
  const orderCalls: { from: number; to: number }[] = [];
  const list = async function* (_keys: unknown, from: number, to: number, filter: ReportFilter) {
    calls.push({ from, to, filter });
    if (from === HISTORY_FROM) yield* subs;
  };
  const listOrders = async function* (_keys: unknown, from: number, to: number) {
    orderCalls.push({ from, to });
    if (from <= HISTORY_FROM && HISTORY_FROM < to) yield* orders;
  };
  return { list, listOrders, calls, orderCalls };
}

describe('syncSolidgateAccount', () => {
  it('бэкфилл: подписки, созданные с HISTORY_FROM, окнами по дню; затем изменения за сутки', async () => {
    const store = openStore(':memory:');
    const { list, listOrders, calls, orderCalls } = fakeList(
      [trialSub, { ...trialSub, id: 'no_trial', product: { id: 'p2', trial: false } }],
      [{ order_id: 'o1', subscription_id: 'sg_1', transactions: [{ card: { country: 'ZAF' } }] }],
    );
    const items = await syncSolidgateAccount(store, acc, { historyFrom: HISTORY_FROM }, NOW, list, listOrders);

    const backfill = calls.filter((c) => c.filter === 'created_at');
    expect(backfill[0]).toEqual({ from: HISTORY_FROM, to: HISTORY_FROM + DAY, filter: 'created_at' });
    expect(backfill.at(-1)!.to).toBe(NOW);
    expect(calls.filter((c) => c.filter === 'updated_at')[0].from).toBe(NOW - DAY);
    expect(items).toBe(1);
    expect(store.getTrial('solidgate', 'sg_1')?.country).toBe('ZA');
    expect(orderCalls[0]).toEqual({ from: HISTORY_FROM - 3600, to: HISTORY_FROM + DAY }); // заказы — с запасом в час
    expect(store.getState('solidgate', 'sgH2H', 'country_done')).toBe(1);
    expect(store.getState('solidgate', 'sgH2H', 'cursor')).toBe(NOW);
  });

  it('ежедневно — только изменения с cursor − 1 день', async () => {
    const store = openStore(':memory:');
    store.setState('solidgate', 'sgH2H', 'cursor', NOW - DAY);
    store.setState('solidgate', 'sgH2H', 'country_done', 1);
    const { list, listOrders, calls } = fakeList([]);
    await syncSolidgateAccount(store, acc, { historyFrom: HISTORY_FROM }, NOW, list, listOrders);
    expect(calls).toEqual([
      { from: NOW - 2 * DAY, to: NOW - DAY, filter: 'updated_at' },
      { from: NOW - DAY, to: NOW, filter: 'updated_at' },
    ]);
  });

  it('база без стран: один раз проходит заказы с HISTORY_FROM и проставляет страны', async () => {
    const store = openStore(':memory:');
    store.upsertTrial({
      provider: 'solidgate', account: 'sgH2H', subscription_id: 'sg_1', trial_started_at: HISTORY_FROM, trial_ended_at: HISTORY_FROM + 7 * DAY,
      first_invoice_id: null, first_attempt_succeeded: null, paid_at: null, country: null,
    });
    store.setState('solidgate', 'sgH2H', 'cursor', NOW - 3600);
    const { list, listOrders, orderCalls } = fakeList([], [{ order_id: 'o1', subscription_id: 'sg_1', transactions: [{ card: { country: 'USA' } }] }]);
    await syncSolidgateAccount(store, acc, { historyFrom: HISTORY_FROM }, NOW, list, listOrders);

    expect(store.getTrial('solidgate', 'sg_1')?.country).toBe('US');
    expect(orderCalls[0].from).toBe(HISTORY_FROM - 3600);
    expect(store.getState('solidgate', 'sgH2H', 'country_done')).toBe(1);

    orderCalls.length = 0;
    await syncSolidgateAccount(store, acc, { historyFrom: HISTORY_FROM }, NOW + 60, list, listOrders);
    expect(orderCalls.every((c) => c.from >= NOW - 3600 - DAY - 3600)).toBe(true); // второй раз — только свежие окна
  });
});
