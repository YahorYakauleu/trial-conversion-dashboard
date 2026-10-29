import { mondayOf, type Granularity } from './metrics.js';
import { addDays } from './time.js';

// Уникальные визиты на пейволл — из отдельного сборщика (visit-collector, событие visit): лендинг отправляет его
// один раз на браузер, сборщик хранит только счётчики по суткам и разрезам. Дашборд забирает готовые счётчики
// по READ_TOKEN сборщика; токен остаётся на сервере, в браузер не попадает
// site — домен лендинга (на экране — Domain). Пути страниц сборщик тоже хранит, но он почти всегда «/» — на экране его нет;
// страны нет: сборщик не за Cloudflare
export const VISIT_DIMENSIONS = ['site', 'device', 'os'] as const;
export type VisitDimension = (typeof VISIT_DIMENSIONS)[number];
// Фильтр — список значений, 'none' — «не определено» (как на других экранах)
export type VisitFilters = Partial<Record<VisitDimension, string[]>>;

// Боты сборщик отсекает сам и считает отдельно — на экране их нет
export interface VisitCounts {
  visits: number; // уникальные визиты
}

export interface VisitPoint extends VisitCounts {
  period: string; // первый день группы внутри периода (YYYY-MM-DD)
  period_end: string;
}

export interface VisitRow extends VisitCounts {
  value: string | null; // null — не определено
  share: number | null; // доля в визитах периода
}

export interface VisitQuery {
  from: string;
  to: string;
  group: VisitDimension | null;
  filters: VisitFilters;
}

// Ответ сборщика: строки по дням (и значению разреза), сутки — по его часовому поясу
export interface VisitStats {
  time_zone: string;
  rows: { day: string; value: string | null; count: number }[];
}

export type VisitsClient = (query: VisitQuery) => Promise<VisitStats>;

// Сборщик пишет счётчики на диск раз в минуту — чаще спрашивать его незачем
export function createVisitsClient(collector: { url: string; token: string }, ttlMs = 60_000): VisitsClient {
  const cache = new Map<string, { at: number; stats: Promise<VisitStats> }>();
  return (query) => {
    const params = new URLSearchParams({ from: query.from, to: query.to, event: 'visit' });
    if (query.group) params.set('group', query.group);
    for (const [dimension, values] of Object.entries(query.filters)) for (const value of values) params.append(dimension, value);
    const url = `${collector.url}/api/stats?${params}`;

    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttlMs) return hit.stats;
    if (cache.size > 500) cache.clear();
    // в тексте ошибки — только статус или причина сети: адрес с токеном туда не попадает
    const stats = fetch(url, { headers: { authorization: `Bearer ${collector.token}` }, signal: AbortSignal.timeout(10_000) })
      .catch((error: Error) => Promise.reject(new Error(`Visit collector is unavailable: ${error.message}`)))
      .then((res) => (res.ok ? (res.json() as Promise<VisitStats>) : Promise.reject(new Error(`Visit collector responded ${res.status}`))));
    cache.set(url, { at: Date.now(), stats });
    stats.catch(() => cache.delete(url)); // ошибку не запоминаем — следующий запрос спросит снова
    return stats;
  };
}

const zero = (): VisitCounts => ({ visits: 0 });
const add = (a: VisitCounts, b: VisitCounts): VisitCounts => ({ visits: a.visits + b.visits });
const counts = (r: VisitStats['rows'][number]): VisitCounts => ({ visits: r.count });

export const visitTotals = (stats: VisitStats): VisitCounts => stats.rows.reduce((s, r) => add(s, counts(r)), zero());

// Ряд за [from, to]: дни без визитов — нулями; неделя — ISO (с понедельника), месяц — календарный
export function visitSeries(stats: VisitStats, o: { from: string; to: string; granularity: Granularity }): VisitPoint[] {
  const byDay = new Map<string, VisitCounts>();
  for (const r of stats.rows) byDay.set(r.day, add(byDay.get(r.day) ?? zero(), counts(r)));
  const groups = new Map<string, VisitPoint>();
  for (let day = o.from; day <= o.to; day = addDays(day, 1)) {
    const key = o.granularity === 'day' ? day : o.granularity === 'month' ? day.slice(0, 7) : mondayOf(day);
    const g = groups.get(key);
    groups.set(key, { ...add(g ?? zero(), byDay.get(day) ?? zero()), period: g?.period ?? day, period_end: day });
  }
  return [...groups.values()];
}

// Разбивка по разрезу за весь период: по убыванию визитов, «не определено» — в конце
export function visitBreakdown(stats: VisitStats): VisitRow[] {
  const byValue = new Map<string | null, VisitCounts>();
  for (const r of stats.rows) byValue.set(r.value, add(byValue.get(r.value) ?? zero(), counts(r)));
  const total = [...byValue.values()].reduce((s, c) => s + c.visits, 0);
  return [...byValue]
    .map(([value, c]) => ({ value, ...c, share: total === 0 ? null : c.visits / total }))
    .sort((a, b) => Number(a.value === null) - Number(b.value === null) || b.visits - a.visits || String(a.value).localeCompare(String(b.value)));
}
