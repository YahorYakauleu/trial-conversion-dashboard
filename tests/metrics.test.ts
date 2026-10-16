import { describe, expect, it } from 'vitest';
import { openStore, type AttemptRow, type PaymentRow, type TrialRow } from '../src/db.js';
import { declineHint, declineLabel } from '../src/declines.js';
import { DAY, getBreakdown, getDeclineReasons, getMetrics, latestDay, resolveRange, totalsOf } from '../src/metrics.js';
import { getTurnover, getTurnoverBreakdown } from '../src/turnover.js';

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
  timeZones: { stripe: 'UTC', solidgate: 'UTC' },
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
    mid: 'corp',
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
    expect(getMetrics(store.db, { ...opts, filters: { country: ['US'] } }).totals).toMatchObject({ started: 2, paid_first: 1, rate_first: 0.5 });
    expect(getMetrics(store.db, { ...opts, filters: { country: ['none'] } }).totals.started).toBe(1);
    expect(getMetrics(store.db, { ...opts, filters: { country: ['US'], payment_method: ['google_pay'] } }).totals.started).toBe(1);
    // несколько значений одного фильтра — через ИЛИ, в том числе «не определено»
    expect(getMetrics(store.db, { ...opts, filters: { country: ['US', 'none'] } }).totals.started).toBe(3);
    expect(getMetrics(store.db, { ...opts, filters: { country: ['US', 'none'], payment_method: ['google_pay'] } }).totals.started).toBe(1);
    expect(getMetrics(store.db, { ...opts, filters: { bank: ['AL RAJHI'] } }).totals.started).toBe(1);
    expect(getMetrics(store.db, opts).totals.started).toBe(5);
  });

  it('аккаунт — провайдер и аккаунт вместе: разбивка и фильтр', () => {
    const store = storeWith([
      ...rows(),
      trial(s, { account: 'org' }),
      trial(s, { provider: 'solidgate', account: 'corp' }), // то же имя у другого провайдера — отдельная строка
    ]);
    const range = { ...opts, from: '2026-10-01', to: '2026-10-11' };
    expect(getBreakdown(store.db, range, 'account').map((c) => [c.value, c.started])).toEqual([
      ['stripe:corp', 4],
      ['solidgate:corp', 1],
      ['solidgate:sgH2H', 1],
      ['stripe:org', 1],
    ]);
    expect(getMetrics(store.db, { ...range, filters: { account: ['stripe:org'] } }).totals.started).toBe(1);
    expect(getMetrics(store.db, { ...range, filters: { account: ['solidgate:corp'] } }).totals.started).toBe(1);
    expect(getMetrics(store.db, { ...range, filters: { account: ['stripe:org', 'solidgate:corp'] } }).totals.started).toBe(2);
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
    // первая попытка отклонена у b (оплатил на ретрае) и c (не оплатил)
    expect(totals).toMatchObject({ first_declined: 2, recovered: 1, recovery_rate: 0.5 });
    expect(totals.approval_rate).toBeCloseTo(2 / 6);
    expect(totals.decline_rate).toBeCloseTo(4 / 6);
    expect(totals.refund_rate).toBe(0.5);
  });

  it('без попыток — проходимость и decline пустые, а не ноль', () => {
    const { totals } = getMetrics(storeWith([trial(s)]).db, opts);
    expect(totals).toMatchObject({ attempts: 0, approval_rate: null, decline_rate: null, refund_rate: null, recovery_rate: null });
  });

  it('метрики попыток учитывают фильтры и разбивки', () => {
    const store = paymentsStore();
    expect(getMetrics(store.db, { ...opts, provider: 'solidgate' }).totals).toMatchObject({ attempts: 2, approved: 0, decline_rate: 1 });
    const byProviderMethod = getBreakdown(store.db, opts, 'payment_method');
    expect(byProviderMethod[0]).toMatchObject({ value: 'apple_pay', attempts: 6, approved: 2, first_declined: 2, recovered: 1 });
    expect(getBreakdown(store.db, opts, 'account').map((r) => [r.value, r.recovery_rate])).toEqual([
      ['stripe:corp', 1], // b — единственный с отказом первой попытки, оплатил
      ['solidgate:sgH2H', 0],
    ]);
  });

  it('причины отказа: коды Stripe и Solidgate сведены к общим названиям (как в Stripe) с пояснением, доля от всех отказов', () => {
    const noRecovery = { first_declines: 0, recovered: 0, recovery_rate: null, avg_attempts: null, avg_days_to_pay: null, final: true };
    expect(getDeclineReasons(paymentsStore().db, opts)).toEqual([
      // первая попытка отклонена у b (оплатил через 2 дня, 3 попытки) и у c (не оплатил, 2 попытки); окно ретраев ещё открыто
      { reason: 'Insufficient funds', hint: 'Недостаточно средств на карте', count: 2, share: 0.5, first_declines: 2, recovered: 1, recovery_rate: 0.5, avg_attempts: 2.5, avg_days_to_pay: 2, final: false },
      { reason: 'Do not honor / Generic decline', hint: 'Банк отклонил без объяснения причины', count: 1, share: 0.25, ...noRecovery }, // только на повторных попытках
      { reason: 'Fraudulent', hint: 'Банк заподозрил мошенничество', count: 1, share: 0.25, ...noRecovery },
    ]);
    expect(getDeclineReasons(paymentsStore().db, { ...opts, now: NOW + 30 * DAY })[0].final).toBe(true); // окно закрылось
    expect(getDeclineReasons(paymentsStore().db, { ...opts, provider: 'solidgate' }).map((r) => r.reason)).toEqual([
      'Fraudulent', // поровну — по алфавиту
      'Insufficient funds',
    ]);
  });
});

describe('названия причин отказа', () => {
  it('код без группы — как есть, без кода — Unknown; у каждой группы есть пояснение', () => {
    expect(declineLabel('3.02')).toBe('Insufficient funds');
    expect(declineLabel('previously_declined_do_not_retry')).toBe('Do not retry');
    expect(declineLabel('weird_code')).toBe('weird_code');
    expect(declineLabel(null)).toBe('Unknown');
    expect(declineHint('Unknown')).toBe('Провайдер не передал причину отказа');
    expect(declineHint('weird_code')).toMatch(/без общей группы/);
  });
});

describe('разбивка по MID и итоги из строк разбивки', () => {
  it('MID: у Stripe — аккаунт, у Solidgate — MID заказа, без заказа — не определён; сумма строк = итоги периода', () => {
    const solidgate = { provider: 'solidgate' as const, account: 'sgH2H' };
    const store = storeWith([
      trial('2026-10-05T12:00:00Z', { paid_at: ts('2026-10-12T13:00:00Z'), first_attempt_succeeded: true }),
      trial('2026-10-05T12:00:00Z', { ...solidgate, mid: 'uuid-1' }),
      trial('2026-10-06T12:00:00Z', { ...solidgate, mid: null }),
    ]);
    const rows = getBreakdown(store.db, opts, 'mid');
    expect(rows.map((r) => [r.value, r.started])).toEqual([
      ['solidgate:uuid-1', 1],
      ['stripe:corp', 1],
      [null, 1],
    ]);
    expect(totalsOf(rows)).toEqual(getMetrics(store.db, opts).totals);
  });
});

describe('getMetrics — сутки по Нью-Йорку', () => {
  const ny = { ...opts, timeZones: { stripe: 'America/New_York', solidgate: 'America/New_York' }, from: '2026-10-10', to: '2026-10-11' };

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

  it('у каждого провайдера свои сутки: Stripe — по Нью-Йорку, Solidgate — по UTC, как в их кабинетах', () => {
    const mixed = { ...ny, timeZones: { stripe: 'America/New_York', solidgate: 'UTC' } };
    const store = storeWith([
      trial('2026-10-11T02:00:00Z'), // Stripe: 10.10 22:00 по Нью-Йорку
      trial('2026-10-11T02:00:00Z', { provider: 'solidgate', account: 'sgH2H' }), // Solidgate: 11.10 по UTC
      trial('2026-10-12T02:00:00Z', { provider: 'solidgate', account: 'sgH2H' }), // 12.10 по UTC — вне периода
    ]);
    const { series } = getMetrics(store.db, mixed);
    expect(series.map((p) => [p.period, p.started])).toEqual([
      ['2026-10-10', 1],
      ['2026-10-11', 1],
    ]);
    expect(getMetrics(store.db, { ...mixed, provider: 'solidgate' }).series.map((p) => p.started)).toEqual([0, 1]);
  });
});

describe('latestDay', () => {
  it('«сегодня» — самый поздний из местных дней провайдеров', () => {
    const at = ts('2026-10-12T01:00:00Z'); // в Нью-Йорке ещё 11.10, по UTC уже 12.10
    expect(latestDay(at, { stripe: 'America/New_York', solidgate: 'America/New_York' })).toBe('2026-10-11');
    expect(latestDay(at, { stripe: 'America/New_York', solidgate: 'UTC' })).toBe('2026-10-12');
  });
});

describe('resolveRange', () => {
  const FIRST = '2026-09-01';
  const TODAY = '2026-10-12';

  it('по умолчанию — вся история по сегодня', () => {
    expect(resolveRange(FIRST, TODAY)).toEqual({ from: '2026-09-01', to: '2026-10-12' });
  });

  it('пресеты считаются от сегодняшнего дня в часовом поясе дашборда', () => {
    expect(resolveRange(FIRST, TODAY, { period: 'last7' })).toEqual({ from: '2026-10-06', to: '2026-10-12' });
    expect(resolveRange(FIRST, TODAY, { period: 'last30' })).toEqual({ from: '2026-09-13', to: '2026-10-12' });
    expect(resolveRange(FIRST, TODAY, { period: 'thisMonth' })).toEqual({ from: '2026-10-01', to: '2026-10-12' });
    expect(resolveRange(FIRST, TODAY, { period: 'prevMonth' })).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(resolveRange(FIRST, '2026-10-11', { period: 'last7' })).toEqual({ from: '2026-10-05', to: '2026-10-11' });
  });

  it('свой период: YYYY-MM-DD, обрезается по истории и сегодняшнему дню', () => {
    expect(resolveRange(FIRST, TODAY, { period: 'custom', from: '2026-10-01', to: '2026-10-05' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-05',
    });
    expect(resolveRange(FIRST, TODAY, { from: '2026-08-01', to: '2026-12-31' })).toEqual({
      from: '2026-09-01',
      to: '2026-10-12',
    });
  });

  it('кривые значения → по умолчанию; from позже to → один день to', () => {
    expect(resolveRange(FIRST, TODAY, { period: 'custom', from: 'вчера', to: 42 })).toEqual({
      from: '2026-09-01',
      to: '2026-10-12',
    });
    expect(resolveRange(FIRST, TODAY, { from: '2026-10-09', to: '2026-10-02' })).toEqual({
      from: '2026-10-02',
      to: '2026-10-02',
    });
  });
});

describe('оборот', () => {
  const payment = (id: string, paidIso: string, patch: Partial<PaymentRow> = {}): PaymentRow => ({
    provider: 'stripe', payment_id: id, account: 'corp', mid: 'corp', paid_at: ts(paidIso), amount_usd_cents: 1_000, refunded_usd_cents: 0,
    country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null, ...patch,
  });
  const range = { product: 'vpn' as const, provider: 'all' as const, filters: {}, from: '2026-10-05', to: '2026-10-11', timeZones: { stripe: 'UTC', solidgate: 'UTC' } };
  function seeded() {
    const store = openStore(':memory:');
    store.upsertPayment(payment('a', '2026-10-05T10:00:00Z', { amount_usd_cents: 3_000, refunded_usd_cents: 1_000 }));
    store.upsertPayment(payment('b', '2026-10-05T23:30:00Z', { country: 'GB', payment_method: 'google_pay' }));
    store.upsertPayment(payment('c', '2026-10-07T12:00:00Z', { provider: 'solidgate', account: 'sgH2H', mid: 'mid-1', country: null }));
    store.upsertPayment(payment('old', '2026-10-01T12:00:00Z')); // вне периода
    return store;
  }

  it('итоги и ряд по дням: оборот, рефанды, нетто, средний чек; пустые дни — нули', () => {
    const { totals, series } = getTurnover(seeded().db, { ...range, granularity: 'day' });
    expect(totals).toEqual({ payments: 3, gross: 5_000, refunded: 1_000, net: 4_000, average: 1_667 });
    expect(series).toHaveLength(7);
    expect(series[0]).toMatchObject({ period: '2026-10-05', payments: 2, gross: 4_000, net: 3_000 });
    expect(series[1]).toMatchObject({ period: '2026-10-06', payments: 0, gross: 0, average: null });
  });

  it('сутки по часовому поясу дашборда и группировка по неделям', () => {
    const ny = getTurnover(seeded().db, { ...range, timeZones: { stripe: 'America/New_York', solidgate: 'UTC' }, granularity: 'day' });
    expect(ny.series[0]).toMatchObject({ period: '2026-10-05', payments: 2 }); // Stripe 23:30 UTC — ещё 5-е по Нью-Йорку
    expect(ny.series[2]).toMatchObject({ period: '2026-10-07', payments: 1 }); // Solidgate 12:00 UTC — 7-е по UTC
    const weeks = getTurnover(seeded().db, { ...range, granularity: 'week' }).series;
    expect(weeks.map((w) => [w.period, w.period_end, w.payments])).toEqual([['2026-10-05', '2026-10-11', 3]]);
  });

  it('разбивка: по убыванию оборота, доля от оборота периода, «не определено» в конце; фильтры', () => {
    const db = seeded().db;
    expect(getTurnoverBreakdown(db, range, 'mid').map((r) => [r.value, r.gross, r.share])).toEqual([
      ['stripe:corp', 4_000, 0.8],
      ['solidgate:mid-1', 1_000, 0.2],
    ]);
    expect(getTurnoverBreakdown(db, range, 'country').map((r) => r.value)).toEqual(['US', 'GB', null]);
    expect(getTurnover(db, { ...range, granularity: 'day', filters: { country: ['none'] } }).totals.payments).toBe(1);
    expect(getTurnover(db, { ...range, granularity: 'day', filters: { country: ['GB', 'none'] } }).totals.payments).toBe(2);
    expect(getTurnover(db, { ...range, granularity: 'day', provider: 'solidgate' }).totals.gross).toBe(1_000);
    expect(getTurnover(db, { ...range, granularity: 'day', filters: { mid: ['stripe:corp'], payment_method: ['google_pay'] } }).totals.payments).toBe(1);
  });
});
