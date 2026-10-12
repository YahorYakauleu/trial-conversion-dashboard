import { describe, expect, it } from 'vitest';
import { openStore, type TrialRow } from '../src/db.js';
import { DAY, getMetrics } from '../src/metrics.js';

// «Сегодня» = понедельник 2026-10-12, окно ретраев 30 дней
const ts = (iso: string) => Date.parse(iso) / 1000;
const NOW = ts('2026-10-12T10:00:00Z');
const opts = { provider: 'all' as const, granularity: 'day' as const, now: NOW, historyDays: 90, retryWindowDays: 30 };

let seq = 0;
function trial(endedIso: string, patch: Partial<TrialRow> = {}): TrialRow {
  const ended = ts(endedIso);
  return {
    provider: 'stripe',
    account: 'org',
    subscription_id: `sub_${++seq}`,
    trial_started_at: ended - 3 * DAY,
    trial_ended_at: ended,
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

describe('getMetrics — по дням', () => {
  it('считает ended / paid_first / paid_retry с учётом окна', () => {
    const e = '2026-09-01T12:00:00Z';
    const store = storeWith([
      trial(e, { first_invoice_id: 'in', first_attempt_succeeded: true, paid_at: ts(e) + 3600 }),
      trial(e, { first_invoice_id: 'in', first_attempt_succeeded: false, paid_at: ts(e) + 5 * DAY }),
      trial(e, { first_invoice_id: 'in', first_attempt_succeeded: false, paid_at: ts(e) + 31 * DAY }),
      trial(e),
    ]);
    const p = day(getMetrics(store.db, opts).series, '2026-09-01');
    expect(p).toMatchObject({ ended: 4, paid_first: 1, paid_retry: 2, rate_first: 0.25, rate_retry: 0.5 });
  });

  it('границы суток UTC и исключение сегодняшнего дня', () => {
    const store = storeWith([
      trial('2026-10-10T23:59:59Z'),
      trial('2026-10-11T00:00:00Z'),
      trial('2026-10-12T01:00:00Z'), // сегодня — не входит
    ]);
    const { series } = getMetrics(store.db, opts);
    expect(day(series, '2026-10-10').ended).toBe(1);
    expect(day(series, '2026-10-11').ended).toBe(1);
    expect(series.at(-1)!.period).toBe('2026-10-11');
    expect(series).toHaveLength(90);
  });

  it('пустые дни заполнены нулями, rate = null', () => {
    const { series } = getMetrics(openStore(':memory:').db, opts);
    expect(series[0]).toMatchObject({ ended: 0, rate_first: null, rate_retry: null });
  });

  it('флаги окончательности', () => {
    const { series } = getMetrics(openStore(':memory:').db, opts);
    expect(day(series, '2026-10-10').final_first).toBe(true);
    expect(day(series, '2026-10-11').final_first).toBe(false);
    expect(day(series, '2026-09-11').final_retry).toBe(true); // 11.09 + 31 д = 12.10
    expect(day(series, '2026-09-12').final_retry).toBe(false);
  });

  it('фильтр по провайдеру и сумма для «Все»', () => {
    const e = '2026-10-01T12:00:00Z';
    const store = storeWith([
      trial(e, { first_attempt_succeeded: true, paid_at: ts(e) }),
      trial(e, { provider: 'solidgate', account: 'sg' }),
    ]);
    expect(day(getMetrics(store.db, { ...opts, provider: 'stripe' }).series, '2026-10-01').ended).toBe(1);
    expect(day(getMetrics(store.db, { ...opts, provider: 'solidgate' }).series, '2026-10-01').ended).toBe(1);
    expect(day(getMetrics(store.db, opts).series, '2026-10-01')).toMatchObject({
      ended: 2,
      paid_first: 1,
      rate_first: 0.5,
    });
  });
});

describe('getMetrics — по неделям и карточки', () => {
  it('группирует по ISO-неделе и отбрасывает неполную первую неделю', () => {
    const store = storeWith([trial('2026-10-05T12:00:00Z'), trial('2026-10-11T12:00:00Z')]);
    const { series } = getMetrics(store.db, { ...opts, granularity: 'week' });
    expect(series.at(-1)).toMatchObject({ period: '2026-10-05', ended: 2, final_first: false });
    expect(series.every((w) => new Date(`${w.period}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
    // 90 дней назад от 12.10 = 14.07 (вторник) — неделя 13.07 неполная и отброшена
    expect(series[0].period).toBe('2026-07-20');
  });

  it('карточки: последние 7 полных дней и последние 7 окончательных', () => {
    const store = storeWith([
      trial('2026-10-11T12:00:00Z'),
      trial('2026-10-10T12:00:00Z', { first_attempt_succeeded: true, paid_at: ts('2026-10-10T13:00:00Z') }),
      trial('2026-09-11T12:00:00Z', { first_attempt_succeeded: false, paid_at: ts('2026-09-15T12:00:00Z') }),
    ]);
    const { cards } = getMetrics(store.db, opts);
    expect(cards.ended_7d).toEqual({ value: 2, from: '2026-10-05', to: '2026-10-11' });
    expect(cards.rate_first_7d).toEqual({ rate: 1, from: '2026-10-04', to: '2026-10-10' });
    expect(cards.rate_retry_7d).toEqual({ rate: 1, from: '2026-09-05', to: '2026-09-11' });
  });
});
