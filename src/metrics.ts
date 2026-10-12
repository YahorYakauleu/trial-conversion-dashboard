import type { Db, Provider } from './db.js';
import { declineLabel } from './declines.js';
import { addDays, localDay, localMidnight } from './time.js';

export const DAY = 86_400;
// Первая автоматическая попытка проходит в течение суток после конца триала
const FIRST_ATTEMPT_SETTLE = DAY;
// Корзины по 15 минут: смещения всех часовых поясов кратны 15 минутам, поэтому корзина целиком
// лежит в одних местных сутках. Так SQLite отдаёт сотни строк вместо сотен тысяч триалов.
const BUCKET = 900;

export type ProviderFilter = Provider | 'all';
export type Granularity = 'day' | 'week' | 'month';
export type Preset = 'last7' | 'last30' | 'thisMonth' | 'prevMonth' | 'all' | 'custom';
// Измерения для разбивки и фильтров — это колонки trials
export const DIMENSIONS = ['country', 'payment_method', 'bank', 'card_brand'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
// Фильтр по измерению: значение или 'none' — «не определено»
export type Filters = Partial<Record<Dimension, string>>;

export interface Counts {
  started: number; // оформлено триалов
  paid_first: number; // оплатили с первой попытки
  paid_retry: number; // оплатили в окне ретраев («сконвертилось»)
  attempts: number; // попыток списания первого платного периода
  approved: number; // из них успешных
  refunded: number; // сконвертившихся, кому вернули первый платёж
}

export interface Totals extends Counts {
  rate_first: number | null;
  rate_retry: number | null;
  approval_rate: number | null; // проходимость: успешные попытки / все попытки
  decline_rate: number | null; // отклонённые попытки / все попытки
  refund_rate: number | null; // рефанды / сконвертившиеся
  final_first: boolean;
  final_retry: boolean; // для конверсии, проходимости, decline и рефандов
}

export interface Point extends Totals {
  period: string; // первый день группы внутри периода (YYYY-MM-DD)
  period_end: string; // последний день группы внутри периода
}

export interface BreakdownRow extends Totals {
  value: string | null; // значение измерения; null — не определено
}

export interface ReasonRow {
  reason: string; // общее название причины (коды Stripe и Solidgate сведены)
  count: number;
  share: number; // доля от всех отказов
}

export interface MetricsOptions {
  provider: ProviderFilter;
  granularity: Granularity;
  filters: Filters;
  now: number;
  from: string; // первый день периода (YYYY-MM-DD, местные сутки)
  to: string; // последний день периода включительно
  timeZone: string;
  retryWindowDays: number;
}

type RangeOptions = Omit<MetricsOptions, 'granularity'>;

export const startOfUtcDay = (ts: number) => Math.floor(ts / DAY) * DAY;
export const dayKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const rate = (part: number, total: number) => (total === 0 ? null : part / total);
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const zero = (): Counts => ({ started: 0, paid_first: 0, paid_retry: 0, attempts: 0, approved: 0, refunded: 0 });

// Период из адреса страницы: пресет или свои даты, в местных сутках; обрезается по началу истории и сегодняшнему дню.
// Сегодня — неполный день, но показывается как обычный (его цифры неокончательные, «≈»).
export function resolveRange(
  historyFrom: number,
  now: number,
  timeZone: string,
  query: { period?: unknown; from?: unknown; to?: unknown } = {},
): { from: string; to: string } {
  const first = localDay(historyFrom, timeZone);
  const today = localDay(now, timeZone);
  const monthStart = (day: string) => `${day.slice(0, 8)}01`;
  const period = typeof query.period === 'string' ? query.period : isDay(query.from) || isDay(query.to) ? 'custom' : 'all';

  let from = first;
  let to = today;
  if (period === 'last7') from = addDays(today, -6);
  if (period === 'last30') from = addDays(today, -29);
  if (period === 'thisMonth') from = monthStart(today);
  if (period === 'prevMonth') {
    to = addDays(monthStart(today), -1);
    from = monthStart(to);
  }
  if (period === 'custom') {
    if (isDay(query.from)) from = query.from;
    if (isDay(query.to)) to = query.to;
  }

  const clamp = (day: string) => (day < first ? first : day > today ? today : day);
  to = clamp(to);
  from = clamp(from);
  return { from: from > to ? to : from, to };
}

// Фильтр по триалам (алиас t): период оформления в местных сутках, провайдер, измерения.
// node:sqlite не принимает лишние именованные параметры — параметры фильтров добавляются только используемые.
function trialFilter(o: RangeOptions) {
  const params: Record<string, string | number> = {
    from: localMidnight(o.from, o.timeZone),
    until: localMidnight(addDays(o.to, 1), o.timeZone),
    provider: o.provider,
  };
  const clauses = ['t.trial_started_at >= @from', 't.trial_started_at < @until', "(@provider = 'all' OR t.provider = @provider)"];
  for (const dimension of DIMENSIONS) {
    const value = o.filters[dimension];
    if (!value) continue;
    if (value === 'none') {
      clauses.push(`t.${dimension} IS NULL`);
    } else {
      clauses.push(`t.${dimension} = @f_${dimension}`);
      params[`f_${dimension}`] = value;
    }
  }
  return { sql: clauses.join(' AND '), params };
}

// Агрегаты по группам (key — SQL-выражение): триалы и, отдельно, их попытки списания
function aggregate(db: Db, o: RangeOptions, key: string): Map<string | number | null, Counts> {
  const filter = trialFilter(o);
  const paid = 't.paid_at IS NOT NULL AND t.paid_at <= t.trial_ended_at + @window';
  const trials = db
    .prepare(
      `SELECT ${key} AS key,
              COUNT(*) AS started,
              SUM(CASE WHEN t.first_attempt_succeeded = 1 THEN 1 ELSE 0 END) AS paid_first,
              SUM(CASE WHEN ${paid} THEN 1 ELSE 0 END) AS paid_retry,
              SUM(CASE WHEN ${paid} AND EXISTS (SELECT 1 FROM attempts a WHERE a.provider = t.provider
                    AND a.subscription_id = t.subscription_id AND a.refunded = 1) THEN 1 ELSE 0 END) AS refunded
       FROM trials t WHERE ${filter.sql} GROUP BY key`,
    )
    .all({ ...filter.params, window: o.retryWindowDays * DAY }) as unknown as (Counts & { key: string | number | null })[];
  const attempts = db
    .prepare(
      `SELECT ${key} AS key, COUNT(*) AS attempts, SUM(a.approved) AS approved
       FROM attempts a JOIN trials t ON t.provider = a.provider AND t.subscription_id = a.subscription_id
       WHERE ${filter.sql} GROUP BY key`,
    )
    .all(filter.params) as unknown as { key: string | number | null; attempts: number; approved: number }[];

  const groups = new Map<string | number | null, Counts>();
  for (const r of trials) {
    groups.set(r.key, { ...zero(), started: r.started, paid_first: r.paid_first, paid_retry: r.paid_retry, refunded: r.refunded });
  }
  for (const r of attempts) {
    const g = groups.get(r.key) ?? zero();
    g.attempts = r.attempts;
    g.approved = r.approved;
    groups.set(r.key, g);
  }
  return groups;
}

// Окончательность: самый длинный триал периода закончился и прошло окно ожидания оплаты
function finality(db: Db, o: RangeOptions, lastDay: string) {
  const filter = trialFilter(o);
  const { max_len: maxLength } = db
    .prepare(`SELECT COALESCE(MAX(t.trial_ended_at - t.trial_started_at), 0) AS max_len FROM trials t WHERE ${filter.sql}`)
    .get(filter.params) as { max_len: number };
  const lastTrialEnd = localMidnight(addDays(lastDay, 1), o.timeZone) + maxLength;
  return {
    final_first: lastTrialEnd + FIRST_ATTEMPT_SETTLE <= o.now,
    final_retry: lastTrialEnd + o.retryWindowDays * DAY <= o.now,
    maxLength,
  };
}

function withRates<T extends Counts & { final_first: boolean; final_retry: boolean }>(c: T): T & Totals {
  return {
    ...c,
    rate_first: rate(c.paid_first, c.started),
    rate_retry: rate(c.paid_retry, c.started),
    approval_rate: rate(c.approved, c.attempts),
    decline_rate: rate(c.attempts - c.approved, c.attempts),
    refund_rate: rate(c.refunded, c.paid_retry),
  };
}

export function getMetrics(db: Db, o: MetricsOptions): { totals: Totals; series: Point[] } {
  const days = dailyPoints(db, o);
  return { totals: totals(days), series: o.granularity === 'day' ? days : group(days, o.granularity) };
}

function dailyPoints(db: Db, o: MetricsOptions): Point[] {
  const byDay = new Map<string, Counts>();
  for (const [bucket, counts] of aggregate(db, o, `(t.trial_started_at / ${BUCKET}) * ${BUCKET}`)) {
    const day = localDay(Number(bucket), o.timeZone);
    byDay.set(day, add(byDay.get(day) ?? zero(), counts));
  }
  const { maxLength } = finality(db, o, o.to);

  const points: Point[] = [];
  for (let day = o.from; day <= o.to; day = addDays(day, 1)) {
    const lastTrialEnd = localMidnight(addDays(day, 1), o.timeZone) + maxLength;
    points.push(
      withRates({
        period: day,
        period_end: day,
        ...(byDay.get(day) ?? zero()),
        final_first: lastTrialEnd + FIRST_ATTEMPT_SETTLE <= o.now,
        final_retry: lastTrialEnd + o.retryWindowDays * DAY <= o.now,
      }),
    );
  }
  return points;
}

// Разбивка за период по измерению: по убыванию числа триалов; «не определено» — всегда в конце
// (у Stripe банк пуст у всех — иначе эта строка заслоняла бы остальные)
export function getBreakdown(db: Db, o: RangeOptions, dimension: Dimension): BreakdownRow[] {
  const { final_first, final_retry } = finality(db, o, o.to);
  return [...aggregate(db, o, `t.${dimension}`)]
    .map(([value, counts]) => withRates({ value: value === null ? null : String(value), ...counts, final_first, final_retry }))
    .sort((a, b) => Number(a.value === null) - Number(b.value === null) || b.started - a.started || String(a.value).localeCompare(String(b.value)));
}

// Причины отказов за период: коды провайдеров сводятся к общим названиям, доля — от всех отказов
export function getDeclineReasons(db: Db, o: RangeOptions): ReasonRow[] {
  const filter = trialFilter(o);
  const rows = db
    .prepare(
      `SELECT a.reason AS reason, COUNT(*) AS count
       FROM attempts a JOIN trials t ON t.provider = a.provider AND t.subscription_id = a.subscription_id
       WHERE a.approved = 0 AND ${filter.sql} GROUP BY a.reason`,
    )
    .all(filter.params) as unknown as { reason: string | null; count: number }[];
  const byLabel = new Map<string, number>();
  for (const r of rows) byLabel.set(declineLabel(r.reason), (byLabel.get(declineLabel(r.reason)) ?? 0) + r.count);
  const total = [...byLabel.values()].reduce((s, n) => s + n, 0);
  return [...byLabel]
    .map(([reason, count]) => ({ reason, count, share: count / total }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, 'ru'));
}

const add = (a: Counts, b: Counts): Counts => ({
  started: a.started + b.started,
  paid_first: a.paid_first + b.paid_first,
  paid_retry: a.paid_retry + b.paid_retry,
  attempts: a.attempts + b.attempts,
  approved: a.approved + b.approved,
  refunded: a.refunded + b.refunded,
});

// Неделя — ISO (с понедельника), месяц — календарный; края, обрезанные периодом, подписаны его днями
function group(days: Point[], granularity: 'week' | 'month'): Point[] {
  const groups = new Map<string, Point>();
  for (const d of days) {
    const key = granularity === 'month' ? d.period.slice(0, 7) : mondayOf(d.period);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { ...d });
      continue;
    }
    Object.assign(g, add(g, d));
    g.period_end = d.period;
    g.final_first &&= d.final_first;
    g.final_retry &&= d.final_retry;
  }
  return [...groups.values()].map(withRates);
}

function totals(days: Point[]): Totals {
  return withRates({
    ...days.reduce(add, zero()),
    final_first: days.every((p) => p.final_first),
    final_retry: days.every((p) => p.final_retry),
  });
}

function mondayOf(period: string): string {
  const ts = Date.parse(`${period}T00:00:00Z`) / 1000;
  return dayKey(ts - ((new Date(ts * 1000).getUTCDay() + 6) % 7) * DAY);
}
