import { describe, expect, it } from 'vitest';
import { openStore, type EsimChargeRow } from '../src/db.js';
import { getHealth, getHealthBreakdown, getHealthReasons, getRepeat, getRepeatBreakdown } from '../src/esim.js';
import { DAY } from '../src/metrics.js';

const ts = (iso: string) => Date.parse(iso) / 1000;
const NOW = ts('2027-01-15T12:00:00Z'); // все окна (30 и 90 дней) у октябрьских когорт закрыты
const opts = { filters: {}, from: '2026-10-01', to: '2026-10-31', timeZones: { stripe: 'UTC', solidgate: 'UTC' }, now: NOW };

let seq = 0;
const charge = (customer: string, intent: string, iso: string, p: Partial<EsimChargeRow> = {}): EsimChargeRow => ({
  provider: 'stripe', payment_id: `ch_${++seq}`, account: 'esim', mid: 'esim', paid_at: ts(iso), amount_usd_cents: 800, refunded_usd_cents: 0,
  country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null,
  approved: true, reason: null, intent_id: intent, customer_id: customer, destination: 'Spain', package: '5 GB · 7 days', order_type: 'purchase',
  ...p,
});

// A: первая оплата — отказ, потом прошла; через 9 дней пополнение. B: одна покупка (Япония).
// C: оплата так и не прошла — не клиент. D: вторая покупка через 48 дней (вне окна 30, внутри 90). VPN-платёж — не в счёт.
function seeded() {
  const store = openStore(':memory:');
  store.upsertEsimCharge(charge('A', 'pi_a1', '2026-10-01T10:00:00Z', { approved: false, reason: 'insufficient_funds' }));
  store.upsertEsimCharge(charge('A', 'pi_a1', '2026-10-01T10:02:00Z'));
  store.upsertEsimCharge(charge('A', 'pi_a2', '2026-10-10T10:00:00Z', { amount_usd_cents: 500, order_type: 'topup', package: '1 GB · 7 days' }));
  store.upsertEsimCharge(charge('B', 'pi_b1', '2026-10-02T10:00:00Z', { amount_usd_cents: 1000, destination: 'Japan', package: '3 GB · 15 days' }));
  store.upsertEsimCharge(charge('C', 'pi_c1', '2026-10-03T10:00:00Z', { approved: false, reason: '3.02', amount_usd_cents: 1000 }));
  store.upsertEsimCharge(charge('C', 'pi_c1', '2026-10-03T10:01:00Z', { approved: false, reason: 'do_not_honor', amount_usd_cents: 1000 }));
  store.upsertEsimCharge(charge('D', 'pi_d1', '2026-10-03T12:00:00Z'));
  store.upsertEsimCharge(charge('D', 'pi_d2', '2026-11-20T12:00:00Z'));
  store.upsertPayment({
    provider: 'stripe', payment_id: 'ch_vpn', account: 'corp', mid: 'corp', paid_at: ts('2026-10-05T10:00:00Z'), amount_usd_cents: 999, refunded_usd_cents: 0,
    country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null,
  });
  return store;
}

describe('eSIM: платёжное здоровье', () => {
  it('попытки и оплаты: approval — по попыткам, checkout success — по оплатам, recovery — оплаты с первым отказом, потерянная сумма', () => {
    const { totals, series } = getHealth(seeded().db, { ...opts, granularity: 'day' });
    expect(totals).toMatchObject({
      charges: 7, approved: 4, checkouts: 5, paid_checkouts: 4, first_declined: 2, recovered: 1, lost_usd_cents: 1000,
      approval_rate: 4 / 7, checkout_success_rate: 0.8, recovery_rate: 0.5,
    });
    expect(series).toHaveLength(31);
    expect(series.find((p) => p.period === '2026-10-03')).toMatchObject({ charges: 3, checkouts: 2, paid_checkouts: 1 });
  });

  it('разбивка и причины отказа: те же группы, что у VPN; recovery — по причине первого отказа оплаты', () => {
    expect(getHealthBreakdown(seeded().db, opts, 'destination').breakdown.map((r) => [r.value, r.charges, r.checkout_success_rate])).toEqual([
      ['Spain', 6, 0.75],
      ['Japan', 1, 1],
    ]);
    expect(getHealthReasons(seeded().db, opts)).toEqual([
      { reason: 'Insufficient funds', hint: 'Недостаточно средств на карте', count: 2, share: 2 / 3, first_declines: 2, recovered: 1, recovery_rate: 0.5, avg_attempts: 2, avg_days_to_pay: null, final: true },
      { reason: 'Do not honor / Generic decline', hint: 'Банк отклонил без объяснения причины', count: 1, share: 1 / 3, first_declines: 0, recovered: 0, recovery_rate: null, avg_attempts: null, avg_days_to_pay: null, final: true },
    ]);
  });
});

describe('eSIM: повторные покупки', () => {
  it('когорты по первой покупке: повтор за 30 и 90 дней, пополнения, выручка на клиента, дни до второй покупки', () => {
    const { totals, series } = getRepeat(seeded().db, { ...opts, granularity: 'day' });
    expect(totals).toMatchObject({
      customers: 3, repeat_30: 1, repeat_90: 2, topup_30: 1, revenue_30: 800 + 500 + 1000 + 800, revenue_90: 1300 + 1000 + 1600,
      repeat_rate_30: 1 / 3, repeat_rate_90: 2 / 3, topup_rate_30: 1 / 3, revenue_per_customer_90: 1300, final_30: true, final_90: true,
    });
    expect(totals.avg_days_to_second).toBeCloseTo((9 + 48) / 2, 2); // первая успешная покупка A — в 10:02
    // самая ранняя и самая поздняя первые покупки — у A и D; у пустых дней — 0
    expect([totals.first_first_at, totals.last_first_at]).toEqual([ts('2026-10-01T10:02:00Z'), ts('2026-10-03T12:00:00Z')]);
    expect(series.find((p) => p.period === '2026-10-05')).toMatchObject({ customers: 0, first_first_at: 0 });
    expect(series.find((p) => p.period === '2026-10-01')).toMatchObject({ customers: 1, repeat_30: 1, topup_30: 1 });
    // окна ещё открыты — цифры неокончательные
    const fresh = getRepeat(seeded().db, { ...opts, now: ts('2026-11-15T00:00:00Z'), granularity: 'month' }).totals;
    expect([fresh.final_30, fresh.final_90]).toEqual([true, false]);
  });

  it('разбивка по первой покупке и фильтры', () => {
    expect(getRepeatBreakdown(seeded().db, opts, 'destination').breakdown.map((r) => [r.value, r.customers, r.repeat_90])).toEqual([
      ['Spain', 2, 2],
      ['Japan', 1, 0],
    ]);
    expect(getRepeat(seeded().db, { ...opts, filters: { destination: ['Japan'] }, granularity: 'day' }).totals.customers).toBe(1);
    expect(DAY).toBe(86_400);
  });
});
