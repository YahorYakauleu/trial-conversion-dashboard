import type { Db, Provider } from './db.js';

export const DAY = 86_400;
// Первая автоматическая попытка проходит в течение суток после конца триала
const FIRST_ATTEMPT_SETTLE = DAY;

export type ProviderFilter = Provider | 'all';
export type Granularity = 'day' | 'week';

export interface Point {
  period: string; // YYYY-MM-DD — день оформления триала; для недели — первый её день в истории
  started: number;
  paid_first: number;
  paid_retry: number;
  rate_first: number | null;
  rate_retry: number | null;
  final_first: boolean;
  final_retry: boolean;
}

export interface RateCard {
  rate: number | null;
  from: string | null;
  to: string | null;
}

export interface Cards {
  started_7d: { value: number; from: string; to: string };
  rate_first_7d: RateCard;
  rate_retry_7d: RateCard;
}

export interface MetricsOptions {
  provider: ProviderFilter;
  granularity: Granularity;
  now: number;
  historyFrom: number;
  retryWindowDays: number;
}

export const startOfUtcDay = (ts: number) => Math.floor(ts / DAY) * DAY;
export const dayKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const rate = (part: number, total: number) => (total === 0 ? null : part / total);

export function getMetrics(db: Db, o: MetricsOptions): { cards: Cards; series: Point[] } {
  const days = dailyPoints(db, o);
  return { cards: cards(days), series: o.granularity === 'week' ? groupByWeek(days) : days };
}

function dailyPoints(db: Db, o: MetricsOptions): Point[] {
  const today = startOfUtcDay(o.now);
  const params = { from: o.historyFrom, today, provider: o.provider };
  const filter = `trial_started_at >= @from AND trial_started_at < @today AND (@provider = 'all' OR provider = @provider)`;

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
  for (let day = o.historyFrom; day < today; day += DAY) {
    const r = byDay.get(dayKey(day)) ?? { started: 0, paid_first: 0, paid_retry: 0 };
    const lastTrialEnd = day + DAY + maxTrialLength;
    points.push({
      period: dayKey(day),
      started: r.started,
      paid_first: r.paid_first,
      paid_retry: r.paid_retry,
      rate_first: rate(r.paid_first, r.started),
      rate_retry: rate(r.paid_retry, r.started),
      final_first: lastTrialEnd + FIRST_ATTEMPT_SETTLE <= o.now,
      final_retry: lastTrialEnd + o.retryWindowDays * DAY <= o.now,
    });
  }
  return points;
}

function groupByWeek(days: Point[]): Point[] {
  const weeks = new Map<string, Point>();
  for (const d of days) {
    const ts = Date.parse(`${d.period}T00:00:00Z`) / 1000;
    const monday = dayKey(ts - ((new Date(ts * 1000).getUTCDay() + 6) % 7) * DAY);
    const w = weeks.get(monday);
    if (!w) {
      weeks.set(monday, { ...d });
      continue;
    }
    w.started += d.started;
    w.paid_first += d.paid_first;
    w.paid_retry += d.paid_retry;
    w.final_first &&= d.final_first;
    w.final_retry &&= d.final_retry;
  }
  return [...weeks.values()].map((w) => ({
    ...w,
    rate_first: rate(w.paid_first, w.started),
    rate_retry: rate(w.paid_retry, w.started),
  }));
}

function cards(days: Point[]): Cards {
  const sum = (pts: Point[], key: 'started' | 'paid_first' | 'paid_retry') => pts.reduce((s, p) => s + p[key], 0);
  const rateCard = (pts: Point[], key: 'paid_first' | 'paid_retry'): RateCard => ({
    rate: rate(sum(pts, key), sum(pts, 'started')),
    from: pts[0]?.period ?? null,
    to: pts.at(-1)?.period ?? null,
  });
  const last7 = days.slice(-7);
  return {
    started_7d: { value: sum(last7, 'started'), from: last7[0]?.period ?? '', to: last7.at(-1)?.period ?? '' },
    rate_first_7d: rateCard(days.filter((p) => p.final_first).slice(-7), 'paid_first'),
    rate_retry_7d: rateCard(days.filter((p) => p.final_retry).slice(-7), 'paid_retry'),
  };
}
