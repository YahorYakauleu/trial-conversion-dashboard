import { mondayOf, type Granularity } from './metrics.js';
import { addDays } from './time.js';

// Обходит окна [from, to) длиной step пачками по `parallel` штук одновременно.
// После каждой пачки сообщает, с какого момента продолжать, — чтобы прерванная выгрузка возобновлялась.
export async function forEachWindow(
  from: number,
  to: number,
  step: number,
  parallel: number,
  fn: (windowStart: number) => Promise<void>,
  onProgress?: (next: number) => void,
): Promise<void> {
  for (let start = from; start < to; start += parallel * step) {
    const windows: number[] = [];
    for (let w = start; w < Math.min(start + parallel * step, to); w += step) windows.push(w);
    await Promise.all(windows.map(fn));
    onProgress?.(windows.at(-1)! + step);
  }
}

// Ряд по дням периода (пустые дни — нулями), сгруппированный по неделям (ISO) или месяцам; края подписаны днями периода
export function groupDays<T extends object>(byDay: Map<string, T>, o: { from: string; to: string; granularity: Granularity }, zero: () => T, add: (a: T, b: T) => T) {
  const groups = new Map<string, T & { period: string; period_end: string }>();
  for (let day = o.from; day <= o.to; day = addDays(day, 1)) {
    const key = o.granularity === 'day' ? day : o.granularity === 'month' ? day.slice(0, 7) : mondayOf(day);
    const g = groups.get(key);
    groups.set(key, { ...add(g ?? zero(), byDay.get(day) ?? zero()), period: g?.period ?? day, period_end: day });
  }
  return [...groups.values()];
}
