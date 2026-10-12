import { DAY } from './metrics.js';

// Обходит дни [from, to) пачками по `parallel` штук одновременно.
// После каждой пачки сообщает, с какого дня продолжать, — чтобы прерванная выгрузка возобновлялась.
export async function forEachDay(
  from: number,
  to: number,
  parallel: number,
  fn: (day: number) => Promise<void>,
  onProgress: (nextDay: number) => void,
): Promise<void> {
  for (let start = from; start < to; start += parallel * DAY) {
    const days: number[] = [];
    for (let day = start; day < Math.min(start + parallel * DAY, to); day += DAY) days.push(day);
    await Promise.all(days.map(fn));
    onProgress(days.at(-1)! + DAY);
  }
}
