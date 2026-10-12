import { mkdirSync } from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { loadConfig, loadEnvFile } from './config.js';
import { openStore } from './db.js';
import { createApp } from './server.js';
import { buildSources, runSync } from './sync.js';

loadEnvFile();
const config = loadConfig();
if (!cron.validate(config.syncCron)) throw new Error(`SYNC_CRON: неверное cron-выражение "${config.syncCron}"`);

mkdirSync(config.dataDir, { recursive: true });
const store = openStore(path.join(config.dataDir, 'dashboard.sqlite'));
store.failStaleRuns();
const sources = buildSources(config);

createApp({ store, config, sources }).listen(config.port, () => {
  console.log(`Дашборд: http://localhost:${config.port}`);
});

cron.schedule(config.syncCron, () => void runSync(store, sources), { timezone: 'UTC' });

// Первый запуск или прерванный бэкфилл — сразу догружаем
if (sources.some((s) => store.getState(s.provider, s.account, 'cursor') === null)) {
  void runSync(store, sources);
}
