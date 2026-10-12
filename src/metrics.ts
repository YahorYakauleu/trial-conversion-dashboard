import type { Db, Provider } from './db.js';
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

export interface Totals {
  started: number;
  paid_first: number;
  paid_retry: number;
  rate_first: number | null;
  rate_retry: number | null;
  final_first: boolean;
  final_retry: boolean;
}

export interface Point extends Totals {
  period: string; // первый день группы внутри периода (YYYY-MM-DD)
  period_end: string; // последний день группы внутри периода
}

export interface MetricsOptions {
  provider: ProviderFilter;
  granularity: Granularity;
  now: number;
  from: string; // первый день периода (YYYY-MM-DD, местные сутки)
  to: string; // последний день периода включительно
  timeZone: string;
  retryWindowDays: number;
}

export const startOfUtcDay = (ts: number) => Math.floor(ts / DAY) * DAY;
export const dayKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const rate = (part: number, total: number) => (total === 0 ? null : part / total);
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

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

export function getMetrics(db: Db, o: MetricsOptions): { totals: Totals; series: Point[] } {
  const days = dailyPoints(db, o);
  return { totals: totals(days), series: o.granularity === 'day' ? days : group(days, o.granularity) };
}

function dailyPoints(db: Db, o: MetricsOptions): Point[] {
  const params = {
    from: localMidnight(o.from, o.timeZone),
    until: localMidnight(addDays(o.to, 1), o.timeZone),
    provider: o.provider,
  };
  const filter = `trial_started_at >= @from AND trial_started_at < @until AND (@provider = 'all' OR provider = @provider)`;

  const buckets = db
    .prepare(
      `SELECT (trial_started_at / ${BUCKET}) * ${BUCKET} AS bucket,
              COUNT(*) AS started,
              SUM(CASE WHEN first_attempt_succeeded = 1 THEN 1 ELSE 0 END) AS paid_first,
              SUM(CASE WHEN paid_at IS NOT NULL AND paid_at <= trial_ended_at + @window THEN 1 ELSE 0 END) AS paid_retry
       FROM trials WHERE ${filter}
       GROUP BY bucket`,
    )
    .all({ ...params, window: o.retryWindowDays * DAY }) as unknown as {
    bucket: number;
    started: number;
    paid_first: number;
    paid_retry: number;
  }[];
  const byDay = new Map<string, { started: number; paid_first: number; paid_retry: number }>();
  for (const b of buckets) {
    const day = localDay(b.bucket, o.timeZone);
    const acc = byDay.get(day) ?? { started: 0, paid_first: 0, paid_retry: 0 };
    acc.started += b.started;
    acc.paid_first += b.paid_first;
    acc.paid_retry += b.paid_retry;
    byDay.set(day, acc);
  }

  // День окончателен, когда даже самый длинный его триал закончился и прошло окно ожидания оплаты
  const { max_len: maxTrialLength } = db
    .prepare(`SELECT COALESCE(MAX(trial_ended_at - trial_started_at), 0) AS max_len FROM trials WHERE ${filter}`)
    .get(params) as { max_len: number };

  const points: Point[] = [];
  for (let day = o.from; day <= o.to; day = addDays(day, 1)) {
    const r = byDay.get(day) ?? { started: 0, paid_first: 0, paid_retry: 0 };
    const lastTrialEnd = localMidnight(addDays(day, 1), o.timeZone) + maxTrialLength;
    points.push(
      withRates({
        period: day,
        period_end: day,
        started: r.started,
        paid_first: r.paid_first,
        paid_retry: r.paid_retry,
        rate_first: null,
        rate_retry: null,
        final_first: lastTrialEnd + FIRST_ATTEMPT_SETTLE <= o.now,
        final_retry: lastTrialEnd + o.retryWindowDays * DAY <= o.now,
      }),
    );
  }
  return points;
}

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
    g.period_end = d.period;
    g.started += d.started;
    g.paid_first += d.paid_first;
    g.paid_retry += d.paid_retry;
    g.final_first &&= d.final_first;
    g.final_retry &&= d.final_retry;
  }
  return [...groups.values()].map(withRates);
}

function totals(days: Point[]): Totals {
  const sum = (key: 'started' | 'paid_first' | 'paid_retry') => days.reduce((s, p) => s + p[key], 0);
  return withRates({
    started: sum('started'),
    paid_first: sum('paid_first'),
    paid_retry: sum('paid_retry'),
    rate_first: null,
    rate_retry: null,
    final_first: days.every((p) => p.final_first),
    final_retry: days.every((p) => p.final_retry),
  });
}

function withRates<T extends Totals>(p: T): T {
  return { ...p, rate_first: rate(p.paid_first, p.started), rate_retry: rate(p.paid_retry, p.started) };
}

function mondayOf(period: string): string {
  const ts = Date.parse(`${period}T00:00:00Z`) / 1000;
  return dayKey(ts - ((new Date(ts * 1000).getUTCDay() + 6) % 7) * DAY);
}
