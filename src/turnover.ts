import type { Db } from './db.js';
import {
  bucketDay,
  bucketSql,
  dimensionFilterSql,
  mondayOf,
  periodSql,
  type Granularity,
  type Product,
  type ProviderFilter,
  type TimeZones,
} from './metrics.js';
import { addDays } from './time.js';

// Оборот — все успешные платежи по дате платежа (не по когортам триалов). Суммы — в центах USD.
// Разрезы у продуктов свои: у eSIM — что купили (направление, пакет, покупка или пополнение)
export const TURNOVER_DIMENSIONS = ['mid', 'country', 'payment_method', 'bank', 'card_brand'] as const;
export const ESIM_TURNOVER_DIMENSIONS = ['destination', 'package', 'order_type', 'country', 'payment_method', 'card_brand'] as const;
export type TurnoverDimension = (typeof TURNOVER_DIMENSIONS)[number] | (typeof ESIM_TURNOVER_DIMENSIONS)[number];
export const turnoverDimensions = (product: Product): readonly TurnoverDimension[] =>
  product === 'esim' ? ESIM_TURNOVER_DIMENSIONS : TURNOVER_DIMENSIONS;
export const DIMENSION_SQL: Record<TurnoverDimension, string> = {
  // провайдер вместе с MID, как у аккаунтов: stripe:corp, solidgate:<uuid>
  mid: "p.provider || ':' || p.mid",
  country: 'p.country',
  payment_method: 'p.payment_method',
  bank: 'p.bank',
  card_brand: 'p.card_brand',
  destination: 'p.destination',
  package: 'p.package',
  order_type: 'p.order_type',
};
// Фильтр по измерению — список значений, 'none' — «не определено» (как у триалов)
export type TurnoverFilters = Partial<Record<TurnoverDimension, string[]>>;

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
  product: Product;
  provider: ProviderFilter;
  filters: TurnoverFilters;
  from: string; // первый день периода (местные сутки)
  to: string; // последний день включительно
  timeZones: TimeZones;
}

const zero = (): Sums => ({ payments: 0, gross: 0, refunded: 0 });
const add = (a: Sums, b: Sums): Sums => ({ payments: a.payments + b.payments, gross: a.gross + b.gross, refunded: a.refunded + b.refunded });
const withTotals = <T extends Sums>(s: T): T & TurnoverTotals => ({
  ...s,
  net: s.gross - s.refunded,
  average: s.payments === 0 ? null : Math.round(s.gross / s.payments),
});

function paymentFilter(o: TurnoverOptions) {
  const period = periodSql('p', 'p.paid_at', o);
  const dimensions = dimensionFilterSql(DIMENSION_SQL, o.filters);
  const params: Record<string, string | number> = { ...period.params, ...dimensions.params, provider: o.provider, product: o.product };
  // в payments у eSIM лежат и отклонённые списания — в оборот только успешные
  const clauses = [period.sql, 'p.product = @product', 'p.approved = 1', "(@provider = 'all' OR p.provider = @provider)", ...dimensions.clauses];
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
  // корзины по 15 минут → местные сутки провайдера (как у триалов)
  const byDay = new Map<string, Sums>();
  for (const { key, ...s } of sums(db, o, bucketSql('p', 'p.paid_at'))) {
    const day = bucketDay(key, o.timeZones);
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

// Итоги из разбивки: каждый платёж попадает ровно в одну строку — второй проход по базе не нужен
export const turnoverTotalsOf = (rows: TurnoverRow[]): TurnoverTotals => withTotals(rows.reduce<Sums>(add, zero()));

// Значения измерений для фильтров (вся история провайдера и продукта) — по убыванию числа списаний; null — «не определено».
// У eSIM — и по отклонённым списаниям: те же значения нужны экрану платёжного здоровья
export function getTurnoverDimensionValues(db: Db, provider: ProviderFilter, product: Product = 'vpn') {
  return Object.fromEntries(
    turnoverDimensions(product).map((d) => [
      d,
      db
        .prepare(
          `SELECT ${DIMENSION_SQL[d]} AS value, COUNT(*) AS count FROM payments p
           WHERE p.product = @product AND (@provider = 'all' OR p.provider = @provider) GROUP BY value ORDER BY count DESC LIMIT 1000`,
        )
        .all({ provider, product }) as unknown as { value: string | null; count: number }[],
    ]),
  );
}

// Разбивка по измерению: по убыванию оборота, доля — от оборота периода; «не определено» — всегда в конце
export function getTurnoverBreakdown(db: Db, o: TurnoverOptions, dimension: TurnoverDimension): TurnoverRow[] {
  const rows = sums(db, o, DIMENSION_SQL[dimension]);
  const total = rows.reduce((s, r) => s + r.gross, 0);
  return rows
    .map(({ key, ...s }) => withTotals({ value: key === null ? null : String(key), ...s, share: total === 0 ? null : s.gross / total }))
    .sort((a, b) => Number(a.value === null) - Number(b.value === null) || b.gross - a.gross || String(a.value).localeCompare(String(b.value)));
}
