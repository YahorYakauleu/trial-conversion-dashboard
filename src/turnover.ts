import type { Db } from './db.js';
import { BUCKET, mondayOf, type Granularity, type ProviderFilter } from './metrics.js';
import { addDays, localDay, localMidnight } from './time.js';

// Оборот — все успешные платежи по дате платежа (не по когортам триалов). Суммы — в центах USD.
export const TURNOVER_DIMENSIONS = ['mid', 'country', 'payment_method', 'bank', 'card_brand'] as const;
export type TurnoverDimension = (typeof TURNOVER_DIMENSIONS)[number];
const DIMENSION_SQL: Record<TurnoverDimension, string> = {
  // провайдер вместе с MID, как у аккаунтов: stripe:corp, solidgate:<uuid>
  mid: "p.provider || ':' || p.mid",
  country: 'p.country',
  payment_method: 'p.payment_method',
  bank: 'p.bank',
  card_brand: 'p.card_brand',
};
// Фильтр по измерению: значение или 'none' — «не определено»
export type TurnoverFilters = Partial<Record<TurnoverDimension, string>>;

interface Sums {
  payments: number;
  gross: number; // оборот
  refunded: number; // из него возвращено
}

export interface TurnoverTotals extends Sums {
  net: number; // оборот за вычетом рефандов
  average: number | null; // средний чек
}

export interface TurnoverPoint extends TurnoverTotals {
  period: string; // первый день группы внутри периода (YYYY-MM-DD)
  period_end: string;
}

export interface TurnoverRow extends TurnoverTotals {
  value: string | null; // null — не определено
  share: number | null; // доля в обороте периода
}

export interface TurnoverOptions {
  provider: ProviderFilter;
  filters: TurnoverFilters;
  from: string; // первый день периода (местные сутки)
  to: string; // последний день включительно
  timeZone: string;
}

const zero = (): Sums => ({ payments: 0, gross: 0, refunded: 0 });
const add = (a: Sums, b: Sums): Sums => ({ payments: a.payments + b.payments, gross: a.gross + b.gross, refunded: a.refunded + b.refunded });
const withTotals = <T extends Sums>(s: T): T & TurnoverTotals => ({
  ...s,
  net: s.gross - s.refunded,
  average: s.payments === 0 ? null : Math.round(s.gross / s.payments),
});

// node:sqlite не принимает лишние именованные параметры — параметры фильтров добавляются только используемые
function paymentFilter(o: TurnoverOptions) {
  const params: Record<string, string | number> = {
    from: localMidnight(o.from, o.timeZone),
    until: localMidnight(addDays(o.to, 1), o.timeZone),
    provider: o.provider,
  };
  const clauses = ['p.paid_at >= @from', 'p.paid_at < @until', "(@provider = 'all' OR p.provider = @provider)"];
  for (const dimension of TURNOVER_DIMENSIONS) {
    const value = o.filters[dimension];
    if (!value) continue;
    if (value === 'none') {
      clauses.push(`${DIMENSION_SQL[dimension]} IS NULL`);
    } else {
      clauses.push(`${DIMENSION_SQL[dimension]} = @f_${dimension}`);
      params[`f_${dimension}`] = value;
    }
  }
  return { sql: clauses.join(' AND '), params };
}

function sums(db: Db, o: TurnoverOptions, key: string) {
  const filter = paymentFilter(o);
  return db
    .prepare(
      `SELECT ${key} AS key, COUNT(*) AS payments, SUM(p.amount_usd_cents) AS gross, SUM(p.refunded_usd_cents) AS refunded
       FROM payments p WHERE ${filter.sql} GROUP BY key`,
    )
    .all(filter.params) as unknown as (Sums & { key: string | number | null })[];
}

export function getTurnover(db: Db, o: TurnoverOptions & { granularity: Granularity }): { totals: TurnoverTotals; series: TurnoverPoint[] } {
  // корзины по 15 минут → местные сутки (как у триалов)
  const byDay = new Map<string, Sums>();
  for (const { key, ...s } of sums(db, o, `(p.paid_at / ${BUCKET}) * ${BUCKET}`)) {
    const day = localDay(Number(key), o.timeZone);
    byDay.set(day, add(byDay.get(day) ?? zero(), s));
  }

  // неделя — ISO (с понедельника), месяц — календарный; края, обрезанные периодом, подписаны его днями
  const groups = new Map<string, Sums & { period: string; period_end: string }>();
  for (let day = o.from; day <= o.to; day = addDays(day, 1)) {
    const key = o.granularity === 'day' ? day : o.granularity === 'month' ? day.slice(0, 7) : mondayOf(day);
    const g = groups.get(key);
    const s = byDay.get(day) ?? zero();
    groups.set(key, g ? { ...add(g, s), period: g.period, period_end: day } : { ...s, period: day, period_end: day });
  }
  const series = [...groups.values()].map(withTotals);
  return { totals: withTotals(series.reduce<Sums>(add, zero())), series };
}

// Разбивка по измерению: по убыванию оборота, доля — от оборота периода; «не определено» — всегда в конце
export function getTurnoverBreakdown(db: Db, o: TurnoverOptions, dimension: TurnoverDimension): TurnoverRow[] {
  const rows = sums(db, o, DIMENSION_SQL[dimension]);
  const total = rows.reduce((s, r) => s + r.gross, 0);
  return rows
    .map(({ key, ...s }) => withTotals({ value: key === null ? null : String(key), ...s, share: total === 0 ? null : s.gross / total }))
    .sort((a, b) => Number(a.value === null) - Number(b.value === null) || b.gross - a.gross || String(a.value).localeCompare(String(b.value)));
}
