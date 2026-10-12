import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type RequestHandler } from 'express';
import type { Config } from './config.js';
import { nowSec, type Store } from './db.js';
import {
  DIMENSIONS,
  getBreakdown,
  getDeclineReasons,
  getMetrics,
  resolveRange,
  type Dimension,
  type Filters,
  type Granularity,
  type ProviderFilter,
} from './metrics.js';
import { isSyncRunning, runSync, type Source } from './sync.js';
import { localDay } from './time.js';

// одинаково работает из src/ (tsx, vitest) и из dist/ (prod)
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PROVIDERS: ProviderFilter[] = ['all', 'stripe', 'solidgate'];
const GRANULARITIES: Granularity[] = ['day', 'week', 'month'];
// Допустимые значения фильтров: код страны, способ оплаты / платёжная система (латиница), банк — любое название
const FILTER_FORMAT: Record<Dimension, RegExp> = {
  account: /^(stripe|solidgate):[A-Za-z0-9_]{1,32}$/,
  country: /^[A-Z]{2}$/,
  payment_method: /^[a-z_]{1,32}$/,
  card_brand: /^[a-z_ ]{1,32}$/,
  bank: /^.{1,120}$/,
};

function parseFilters(query: Record<string, unknown>): Filters {
  const filters: Filters = {};
  for (const dimension of DIMENSIONS) {
    const raw = query[dimension];
    if (typeof raw !== 'string' || raw === '') continue;
    const value = dimension === 'country' ? raw.toUpperCase() : raw;
    if (raw === 'none') filters[dimension] = 'none';
    else if (FILTER_FORMAT[dimension].test(value)) filters[dimension] = value;
  }
  return filters;
}

export function createApp({ store, config, sources }: { store: Store; config: Config; sources: Source[] }) {
  const app = express();

  app.get('/health', (_req, res) => {
    res.send('ok');
  });
  app.use(basicAuth(config.basicAuth.user, config.basicAuth.password));
  app.use(express.static(PUBLIC_DIR));

  // ?provider=all|stripe|solidgate&granularity=day|week|month&period=last7|last30|thisMonth|prevMonth|all|custom
  //  &from=YYYY-MM-DD&to=YYYY-MM-DD (для custom)&account=stripe:corp&country=…&payment_method=…&bank=…&card_brand=… ('none' — не определено)
  //  &view=time|account|country|payment_method|bank|card_brand|decline_reason. Дни — местные сутки в config.timeZone.
  app.get('/api/metrics', (req, res) => {
    const now = nowSec();
    const provider = PROVIDERS.find((p) => p === req.query.provider) ?? 'all';
    const granularity = GRANULARITIES.find((g) => g === req.query.granularity) ?? 'day';
    const view = [...DIMENSIONS, 'decline_reason'].find((v) => v === req.query.view) ?? 'time';
    const filters = parseFilters(req.query);
    const range = resolveRange(config.historyFrom, now, config.timeZone, {
      period: req.query.period,
      from: req.query.from,
      to: req.query.to,
    });
    const options = { provider, filters, now, ...range, timeZone: config.timeZone, retryWindowDays: config.retryWindowDays };
    const { totals, series } = getMetrics(store.db, { ...options, granularity });
    res.json({
      generated_at: now,
      retry_window_days: config.retryWindowDays,
      time_zone: config.timeZone,
      history_from: localDay(config.historyFrom, config.timeZone),
      today: localDay(now, config.timeZone),
      range,
      filters,
      view,
      sync_running: isSyncRunning(),
      sync: store.latestRuns(),
      totals,
      series: view === 'time' ? series : [],
      breakdown: (DIMENSIONS as readonly string[]).includes(view) ? getBreakdown(store.db, options, view as Dimension) : [],
      reasons: view === 'decline_reason' ? getDeclineReasons(store.db, options) : [],
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
