import { Worker } from 'node:worker_threads';
import type { Config } from './config.js';
import { nowSec, type Provider, type Store } from './db.js';
import { createToUsd } from './fx.js';
import { DAY } from './metrics.js';
import { ESIM_ACCOUNT, syncEsimAccount } from './providers/esim.js';
import { syncSolidgateAccount, syncSolidgateVamp } from './providers/solidgate.js';
import { createStripeClient, syncStripeAccount, syncStripeVamp } from './providers/stripe.js';

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
// onSourceDone — после каждого источника (данные уже записаны: серверу пора сбросить кэш)
export async function runSync(store: Store, sources: Source[], onSourceDone?: () => void): Promise<boolean> {
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
      onSourceDone?.();
    }
    return true;
  } finally {
    running = false;
  }
}

// Что серверу нужно от синка: идёт ли он, запустить вручную и версия данных — растёт после каждого источника,
// по ней сервер сбрасывает кэш ответов
export interface SyncControl {
  running(): boolean;
  start(): boolean; // false — синк уже идёт
  version(): number;
}

// Синк в этом же потоке — тесты
export function inProcessSync(store: Store, sources: Source[]): SyncControl {
  return {
    running: isSyncRunning,
    start: () => (isSyncRunning() ? false : (void runSync(store, sources), true)),
    version: () => store.dataVersion(),
  };
}

// Синк — в отдельном потоке (src/sync-worker.ts) со своим соединением с базой. У SQLite запросы синхронные:
// в одном потоке с сервером запись тысяч строк и пересчёт LTV и фрода на десятки секунд останавливали ответы,
// Render не получал ответа на /health за 5 с и перезапускал сервис — отсюда 502. База в режиме WAL: сервер читает,
// пока поток пишет. Поток упал — поднимаем заново через минуту
const WORKER_RESTART_MS = 60_000;
export function startSyncWorker(): SyncControl {
  let running = false;
  // версия для сервера только растёт: у перезапущенного потока свой счётчик с нуля — считаем его изменения
  let version = 0;
  let workerVersion = 0;
  const spawn = () => {
    // В сборке модуль потока — .js. В разработке (tsx) — .ts, а загрузчик tsx в поток сам не переходит, и импорты .js
    // не находят .ts: поток стартует с модуля, который сначала подключает tsx, а потом — модуль потока
    const dev = import.meta.url.endsWith('.ts');
    const entry = new URL(`./sync-worker.${dev ? 'ts' : 'js'}`, import.meta.url);
    const bootstrap = () =>
      `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register(); await import(${JSON.stringify(entry.href)});`;
    const worker = new Worker(dev ? new URL(`data:text/javascript,${encodeURIComponent(bootstrap())}`) : entry);
    workerVersion = 0;
    worker.on('message', (next: { running: boolean; version: number }) => {
      running = next.running;
      if (next.version !== workerVersion) [workerVersion, version] = [next.version, version + 1];
    });
    worker.on('error', (error) => console.error('[sync] поток синка упал:', error));
    worker.on('exit', (code) => {
      console.error(`[sync] поток синка завершился (код ${code}) — перезапуск через минуту`);
      running = false;
      version++; // синк мог оборваться посреди записи
      setTimeout(() => (current = spawn()), WORKER_RESTART_MS).unref();
    });
    return worker;
  };
  let current = spawn();
  return {
    running: () => running,
    start: () => {
      if (running) return false;
      running = true; // сразу — без двойного запуска до ответа потока
      current.postMessage('sync');
      return true;
    },
    version: () => version,
  };
}

export function buildSources(config: Config): Source[] {
  const syncConfig = (store: Store) => ({ historyFrom: config.historyFrom, retryWindowDays: config.retryWindowDays, toUsd: createToUsd(store) });
  const stripe = config.stripeAccounts.map(({ account, key }): Source => {
    const client = createStripeClient(key);
    // после основных данных — фрод-репорты и диспуты для Visa VAMP
    const run = async (store: Store, now: number) => {
      const items = await syncStripeAccount(store, client, account, syncConfig(store), now);
      await syncStripeVamp(store, client, account, config.historyFrom, now);
      return items;
    };
    return { provider: 'stripe', account, run };
  });
  const solidgate = config.solidgateAccounts.map((acc): Source => {
    const run = async (store: Store, now: number) => {
      const items = await syncSolidgateAccount(store, acc, syncConfig(store), now);
      await syncSolidgateVamp(store, acc, config.historyFrom, now);
      return items;
    };
    return { provider: 'solidgate', account: acc.account, run };
  });
  // eSIM — свой Stripe-аккаунт со своей выгрузкой (разовые покупки вместо подписок)
  const esimClient = config.esimStripeKey && createStripeClient(config.esimStripeKey);
  const esim: Source[] = esimClient
    ? [{ provider: 'stripe', account: ESIM_ACCOUNT, run: (store, now) => syncEsimAccount(store, esimClient, syncConfig(store), now) }]
    : [];
  return [...stripe, ...solidgate, ...esim];
}
