import type { Db, Provider } from './db.js';

export const DAY = 86_400;
const FIRST_ATTEMPT_SETTLE_DAYS = 2;

export type ProviderFilter = Provider | 'all';
export type Granularity = 'day' | 'week';

export interface Point {
  period: string; // YYYY-MM-DD; для недели — понедельник
  ended: number;
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
  ended_7d: { value: number; from: string; to: string };
  rate_first_7d: RateCard;
  rate_retry_7d: RateCard;
}

export interface MetricsOptions {
  provider: ProviderFilter;
  granularity: Granularity;
  now: number;
  historyDays: number;
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
  const from = today - o.historyDays * DAY;
  const rows = db
    .prepare(
      `SELECT date(trial_ended_at, 'unixepoch') AS day,
              COUNT(*) AS ended,
              SUM(CASE WHEN first_attempt_succeeded = 1 THEN 1 ELSE 0 END) AS paid_first,
              SUM(CASE WHEN paid_at IS NOT NULL AND paid_at <= trial_ended_at + @window THEN 1 ELSE 0 END) AS paid_retry
       FROM trials
       WHERE trial_ended_at >= @from AND trial_ended_at < @today
         AND (@provider = 'all' OR provider = @provider)
       GROUP BY day`,
    )
    .all({ from, today, window: o.retryWindowDays * DAY, provider: o.provider }) as unknown as {
    day: string;
    ended: number;
    paid_first: number;
    paid_retry: number;
  }[];
  const byDay = new Map(rows.map((r) => [r.day, r]));

  const points: Point[] = [];
  for (let day = from; day < today; day += DAY) {
    const r = byDay.get(dayKey(day)) ?? { ended: 0, paid_first: 0, paid_retry: 0 };
    points.push({
      period: dayKey(day),
      ended: r.ended,
      paid_first: r.paid_first,
      paid_retry: r.paid_retry,
      rate_first: rate(r.paid_first, r.ended),
      rate_retry: rate(r.paid_retry, r.ended),
      final_first: day + FIRST_ATTEMPT_SETTLE_DAYS * DAY <= today,
      final_retry: day + (o.retryWindowDays + 1) * DAY <= today,
    });
  }
  return points;
}

function groupByWeek(days: Point[]): Point[] {
  const weeks = new Map<string, Point & { days: number }>();
  for (const d of days) {
    const ts = Date.parse(`${d.period}T00:00:00Z`) / 1000;
    const monday = dayKey(ts - ((new Date(ts * 1000).getUTCDay() + 6) % 7) * DAY);
    const w = weeks.get(monday) ?? {
      period: monday,
      ended: 0,
      paid_first: 0,
      paid_retry: 0,
      rate_first: null,
      rate_retry: null,
      final_first: true,
      final_retry: true,
      days: 0,
    };
    w.ended += d.ended;
    w.paid_first += d.paid_first;
    w.paid_retry += d.paid_retry;
    w.final_first &&= d.final_first;
    w.final_retry &&= d.final_retry;
    w.days += 1;
    weeks.set(monday, w);
  }
  const list = [...weeks.values()];
  // первая неделя истории обычно неполная — её ended занижен
  if (list.length > 0 && list[0].days < 7) list.shift();
  return list.map(({ days: _days, ...w }) => ({
    ...w,
    rate_first: rate(w.paid_first, w.ended),
    rate_retry: rate(w.paid_retry, w.ended),
  }));
}

function cards(days: Point[]): Cards {
  const sum = (pts: Point[], key: 'ended' | 'paid_first' | 'paid_retry') => pts.reduce((s, p) => s + p[key], 0);
  const rateCard = (pts: Point[], key: 'paid_first' | 'paid_retry'): RateCard => ({
    rate: rate(sum(pts, key), sum(pts, 'ended')),
    from: pts[0]?.period ?? null,
    to: pts.at(-1)?.period ?? null,
  });
  const last7 = days.slice(-7);
  return {
    ended_7d: { value: sum(last7, 'ended'), from: last7[0]?.period ?? '', to: last7.at(-1)?.period ?? '' },
    rate_first_7d: rateCard(days.filter((p) => p.final_first).slice(-7), 'paid_first'),
    rate_retry_7d: rateCard(days.filter((p) => p.final_retry).slice(-7), 'paid_retry'),
  };
}
