import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type RequestHandler } from 'express';
import type { Config } from './config.js';
import { nowSec, type Store } from './db.js';
import { getMetrics, type ProviderFilter } from './metrics.js';
import { isSyncRunning, runSync, type Source } from './sync.js';

// одинаково работает из src/ (tsx, vitest) и из dist/ (prod)
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PROVIDERS: ProviderFilter[] = ['all', 'stripe', 'solidgate'];

export function createApp({ store, config, sources }: { store: Store; config: Config; sources: Source[] }) {
  const app = express();

  app.get('/health', (_req, res) => {
    res.send('ok');
  });
  app.use(basicAuth(config.basicAuth.user, config.basicAuth.password));
  app.use(express.static(PUBLIC_DIR));

  app.get('/api/metrics', (req, res) => {
    const provider = PROVIDERS.find((p) => p === req.query.provider) ?? 'all';
    const granularity = req.query.granularity === 'week' ? 'week' : 'day';
    const { cards, series } = getMetrics(store.db, {
      provider,
      granularity,
      now: nowSec(),
      historyFrom: config.historyFrom,
      retryWindowDays: config.retryWindowDays,
    });
    res.json({
      generated_at: nowSec(),
      retry_window_days: config.retryWindowDays,
      sync_running: isSyncRunning(),
      sync: store.latestRuns(),
      cards,
      series,
    });
  });

  app.post('/api/sync', (_req, res) => {
    if (isSyncRunning()) {
      res.status(409).json({ status: 'running' });
      return;
    }
    void runSync(store, sources);
    res.status(202).json({ status: 'started' });
  });

  return app;
}

function basicAuth(user: string, password: string): RequestHandler {
  const expected = hash(`${user}:${password}`);
  return (req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    const given = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString() : '';
    if (timingSafeEqual(hash(given), expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="trial-dashboard", charset="UTF-8"').status(401).send('Нужна авторизация');
  };
}

const hash = (value: string) => createHash('sha256').update(value).digest();
