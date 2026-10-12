import type { Db, Provider } from './db.js';

export const DAY = 86_400;
// Первая автоматическая попытка проходит в течение суток после конца триала
const FIRST_ATTEMPT_SETTLE = DAY;

export type ProviderFilter = Provider | 'all';
export type Granularity = 'day' | 'week' | 'month';

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
  from: number; // первый день периода, полночь UTC
  to: number; // последний день периода включительно
  retryWindowDays: number;
}

export const startOfUtcDay = (ts: number) => Math.floor(ts / DAY) * DAY;
export const dayKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const rate = (part: number, total: number) => (total === 0 ? null : part / total);

// Период из адреса страницы: YYYY-MM-DD, обрезается по началу истории и сегодняшнему дню.
// Сегодня — неполный день, но показывается как обычный (его цифры неокончательные, «≈»).
export function resolveRange(historyFrom: number, now: number, from?: unknown, to?: unknown): { from: number; to: number } {
  const lastDay = Math.max(historyFrom, startOfUtcDay(now));
  const parse = (value: unknown) =>
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) / 1000 : NaN;
  const clamp = (value: number, fallback: number) =>
    Number.isNaN(value) ? fallback : Math.min(Math.max(value, historyFrom), lastDay);
  const end = clamp(parse(to), lastDay);
  return { from: Math.min(clamp(parse(from), historyFrom), end), to: end };
}

export function getMetrics(db: Db, o: MetricsOptions): { totals: Totals; series: Point[] } {
  const days = dailyPoints(db, o);
  return { totals: totals(days), series: o.granularity === 'day' ? days : group(days, o.granularity) };
}

function dailyPoints(db: Db, o: MetricsOptions): Point[] {
  const params = { from: o.from, until: o.to + DAY, provider: o.provider };
  const filter = `trial_started_at >= @from AND trial_started_at < @until AND (@provider = 'all' OR provider = @provider)`;

  const rows = db
    .prepare(
      `SELECT date(trial_started_at, 'unixepoch') AS day,
              COUNT(*) AS started,
              SUM(CASE WHEN first_attempt_succeeded = 1 THEN 1 ELSE 0 END) AS paid_first,
              SUM(CASE WHEN paid_at IS NOT NULL AND paid_at <= trial_ended_at + @window THEN 1 ELSE 0 END) AS paid_retry
       FROM trials WHERE ${filter}
       GROUP BY day`,
    )
    .all({ ...params, window: o.retryWindowDays * DAY }) as unknown as {
    day: string;
    started: number;
    paid_first: number;
    paid_retry: number;
  }[];
  const byDay = new Map(rows.map((r) => [r.day, r]));

  // День окончателен, когда даже самый длинный его триал закончился и прошло окно ожидания оплаты
  const { max_len: maxTrialLength } = db
    .prepare(`SELECT COALESCE(MAX(trial_ended_at - trial_started_at), 0) AS max_len FROM trials WHERE ${filter}`)
    .get(params) as { max_len: number };

  const points: Point[] = [];
  for (let day = o.from; day <= o.to; day += DAY) {
    const r = byDay.get(dayKey(day)) ?? { started: 0, paid_first: 0, paid_retry: 0 };
    const lastTrialEnd = day + DAY + maxTrialLength;
    points.push(
      withRates({
        period: dayKey(day),
        period_end: dayKey(day),
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
