import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import cron from 'node-cron';
import { loadConfig } from './config.js';
import { nowSec, openStore } from './db.js';
import { refreshPaymentNumbers } from './ltv.js';
import { buildSources, isSyncRunning, needsStartupSync, runSync } from './sync.js';

// Поток синка (запускает src/sync.ts → startSyncWorker): по расписанию, при старте, если данные устарели, и по просьбе
// сервера (ручной синк). Пишет в базу своим соединением; серверу сообщает, идёт ли синк и версию данных
const config = loadConfig();
const store = openStore(path.join(config.dataDir, 'dashboard.sqlite'));
const sources = buildSources(config);

const report = () => parentPort!.postMessage({ running: isSyncRunning(), version: store.dataVersion() });
const sync = async () => {
  const done = runSync(store, sources, report);
  report(); // синк начался
  await done;
  report();
};

refreshPaymentNumbers(store.db, nowSec()); // номера платежей для VAMP — не дожидаясь синка
parentPort!.on('message', (message) => message === 'sync' && void sync());
cron.schedule(config.syncCron, () => void sync(), { timezone: 'UTC' });
if (needsStartupSync(store, sources, nowSec())) {
  console.log('Данные устарели или первая выгрузка не закончена — запускаю синк');
  void sync();
}
report();
