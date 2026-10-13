import { describe, expect, it } from 'vitest';
import { openStore } from '../src/db.js';
import { DAY } from '../src/metrics.js';
import { syncStripeAccount, type StripeLike } from '../src/providers/stripe.js';

const NOW = Date.parse('2026-10-12T10:00:00Z') / 1000;
const TODAY = NOW - (NOW % DAY);
const HISTORY_FROM = Date.parse('2026-09-01T00:00:00Z') / 1000;
// валюта зачисления в тестах — всегда USD
const cfg = { historyFrom: HISTORY_FROM, toUsd: async (amount: number) => amount };
const HOUR = 3600;
// Окна бэкфилла — сутки, окна ежедневного синка — час
const isWindow = (c: { params: { created: Range } }, size: number) => c.params.created.lt! - c.params.created.gte! === size;

type Range = { gte?: number; lt?: number };
type Call = { method: string; params: { created: Range; [key: string]: unknown }; options?: { apiVersion?: string } };
type Item = { created: number };

function fakeStripe(data: { subs: Item[]; invoices: Item[]; events: Item[]; charges?: Item[]; refunds?: Item[] }) {
  const calls: Call[] = [];
  const inRange = (created: number, r: Range) =>
    (r.gte === undefined || created >= r.gte) && (r.lt === undefined || created < r.lt);
  const list = (method: string, items: Item[]) => (params: Call['params'], options?: Call['options']) => {
    calls.push({ method, params, options });
    return (async function* () {
      for (const item of items) if (inRange(item.created, params.created)) yield item;
    })();
  };
  const client = {
    subscriptions: { list: list('subscriptions', data.subs) },
    invoices: { list: list('invoices', data.invoices) },
    events: { list: list('events', data.events) },
    charges: { list: list('charges', data.charges ?? []) },
    refunds: { list: list('refunds', data.refunds ?? []) },
  } as unknown as StripeLike;
  return { client, calls };
}

const trialEnd = TODAY - 10 * DAY;
const subscription = { id: 'sub_1', created: trialEnd - 3 * DAY, trial_start: trialEnd - 3 * DAY, trial_end: trialEnd };
const invoice = (p: object) => ({
  id: 'in_1',
  created: trialEnd,
  billing_reason: 'subscription_cycle',
  amount_due: 999,
  attempt_count: 1,
  status: 'open',
  status_transitions: { finalized_at: trialEnd + 3600, paid_at: null },
  parent: { subscription_details: { subscription: 'sub_1' } },
  ...p,
});

describe('syncStripeAccount', () => {
  it('бэкфилл: подписки, затем инвойсы; сохраняет курсор', async () => {
    const store = openStore(':memory:');
    const { client, calls } = fakeStripe({ subs: [subscription], invoices: [invoice({})], events: [] });
    const items = await syncStripeAccount(store, client, 'org', cfg, NOW);

    expect(store.getTrial('stripe', 'sub_1')).toMatchObject({
      first_invoice_id: 'in_1',
      first_attempt_succeeded: false,
      paid_at: null,
    });
    expect(store.getState('stripe', 'org', 'cursor')).toBe(NOW);
    expect(calls.find((c) => c.method === 'subscriptions')!.params).toMatchObject({
      status: 'all',
      created: { gte: HISTORY_FROM, lt: HISTORY_FROM + DAY },
    });
    expect(calls.find((c) => c.method === 'invoices')!.params.created.gte).toBe(HISTORY_FROM);
    expect(items).toBe(2); // подписка + первый платный инвойс
  });

  it('бэкфилл обходит каждый день с HISTORY_FROM до вчера ровно один раз', async () => {
    const store = openStore(':memory:');
    const { client, calls } = fakeStripe({ subs: [], invoices: [], events: [] });
    await syncStripeAccount(store, client, 'corp', cfg, NOW);

    const backfillDays = (method: string) =>
      calls.filter((c) => c.method === method && isWindow(c, DAY)).map((c) => c.params.created.gte!);
    const expected = Array.from({ length: (TODAY - HISTORY_FROM) / DAY }, (_, i) => HISTORY_FROM + i * DAY);
    expect(backfillDays('subscriptions').sort()).toEqual(expected);
    expect(backfillDays('invoices').sort()).toEqual(expected);
    expect(store.getState('stripe', 'corp', 'subs_day')).toBe(TODAY);
  });

  it('ежедневно: события об оплате на ретрае обновляют paid_at', async () => {
    const store = openStore(':memory:');
    await syncStripeAccount(
      store,
      fakeStripe({ subs: [subscription], invoices: [invoice({})], events: [] }).client,
      'org',
      cfg,
      NOW,
    );

    const later = NOW + DAY;
    const paidEvent = {
      created: later - 3600,
      type: 'invoice.paid',
      data: {
        object: invoice({
          status: 'paid',
          attempt_count: 2,
          status_transitions: { finalized_at: trialEnd + 3600, paid_at: later - 3600 },
        }),
      },
    };
    const { client, calls } = fakeStripe({ subs: [], invoices: [], events: [paidEvent] });
    await syncStripeAccount(store, client, 'org', cfg, later);

    expect(store.getTrial('stripe', 'sub_1')).toMatchObject({ first_attempt_succeeded: false, paid_at: later - 3600 });
    expect(calls.some((c) => c.method === 'invoices')).toBe(false);
    // с прошлого синка с запасом в час, часовыми окнами без пропусков до текущего момента
    const eventWindows = calls.filter((c) => c.method === 'events').map((c) => c.params.created);
    expect(calls.find((c) => c.method === 'events')!.params).toMatchObject({ types: ['invoice.paid', 'invoice.payment_failed'] });
    expect(eventWindows[0]).toEqual({ gte: NOW - HOUR, lt: NOW });
    expect(eventWindows.every((w, i) => i === 0 || w.gte === eventWindows[i - 1].lt)).toBe(true);
    expect(eventWindows.at(-1)!.lt!).toBeGreaterThanOrEqual(later);
  });

  it('события по чужим подпискам и инвойсам без подписки пропускаются', async () => {
    const store = openStore(':memory:');
    store.setState('stripe', 'org', 'cursor', NOW - DAY);
    const foreign = { created: NOW - 3600, data: { object: invoice({ parent: { subscription_details: { subscription: 'sub_x' } } }) } };
    const orphan = { created: NOW - 3600, data: { object: invoice({ parent: null }) } };
    const items = await syncStripeAccount(
      store,
      fakeStripe({ subs: [], invoices: [], events: [foreign, orphan] }).client,
      'org',
      cfg,
      NOW,
    );
    expect(items).toBe(0);
    expect(store.countTrials()).toBe(0);
  });

  it('продолжает прерванный бэкфилл с сохранённого дня', async () => {
    const store = openStore(':memory:');
    store.setState('stripe', 'org', 'subs_day', TODAY - 2 * DAY);
    const { client, calls } = fakeStripe({ subs: [], invoices: [], events: [] });
    await syncStripeAccount(store, client, 'org', cfg, NOW);
    expect(calls.filter((c) => c.method === 'subscriptions')[0].params.created.gte).toBe(TODAY - 2 * DAY);
  });

  it('списания первого инвойса становятся попытками (старая версия API — ради ссылки на инвойс); рефанды помечаются', async () => {
    const store = openStore(':memory:');
    const charges = [
      { id: 'ch_1', created: trialEnd + 3700, status: 'failed', amount_refunded: 0, outcome: { type: 'issuer_declined', reason: 'insufficient_funds' }, invoice: 'in_1' },
      { id: 'ch_2', created: trialEnd + 2 * DAY, status: 'succeeded', amount_refunded: 0, outcome: { type: 'authorized' }, invoice: 'in_1' },
      { id: 'ch_other', created: trialEnd + 3700, status: 'succeeded', amount_refunded: 0, outcome: { type: 'authorized' }, invoice: 'in_renewal' },
    ];
    const { client, calls } = fakeStripe({ subs: [subscription], invoices: [invoice({})], events: [], charges });
    await syncStripeAccount(store, client, 'corp', cfg, NOW);

    expect(store.getAttempts('stripe', 'sub_1').map((a) => [a.attempt_id, a.approved, a.reason])).toEqual([
      ['ch_1', false, 'insufficient_funds'],
      ['ch_2', true, null],
    ]);
    expect(calls.find((c) => c.method === 'charges')!.options).toEqual({ apiVersion: '2024-06-20' });
    expect(store.getState('stripe', 'corp', 'details_version')).toBe(2);

    const later = NOW + DAY;
    await syncStripeAccount(store, fakeStripe({ subs: [], invoices: [], events: [], refunds: [{ created: later - 60, charge: 'ch_2', status: 'succeeded' } as Item] }).client, 'corp', cfg, later);
    expect(store.getAttempts('stripe', 'sub_1')[1].refunded).toBe(true);
  });

  it('база до версии 2: один раз проходит подписки (с картой клиента) и списания, инвойсы не трогает', async () => {
    const store = openStore(':memory:');
    store.setState('stripe', 'corp', 'cursor', NOW - 3600);
    store.setState('stripe', 'corp', 'country_done', 1); // старый флаг ничего не значит
    const withCard = {
      ...subscription,
      customer: { id: 'cus_1', invoice_settings: { default_payment_method: { type: 'card', card: { country: 'SA', brand: 'visa', wallet: { type: 'google_pay' } } } } },
    };
    const { client, calls } = fakeStripe({ subs: [withCard], invoices: [], events: [] });
    await syncStripeAccount(store, client, 'corp', cfg, NOW);

    const subsCalls = calls.filter((c) => c.method === 'subscriptions');
    expect(subsCalls[0].params).toMatchObject({
      created: { gte: HISTORY_FROM, lt: HISTORY_FROM + DAY },
      expand: ['data.customer.invoice_settings.default_payment_method'],
    });
    expect(calls.filter((c) => c.method === 'charges' && isWindow(c, DAY))).toHaveLength((TODAY - HISTORY_FROM) / DAY);
    expect(calls.some((c) => c.method === 'invoices')).toBe(false);
    expect(store.getTrial('stripe', 'sub_1')).toMatchObject({ country: 'SA', payment_method: 'google_pay', card_brand: 'visa' });
    expect(store.getState('stripe', 'corp', 'details_version')).toBe(2);

    calls.length = 0;
    await syncStripeAccount(store, client, 'corp', cfg, NOW + 60);
    expect(calls.filter((c) => c.method === 'subscriptions').every((c) => isWindow(c, HOUR))).toBe(true); // второй раз — только свежие
  });

  it('повторный синк сразу после предыдущего читает только последний час, а не сутки', async () => {
    const store = openStore(':memory:');
    store.setState('stripe', 'corp', 'cursor', NOW - 60);
    store.setState('stripe', 'corp', 'details_version', 2);
    store.setState('stripe', 'corp', 'payments_version', 1);
    const { client, calls } = fakeStripe({ subs: [], invoices: [], events: [] });
    await syncStripeAccount(store, client, 'corp', cfg, NOW);

    for (const method of ['subscriptions', 'events', 'charges']) {
      const windows = calls.filter((c) => c.method === method).map((c) => c.params.created);
      expect(windows).toEqual([{ gte: NOW - 60 - HOUR, lt: NOW - 60 }, { gte: NOW - 60, lt: NOW - 60 + HOUR }]);
    }
    expect(calls.find((c) => c.method === 'refunds')!.params.created).toEqual({ gte: NOW - 60 - HOUR });
  });

  const paidCharge = (p: Record<string, unknown>) => ({
    id: 'ch_9', created: TODAY - 5 * DAY, status: 'succeeded', captured: true, amount: 1199, amount_refunded: 0,
    balance_transaction: { amount: 1199, currency: 'usd' }, payment_method_details: { type: 'card', card: { country: 'US', brand: 'visa' } },
    invoice: 'in_renewal', ...p,
  });
  const payments = (store: ReturnType<typeof openStore>) =>
    store.db.prepare('SELECT payment_id, mid, amount_usd_cents, refunded_usd_cents FROM payments').all();

  it('оборот: бэкфилл сохраняет успешные списания (любые, не только первых инвойсов) и отдельной догрузки не делает', async () => {
    const store = openStore(':memory:');
    const { client, calls } = fakeStripe({ subs: [], invoices: [], events: [], charges: [paidCharge({}), paidCharge({ id: 'ch_failed', status: 'failed' })] });
    await syncStripeAccount(store, client, 'corp', cfg, NOW);

    expect(payments(store)).toEqual([{ payment_id: 'ch_9', mid: 'corp', amount_usd_cents: 1199, refunded_usd_cents: 0 }]);
    expect(calls.find((c) => c.method === 'charges')!.params.expand).toEqual(['data.balance_transaction']);
    expect(calls.filter((c) => c.method === 'charges' && isWindow(c, DAY))).toHaveLength((TODAY - HISTORY_FROM) / DAY);
    expect(store.getState('stripe', 'corp', 'payments_version')).toBe(1);
  });

  it('оборот: база без платежей один раз проходит списания с HISTORY_FROM; рефанд позже обновляет возвращённую сумму', async () => {
    const store = openStore(':memory:');
    store.setState('stripe', 'corp', 'cursor', NOW - 60);
    store.setState('stripe', 'corp', 'details_version', 2);
    const { client, calls } = fakeStripe({ subs: [], invoices: [], events: [], charges: [paidCharge({})] });
    await syncStripeAccount(store, client, 'corp', cfg, NOW);

    expect(calls.filter((c) => c.method === 'charges' && isWindow(c, DAY))).toHaveLength((TODAY - HISTORY_FROM) / DAY);
    expect(calls.some((c) => c.method === 'subscriptions' && isWindow(c, DAY))).toBe(false);
    expect(store.getState('stripe', 'corp', 'payments_version')).toBe(1);

    const later = NOW + DAY;
    const refund = { created: later - 60, status: 'succeeded', charge: { id: 'ch_9', amount: 1199, amount_refunded: 600 } };
    const next = fakeStripe({ subs: [], invoices: [], events: [], refunds: [refund as unknown as Item] });
    await syncStripeAccount(store, next.client, 'corp', cfg, later);
    expect(payments(store)).toEqual([{ payment_id: 'ch_9', mid: 'corp', amount_usd_cents: 1199, refunded_usd_cents: 600 }]);
    expect(next.calls.find((c) => c.method === 'refunds')!.params.expand).toEqual(['data.charge']);
    expect(next.calls.some((c) => c.method === 'charges' && isWindow(c, DAY))).toBe(false); // догрузка — один раз
  });
});

