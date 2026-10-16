import { describe, expect, it } from 'vitest';
import { openStore, type EsimChargeRow } from '../src/db.js';
import { getOverview, getOverviewBreakdown, getOverviewReasons, getRepeat, getRepeatBreakdown } from '../src/esim.js';
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
  // E: перебор карт — антифрод отсёк обе попытки, клиентом не стал
  store.upsertEsimCharge(charge('E', 'pi_e1', '2026-10-04T10:00:00Z', { approved: false, reason: 'rule' }));
  store.upsertEsimCharge(charge('E', 'pi_e1', '2026-10-04T10:00:30Z', { approved: false, reason: 'highest_risk_level' }));
  store.upsertPayment({
    provider: 'stripe', payment_id: 'ch_vpn', account: 'corp', mid: 'corp', paid_at: ts('2026-10-05T10:00:00Z'), amount_usd_cents: 999, refunded_usd_cents: 0,
    country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null,
  });
  return store;
}

describe('eSIM: обзор', () => {
  it('заказы, деньги, новые и повторные; доля оплаченных — без отсечённых антифродом; потерянная выручка — только настоящие покупатели', () => {
    const { totals, series } = getOverview(seeded().db, { ...opts, granularity: 'day' });
    expect(totals).toMatchObject({
      orders: 6, paid_orders: 4, new_customers: 3, repeat_orders: 1, fraud_blocked: 1, revenue: 800 + 500 + 1000 + 800, lost_revenue: 1000,
      payment_success_rate: 4 / 5,
    });
    expect(series).toHaveLength(31);
    // заказ A — в день первой попытки; отказ и оплата через 2 минуты — один заказ
    expect(series.find((p) => p.period === '2026-10-01')).toMatchObject({ orders: 1, paid_orders: 1, new_customers: 1 });
    expect(series.find((p) => p.period === '2026-10-10')).toMatchObject({ paid_orders: 1, new_customers: 0, repeat_orders: 1 });
  });

  it('разбивка — по убыванию выручки; почему не оплачено — причина последней попытки, антифрод — своей строкой', () => {
    expect(getOverviewBreakdown(seeded().db, opts, 'destination').breakdown.map((r) => [r.value, r.orders, r.paid_orders, r.revenue])).toEqual([
      ['Spain', 5, 3, 2100],
      ['Japan', 1, 1, 1000],
    ]);
    expect(getOverviewReasons(seeded().db, opts)).toEqual([
      { reason: 'Blocked by fraud rules', hint: 'Отклонил антифрод провайдера (Radar, Solidgate) — до банка платёж не дошёл', count: 1, share: 0.5 },
      { reason: 'Do not honor / Generic decline', hint: 'Банк отклонил без объяснения причины', count: 1, share: 0.5 },
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
