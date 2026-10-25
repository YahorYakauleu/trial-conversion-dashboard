import { mkdirSync } from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { loadConfig, loadEnvFile } from './config.js';
import { openStore } from './db.js';
import { createApp } from './server.js';
import { startSyncWorker } from './sync.js';

loadEnvFile();
const config = loadConfig();
if (!cron.validate(config.syncCron)) throw new Error(`SYNC_CRON: неверное cron-выражение "${config.syncCron}"`);

mkdirSync(config.dataDir, { recursive: true });
const store = openStore(path.join(config.dataDir, 'dashboard.sqlite'));
store.failStaleRuns();
// синк — в отдельном потоке: расписание, синк при старте и ручной синк — там (src/sync-worker.ts)
const sync = startSyncWorker();

const server = createApp({ store, config, sync }).listen(config.port, () => {
  console.log(`Дашборд: http://localhost:${config.port}`);
});
// Прокси Render держит соединение с приложением открытым дольше, чем Node (5 с по умолчанию): запрос, отправленный
// в соединение, которое Node как раз закрыл, прокси отдаёт как 502. Держим соединения дольше прокси
server.keepAliveTimeout = 120_000;
server.headersTimeout = 121_000;
