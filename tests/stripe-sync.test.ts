import { describe, expect, it } from 'vitest';
import { openStore } from '../src/db.js';
import { DAY } from '../src/metrics.js';
import { syncStripeAccount, type StripeLike } from '../src/providers/stripe.js';

const NOW = Date.parse('2026-10-12T10:00:00Z') / 1000;
const TODAY = NOW - (NOW % DAY);
const HISTORY_FROM = Date.parse('2026-09-01T00:00:00Z') / 1000;
const cfg = { historyFrom: HISTORY_FROM };

type Range = { gte?: number; lt?: number };
type Call = { method: string; params: { created: Range; [key: string]: unknown } };

function fakeStripe(data: { subs: { created: number }[]; invoices: { created: number }[]; events: { created: number }[] }) {
  const calls: Call[] = [];
  const inRange = (created: number, r: Range) =>
    (r.gte === undefined || created >= r.gte) && (r.lt === undefined || created < r.lt);
  const list = (method: string, items: { created: number }[]) => (params: Call['params']) => {
    calls.push({ method, params });
    return (async function* () {
      for (const item of items) if (inRange(item.created, params.created)) yield item;
    })();
  };
  const client = {
    subscriptions: { list: list('subscriptions', data.subs) },
    invoices: { list: list('invoices', data.invoices) },
    events: { list: list('events', data.events) },
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
      calls.filter((c) => c.method === method && c.params.created.lt !== undefined).map((c) => c.params.created.gte!);
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
    expect(calls.find((c) => c.method === 'events')!.params).toMatchObject({
      types: ['invoice.paid', 'invoice.payment_failed'],
      created: { gte: NOW - DAY },
    });
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

  it('база без стран: один раз проходит подписки с HISTORY_FROM (с картой клиента), инвойсы не трогает', async () => {
    const store = openStore(':memory:');
    store.setState('stripe', 'corp', 'cursor', NOW - 3600);
    const withCard = {
      ...subscription,
      customer: { id: 'cus_1', invoice_settings: { default_payment_method: { card: { country: 'SA' } } } },
    };
    const { client, calls } = fakeStripe({ subs: [withCard], invoices: [], events: [] });
    await syncStripeAccount(store, client, 'corp', cfg, NOW);

    const subsCalls = calls.filter((c) => c.method === 'subscriptions');
    expect(subsCalls[0].params).toMatchObject({
      created: { gte: HISTORY_FROM, lt: HISTORY_FROM + DAY },
      expand: ['data.customer.invoice_settings.default_payment_method'],
    });
    expect(calls.some((c) => c.method === 'invoices')).toBe(false);
    expect(store.getTrial('stripe', 'sub_1')?.country).toBe('SA');
    expect(store.getState('stripe', 'corp', 'country_done')).toBe(1);

    calls.length = 0;
    await syncStripeAccount(store, client, 'corp', cfg, NOW + 60);
    expect(calls.filter((c) => c.method === 'subscriptions')).toHaveLength(1); // второй раз — только свежие
  });
});
