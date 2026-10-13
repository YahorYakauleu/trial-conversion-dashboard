import { describe, expect, it } from 'vitest';
import { openStore } from '../src/db.js';
import { DAY } from '../src/metrics.js';
import type { ReportFilter, SgCardOrder, SgSubscription } from '../src/providers/solidgate-client.js';
import { syncSolidgateAccount, trialFromSolidgate } from '../src/providers/solidgate.js';

const NOW = Date.parse('2026-10-12T10:00:00Z') / 1000;
const HISTORY_FROM = Date.parse('2026-09-01T00:00:00Z') / 1000;
const acc = { account: 'sgH2H', publicKey: 'pk', secretKey: 'sk' };
// в тестах заказы уже в USD
const cfg = { historyFrom: HISTORY_FROM, toUsd: async (amount: number) => amount };
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
  const orderCalls: { from: number; to: number; filter: ReportFilter }[] = [];
  const list = async function* (_keys: unknown, from: number, to: number, filter: ReportFilter) {
    calls.push({ from, to, filter });
    if (from === HISTORY_FROM) yield* subs;
  };
  const listOrders = async function* (_keys: unknown, from: number, to: number, filter: ReportFilter) {
    orderCalls.push({ from, to, filter });
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
    const items = await syncSolidgateAccount(store, acc, cfg, NOW, list, listOrders);

    const backfill = calls.filter((c) => c.filter === 'created_at');
    expect(backfill[0]).toEqual({ from: HISTORY_FROM, to: HISTORY_FROM + DAY, filter: 'created_at' });
    expect(backfill.at(-1)!.to).toBe(NOW);
    expect(calls.filter((c) => c.filter === 'updated_at')[0].from).toBe(NOW - DAY);
    expect(items).toBe(1);
    expect(store.getTrial('solidgate', 'sg_1')?.country).toBe('ZA');
    expect(orderCalls[0]).toEqual({ from: HISTORY_FROM - 3600, to: HISTORY_FROM + DAY, filter: 'created_at' }); // заказы — с запасом в час
    expect(store.getState('solidgate', 'sgH2H', 'details_version')).toBe(2);
    expect(store.getState('solidgate', 'sgH2H', 'cursor')).toBe(NOW);
  });

  it('ежедневно — только изменения с cursor − 1 день', async () => {
    const store = openStore(':memory:');
    store.setState('solidgate', 'sgH2H', 'cursor', NOW - DAY);
    store.setState('solidgate', 'sgH2H', 'details_version', 2);
    const { list, listOrders, calls } = fakeList([]);
    await syncSolidgateAccount(store, acc, cfg, NOW, list, listOrders);
    expect(calls).toEqual([
      { from: NOW - 2 * DAY, to: NOW - DAY, filter: 'updated_at' },
      { from: NOW - DAY, to: NOW, filter: 'updated_at' },
    ]);
  });

  it('попытки из отчёта подписок, причины отказа и рефанды — из отчёта заказов', async () => {
    const store = openStore(':memory:');
    const withAttempts: SgSubscription = {
      ...trialSub,
      invoices: {
        t1: {
          id: 't1', status: 'success', amount: 999, created_at: '2026-10-04 10:00:00', subscription_term_number: 1,
          orders: {
            o1: { id: 'o1', status: 'auth_failed', created_at: '2026-10-04 10:00:00' },
            o2: { id: 'o2', status: 'settle_ok', created_at: '2026-10-05 10:00:00' },
          },
        },
      },
    };
    const { list, listOrders } = fakeList(
      [withAttempts],
      [
        { order_id: 'o1', subscription_id: 'sg_1', error_code: '3.02', payment_method: 'recurring' },
        { order_id: 'o2', subscription_id: 'sg_1', refunded_amount: 999, payment_method: 'apple-pay' },
      ],
    );
    await syncSolidgateAccount(store, acc, cfg, NOW, list, listOrders);

    expect(store.getAttempts('solidgate', 'sg_1').map((a) => [a.attempt_id, a.approved, a.reason, a.refunded])).toEqual([
      ['o1', false, '3.02', false],
      ['o2', true, null, true],
    ]);
    expect(store.getTrial('solidgate', 'sg_1')?.payment_method).toBe('apple_pay');
  });

  it('база до версии 2: один раз проходит подписки и заказы с HISTORY_FROM заново', async () => {
    const store = openStore(':memory:');
    store.setState('solidgate', 'sgH2H', 'cursor', NOW - 3600);
    store.setState('solidgate', 'sgH2H', 'country_done', 1); // старый флаг ничего не значит
    const { list, listOrders, calls, orderCalls } = fakeList(
      [trialSub],
      [{ order_id: 'o1', subscription_id: 'sg_1', payment_method: 'google-pay', transactions: [{ card: { country: 'USA', bank: 'SUTTON BANK' } }] }],
    );
    await syncSolidgateAccount(store, acc, cfg, NOW, list, listOrders);

    expect(calls[0]).toEqual({ from: HISTORY_FROM, to: HISTORY_FROM + DAY, filter: 'created_at' });
    expect(orderCalls[0].from).toBe(HISTORY_FROM - 3600);
    expect(store.getTrial('solidgate', 'sg_1')).toMatchObject({ country: 'US', payment_method: 'google_pay', bank: 'SUTTON BANK' });
    expect(store.getState('solidgate', 'sgH2H', 'details_version')).toBe(2);

    calls.length = 0;
    await syncSolidgateAccount(store, acc, cfg, NOW + 60, list, listOrders);
    expect(calls.every((c) => c.filter === 'updated_at')).toBe(true); // второй раз — только свежие изменения
  });

  it('заказы: платежи для оборота и MID триала; догрузка заказов с HISTORY_FROM — один раз; дальше заказы по дате изменения', async () => {
    const store = openStore(':memory:');
    store.setState('solidgate', 'sgH2H', 'cursor', NOW - 60);
    store.setState('solidgate', 'sgH2H', 'details_version', 2);
    store.setState('solidgate', 'sgH2H', 'payments_version', 1); // база с оборотом, но без MID триала
    store.upsertTrial({ ...trialFromSolidgate(trialSub, 'sgH2H')! });
    const renewal: SgCardOrder = {
      order_id: 'o9', subscription_id: 'sg_1', status: 'refunded', created_at: '2026-09-01 12:00:00', amount: 1199, currency: 'USD',
      processing_amount: 1199, processing_currency: 'USD', refunded_amount: 1199, mid: 'mid-1',
    };
    const { list, listOrders, calls, orderCalls } = fakeList([], [renewal, { order_id: 'o0', status: 'auth_ok', amount: 0, currency: 'USD', created_at: '2026-09-01 12:00:00' }]);
    await syncSolidgateAccount(store, acc, cfg, NOW, list, listOrders);

    expect(store.db.prepare('SELECT payment_id, mid, amount_usd_cents, refunded_usd_cents FROM payments').all()).toEqual([
      { payment_id: 'o9', mid: 'mid-1', amount_usd_cents: 1199, refunded_usd_cents: 1199 },
    ]);
    expect(orderCalls[0]).toEqual({ from: HISTORY_FROM - 3600, to: HISTORY_FROM + DAY, filter: 'created_at' });
    expect(calls.every((c) => c.filter === 'updated_at')).toBe(true); // подписки заново не грузятся
    expect(store.getTrial('solidgate', 'sg_1')?.mid).toBe('mid-1');
    expect(store.getState('solidgate', 'sgH2H', 'orders_version')).toBe(2);

    orderCalls.length = 0;
    await syncSolidgateAccount(store, acc, cfg, NOW + 60, list, listOrders);
    expect(orderCalls.length).toBeGreaterThan(0);
    expect(orderCalls.every((c) => c.filter === 'updated_at')).toBe(true);
  });
});

