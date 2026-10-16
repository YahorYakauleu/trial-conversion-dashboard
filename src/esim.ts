import type { Db } from './db.js';
import { declineHint, declineLabel } from './declines.js';
import { bucketDay, bucketSql, DAY, dimensionFilterSql, mondayOf, periodSql, type Granularity, type TimeZones } from './metrics.js';
import { addDays } from './time.js';

// Метрики eSIM: у продукта нет подписок — каждая покупка пакета или пополнение отдельная оплата (PaymentIntent),
// в которой может быть несколько попыток (списаний). Списания лежат в payments с product = 'esim', и отклонённые тоже.
export const HEALTH_DIMENSIONS = ['destination', 'package', 'order_type', 'country', 'payment_method', 'card_brand'] as const;
export type HealthDimension = (typeof HEALTH_DIMENSIONS)[number];
// Повторные покупки — когорты клиентов по первой покупке; разрезы — по ней же
export const REPEAT_DIMENSIONS = ['destination', 'package', 'country', 'payment_method', 'card_brand'] as const;
export type RepeatDimension = (typeof REPEAT_DIMENSIONS)[number];
export type EsimFilters = Partial<Record<HealthDimension, string[]>>;

export interface EsimOptions {
  filters: EsimFilters;
  from: string; // первый день периода (местные сутки Stripe)
  to: string;
  timeZones: TimeZones;
  now: number;
}

const rate = (part: number, total: number) => (total === 0 ? null : part / total);
const column = (alias: string) => Object.fromEntries(HEALTH_DIMENSIONS.map((d) => [d, `${alias}.${d}`]));

// Ряд по дням периода (пустые дни — нулями), сгруппированный по неделям (ISO) или месяцам; края подписаны днями периода
function series<T extends object>(byDay: Map<string, T>, o: { from: string; to: string; granularity: Granularity }, zero: () => T, add: (a: T, b: T) => T) {
  const groups = new Map<string, T & { period: string; period_end: string }>();
  for (let day = o.from; day <= o.to; day = addDays(day, 1)) {
    const key = o.granularity === 'day' ? day : o.granularity === 'month' ? day.slice(0, 7) : mondayOf(day);
    const g = groups.get(key);
    groups.set(key, { ...add(g ?? zero(), byDay.get(day) ?? zero()), period: g?.period ?? day, period_end: day });
  }
  return [...groups.values()];
}

// --- платёжное здоровье: попытки (списания) и оплаты (PaymentIntent)

interface HealthCounts {
  charges: number; // все попытки списания
  approved: number; // успешные
  checkouts: number; // оплаты, в которых была хотя бы одна попытка
  paid_checkouts: number; // из них прошли — с любой попытки
  first_declined: number; // первая попытка оплаты отклонена
  recovered: number; // из них всё же оплачено — другой картой или повтором
  lost_usd_cents: number; // сумма оплат, которые так и не прошли
}

export interface HealthTotals extends HealthCounts {
  approval_rate: number | null;
  decline_rate: number | null;
  checkout_success_rate: number | null;
  recovery_rate: number | null;
}

const zeroHealth = (): HealthCounts => ({ charges: 0, approved: 0, checkouts: 0, paid_checkouts: 0, first_declined: 0, recovered: 0, lost_usd_cents: 0 });
const addHealth = (a: HealthCounts, b: HealthCounts): HealthCounts => ({
  charges: a.charges + b.charges,
  approved: a.approved + b.approved,
  checkouts: a.checkouts + b.checkouts,
  paid_checkouts: a.paid_checkouts + b.paid_checkouts,
  first_declined: a.first_declined + b.first_declined,
  recovered: a.recovered + b.recovered,
  lost_usd_cents: a.lost_usd_cents + b.lost_usd_cents,
});
const withHealthRates = <T extends HealthCounts>(c: T): T & HealthTotals => ({
  ...c,
  approval_rate: rate(c.approved, c.charges),
  decline_rate: rate(c.charges - c.approved, c.charges),
  checkout_success_rate: rate(c.paid_checkouts, c.checkouts),
  recovery_rate: rate(c.recovered, c.first_declined),
});

// Списания периода с номером попытки внутри своей оплаты и итогом оплаты — общая основа запросов здоровья
function chargesCte(o: EsimOptions) {
  const period = periodSql('p', 'p.paid_at', o);
  const dims = dimensionFilterSql(column('p'), o.filters);
  const sql = `WITH c AS (
      SELECT p.*,
             ROW_NUMBER() OVER (PARTITION BY COALESCE(p.intent_id, p.payment_id) ORDER BY p.paid_at, p.payment_id) AS n,
             COUNT(*) OVER (PARTITION BY COALESCE(p.intent_id, p.payment_id)) AS intent_charges,
             MAX(p.approved) OVER (PARTITION BY COALESCE(p.intent_id, p.payment_id)) AS intent_paid
      FROM payments p WHERE p.product = 'esim' AND ${[period.sql, ...dims.clauses].join(' AND ')}
    )`;
  return { sql, params: { ...period.params, ...dims.params } };
}

function healthSums(db: Db, o: EsimOptions, key: string) {
  const cte = chargesCte(o);
  return db
    .prepare(
      `${cte.sql}
       SELECT ${key} AS key, COUNT(*) AS charges, SUM(c.approved) AS approved,
              SUM(c.n = 1) AS checkouts, SUM(c.n = 1 AND c.intent_paid = 1) AS paid_checkouts,
              SUM(c.n = 1 AND c.approved = 0) AS first_declined, SUM(c.n = 1 AND c.approved = 0 AND c.intent_paid = 1) AS recovered,
              SUM(CASE WHEN c.n = 1 AND c.intent_paid = 0 THEN c.amount_usd_cents ELSE 0 END) AS lost_usd_cents
       FROM c GROUP BY key`,
    )
    .all(cte.params) as unknown as (HealthCounts & { key: string | number | null })[];
}

export function getHealth(db: Db, o: EsimOptions & { granularity: Granularity }) {
  const byDay = new Map<string, HealthCounts>();
  for (const { key, ...c } of healthSums(db, o, bucketSql('c', 'c.paid_at'))) {
    const day = bucketDay(key, o.timeZones);
    byDay.set(day, addHealth(byDay.get(day) ?? zeroHealth(), c));
  }
  const points = series(byDay, o, zeroHealth, addHealth).map(withHealthRates);
  return { totals: withHealthRates(points.reduce<HealthCounts>(addHealth, zeroHealth())), series: points };
}

// Разбивка: по убыванию попыток, «не определено» — в конце
export function getHealthBreakdown(db: Db, o: EsimOptions, dimension: HealthDimension) {
  const rows = healthSums(db, o, `c.${dimension}`)
    .map(({ key, ...c }) => withHealthRates({ value: key === null ? null : String(key), ...c }))
    .sort((a, b) => Number(a.value === null) - Number(b.value === null) || b.charges - a.charges || String(a.value).localeCompare(String(b.value)));
  return { totals: withHealthRates(rows.reduce<HealthCounts>(addHealth, zeroHealth())), breakdown: rows };
}

// Причины отказа — те же группы, что у VPN. Recovery rate — по причине первого отказа оплаты: какая доля таких оплат
// всё же прошла (обычно другой картой через минуту-две, поэтому «дней до оплаты» у eSIM нет)
export function getHealthReasons(db: Db, o: EsimOptions) {
  const cte = chargesCte(o);
  const rows = db
    .prepare(
      `${cte.sql}
       SELECT c.reason AS reason, COUNT(*) AS count, SUM(c.n = 1) AS first_declines,
              SUM(c.n = 1 AND c.intent_paid = 1) AS recovered, SUM(CASE WHEN c.n = 1 THEN c.intent_charges ELSE 0 END) AS attempts
       FROM c WHERE c.approved = 0 GROUP BY c.reason`,
    )
    .all(cte.params) as unknown as { reason: string | null; count: number; first_declines: number; recovered: number; attempts: number }[];
  const byLabel = new Map<string, { count: number; first_declines: number; recovered: number; attempts: number }>();
  for (const { reason, ...r } of rows) {
    const label = declineLabel(reason);
    const g = byLabel.get(label) ?? { count: 0, first_declines: 0, recovered: 0, attempts: 0 };
    byLabel.set(label, {
      count: g.count + r.count,
      first_declines: g.first_declines + r.first_declines,
      recovered: g.recovered + r.recovered,
      attempts: g.attempts + r.attempts,
    });
  }
  const total = [...byLabel.values()].reduce((s, g) => s + g.count, 0);
  return [...byLabel]
    .map(([reason, g]) => ({
      reason,
      hint: declineHint(reason),
      count: g.count,
      share: g.count / total,
      first_declines: g.first_declines,
      recovered: g.recovered,
      recovery_rate: rate(g.recovered, g.first_declines),
      avg_attempts: g.first_declines === 0 ? null : g.attempts / g.first_declines,
      avg_days_to_pay: null,
      final: true,
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, 'en'));
}

// --- повторные покупки: когорты клиентов по дню первой успешной покупки

const D30 = 30 * DAY;
const D90 = 90 * DAY;

interface RepeatCounts {
  customers: number; // новые клиенты — первая успешная покупка в эти дни
  repeat_30: number; // купили ещё раз в течение 30 дней после первой покупки
  repeat_90: number;
  topup_30: number; // пополнили пакет в течение 30 дней
  revenue_30: number; // выручка с них за 30 дней с первой покупки (включая её, без рефандов), центы USD
  revenue_90: number;
  repeaters: number; // купили второй раз когда-либо
  seconds_to_second: number; // сумма времени до второй покупки — у них
  first_first_at: number; // самая ранняя первая покупка в когорте (0 — клиентов нет): пока ей меньше 30 дней, 90 дней = 30 дням
  last_first_at: number; // самая поздняя первая покупка — для окончательности
}

export interface RepeatTotals extends RepeatCounts {
  repeat_rate_30: number | null;
  repeat_rate_90: number | null;
  topup_rate_30: number | null;
  revenue_per_customer_30: number | null; // центы USD
  revenue_per_customer_90: number | null;
  avg_days_to_second: number | null;
  final_30: boolean; // у всех клиентов прошло 30 дней с первой покупки — цифры за 30 дней больше не изменятся
  final_90: boolean;
}

const zeroRepeat = (): RepeatCounts => ({
  customers: 0, repeat_30: 0, repeat_90: 0, topup_30: 0, revenue_30: 0, revenue_90: 0, repeaters: 0, seconds_to_second: 0, first_first_at: 0, last_first_at: 0,
});
const addRepeat = (a: RepeatCounts, b: RepeatCounts): RepeatCounts => ({
  customers: a.customers + b.customers,
  repeat_30: a.repeat_30 + b.repeat_30,
  repeat_90: a.repeat_90 + b.repeat_90,
  topup_30: a.topup_30 + b.topup_30,
  revenue_30: a.revenue_30 + b.revenue_30,
  revenue_90: a.revenue_90 + b.revenue_90,
  repeaters: a.repeaters + b.repeaters,
  seconds_to_second: a.seconds_to_second + b.seconds_to_second,
  first_first_at: a.first_first_at && b.first_first_at ? Math.min(a.first_first_at, b.first_first_at) : a.first_first_at || b.first_first_at,
  last_first_at: Math.max(a.last_first_at, b.last_first_at),
});
const withRepeatRates = <T extends RepeatCounts>(c: T, now: number): T & RepeatTotals => ({
  ...c,
  repeat_rate_30: rate(c.repeat_30, c.customers),
  repeat_rate_90: rate(c.repeat_90, c.customers),
  topup_rate_30: rate(c.topup_30, c.customers),
  revenue_per_customer_30: c.customers === 0 ? null : Math.round(c.revenue_30 / c.customers),
  revenue_per_customer_90: c.customers === 0 ? null : Math.round(c.revenue_90 / c.customers),
  avg_days_to_second: c.repeaters === 0 ? null : c.seconds_to_second / c.repeaters / DAY,
  final_30: c.last_first_at + D30 <= now,
  final_90: c.last_first_at + D90 <= now,
});

// Один проход: успешные покупки клиента по порядку → итоги по клиенту → когорты по первой покупке (её же разрезы)
function repeatSums(db: Db, o: EsimOptions, key: string) {
  const period = periodSql('f', 'f.paid_at', o);
  const dims = dimensionFilterSql(column('f'), o.filters);
  return db
    .prepare(
      `WITH ranked AS (
         SELECT p.*, p.amount_usd_cents - p.refunded_usd_cents AS net,
                ROW_NUMBER() OVER (PARTITION BY p.customer_id ORDER BY p.paid_at, p.payment_id) AS n,
                MIN(p.paid_at) OVER (PARTITION BY p.customer_id) AS first_at
         FROM payments p WHERE p.product = 'esim' AND p.approved = 1 AND p.customer_id IS NOT NULL
       ),
       per_customer AS (
         SELECT customer_id,
                MIN(CASE WHEN n = 2 THEN paid_at END) AS second_at,
                SUM(CASE WHEN paid_at < first_at + @d30 THEN net ELSE 0 END) AS revenue_30,
                SUM(CASE WHEN paid_at < first_at + @d90 THEN net ELSE 0 END) AS revenue_90,
                MAX(n > 1 AND COALESCE(order_type, '') = 'topup' AND paid_at < first_at + @d30) AS topup_30
         FROM ranked GROUP BY customer_id
       )
       SELECT ${key} AS key, COUNT(*) AS customers,
              -- у клиента без второй покупки second_at пуст — сравнение даёт NULL, поэтому COALESCE
              COALESCE(SUM(c.second_at < f.paid_at + @d30), 0) AS repeat_30, COALESCE(SUM(c.second_at < f.paid_at + @d90), 0) AS repeat_90,
              COALESCE(SUM(c.topup_30), 0) AS topup_30, SUM(c.revenue_30) AS revenue_30, SUM(c.revenue_90) AS revenue_90,
              SUM(c.second_at IS NOT NULL) AS repeaters,
              COALESCE(SUM(c.second_at - f.paid_at), 0) AS seconds_to_second, MIN(f.paid_at) AS first_first_at, MAX(f.paid_at) AS last_first_at
       FROM ranked f JOIN per_customer c ON c.customer_id = f.customer_id
       WHERE f.n = 1 AND ${[period.sql, ...dims.clauses].join(' AND ')}
       GROUP BY key`,
    )
    .all({ ...period.params, ...dims.params, d30: D30, d90: D90 }) as unknown as (RepeatCounts & { key: string | number | null })[];
}

export function getRepeat(db: Db, o: EsimOptions & { granularity: Granularity }) {
  const byDay = new Map<string, RepeatCounts>();
  for (const { key, ...c } of repeatSums(db, o, bucketSql('f', 'f.paid_at'))) {
    const day = bucketDay(key, o.timeZones);
    byDay.set(day, addRepeat(byDay.get(day) ?? zeroRepeat(), c));
  }
  const points = series(byDay, o, zeroRepeat, addRepeat).map((p) => withRepeatRates(p, o.now));
  return { totals: withRepeatRates(points.reduce<RepeatCounts>(addRepeat, zeroRepeat()), o.now), series: points };
}

// Разбивка: по убыванию новых клиентов, «не определено» — в конце
export function getRepeatBreakdown(db: Db, o: EsimOptions, dimension: RepeatDimension) {
  const rows = repeatSums(db, o, `f.${dimension}`)
    .map(({ key, ...c }) => withRepeatRates({ value: key === null ? null : String(key), ...c }, o.now))
    .sort((a, b) => Number(a.value === null) - Number(b.value === null) || b.customers - a.customers || String(a.value).localeCompare(String(b.value)));
  return { totals: withRepeatRates(rows.reduce<RepeatCounts>(addRepeat, zeroRepeat()), o.now), breakdown: rows };
}
