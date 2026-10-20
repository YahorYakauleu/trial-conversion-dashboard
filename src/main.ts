import { mkdirSync } from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { loadConfig, loadEnvFile } from './config.js';
import { nowSec, openStore } from './db.js';
import { refreshPaymentNumbers } from './ltv.js';
import { createApp } from './server.js';
import { buildSources, needsStartupSync, runSync } from './sync.js';

loadEnvFile();
const config = loadConfig();
if (!cron.validate(config.syncCron)) throw new Error(`SYNC_CRON: неверное cron-выражение "${config.syncCron}"`);

mkdirSync(config.dataDir, { recursive: true });
const store = openStore(path.join(config.dataDir, 'dashboard.sqlite'));
store.failStaleRuns();
refreshPaymentNumbers(store.db, nowSec()); // номера платежей для VAMP — сразу, не дожидаясь синка (первый раз — секунды)
const sources = buildSources(config);

const server = createApp({ store, config, sources }).listen(config.port, () => {
  console.log(`Дашборд: http://localhost:${config.port}`);
});
// Прокси Render держит соединение с приложением открытым дольше, чем Node (5 с по умолчанию): запрос, отправленный
// в соединение, которое Node как раз закрыл, прокси отдаёт как 502. Держим соединения дольше прокси
server.keepAliveTimeout = 120_000;
server.headersTimeout = 121_000;

cron.schedule(config.syncCron, () => void runSync(store, sources), { timezone: 'UTC' });

if (needsStartupSync(store, sources, nowSec())) {
  console.log('Данные устарели или первая выгрузка не закончена — запускаю синк');
  void runSync(store, sources);
}
