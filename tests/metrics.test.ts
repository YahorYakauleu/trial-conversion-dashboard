import { describe, expect, it } from 'vitest';
import { openStore, type TrialRow } from '../src/db.js';
import { DAY, getMetrics } from '../src/metrics.js';

// «Сегодня» = понедельник 2026-10-12, история с 1 сентября, триалы по 7 дней, окно ретраев 30 дней
const ts = (iso: string) => Date.parse(iso) / 1000;
const NOW = ts('2026-10-12T10:00:00Z');
const opts = {
  provider: 'all' as const,
  granularity: 'day' as const,
  now: NOW,
  historyFrom: ts('2026-09-01T00:00:00Z'),
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

const day = (series: { period: string }[], period: string) => series.find((p) => p.period === period)!;

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
    expect(day(getMetrics(store.db, opts).series, '2026-09-01')).toMatchObject({
      started: 4,
      paid_first: 1,
      paid_retry: 2,
      rate_first: 0.25,
      rate_retry: 0.5,
    });
  });

  it('с HISTORY_FROM до вчера, границы суток UTC', () => {
    const store = storeWith([
      trial('2026-08-31T23:00:00Z'), // до начала истории — не входит
      trial('2026-10-10T23:59:59Z'),
      trial('2026-10-11T00:00:00Z'),
      trial('2026-10-12T01:00:00Z'), // сегодня — не входит
    ]);
    const { series } = getMetrics(store.db, opts);
    expect(series[0].period).toBe('2026-09-01');
    expect(series.at(-1)!.period).toBe('2026-10-11');
    expect(series).toHaveLength(41);
    expect(day(series, '2026-10-10').started).toBe(1);
    expect(day(series, '2026-10-11').started).toBe(1);
    expect(series.reduce((sum, p) => sum + p.started, 0)).toBe(2);
  });

  it('пустые дни заполнены нулями, rate = null', () => {
    const { series } = getMetrics(openStore(':memory:').db, opts);
    expect(series[0]).toMatchObject({ started: 0, rate_first: null, rate_retry: null });
  });

  it('цифра окончательна, когда самый длинный триал дня закончился и прошло окно', () => {
    const { series } = getMetrics(storeWith([trial('2026-09-01T12:00:00Z')]).db, opts);
    // первая попытка: конец дня + 7 дн триала + 1 день; ретраи: конец дня + 7 дн + 30 дн
    expect(day(series, '2026-10-03').final_first).toBe(true);
    expect(day(series, '2026-10-04').final_first).toBe(false);
    expect(day(series, '2026-09-04').final_retry).toBe(true);
    expect(day(series, '2026-09-05').final_retry).toBe(false);
  });

  it('фильтр по провайдеру и сумма для «Все»', () => {
    const s = '2026-10-01T12:00:00Z';
    const store = storeWith([
      trial(s, { first_attempt_succeeded: true, paid_at: ts(s) + 7 * DAY }),
      trial(s, { provider: 'solidgate', account: 'sgH2H' }),
    ]);
    expect(day(getMetrics(store.db, { ...opts, provider: 'stripe' }).series, '2026-10-01').started).toBe(1);
    expect(day(getMetrics(store.db, { ...opts, provider: 'solidgate' }).series, '2026-10-01').started).toBe(1);
    expect(day(getMetrics(store.db, opts).series, '2026-10-01')).toMatchObject({
      started: 2,
      paid_first: 1,
      rate_first: 0.5,
    });
  });
});

describe('getMetrics — по неделям и карточки', () => {
  it('группирует по ISO-неделе; первая неделя подписана первым днём истории', () => {
    const store = storeWith([trial('2026-09-01T12:00:00Z'), trial('2026-10-05T12:00:00Z'), trial('2026-10-11T12:00:00Z')]);
    const { series } = getMetrics(store.db, { ...opts, granularity: 'week' });
    expect(series[0]).toMatchObject({ period: '2026-09-01', started: 1 });
    expect(series[1].period).toBe('2026-09-07');
    expect(series.at(-1)).toMatchObject({ period: '2026-10-05', started: 2, final_first: false });
    expect(series.slice(1).every((w) => new Date(`${w.period}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
  });

  it('карточки: последние 7 полных дней и последние 7 окончательных', () => {
    const store = storeWith([
      trial('2026-10-11T12:00:00Z'),
      trial('2026-10-03T12:00:00Z', { first_attempt_succeeded: true, paid_at: ts('2026-10-10T13:00:00Z') }),
      trial('2026-09-04T12:00:00Z', { first_attempt_succeeded: false, paid_at: ts('2026-09-15T12:00:00Z') }),
    ]);
    const { cards } = getMetrics(store.db, opts);
    expect(cards.started_7d).toEqual({ value: 1, from: '2026-10-05', to: '2026-10-11' });
    expect(cards.rate_first_7d).toEqual({ rate: 1, from: '2026-09-27', to: '2026-10-03' });
    expect(cards.rate_retry_7d).toEqual({ rate: 1, from: '2026-09-01', to: '2026-09-04' });
  });

  it('карточка без триалов в окончательных днях — «нет данных», а не пустой период', () => {
    const { cards } = getMetrics(storeWith([trial('2026-10-01T12:00:00Z')]).db, opts);
    expect(cards.rate_retry_7d).toEqual({ rate: null, from: null, to: null });
  });
});
