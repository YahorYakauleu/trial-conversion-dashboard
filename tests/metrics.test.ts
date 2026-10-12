import { describe, expect, it } from 'vitest';
import { openStore, type TrialRow } from '../src/db.js';
import { DAY, getMetrics, resolveRange } from '../src/metrics.js';

// «Сегодня» = понедельник 2026-10-12, история с 1 сентября, триалы по 7 дней, окно ретраев 30 дней
const ts = (iso: string) => Date.parse(iso) / 1000;
const d = (date: string) => ts(`${date}T00:00:00Z`);
const NOW = ts('2026-10-12T10:00:00Z');
const HISTORY_FROM = d('2026-09-01');
const opts = {
  provider: 'all' as const,
  granularity: 'day' as const,
  now: NOW,
  from: HISTORY_FROM,
  to: d('2026-10-11'),
  retryWindowDays: 30,
};

let seq = 0;
function trial(startedIso: string, patch: Partial<TrialRow> = {}): TrialRow {
  const started = ts(startedIso);
  return {
    provider: 'stripe',
    account: 'corp',
    subscription_id: `sub_${++seq}`,
    trial_started_at: started,
    trial_ended_at: started + 7 * DAY,
    first_invoice_id: null,
    first_attempt_succeeded: null,
    paid_at: null,
    ...patch,
  };
}

function storeWith(rows: TrialRow[]) {
  const store = openStore(':memory:');
  rows.forEach((r) => store.upsertTrial(r));
  return store;
}

const point = (series: { period: string }[], period: string) => series.find((p) => p.period === period)!;

describe('getMetrics — по дню оформления триала', () => {
  it('считает оформленные, оплаченные с первой попытки и с ретраями в окне', () => {
    const s = '2026-09-01T12:00:00Z';
    const end = ts(s) + 7 * DAY;
    const store = storeWith([
      trial(s, { first_invoice_id: 'in', first_attempt_succeeded: true, paid_at: end + 3600 }),
      trial(s, { first_invoice_id: 'in', first_attempt_succeeded: false, paid_at: end + 5 * DAY }),
      trial(s, { first_invoice_id: 'in', first_attempt_succeeded: false, paid_at: end + 31 * DAY }),
      trial(s),
    ]);
    expect(point(getMetrics(store.db, opts).series, '2026-09-01')).toMatchObject({
      period_end: '2026-09-01',
      started: 4,
      paid_first: 1,
      paid_retry: 2,
      rate_first: 0.25,
      rate_retry: 0.5,
    });
  });

  it('период from..to включительно, границы суток UTC', () => {
    const store = storeWith([
      trial('2026-09-30T23:59:59Z'), // до периода
      trial('2026-10-01T00:00:00Z'),
      trial('2026-10-03T23:59:59Z'),
      trial('2026-10-04T00:00:00Z'), // после периода
    ]);
    const { series, totals } = getMetrics(store.db, { ...opts, from: d('2026-10-01'), to: d('2026-10-03') });
    expect(series.map((p) => p.period)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(totals.started).toBe(2);
  });

  it('пустые дни заполнены нулями, rate = null', () => {
    const { series } = getMetrics(openStore(':memory:').db, opts);
    expect(series[0]).toMatchObject({ started: 0, rate_first: null, rate_retry: null });
    expect(series).toHaveLength(41);
  });

  it('цифра окончательна, когда самый длинный триал дня закончился и прошло окно', () => {
    const { series } = getMetrics(storeWith([trial('2026-09-01T12:00:00Z')]).db, opts);
    // первая попытка: конец дня + 7 дн триала + 1 день; ретраи: конец дня + 7 дн + 30 дн
    expect(point(series, '2026-10-03').final_first).toBe(true);
    expect(point(series, '2026-10-04').final_first).toBe(false);
    expect(point(series, '2026-09-04').final_retry).toBe(true);
    expect(point(series, '2026-09-05').final_retry).toBe(false);
  });

  it('фильтр по провайдеру и сумма для «Все»', () => {
    const s = '2026-10-01T12:00:00Z';
    const store = storeWith([
      trial(s, { first_attempt_succeeded: true, paid_at: ts(s) + 7 * DAY }),
      trial(s, { provider: 'solidgate', account: 'sgH2H' }),
    ]);
    expect(point(getMetrics(store.db, { ...opts, provider: 'stripe' }).series, '2026-10-01').started).toBe(1);
    expect(point(getMetrics(store.db, { ...opts, provider: 'solidgate' }).series, '2026-10-01').started).toBe(1);
    expect(point(getMetrics(store.db, opts).series, '2026-10-01')).toMatchObject({
      started: 2,
      paid_first: 1,
      rate_first: 0.5,
    });
  });
});

describe('getMetrics — недели, месяцы, итоги', () => {
  it('недели: ISO-неделя, неполные края подписаны днями периода', () => {
    const store = storeWith([trial('2026-09-01T12:00:00Z'), trial('2026-10-05T12:00:00Z'), trial('2026-10-11T12:00:00Z')]);
    const { series } = getMetrics(store.db, { ...opts, granularity: 'week' });
    expect(series[0]).toMatchObject({ period: '2026-09-01', period_end: '2026-09-06', started: 1 });
    expect(series[1]).toMatchObject({ period: '2026-09-07', period_end: '2026-09-13' });
    expect(series.at(-1)).toMatchObject({ period: '2026-10-05', period_end: '2026-10-11', started: 2, final_first: false });
  });

  it('месяцы: календарный месяц внутри периода', () => {
    const store = storeWith([
      trial('2026-09-01T12:00:00Z', { first_attempt_succeeded: true, paid_at: ts('2026-09-08T13:00:00Z') }),
      trial('2026-09-30T12:00:00Z'),
      trial('2026-10-02T12:00:00Z'),
    ]);
    const { series } = getMetrics(store.db, { ...opts, granularity: 'month' });
    expect(series).toHaveLength(2);
    expect(series[0]).toMatchObject({ period: '2026-09-01', period_end: '2026-09-30', started: 2, paid_first: 1, rate_first: 0.5 });
    expect(series[1]).toMatchObject({ period: '2026-10-01', period_end: '2026-10-11', started: 1 });
  });

  it('итоги за период: суммы, проценты, окончательны только если окончательны все дни', () => {
    const store = storeWith([
      trial('2026-09-02T12:00:00Z', { first_attempt_succeeded: true, paid_at: ts('2026-09-09T13:00:00Z') }),
      trial('2026-09-03T12:00:00Z', { first_attempt_succeeded: false, paid_at: ts('2026-09-15T12:00:00Z') }),
      trial('2026-09-03T12:00:00Z'),
      trial('2026-09-03T12:00:00Z'),
    ]);
    const early = getMetrics(store.db, { ...opts, from: d('2026-09-01'), to: d('2026-09-04') }).totals;
    expect(early).toEqual({
      started: 4,
      paid_first: 1,
      paid_retry: 2,
      rate_first: 0.25,
      rate_retry: 0.5,
      final_first: true,
      final_retry: true,
    });
    expect(getMetrics(store.db, opts).totals).toMatchObject({ started: 4, final_first: false, final_retry: false });
  });
});

describe('resolveRange', () => {
  const lastDay = d('2026-10-11');

  it('по умолчанию — вся история до вчера', () => {
    expect(resolveRange(HISTORY_FROM, NOW)).toEqual({ from: HISTORY_FROM, to: lastDay });
  });

  it('принимает YYYY-MM-DD и обрезает по истории и вчерашнему дню', () => {
    expect(resolveRange(HISTORY_FROM, NOW, '2026-10-01', '2026-10-05')).toEqual({ from: d('2026-10-01'), to: d('2026-10-05') });
    expect(resolveRange(HISTORY_FROM, NOW, '2026-08-01', '2026-12-31')).toEqual({ from: HISTORY_FROM, to: lastDay });
  });

  it('кривые значения → по умолчанию; from позже to → один день to', () => {
    expect(resolveRange(HISTORY_FROM, NOW, 'вчера', 42)).toEqual({ from: HISTORY_FROM, to: lastDay });
    expect(resolveRange(HISTORY_FROM, NOW, '2026-10-09', '2026-10-02')).toEqual({ from: d('2026-10-02'), to: d('2026-10-02') });
  });
});
