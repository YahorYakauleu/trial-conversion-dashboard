import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, loadEnvFile } from './config.js';
import { openStore } from './db.js';
import { buildSources, runSync } from './sync.js';

loadEnvFile();
const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const store = openStore(path.join(config.dataDir, 'dashboard.sqlite'));
store.failStaleRuns();
await runSync(store, buildSources(config));
console.table(store.latestRuns());
