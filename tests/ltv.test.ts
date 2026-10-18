import { describe, expect, it } from 'vitest';
import { openStore } from '../src/db.js';
import { getLtv, getLtvBreakdown, refreshTrialLtv, resetTrialLtv } from '../src/ltv.js';
import { DAY } from '../src/metrics.js';

const ts = (iso: string) => Date.parse(iso) / 1000;
const started = ts('2026-07-01T12:00:00Z');
const end = started + 7 * DAY;
const NOW = ts('2026-10-17T12:00:00Z'); // июльская когорта: прошло больше 90 дней — окна закрыты
const o = {
  provider: 'all' as const,
  now: NOW,
  from: '2026-07-01',
  to: '2026-07-01',
  timeZones: { stripe: 'UTC', solidgate: 'UTC' },
  filters: {},
  retryWindowDays: 30,
};

function storeWithData() {
  const store = openStore(':memory:');
  const trial = (id: string, customer: string, method: string, at = started, paid = true) =>
    store.upsertTrial({
      provider: 'stripe', account: 'corp', subscription_id: id, trial_started_at: at, trial_ended_at: at + 7 * DAY, first_invoice_id: null,
      first_attempt_succeeded: paid, paid_at: paid ? at + 7 * DAY : null, country: 'US', payment_method: method, card_brand: 'visa', bank: null, customer_id: customer,
    });
  const pay = (id: string, customer: string, at: number, cents: number, refunded = 0) =>
    store.upsertPayment({ provider: 'stripe', payment_id: id, account: 'corp', mid: 'corp', paid_at: at, amount_usd_cents: cents, refunded_usd_cents: refunded, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null, customer_id: customer });
  // a: оплата триала $1, первый период и два продления по $10 (одно частично возвращено)
  trial('a', 'cus_a', 'apple_pay');
  pay('ch_a0', 'cus_a', started, 100);
  pay('ch_a1', 'cus_a', end, 1000);
  pay('ch_a2', 'cus_a', end + 30 * DAY, 1000, 400);
  pay('ch_a3', 'cus_a', end + 60 * DAY, 1000);
  pay('ch_a4', 'cus_a', end + 90 * DAY, 1000); // уже за 90 днями
  // b: оплатил только первый период; потом оформил новый триал — деньги после него уже не этому триалу
  trial('b', 'cus_b', 'google_pay');
  pay('ch_b1', 'cus_b', end, 1000);
  trial('b2', 'cus_b', 'google_pay', started + 40 * DAY);
  pay('ch_b2', 'cus_b', started + 47 * DAY, 1000);
  // c: не оплатил
  trial('c', 'cus_c', 'google_pay', started, false);
  // платёж другого клиента и платёж без клиента — ни к кому
  pay('ch_x', 'cus_x', end, 1000);
  store.upsertPayment({ provider: 'stripe', payment_id: 'ch_y', account: 'corp', mid: 'corp', paid_at: end, amount_usd_cents: 1000, refunded_usd_cents: 0, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null });
  refreshTrialLtv(store.db, 'stripe', 'corp', NOW);
  return store;
}

describe('LTV по когортам триалов', () => {
  it('в строке триала — деньги за 30/60/90 дней за вычетом рефандов и оплаченные периоды; следующий триал клиента забирает его деньги', () => {
    const rows = storeWithData().db.prepare('SELECT subscription_id, ltv_30, ltv_60, ltv_90, periods_90 FROM trials ORDER BY subscription_id').all();
    expect(rows).toEqual([
      { subscription_id: 'a', ltv_30: 1100, ltv_60: 1700, ltv_90: 2700, periods_90: 3 },
      { subscription_id: 'b', ltv_30: 1000, ltv_60: 1000, ltv_90: 1000, periods_90: 1 },
      { subscription_id: 'b2', ltv_30: 1000, ltv_60: 1000, ltv_90: 1000, periods_90: 1 },
      { subscription_id: 'c', ltv_30: 0, ltv_60: 0, ltv_90: 0, periods_90: 0 },
    ]);
  });

  it('когорта: деньги на триал и на оплатившего, доля оплативших второй и третий период; окна закрыты', () => {
    const { totals, series } = getLtv(storeWithData().db, { ...o, granularity: 'day' });
    expect(totals).toMatchObject({
      started: 3, paid: 2, paid_1: 2, ltv_90: 3700, ltv_30_per_trial: 2100 / 3, ltv_90_per_trial: 3700 / 3, ltv_90_per_paid: 1850,
      avg_first_payment: 1000, // первый платёж после триала — $10 у обоих оплативших (оплата триала $1 не в счёт)
      renewed_2: 1, renewed_3: 1, renewal_2: 0.5, renewal_3: 0.5, final_30: true, final_90: true,
    });
    expect(series).toHaveLength(1);
  });

  it('свежая когорта — окна ещё открыты', () => {
    const fresh = getLtv(storeWithData().db, { ...o, now: started + 45 * DAY, granularity: 'day' });
    expect([fresh.totals.final_30, fresh.totals.final_60, fresh.totals.final_90]).toEqual([true, false, false]);
  });

  it('разбивка по измерению', () => {
    const { breakdown } = getLtvBreakdown(storeWithData().db, o, 'payment_method');
    expect(breakdown.map((r) => [r.value, r.started, r.ltv_90])).toEqual([
      ['google_pay', 2, 1000],
      ['apple_pay', 1, 2700],
    ]);
  });

  it('посчитанное с закрытыми окнами не пересчитывается — до сброса (платежам проставили клиента задним числом)', () => {
    const store = storeWithData();
    store.db.prepare("UPDATE payments SET amount_usd_cents = 5000 WHERE payment_id = 'ch_a1'").run();
    refreshTrialLtv(store.db, 'stripe', 'corp', NOW + DAY);
    expect(store.db.prepare("SELECT ltv_30 FROM trials WHERE subscription_id = 'a'").get()).toEqual({ ltv_30: 1100 });
    resetTrialLtv(store.db, 'stripe', 'corp');
    refreshTrialLtv(store.db, 'stripe', 'corp', NOW + DAY);
    expect(store.db.prepare("SELECT ltv_30 FROM trials WHERE subscription_id = 'a'").get()).toEqual({ ltv_30: 5100 });
  });
});
