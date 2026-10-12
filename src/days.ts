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
