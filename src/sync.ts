import type { Config } from './config.js';
import { nowSec, type Provider, type Store } from './db.js';
import { createToUsd } from './fx.js';
import { DAY } from './metrics.js';
import { syncSolidgateAccount } from './providers/solidgate.js';
import { createStripeClient, syncStripeAccount } from './providers/stripe.js';

export interface Source {
  provider: Provider;
  account: string;
  run: (store: Store, now: number) => Promise<number>;
}

let running = false;

export const isSyncRunning = () => running;

// Синк при старте: первая выгрузка не закончена или данные старше суток —
// например, сервер был выключен во время планового синка. Курсор = время последнего успешного синка.
export function needsStartupSync(store: Store, sources: Source[], now: number): boolean {
  return sources.some((s) => {
    const cursor = store.getState(s.provider, s.account, 'cursor');
    return cursor === null || now - cursor > DAY;
  });
}

// Источники синкаются по очереди; ошибка одного пишется в журнал и не трогает остальные.
export async function runSync(store: Store, sources: Source[]): Promise<boolean> {
  if (running) return false;
  running = true;
  try {
    for (const source of sources) {
      const kind = store.getState(source.provider, source.account, 'cursor') === null ? 'backfill' : 'daily';
      const runId = store.startRun(source.provider, source.account, kind);
      try {
        const items = await source.run(store, nowSec());
        store.finishRun(runId, 'ok', items, null);
        console.log(`[${source.provider}:${source.account}] ${kind}: ${items} записей`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        store.finishRun(runId, 'error', 0, message);
        console.error(`[${source.provider}:${source.account}] ${kind} упал: ${message}`);
      }
    }
    return true;
  } finally {
    running = false;
  }
}

export function buildSources(config: Config): Source[] {
  const syncConfig = (store: Store) => ({ historyFrom: config.historyFrom, toUsd: createToUsd(store) });
  const stripe = config.stripeAccounts.map(({ account, key }): Source => {
    const client = createStripeClient(key);
    return { provider: 'stripe', account, run: (store, now) => syncStripeAccount(store, client, account, syncConfig(store), now) };
  });
  const solidgate = config.solidgateAccounts.map(
    (acc): Source => ({
      provider: 'solidgate',
      account: acc.account,
      run: (store, now) => syncSolidgateAccount(store, acc, syncConfig(store), now),
    }),
  );
  return [...stripe, ...solidgate];
}
