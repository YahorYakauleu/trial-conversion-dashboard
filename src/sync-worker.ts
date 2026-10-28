import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import cron from 'node-cron';
import { loadConfig } from './config.js';
import { nowSec, openStore } from './db.js';
import { DIGEST_CRON, runDigest } from './digest.js';
import { refreshPaymentNumbers, refreshTrialLtv } from './ltv.js';
import { buildSources, isSyncRunning, needsStartupSync, runSync } from './sync.js';

// Поток синка (запускает src/sync.ts → startSyncWorker): по расписанию, при старте, если данные устарели, и по просьбе
// сервера (ручной синк). Пишет в базу своим соединением; серверу сообщает, идёт ли синк и версию данных.
// Здесь же утренняя сводка в Slack (src/digest.ts) — после свежего синка
const config = loadConfig();
const store = openStore(path.join(config.dataDir, 'dashboard.sqlite'));
const sources = buildSources(config);

const report = () => parentPort!.postMessage({ running: isSyncRunning(), version: store.dataVersion() });
// если синк уже идёт — вернётся он же: сводка дождётся его, а не пропустит
let syncing: Promise<void> | null = null;
const sync = () =>
  (syncing ??= (async () => {
    const done = runSync(store, sources, report);
    report(); // синк начался
    await done;
    report();
  })().finally(() => (syncing = null)));

refreshPaymentNumbers(store.db, nowSec()); // номера платежей для VAMP — не дожидаясь синка
// LTV и плата за триал — тоже: после выкатки новой колонки тип триала иначе не определён до синка (секунды на всю базу)
for (const s of sources) refreshTrialLtv(store.db, s.provider, s.account, nowSec());
parentPort!.on('message', (message) => message === 'sync' && void sync());
cron.schedule(config.syncCron, () => void sync(), { timezone: 'UTC' });
cron.schedule(DIGEST_CRON, () => void runDigest(store, config, sync), { timezone: 'UTC' });
if (needsStartupSync(store, sources, nowSec())) {
  console.log('Данные устарели или первая выгрузка не закончена — запускаю синк');
  void sync();
}
void runDigest(store, config, sync); // поток поднялся после 06:00 UTC, а сводки сегодня не было — отправит сейчас
report();
