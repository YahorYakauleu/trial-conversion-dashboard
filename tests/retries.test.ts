import { describe, expect, it } from 'vitest';
import { openStore } from '../src/db.js';
import { exportRetryAttempts } from '../src/export.js';
import { DAY } from '../src/metrics.js';
import { getRetries, getRetryBreakdown, getRetryCodes, getRetryCurve, getRetryDays } from '../src/retries.js';

// «Сегодня» — 2026-10-12; триалы по 7 дней, окно ретраев 30 дней
const ts = (iso: string) => Date.parse(iso) / 1000;
const o = {
  provider: 'all' as const,
  now: ts('2026-10-12T10:00:00Z'),
  from: '2026-09-01',
  to: '2026-09-01',
  timeZones: { stripe: 'UTC', solidgate: 'UTC' },
  filters: {},
  retryWindowDays: 30,
};
const started = ts('2026-09-01T12:00:00Z');
const end = started + 7 * DAY;

// Триал и его попытки: [дней после конца триала, прошла ли, код отказа]
function storeWith(trials: [id: string, method: string, attempts: [number, boolean, string | null][]][]) {
  const store = openStore(':memory:');
  for (const [id, method, attempts] of trials) {
    store.upsertTrial({
      provider: 'stripe', account: 'corp', subscription_id: id, trial_started_at: started, trial_ended_at: end, first_invoice_id: `in_${id}`,
      first_attempt_succeeded: attempts[0]?.[1] ?? null, paid_at: null, country: 'US', payment_method: method, card_brand: 'visa', bank: null, customer_id: `cus_${id}`,
    });
    attempts.forEach(([days, approved, reason], i) =>
      store.upsertAttempt({ provider: 'stripe', attempt_id: `ch_${id}_${i + 1}`, subscription_id: id, attempted_at: end + days * DAY, approved, reason, refunded: false }),
    );
  }
  return store;
}

const data = () =>
  storeWith([
    ['a', 'apple_pay', [[0, true, null]]], // прошла сразу
    ['b', 'apple_pay', [[0, false, 'insufficient_funds'], [3, false, 'insufficient_funds'], [7, true, null]]], // восстановлен на третьей
    ['c', 'google_pay', [[0, false, 'stolen_card'], [3, false, 'previously_declined_do_not_retry'], [7, false, 'previously_declined_do_not_retry']]], // повторы после «не повторять»
    ['d', 'google_pay', [[0, false, 'do_not_honor'], [3, true, null]]], // восстановлен на второй
    ['e', 'google_pay', [[0, false, 'insufficient_funds'], [40, true, null]]], // оплатил, но уже за окном ретраев
  ]);

describe('ретраи первого платежа', () => {
  it('итоги: отказ первой попытки, повторы, восстановления в окне, повторы после «не повторять»', () => {
    const { totals, series } = getRetries(data().db, { ...o, granularity: 'day' });
    expect(totals).toMatchObject({
      first_declined: 4, retries: 6, recovered: 2, no_retry_retries: 2, no_retry_recovered: 0,
      recovery_rate: 0.5, retry_success: 2 / 6, retries_per_recovery: 3, no_retry_share: 2 / 6, final: true,
    });
    expect(series).toHaveLength(1);
  });

  it('отдача по номеру попытки и доля восстановлений к этой попытке', () => {
    expect(getRetryCurve(data().db, o).map((r) => [r.attempt, r.attempts, r.approved, r.recovered_share])).toEqual([
      [1, 5, 1, null],
      [2, 4, 2, 2 / 3],
      [3, 2, 1, 1],
    ]);
  });

  it('повторы по дням после первой попытки', () => {
    expect(getRetryDays(data().db, o).map((r) => [r.day, r.retries, r.approved])).toEqual([
      [3, 3, 1],
      [7, 2, 1],
      [31, 1, 1],
    ]);
  });

  it('после кода отказа: повторили ли, прошла ли следующая и любая дальнейшая попытка; «не повторять» помечен', () => {
    const codes = getRetryCodes(data().db, o);
    expect(codes.map((r) => [r.code, r.declines, r.retried, r.next_approved, r.approved_later, r.no_retry])).toEqual([
      ['insufficient_funds', 3, 3, 2, 3, false],
      ['previously_declined_do_not_retry', 2, 1, 0, 0, true],
      ['do_not_honor', 1, 1, 1, 1, false],
      ['stolen_card', 1, 1, 0, 0, true],
    ]);
  });

  it('разбивка по измерению триала', () => {
    const { breakdown, totals } = getRetryBreakdown(data().db, o, 'payment_method');
    expect(breakdown.map((r) => [r.value, r.first_declined, r.retries, r.recovered])).toEqual([
      ['google_pay', 3, 4, 1],
      ['apple_pay', 1, 2, 1],
    ]);
    expect(totals.retries).toBe(6);
  });

  it('выгрузка: все попытки или только с этим номером, днём, кодом', () => {
    const all = exportRetryAttempts(data().db, o, {});
    expect(all.rows).toHaveLength(11);
    const second = exportRetryAttempts(data().db, o, { attempt: 2 });
    expect(second.rows.map((r) => r[second.columns.indexOf('attempt_id')])).toEqual(['ch_b_2', 'ch_c_2', 'ch_d_2', 'ch_e_2']);
    const late = exportRetryAttempts(data().db, o, { day: 31 });
    expect(late.rows.map((r) => r[late.columns.indexOf('attempt_id')])).toEqual(['ch_e_2']);
    const blocked = exportRetryAttempts(data().db, o, { code: 'previously_declined_do_not_retry' });
    expect(blocked.rows.map((r) => [r[blocked.columns.indexOf('attempt_id')], r[blocked.columns.indexOf('after_no_retry_decline')]])).toEqual([
      ['ch_c_2', 'yes'],
      ['ch_c_3', 'yes'],
    ]);
  });
});
