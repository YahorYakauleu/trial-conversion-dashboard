import type { Db, Provider } from './db.js';
import { declineHint, declineLabel } from './declines.js';
import { addDays, localDay, localMidnight } from './time.js';

export const DAY = 86_400;
// Первая автоматическая попытка проходит в течение суток после конца триала
const FIRST_ATTEMPT_SETTLE = DAY;
// Корзины по 15 минут: смещения всех часовых поясов кратны 15 минутам, поэтому корзина целиком
// лежит в одних местных сутках. Так SQLite отдаёт сотни строк вместо сотен тысяч триалов.
const BUCKET = 900;
const PROVIDERS: Provider[] = ['stripe', 'solidgate'];

export type ProviderFilter = Provider | 'all';
// Продукты: VPN — подписки с триалом (Stripe-аккаунты из STRIPE_KEYS и Solidgate), eSIM — разовые покупки, свой Stripe-аккаунт
export const PRODUCTS = ['vpn', 'esim'] as const;
export type Product = (typeof PRODUCTS)[number];
// Сутки у каждого провайдера свои — как в его кабинете: Stripe — по часовому поясу аккаунта, Solidgate Hub — по UTC
export type TimeZones = Record<Provider, string>;
export type Granularity = 'day' | 'week' | 'month';
export type Preset = 'last7' | 'last30' | 'thisMonth' | 'prevMonth' | 'all' | 'custom';
// Измерения для разбивки и фильтров и их значение в SQL по триалу (алиас t)
export const DIMENSIONS = ['account', 'mid', 'country', 'payment_method', 'bank', 'card_brand'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
const DIMENSION_SQL: Record<Dimension, string> = {
  // провайдер вместе с аккаунтом: одинаковые имена у Stripe и Solidgate не склеиваются (stripe:corp, solidgate:sgH2H)
  account: "t.provider || ':' || t.account",
  // MID, как на экране оборота: stripe:corp, solidgate:<uuid>; у Solidgate без заказа — не определён
  mid: "t.provider || ':' || t.mid",
  country: 't.country',
  payment_method: 't.payment_method',
  bank: 't.bank',
  card_brand: 't.card_brand',
};
// Фильтр по измерению — список значений, 'none' — «не определено».
// Значения одного фильтра складываются (ИЛИ), разные фильтры сужают выборку (И).
export type Filters = Partial<Record<Dimension, string[]>>;

export interface Counts {
  started: number; // оформлено триалов
  paid_first: number; // оплатили с первой попытки
  paid_retry: number; // оплатили в окне ретраев («сконвертилось»)
  attempts: number; // попыток списания первого платного периода
  approved: number; // из них успешных
  refunded: number; // сконвертившихся, кому вернули первый платёж
  first_declined: number; // первая попытка списания отклонена
  recovered: number; // из них всё же оплатили в окне ретраев
}

export interface Totals extends Counts {
  rate_first: number | null;
  rate_retry: number | null;
  approval_rate: number | null; // проходимость: успешные попытки / все попытки
  decline_rate: number | null; // отклонённые попытки / все попытки
  refund_rate: number | null; // рефанды / сконвертившиеся
  recovery_rate: number | null; // восстановленные / триалы с отклонённой первой попыткой
  final_first: boolean;
  final_retry: boolean; // для конверсии, проходимости, decline, рефандов и recovery
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
  hint: string; // короткое пояснение по-русски — для подсказки
  count: number; // отклонённых попыток с этой причиной
  share: number; // доля от всех отказов
  // Восстановление: триалы, у которых первая попытка первого платежа отклонена по этой причине, и сколько из них потом оплатили
  first_declines: number;
  recovered: number; // оплатили в окне ретраев
  recovery_rate: number | null;
  avg_attempts: number | null; // попыток на такой триал в среднем
  avg_days_to_pay: number | null; // дней от первого отказа до оплаты — у восстановленных
  final: boolean; // окно ретраев закрыто у всех таких триалов — recovery rate больше не изменится
}

export interface MetricsOptions {
  provider: ProviderFilter;
  granularity: Granularity;
  filters: Filters;
  now: number;
  from: string; // первый день периода (YYYY-MM-DD, местные сутки)
  to: string; // последний день периода включительно
  timeZones: TimeZones;
  retryWindowDays: number;
}

type RangeOptions = Omit<MetricsOptions, 'granularity'>;

export const startOfUtcDay = (ts: number) => Math.floor(ts / DAY) * DAY;
export const dayKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const rate = (part: number, total: number) => (total === 0 ? null : part / total);
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const zero = (): Counts => ({ started: 0, paid_first: 0, paid_retry: 0, attempts: 0, approved: 0, refunded: 0, first_declined: 0, recovered: 0 });

// Условие «момент column попал в местные сутки периода» — в часовом поясе провайдера строки (alias — алиас таблицы).
// node:sqlite не принимает лишние именованные параметры — условия есть для всех провайдеров, параметры используются все.
export function periodSql(alias: string, column: string, o: { from: string; to: string; timeZones: TimeZones }) {
  const params: Record<string, number> = {};
  const byProvider = PROVIDERS.map((p) => {
    params[`from_${p}`] = localMidnight(o.from, o.timeZones[p]);
    params[`until_${p}`] = localMidnight(addDays(o.to, 1), o.timeZones[p]);
    return `(${alias}.provider = '${p}' AND ${column} >= @from_${p} AND ${column} < @until_${p})`;
  });
  return { sql: `(${byProvider.join(' OR ')})`, params };
}

// Ключ корзины вместе с провайдером: корзина переводится в местный день по часовому поясу своего провайдера
export const bucketSql = (alias: string, column: string) => `${alias}.provider || ':' || ((${column} / ${BUCKET}) * ${BUCKET})`;
export function bucketDay(key: unknown, timeZones: TimeZones): string {
  const [provider, bucket] = String(key).split(':');
  return localDay(Number(bucket), timeZones[provider as Provider]);
}

// «Сегодня» — самый поздний из местных дней провайдеров: по UTC новые сутки начинаются раньше, чем в Нью-Йорке
export const latestDay = (now: number, timeZones: TimeZones) => PROVIDERS.map((p) => localDay(now, timeZones[p])).sort().at(-1)!;

// Конец местных суток: у провайдеров он разный — берём самый поздний
const dayEnd = (day: string, timeZones: TimeZones) => Math.max(...PROVIDERS.map((p) => localMidnight(addDays(day, 1), timeZones[p])));

// Период из адреса страницы: пресет или свои даты, в местных сутках; обрезается по началу истории и сегодняшнему дню.
// Сегодня — неполный день, но показывается как обычный (его цифры неокончательные, «≈»).
export function resolveRange(
  first: string,
  today: string,
  query: { period?: unknown; from?: unknown; to?: unknown } = {},
): { from: string; to: string } {
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

// Условия фильтров по измерениям (sqlBy — SQL-выражение каждого измерения): значения одного фильтра — через ИЛИ.
// node:sqlite не принимает лишние именованные параметры — параметры добавляются только используемые.
export function dimensionFilterSql(sqlBy: Record<string, string>, filters: Partial<Record<string, string[]>>) {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  for (const [dimension, sql] of Object.entries(sqlBy)) {
    const values = filters[dimension] ?? [];
    if (values.length === 0) continue;
    const named = values
      .filter((v) => v !== 'none')
      .map((v, i) => {
        params[`f_${dimension}_${i}`] = v;
        return `@f_${dimension}_${i}`;
      });
    const anyOf = [...(named.length ? [`${sql} IN (${named.join(', ')})`] : []), ...(values.includes('none') ? [`${sql} IS NULL`] : [])];
    clauses.push(`(${anyOf.join(' OR ')})`);
  }
  return { clauses, params };
}

// Фильтр по триалам (алиас t): период оформления в местных сутках, провайдер, измерения
function trialFilter(o: RangeOptions) {
  const period = periodSql('t', 't.trial_started_at', o);
  const dimensions = dimensionFilterSql(DIMENSION_SQL, o.filters);
  const params: Record<string, string | number> = { ...period.params, ...dimensions.params, provider: o.provider };
  const clauses = [period.sql, "(@provider = 'all' OR t.provider = @provider)", ...dimensions.clauses];
  return { sql: clauses.join(' AND '), params };
}

// Агрегаты по группам (key — SQL-выражение) за один проход по триалам: итоги попыток лежат в строке триала.
// max_len — самый длинный триал группы, для окончательности цифр.
function aggregate(db: Db, o: RangeOptions, key: string): Map<string | number | null, Counts & { max_len: number }> {
  const filter = trialFilter(o);
  const paid = 't.paid_at IS NOT NULL AND t.paid_at <= t.trial_ended_at + @window';
  // первая попытка отклонена — по флагу в строке триала (совпадает с первой попыткой в attempts, без прохода по ним)
  const firstDeclined = 't.attempts > 0 AND t.first_attempt_succeeded = 0';
  const rows = db
    .prepare(
      `SELECT ${key} AS key,
              COUNT(*) AS started,
              SUM(CASE WHEN t.first_attempt_succeeded = 1 THEN 1 ELSE 0 END) AS paid_first,
              SUM(CASE WHEN ${paid} THEN 1 ELSE 0 END) AS paid_retry,
              SUM(CASE WHEN ${paid} AND t.refunded = 1 THEN 1 ELSE 0 END) AS refunded,
              SUM(t.attempts) AS attempts,
              SUM(t.approved) AS approved,
              SUM(CASE WHEN ${firstDeclined} THEN 1 ELSE 0 END) AS first_declined,
              SUM(CASE WHEN ${firstDeclined} AND ${paid} THEN 1 ELSE 0 END) AS recovered,
              MAX(t.trial_ended_at - t.trial_started_at) AS max_len
       FROM trials t WHERE ${filter.sql} GROUP BY key`,
    )
    .all({ ...filter.params, window: o.retryWindowDays * DAY }) as unknown as (Counts & { key: string | number | null; max_len: number })[];
  return new Map(rows.map(({ key, ...counts }) => [key, counts]));
}

// Окончательность дня: самый длинный триал периода закончился и прошло окно ожидания оплаты
function finality(o: RangeOptions, day: string, maxLength: number) {
  const lastTrialEnd = dayEnd(day, o.timeZones) + maxLength;
  return {
    final_first: lastTrialEnd + FIRST_ATTEMPT_SETTLE <= o.now,
    final_retry: lastTrialEnd + o.retryWindowDays * DAY <= o.now,
  };
}

const maxLengthOf = (groups: Map<unknown, { max_len: number }>) => Math.max(0, ...[...groups.values()].map((g) => g.max_len));

function withRates<T extends Counts & { final_first: boolean; final_retry: boolean }>(c: T): T & Totals {
  return {
    ...c,
    rate_first: rate(c.paid_first, c.started),
    rate_retry: rate(c.paid_retry, c.started),
    approval_rate: rate(c.approved, c.attempts),
    decline_rate: rate(c.attempts - c.approved, c.attempts),
    refund_rate: rate(c.refunded, c.paid_retry),
    recovery_rate: rate(c.recovered, c.first_declined),
  };
}

export function getMetrics(db: Db, o: MetricsOptions): { totals: Totals; series: Point[] } {
  const days = dailyPoints(db, o);
  return { totals: totals(days), series: o.granularity === 'day' ? days : group(days, o.granularity) };
}

function dailyPoints(db: Db, o: MetricsOptions): Point[] {
  const buckets = aggregate(db, o, bucketSql('t', 't.trial_started_at'));
  const byDay = new Map<string, Counts>();
  for (const [bucket, counts] of buckets) {
    const day = bucketDay(bucket, o.timeZones);
    byDay.set(day, add(byDay.get(day) ?? zero(), counts));
  }
  const maxLength = maxLengthOf(buckets);

  const points: Point[] = [];
  for (let day = o.from; day <= o.to; day = addDays(day, 1)) {
    points.push(withRates({ period: day, period_end: day, ...(byDay.get(day) ?? zero()), ...finality(o, day, maxLength) }));
  }
  return points;
}

// Разбивка за период по измерению: по убыванию числа триалов; «не определено» — всегда в конце
// (у Stripe банк пуст у всех — иначе эта строка заслоняла бы остальные)
export function getBreakdown(db: Db, o: RangeOptions, dimension: Dimension): BreakdownRow[] {
  const groups = aggregate(db, o, DIMENSION_SQL[dimension]);
  const final = finality(o, o.to, maxLengthOf(groups));
  return [...groups]
    .map(([value, { max_len: _, ...counts }]) => withRates({ value: value === null ? null : String(value), ...counts, ...final }))
    .sort((a, b) => Number(a.value === null) - Number(b.value === null) || b.started - a.started || String(a.value).localeCompare(String(b.value)));
}

// Значения измерений для фильтров (вся история провайдера) — по убыванию числа триалов; null — «не определено»
export function getDimensionValues(db: Db, provider: ProviderFilter) {
  return Object.fromEntries(
    DIMENSIONS.map((d) => [
      d,
      db
        .prepare(
          `SELECT ${DIMENSION_SQL[d]} AS value, COUNT(*) AS count FROM trials t
           WHERE @provider = 'all' OR t.provider = @provider GROUP BY value ORDER BY count DESC LIMIT 1000`,
        )
        .all({ provider }) as unknown as { value: string | null; count: number }[],
    ]),
  );
}

// Итоги периода из разбивки: каждый триал попадает ровно в одну строку (в том числе «не определено»),
// поэтому сумма строк — это итоги, и второй проход по базе не нужен
export function totalsOf(rows: BreakdownRow[]): Totals {
  return withRates({
    ...rows.reduce(add, zero()),
    final_first: rows.every((r) => r.final_first),
    final_retry: rows.every((r) => r.final_retry),
  });
}

interface ReasonSums {
  count: number;
  first_declines: number;
  recovered: number;
  attempts: number; // попыток у триалов с первым отказом
  seconds_to_pay: number; // у восстановленных
  last_trial_end: number | null;
}

// Причины отказов за период: коды провайдеров сводятся к общим названиям, доля — от всех отказов.
// Recovery rate — по причине первого отказа: первая попытка первого платежа отклонена по причине X — какая доля
// таких триалов всё же оплатила в окне ретраев (как «Сконвертилось»). Всё — за один проход по попыткам периода.
export function getDeclineReasons(db: Db, o: RangeOptions): ReasonRow[] {
  const filter = trialFilter(o);
  const paid = 'paid_at IS NOT NULL AND paid_at <= trial_ended_at + @window';
  const rows = db
    .prepare(
      `WITH ranked AS (
         SELECT a.reason, a.approved, a.attempted_at, t.paid_at, t.trial_ended_at, t.attempts,
                ROW_NUMBER() OVER (PARTITION BY a.provider, a.subscription_id ORDER BY a.attempted_at, a.attempt_id) AS n
         FROM attempts a JOIN trials t ON t.provider = a.provider AND t.subscription_id = a.subscription_id
         WHERE ${filter.sql}
       )
       SELECT reason,
              COUNT(*) AS count,
              SUM(n = 1) AS first_declines,
              SUM(n = 1 AND ${paid}) AS recovered,
              SUM(CASE WHEN n = 1 THEN attempts ELSE 0 END) AS attempts,
              SUM(CASE WHEN n = 1 AND ${paid} THEN MAX(paid_at - attempted_at, 0) ELSE 0 END) AS seconds_to_pay, -- оплата бывает отмечена на секунды раньше попытки
              MAX(CASE WHEN n = 1 THEN trial_ended_at END) AS last_trial_end
       FROM ranked WHERE approved = 0 GROUP BY reason`,
    )
    .all({ ...filter.params, window: o.retryWindowDays * DAY }) as unknown as (ReasonSums & { reason: string | null })[];

  const byLabel = new Map<string, ReasonSums>();
  for (const { reason, ...r } of rows) {
    const label = declineLabel(reason);
    const g = byLabel.get(label) ?? { count: 0, first_declines: 0, recovered: 0, attempts: 0, seconds_to_pay: 0, last_trial_end: null };
    byLabel.set(label, {
      count: g.count + r.count,
      first_declines: g.first_declines + r.first_declines,
      recovered: g.recovered + r.recovered,
      attempts: g.attempts + r.attempts,
      seconds_to_pay: g.seconds_to_pay + r.seconds_to_pay,
      last_trial_end: Math.max(g.last_trial_end ?? 0, r.last_trial_end ?? 0) || null,
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
      avg_days_to_pay: g.recovered === 0 ? null : g.seconds_to_pay / g.recovered / DAY,
      final: g.last_trial_end === null || g.last_trial_end + o.retryWindowDays * DAY <= o.now,
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, 'en'));
}

const add = (a: Counts, b: Counts): Counts => ({
  started: a.started + b.started,
  paid_first: a.paid_first + b.paid_first,
  paid_retry: a.paid_retry + b.paid_retry,
  attempts: a.attempts + b.attempts,
  approved: a.approved + b.approved,
  refunded: a.refunded + b.refunded,
  first_declined: a.first_declined + b.first_declined,
  recovered: a.recovered + b.recovered,
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

export function mondayOf(period: string): string {
  const ts = Date.parse(`${period}T00:00:00Z`) / 1000;
  return dayKey(ts - ((new Date(ts * 1000).getUTCDay() + 6) % 7) * DAY);
}
