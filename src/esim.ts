import type { Db } from './db.js';
import { groupDays } from './days.js';
import { declineHint, declineLabel, FRAUD_RULE_CODES } from './declines.js';
import { bucketDay, bucketSql, DAY, dimensionFilterSql, periodSql, type Granularity, type TimeZones } from './metrics.js';

// Метрики eSIM: у продукта нет подписок — каждая покупка пакета или пополнение отдельный заказ (PaymentIntent),
// в котором может быть несколько попыток списания (повторное нажатие, другая карта). Наружу — только заказы:
// попытки путают. Списания лежат в payments с product = 'esim', отклонённые тоже.
export const OVERVIEW_DIMENSIONS = ['destination', 'package', 'country', 'payment_method', 'bank', 'card_brand'] as const;
export type OverviewDimension = (typeof OVERVIEW_DIMENSIONS)[number];
// Удержание — когорты клиентов по первой покупке; разрезы — по ней же
export const REPEAT_DIMENSIONS = OVERVIEW_DIMENSIONS;
export type RepeatDimension = OverviewDimension;
export type EsimFilters = Partial<Record<OverviewDimension, string[]>>;

export interface EsimOptions {
  filters: EsimFilters;
  from: string; // первый день периода (местные сутки Stripe)
  to: string;
  timeZones: TimeZones;
  now: number;
}

const rate = (part: number, total: number) => (total === 0 ? null : part / total);
const column = (alias: string) => Object.fromEntries(OVERVIEW_DIMENSIONS.map((d) => [d, `${alias}.${d}`]));

// --- обзор: что случилось в этот день — заказы, деньги, новые клиенты, неоплаченные заказы

interface OverviewCounts {
  orders: number; // заказы, в которых была хотя бы одна попытка оплаты
  paid_orders: number; // из них оплачены
  new_customers: number; // оплаченные заказы, ставшие первой покупкой клиента
  repeat_orders: number; // оплаченные заказы клиентов, уже покупавших раньше
  fraud_blocked: number; // неоплаченные заказы, которые отсёк антифрод, — в долю оплаченных не входят
  revenue: number; // оплаченные заказы за вычетом рефандов, центы USD
  lost_revenue: number; // сумма неоплаченных заказов настоящих покупателей (без отсечённых антифродом)
}

export interface OverviewTotals extends OverviewCounts {
  payment_success_rate: number | null; // оплачено ÷ заказы без отсечённых антифродом
}

const zeroOverview = (): OverviewCounts => ({ orders: 0, paid_orders: 0, new_customers: 0, repeat_orders: 0, fraud_blocked: 0, revenue: 0, lost_revenue: 0 });
const addOverview = (a: OverviewCounts, b: OverviewCounts): OverviewCounts => ({
  orders: a.orders + b.orders,
  paid_orders: a.paid_orders + b.paid_orders,
  new_customers: a.new_customers + b.new_customers,
  repeat_orders: a.repeat_orders + b.repeat_orders,
  fraud_blocked: a.fraud_blocked + b.fraud_blocked,
  revenue: a.revenue + b.revenue,
  lost_revenue: a.lost_revenue + b.lost_revenue,
});
const withOverviewRates = <T extends OverviewCounts>(c: T): T & OverviewTotals => ({
  ...c,
  payment_success_rate: rate(c.paid_orders, c.orders - c.fraud_blocked),
});

// Заказы периода: попытки → заказ (день и разрезы — по первой попытке, причина отказа — по последней).
// Новый клиент — если оплата заказа стала первой успешной покупкой клиента за всю историю.
// Общая основа для цифр экрана и выгрузки списком (src/export.ts)
export function ordersCte(o: EsimOptions, key: string) {
  const period = periodSql('p', 'p.paid_at', o);
  const dims = dimensionFilterSql(column('p'), o.filters);
  const fraud = FRAUD_RULE_CODES.map((code) => `'${code}'`).join(', ');
  const sql = `WITH first_paid AS (
      SELECT payment_id FROM (
        SELECT payment_id, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY paid_at, payment_id) AS k
        FROM payments WHERE product = 'esim' AND approved = 1 AND customer_id IS NOT NULL
      ) WHERE k = 1
    ),
    c AS (
      SELECT p.*, COALESCE(p.intent_id, p.payment_id) AS order_id,
             ROW_NUMBER() OVER (PARTITION BY COALESCE(p.intent_id, p.payment_id) ORDER BY p.paid_at, p.payment_id) AS n,
             COUNT(*) OVER (PARTITION BY COALESCE(p.intent_id, p.payment_id)) AS n_attempts,
             p.payment_id IN (SELECT payment_id FROM first_paid) AS first_purchase
      FROM payments p WHERE p.product = 'esim' AND ${[period.sql, ...dims.clauses].join(' AND ')}
    ),
    orders AS (
      SELECT c.order_id, MAX(CASE WHEN c.n = 1 THEN ${key} END) AS key,
             MAX(c.approved) AS paid,
             MAX(c.first_purchase) AS first_purchase,
             MAX(c.approved = 0 AND c.reason IN (${fraud})) AS fraud,
             MAX(CASE WHEN c.n = c.n_attempts THEN c.reason END) AS last_reason,
             SUM(CASE WHEN c.approved = 1 THEN c.amount_usd_cents - c.refunded_usd_cents ELSE 0 END) AS revenue,
             SUM(CASE WHEN c.n = 1 THEN c.amount_usd_cents ELSE 0 END) AS amount,
             -- для выгрузки: кто, когда и что покупал (разрезы — по первой попытке), сколько попыток, какие списания
             MAX(c.customer_id) AS customer_id, MIN(c.paid_at) AS started_at, COUNT(*) AS attempts, GROUP_CONCAT(c.payment_id, ' ') AS charge_ids,
             ${['destination', 'package', 'order_type', 'country', 'payment_method', 'bank', 'card_brand'].map((d) => `MAX(CASE WHEN c.n = 1 THEN c.${d} END) AS ${d}`).join(', ')}
      FROM c GROUP BY c.order_id
    )`;
  return { sql, params: { ...period.params, ...dims.params } };
}

function overviewSums(db: Db, o: EsimOptions, key: string) {
  const cte = ordersCte(o, key);
  return db
    .prepare(
      `${cte.sql}
       SELECT key, COUNT(*) AS orders, SUM(paid) AS paid_orders,
              SUM(paid = 1 AND first_purchase = 1) AS new_customers, SUM(paid = 1 AND first_purchase = 0) AS repeat_orders,
              SUM(paid = 0 AND fraud = 1) AS fraud_blocked, SUM(revenue) AS revenue,
              SUM(CASE WHEN paid = 0 AND fraud = 0 THEN amount ELSE 0 END) AS lost_revenue
       FROM orders GROUP BY key`,
    )
    .all(cte.params) as unknown as (OverviewCounts & { key: string | number | null })[];
}

export function getOverview(db: Db, o: EsimOptions & { granularity: Granularity }) {
  const byDay = new Map<string, OverviewCounts>();
  for (const { key, ...c } of overviewSums(db, o, bucketSql('c', 'c.paid_at'))) {
    const day = bucketDay(key, o.timeZones);
    byDay.set(day, addOverview(byDay.get(day) ?? zeroOverview(), c));
  }
  const points = groupDays(byDay, o, zeroOverview, addOverview).map(withOverviewRates);
  return { totals: withOverviewRates(points.reduce<OverviewCounts>(addOverview, zeroOverview())), series: points };
}

// Разбивка: по убыванию выручки, «не определено» — в конце
export function getOverviewBreakdown(db: Db, o: EsimOptions, dimension: OverviewDimension) {
  const rows = overviewSums(db, o, `c.${dimension}`)
    .map(({ key, ...c }) => withOverviewRates({ value: key === null ? null : String(key), ...c }))
    .sort((a, b) => Number(a.value === null) - Number(b.value === null) || b.revenue - a.revenue || b.orders - a.orders || String(a.value).localeCompare(String(b.value)));
  return { totals: withOverviewRates(rows.reduce<OverviewCounts>(addOverview, zeroOverview())), breakdown: rows };
}

// Почему заказы не оплачены: причина последней попытки, те же группы, что у VPN (антифрод — отдельной строкой)
export function getOverviewReasons(db: Db, o: EsimOptions) {
  const cte = ordersCte(o, "''");
  const rows = db
    .prepare(`${cte.sql} SELECT last_reason AS reason, COUNT(*) AS count FROM orders WHERE paid = 0 GROUP BY last_reason`)
    .all(cte.params) as unknown as { reason: string | null; count: number }[];
  const byLabel = new Map<string, number>();
  for (const r of rows) byLabel.set(declineLabel(r.reason), (byLabel.get(declineLabel(r.reason)) ?? 0) + r.count);
  const total = [...byLabel.values()].reduce((s, n) => s + n, 0);
  return [...byLabel]
    .map(([reason, count]) => ({ reason, hint: declineHint(reason), count, share: count / total }))
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

// Когорта: клиенты, впервые купившие в периоде, — строка первой покупки (её разрезы) и итоги клиента:
// когда купил второй раз, выручка за 30 и 90 дней, пополнял ли. Общая основа для цифр экрана и выгрузки (src/export.ts)
export function cohortCte(o: EsimOptions) {
  const period = periodSql('f', 'f.paid_at', o);
  const dims = dimensionFilterSql(column('f'), o.filters);
  const sql = `WITH ranked AS (
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
     ),
     cohort AS (
       SELECT f.*, c.second_at, c.revenue_30, c.revenue_90, c.topup_30
       FROM ranked f JOIN per_customer c ON c.customer_id = f.customer_id
       WHERE f.n = 1 AND ${[period.sql, ...dims.clauses].join(' AND ')}
     )`;
  return { sql, params: { ...period.params, ...dims.params, d30: D30, d90: D90 } };
}

function repeatSums(db: Db, o: EsimOptions, key: string) {
  const cte = cohortCte(o);
  return db
    .prepare(
      `${cte.sql}
       SELECT ${key} AS key, COUNT(*) AS customers,
              -- у клиента без второй покупки second_at пуст — сравнение даёт NULL, поэтому COALESCE
              COALESCE(SUM(f.second_at < f.paid_at + @d30), 0) AS repeat_30, COALESCE(SUM(f.second_at < f.paid_at + @d90), 0) AS repeat_90,
              COALESCE(SUM(f.topup_30), 0) AS topup_30, SUM(f.revenue_30) AS revenue_30, SUM(f.revenue_90) AS revenue_90,
              SUM(f.second_at IS NOT NULL) AS repeaters,
              COALESCE(SUM(f.second_at - f.paid_at), 0) AS seconds_to_second, MIN(f.paid_at) AS first_first_at, MAX(f.paid_at) AS last_first_at
       FROM cohort f GROUP BY key`,
    )
    .all(cte.params) as unknown as (RepeatCounts & { key: string | number | null })[];
}

export function getRepeat(db: Db, o: EsimOptions & { granularity: Granularity }) {
  const byDay = new Map<string, RepeatCounts>();
  for (const { key, ...c } of repeatSums(db, o, bucketSql('f', 'f.paid_at'))) {
    const day = bucketDay(key, o.timeZones);
    byDay.set(day, addRepeat(byDay.get(day) ?? zeroRepeat(), c));
  }
  const points = groupDays(byDay, o, zeroRepeat, addRepeat).map((p) => withRepeatRates(p, o.now));
  return { totals: withRepeatRates(points.reduce<RepeatCounts>(addRepeat, zeroRepeat()), o.now), series: points };
}

// Разбивка: по убыванию новых клиентов, «не определено» — в конце
export function getRepeatBreakdown(db: Db, o: EsimOptions, dimension: RepeatDimension) {
  const rows = repeatSums(db, o, `f.${dimension}`)
    .map(({ key, ...c }) => withRepeatRates({ value: key === null ? null : String(key), ...c }, o.now))
    .sort((a, b) => Number(a.value === null) - Number(b.value === null) || b.customers - a.customers || String(a.value).localeCompare(String(b.value)));
  return { totals: withRepeatRates(rows.reduce<RepeatCounts>(addRepeat, zeroRepeat()), o.now), breakdown: rows };
}
