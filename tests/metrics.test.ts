import { describe, expect, it } from 'vitest';
import { openStore, type AttemptRow, type TrialRow } from '../src/db.js';
import { DAY, getBreakdown, getDeclineReasons, getMetrics, resolveRange } from '../src/metrics.js';

// «Сегодня» = понедельник 2026-10-12, история с 1 сентября, триалы по 7 дней, окно ретраев 30 дней
const ts = (iso: string) => Date.parse(iso) / 1000;
const d = (date: string) => ts(`${date}T00:00:00Z`);
const NOW = ts('2026-10-12T10:00:00Z');
const HISTORY_FROM = d('2026-09-01');
const opts = {
  provider: 'all' as const,
  granularity: 'day' as const,
  now: NOW,
  from: '2026-09-01',
  to: '2026-10-11',
  timeZone: 'UTC',
  filters: {},
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
    country: 'US',
    payment_method: 'apple_pay',
    card_brand: 'visa',
    bank: null,
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

  it('сегодняшний день считается как обычный и помечен неокончательным', () => {
    const store = storeWith([trial('2026-10-12T01:00:00Z'), trial('2026-10-12T09:00:00Z')]);
    const { series } = getMetrics(store.db, { ...opts, to: '2026-10-12' });
    expect(series.at(-1)).toMatchObject({ period: '2026-10-12', started: 2, final_first: false, final_retry: false });
  });

  it('период from..to включительно, границы суток UTC', () => {
    const store = storeWith([
      trial('2026-09-30T23:59:59Z'), // до периода
      trial('2026-10-01T00:00:00Z'),
      trial('2026-10-03T23:59:59Z'),
      trial('2026-10-04T00:00:00Z'), // после периода
    ]);
    const { series, totals } = getMetrics(store.db, { ...opts, from: '2026-10-01', to: '2026-10-03' });
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
    const early = getMetrics(store.db, { ...opts, from: '2026-09-01', to: '2026-09-04' }).totals;
    expect(early).toMatchObject({
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

describe('измерения: фильтры и разбивки', () => {
  const s = '2026-10-01T12:00:00Z';
  const paid = { first_invoice_id: 'in', first_attempt_succeeded: true, paid_at: ts(s) + 7 * DAY + 60 };
  const rows = () => [
    trial(s, { country: 'US', ...paid }),
    trial(s, { country: 'US', payment_method: 'google_pay' }),
    trial(s, { country: 'SA', bank: 'AL RAJHI', ...paid }),
    trial(s, { country: null, payment_method: null }),
    trial(s, { country: 'GB', provider: 'solidgate', account: 'sgH2H' }),
  ];

  it('фильтры применяются к ряду и итогам; none — значение не определено; фильтры складываются', () => {
    const store = storeWith(rows());
    expect(getMetrics(store.db, { ...opts, filters: { country: 'US' } }).totals).toMatchObject({ started: 2, paid_first: 1, rate_first: 0.5 });
    expect(getMetrics(store.db, { ...opts, filters: { country: 'none' } }).totals.started).toBe(1);
    expect(getMetrics(store.db, { ...opts, filters: { country: 'US', payment_method: 'google_pay' } }).totals.started).toBe(1);
    expect(getMetrics(store.db, { ...opts, filters: { bank: 'AL RAJHI' } }).totals.started).toBe(1);
    expect(getMetrics(store.db, opts).totals.started).toBe(5);
  });

  it('разбивка: по убыванию числа триалов, «не определено» в конце, с учётом провайдера и периода', () => {
    const store = storeWith([...rows(), trial('2026-09-15T12:00:00Z', { country: 'FR' })]);
    const range = { ...opts, from: '2026-10-01', to: '2026-10-11' };
    expect(getBreakdown(store.db, range, 'country').map((c) => [c.value, c.started, c.paid_retry])).toEqual([
      ['US', 2, 1],
      ['GB', 1, 0],
      ['SA', 1, 1],
      [null, 1, 0],
    ]);
    expect(getBreakdown(store.db, { ...range, provider: 'solidgate' }, 'country').map((c) => c.value)).toEqual(['GB']);
    expect(getBreakdown(store.db, range, 'payment_method').map((c) => [c.value, c.started])).toEqual([
      ['apple_pay', 3],
      ['google_pay', 1],
      [null, 1],
    ]);
    expect(getBreakdown(store.db, range, 'country')[0]).toMatchObject({ rate_retry: 0.5, final_first: false, final_retry: false });
  });
});

describe('платёжные метрики: проходимость, decline, рефанды, причины отказа', () => {
  const s = '2026-10-01T12:00:00Z';
  const end = ts(s) + 7 * DAY;
  const attempt = (sub: string, n: number, approved: boolean, patch: Partial<AttemptRow> = {}): AttemptRow => ({
    provider: 'stripe',
    attempt_id: `${sub}_${n}`,
    subscription_id: sub,
    attempted_at: end + n * DAY,
    approved,
    reason: approved ? null : 'insufficient_funds',
    refunded: false,
    ...patch,
  });

  function paymentsStore() {
    const store = storeWith([
      trial(s, { subscription_id: 'a', first_invoice_id: 'in_a', first_attempt_succeeded: true, paid_at: end + 60 }),
      trial(s, { subscription_id: 'b', first_invoice_id: 'in_b', first_attempt_succeeded: false, paid_at: end + 2 * DAY }),
      trial(s, { subscription_id: 'c', first_invoice_id: 'in_c', first_attempt_succeeded: false, provider: 'solidgate', account: 'sgH2H' }),
      trial(s, { subscription_id: 'd' }), // отменил во время триала — попыток нет
    ]);
    store.upsertAttempt(attempt('a', 0, true, { refunded: true }));
    store.upsertAttempt(attempt('b', 0, false));
    store.upsertAttempt(attempt('b', 1, false, { reason: 'do_not_honor' }));
    store.upsertAttempt(attempt('b', 2, true));
    store.upsertAttempt(attempt('c', 0, false, { provider: 'solidgate', reason: '3.02' }));
    store.upsertAttempt(attempt('c', 1, false, { provider: 'solidgate', reason: '3.10' }));
    return store;
  }

  it('проходимость и decline — по попыткам; рефанды — от сконвертившихся', () => {
    const { totals } = getMetrics(paymentsStore().db, opts);
    expect(totals).toMatchObject({ started: 4, paid_retry: 2, attempts: 6, approved: 2, refunded: 1 });
    expect(totals.approval_rate).toBeCloseTo(2 / 6);
    expect(totals.decline_rate).toBeCloseTo(4 / 6);
    expect(totals.refund_rate).toBe(0.5);
  });

  it('без попыток — проходимость и decline пустые, а не ноль', () => {
    const { totals } = getMetrics(storeWith([trial(s)]).db, opts);
    expect(totals).toMatchObject({ attempts: 0, approval_rate: null, decline_rate: null, refund_rate: null });
  });

  it('метрики попыток учитывают фильтры и разбивки', () => {
    const store = paymentsStore();
    expect(getMetrics(store.db, { ...opts, provider: 'solidgate' }).totals).toMatchObject({ attempts: 2, approved: 0, decline_rate: 1 });
    const byProviderMethod = getBreakdown(store.db, opts, 'payment_method');
    expect(byProviderMethod[0]).toMatchObject({ value: 'apple_pay', attempts: 6, approved: 2 });
  });

  it('причины отказа: коды Stripe и Solidgate сведены к общим названиям, доля от всех отказов', () => {
    expect(getDeclineReasons(paymentsStore().db, opts)).toEqual([
      { reason: 'Недостаточно средств', count: 2, share: 0.5 },
      { reason: 'Отказ банка без причины', count: 1, share: 0.25 },
      { reason: 'Подозрение на фрод (банк)', count: 1, share: 0.25 },
    ]);
    expect(getDeclineReasons(paymentsStore().db, { ...opts, provider: 'solidgate' }).map((r) => r.reason)).toEqual([
      'Недостаточно средств',
      'Подозрение на фрод (банк)',
    ]);
  });
});

describe('getMetrics — сутки по Нью-Йорку', () => {
  const ny = { ...opts, timeZone: 'America/New_York', from: '2026-10-10', to: '2026-10-11' };

  it('день оформления считается по местному времени', () => {
    const store = storeWith([
      trial('2026-10-11T03:59:59Z'), // 10.10 23:59 по Нью-Йорку
      trial('2026-10-11T04:00:00Z'), // 11.10 00:00 по Нью-Йорку
      trial('2026-10-11T23:00:00Z'),
    ]);
    const { series } = getMetrics(store.db, ny);
    expect(series.map((p) => [p.period, p.started])).toEqual([
      ['2026-10-10', 1],
      ['2026-10-11', 2],
    ]);
  });

  it('период обрезается по местным суткам', () => {
    const store = storeWith([trial('2026-10-10T03:00:00Z'), trial('2026-10-12T03:59:00Z'), trial('2026-10-12T04:00:00Z')]);
    expect(getMetrics(store.db, ny).totals.started).toBe(1); // 09.10 и 12.10 по Нью-Йорку — вне периода
  });
});

describe('resolveRange', () => {
  const UTC = 'UTC';

  it('по умолчанию — вся история по сегодня', () => {
    expect(resolveRange(HISTORY_FROM, NOW, UTC)).toEqual({ from: '2026-09-01', to: '2026-10-12' });
  });

  it('пресеты считаются от сегодняшнего дня в часовом поясе дашборда', () => {
    expect(resolveRange(HISTORY_FROM, NOW, UTC, { period: 'last7' })).toEqual({ from: '2026-10-06', to: '2026-10-12' });
    expect(resolveRange(HISTORY_FROM, NOW, UTC, { period: 'last30' })).toEqual({ from: '2026-09-13', to: '2026-10-12' });
    expect(resolveRange(HISTORY_FROM, NOW, UTC, { period: 'thisMonth' })).toEqual({ from: '2026-10-01', to: '2026-10-12' });
    expect(resolveRange(HISTORY_FROM, NOW, UTC, { period: 'prevMonth' })).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    // 12.10 01:00 UTC — в Нью-Йорке ещё 11.10
    expect(resolveRange(HISTORY_FROM, ts('2026-10-12T01:00:00Z'), 'America/New_York', { period: 'last7' })).toEqual({
      from: '2026-10-05',
      to: '2026-10-11',
    });
  });

  it('свой период: YYYY-MM-DD, обрезается по истории и сегодняшнему дню', () => {
    expect(resolveRange(HISTORY_FROM, NOW, UTC, { period: 'custom', from: '2026-10-01', to: '2026-10-05' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-05',
    });
    expect(resolveRange(HISTORY_FROM, NOW, UTC, { from: '2026-08-01', to: '2026-12-31' })).toEqual({
      from: '2026-09-01',
      to: '2026-10-12',
    });
  });

  it('кривые значения → по умолчанию; from позже to → один день to', () => {
    expect(resolveRange(HISTORY_FROM, NOW, UTC, { period: 'custom', from: 'вчера', to: 42 })).toEqual({
      from: '2026-09-01',
      to: '2026-10-12',
    });
    expect(resolveRange(HISTORY_FROM, NOW, UTC, { from: '2026-10-09', to: '2026-10-02' })).toEqual({
      from: '2026-10-02',
      to: '2026-10-02',
    });
  });
});
