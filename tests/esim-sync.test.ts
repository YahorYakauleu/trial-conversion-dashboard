import { describe, expect, it } from 'vitest';
import { openStore } from '../src/db.js';
import { DAY } from '../src/metrics.js';
import { esimChargeRow, parsePackage, syncEsimAccount } from '../src/providers/esim.js';
import type { StripeLike } from '../src/providers/stripe.js';

const NOW = Date.parse('2026-10-12T10:00:00Z') / 1000;
const TODAY = NOW - (NOW % DAY);
const HISTORY_FROM = Date.parse('2026-10-01T00:00:00Z') / 1000;
// курс в тестах: EUR — 1,25 евро за доллар, USD — как есть
const toUsd = async (amount: number, currency: string) => (currency === 'eur' ? Math.round(amount / 1.25) : amount);
const cfg = { historyFrom: HISTORY_FROM, toUsd };

type Range = { gte?: number; lt?: number };
const charge = (p: Record<string, unknown> = {}) => ({
  id: 'ch_1',
  created: TODAY - 3 * DAY,
  status: 'succeeded',
  captured: true,
  amount: 1000,
  amount_refunded: 0,
  currency: 'eur',
  balance_transaction: { amount: 800, currency: 'usd' },
  description: 'Spain - 5 GB - 7 days',
  metadata: { order_type: 'purchase', user_id: 'u1' },
  payment_intent: 'pi_1',
  customer: 'cus_1',
  outcome: { type: 'authorized', reason: null },
  failure_code: null,
  payment_method_details: { type: 'card', card: { country: 'ES', brand: 'visa', wallet: { type: 'apple_pay' } } },
  ...p,
});

function fakeStripe(data: { charges: ReturnType<typeof charge>[]; events?: { created: number; data: { object: { id: string } } }[]; refunds?: object[] }) {
  const calls: { method: string; created: Range }[] = [];
  const inRange = (created: number, r: Range) => (r.gte === undefined || created >= r.gte) && (r.lt === undefined || created < r.lt);
  const list = (method: string, items: { created: number }[]) => (params: { created: Range }) => {
    calls.push({ method, created: params.created });
    return (async function* () {
      for (const item of items) if (inRange(item.created, params.created)) yield item;
    })();
  };
  const client = {
    charges: { list: list('charges', data.charges), retrieve: async (id: string) => data.charges.find((c) => c.id === id) },
    events: { list: list('events', data.events ?? []) },
    refunds: { list: list('refunds', (data.refunds ?? []) as { created: number }[]) },
  } as unknown as StripeLike;
  return { client, calls };
}

describe('eSIM: списания', () => {
  it('пакет из описания платежа: направление и объём со сроком; другой формат — пусто', () => {
    expect(parsePackage('Spain - 5 GB - 7 days')).toEqual({ destination: 'Spain', package: '5 GB · 7 days' });
    expect(parsePackage('Europe - 500 MB - 1 days')).toEqual({ destination: 'Europe', package: '500 MB · 1 days' });
    expect(parsePackage('Guinea - Bissau - 1 GB - 7 days')).toEqual({ destination: 'Guinea - Bissau', package: '1 GB · 7 days' });
    expect(parsePackage('Top-up')).toEqual({ destination: null, package: null });
    expect(parsePackage(null)).toEqual({ destination: null, package: null });
  });

  it('успешное списание — оборот в USD по зачислению Stripe; отклонённое — сумма попытки по курсу и причина', async () => {
    expect(await esimChargeRow(charge() as never, toUsd)).toMatchObject({
      payment_id: 'ch_1', account: 'esim', approved: true, amount_usd_cents: 800, refunded_usd_cents: 0, reason: null,
      intent_id: 'pi_1', customer_id: 'cus_1', destination: 'Spain', package: '5 GB · 7 days', order_type: 'purchase',
      country: 'ES', payment_method: 'apple_pay', card_brand: 'visa',
    });
    const declined = charge({ id: 'ch_2', status: 'failed', balance_transaction: null, outcome: { type: 'issuer_declined', reason: 'insufficient_funds' } });
    expect(await esimChargeRow(declined as never, toUsd)).toMatchObject({ approved: false, amount_usd_cents: 800, reason: 'insufficient_funds' });
    const refunded = charge({ amount_refunded: 500 });
    expect((await esimChargeRow(refunded as never, toUsd))?.refunded_usd_cents).toBe(400);
  });

  it('холд intro-пакета без захвата и списание в процессе — не платёж', async () => {
    expect(await esimChargeRow(charge({ captured: false }) as never, toUsd)).toBeNull();
    expect(await esimChargeRow(charge({ status: 'pending' }) as never, toUsd)).toBeNull();
  });

  it('синк: бэкфилл по дням с HISTORY_FROM, курсор; захват холда и рефанд — в инкременте; VPN-платежи не задеты', async () => {
    const store = openStore(':memory:');
    store.upsertPayment({
      provider: 'stripe', payment_id: 'ch_vpn', account: 'corp', mid: 'corp', paid_at: TODAY - DAY, amount_usd_cents: 999, refunded_usd_cents: 0,
      country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null,
    });
    const intro = charge({ id: 'ch_intro', created: NOW - 600, captured: true, description: 'Japan - 1 GB - 3 days' });
    const { client, calls } = fakeStripe({
      charges: [charge(), charge({ id: 'ch_2', created: TODAY - 2 * DAY, status: 'failed', outcome: { reason: 'do_not_honor' } }), intro],
      events: [{ created: NOW - 300, data: { object: { id: 'ch_intro' } } }],
      refunds: [{ created: NOW - 200, status: 'succeeded', charge: { id: 'ch_1', amount: 1000, amount_refunded: 1000 } }],
    });
    await syncEsimAccount(store, client, cfg, NOW);

    const rows = store.db.prepare('SELECT payment_id, product, approved, amount_usd_cents, refunded_usd_cents, destination FROM payments ORDER BY payment_id').all();
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { payment_id: 'ch_1', product: 'esim', approved: 1, amount_usd_cents: 800, refunded_usd_cents: 800, destination: 'Spain' },
      { payment_id: 'ch_2', product: 'esim', approved: 0, amount_usd_cents: 800, refunded_usd_cents: 0, destination: 'Spain' },
      { payment_id: 'ch_intro', product: 'esim', approved: 1, amount_usd_cents: 800, refunded_usd_cents: 0, destination: 'Japan' },
      { payment_id: 'ch_vpn', product: 'vpn', approved: 1, amount_usd_cents: 999, refunded_usd_cents: 0, destination: null },
    ]);
    expect(store.getState('stripe', 'esim', 'cursor')).toBe(NOW);
    const days = calls.filter((c) => c.method === 'charges' && c.created.lt! - c.created.gte! === DAY);
    expect(days).toHaveLength(11); // 01.10 — 11.10, сегодня — уже инкрементом

    // повторный синк — без бэкфилла, только последний час
    calls.length = 0;
    await syncEsimAccount(store, client, cfg, NOW + 60);
    expect(calls.filter((c) => c.method === 'charges').every((c) => c.created.gte! >= NOW - 3600)).toBe(true);
  });
});
