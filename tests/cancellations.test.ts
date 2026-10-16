import { describe, expect, it } from 'vitest';
import { cancelCodes, cancelLabel, getCancellationBreakdown, getCancellationReasons, getCancellations } from '../src/cancellations.js';
import { openStore, type TrialRow } from '../src/db.js';
import { DAY } from '../src/metrics.js';

// «Сегодня» = 2026-10-12, триалы по 7 дней, окно после триала 30 дней
const ts = (iso: string) => Date.parse(iso) / 1000;
const HOUR = 3600;
const NOW = ts('2026-10-12T10:00:00Z');
const opts = {
  provider: 'all' as const,
  now: NOW,
  from: '2026-09-01',
  to: '2026-09-01',
  timeZones: { stripe: 'UTC', solidgate: 'UTC' },
  filters: {},
  retryWindowDays: 30,
};

let seq = 0;
function trial(startedIso: string, cancel: [after: number, reason: string | null] | null = null, patch: Partial<TrialRow> = {}): TrialRow {
  const started = ts(startedIso);
  return {
    provider: 'stripe', account: 'corp', subscription_id: `sub_${++seq}`, trial_started_at: started, trial_ended_at: started + 7 * DAY,
    first_invoice_id: null, first_attempt_succeeded: null, paid_at: null, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null, mid: 'corp',
    canceled_at: cancel ? started + cancel[0] : null, cancel_reason: cancel ? cancel[1] : null,
    ...patch,
  };
}

function storeWith(rows: TrialRow[]) {
  const store = openStore(':memory:');
  rows.forEach((r) => store.upsertTrial(r));
  return store;
}

// 10 триалов 1 сентября: 4 отменили во время триала (2 — в первые сутки), 1 — через 2 дня после конца, 1 — уже за окном 30 дней
const s = '2026-09-01T12:00:00Z';
const cohort = () => [
  trial(s, [6 * HOUR, 'cancellation_requested']),
  trial(s, [10 * HOUR, '8.06'], { provider: 'solidgate', account: 'sgH2H', payment_method: 'google_pay' }),
  trial(s, [1.5 * DAY, null]),
  trial(s, [5.5 * DAY, 'payment_disputed']),
  trial(s, [9 * DAY, 'payment_failed']),
  trial(s, [38 * DAY, 'cancellation_requested']),
  ...Array.from({ length: 4 }, () => trial(s)),
];

describe('отмены триалов', () => {
  it('доля отмен во время триала, в первые сутки, средний день и отмены в 30 дней после триала', () => {
    const { totals, series, by_day, median_cancel_day } = getCancellations(storeWith(cohort()).db, { ...opts, granularity: 'day' });
    expect(totals).toMatchObject({
      started: 10, canceled_in_trial: 4, canceled_day0: 2, canceled_after: 1,
      trial_cancellation_rate: 0.4, day0_share: 0.5, post_trial_cancellation_rate: 0.1, final_trial: true, final_after: true,
    });
    // (6 ч + 10 ч + 1,5 дня + 5,5 дня) ÷ 4
    expect(totals.avg_cancel_day).toBeCloseTo((16 / 24 + 7) / 4, 6);
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ period: '2026-09-01', started: 10, canceled_in_trial: 4 });
    expect(by_day).toEqual([
      { day: 0, count: 2, share: 0.5 },
      { day: 1, count: 1, share: 0.25 },
      { day: 5, count: 1, share: 0.25 },
    ]);
    expect(median_cancel_day).toBe(0);
  });

  it('пустой период — без деления на ноль; свежая когорта — неокончательная', () => {
    const empty = getCancellations(storeWith([]).db, { ...opts, granularity: 'day' });
    expect(empty.totals).toMatchObject({ started: 0, trial_cancellation_rate: null, day0_share: null, avg_cancel_day: null });
    expect([empty.by_day, empty.median_cancel_day]).toEqual([[], null]);

    const fresh = getCancellations(storeWith([trial('2026-10-08T12:00:00Z', [HOUR, null])]).db, { ...opts, from: '2026-10-08', to: '2026-10-08', granularity: 'day' });
    expect(fresh.totals).toMatchObject({ canceled_in_trial: 1, final_trial: false, final_after: false });
  });

  it('отмена ровно в момент конца триала — уже после триала', () => {
    const { totals } = getCancellations(storeWith([trial(s, [7 * DAY, null])]).db, { ...opts, granularity: 'day' });
    expect([totals.canceled_in_trial, totals.canceled_after]).toEqual([0, 1]);
  });

  it('разбивка по измерению и фильтры', () => {
    const db = storeWith(cohort()).db;
    const byMethod = getCancellationBreakdown(db, opts, 'payment_method');
    expect(byMethod.breakdown.map((r) => [r.value, r.started, r.canceled_in_trial, r.trial_cancellation_rate])).toEqual([
      ['apple_pay', 9, 3, 1 / 3],
      ['google_pay', 1, 1, 1],
    ]);
    expect(byMethod.totals).toMatchObject({ started: 10, canceled_in_trial: 4 });
    const solidgate = getCancellations(db, { ...opts, provider: 'solidgate', granularity: 'day' });
    expect([solidgate.totals.started, solidgate.by_day]).toEqual([1, [{ day: 0, count: 1, share: 1 }]]);
  });

  it('причины отмены — общими группами Stripe и Solidgate; за окном 30 дней не считаются', () => {
    expect(getCancellationReasons(storeWith(cohort()).db, opts)).toEqual([
      { reason: 'Requested', hint: expect.any(String), count: 2, share: 0.4, in_trial: 2, after_trial: 0 },
      { reason: 'Fraud or dispute', hint: expect.any(String), count: 1, share: 0.2, in_trial: 1, after_trial: 0 },
      { reason: 'Payment failed', hint: expect.any(String), count: 1, share: 0.2, in_trial: 0, after_trial: 1 },
      { reason: 'Unknown', hint: 'Провайдер не передал причину отмены', count: 1, share: 0.2, in_trial: 1, after_trial: 0 },
    ]);
  });

  it('названия и коды групп', () => {
    expect([cancelLabel('8.11'), cancelLabel('8.10'), cancelLabel(null), cancelLabel('9.99')]).toEqual(['Payment method removed', 'Payment method removed', 'Unknown', '9.99']);
    expect(cancelCodes('Payment failed')).toEqual({ codes: ['payment_failed', '8.09'], withoutCode: false });
    expect(cancelCodes('Unknown')).toEqual({ codes: [], withoutCode: true });
    expect(cancelCodes('9.99')).toEqual({ codes: ['9.99'], withoutCode: false });
  });
});
