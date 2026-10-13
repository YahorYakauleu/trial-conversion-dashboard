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
  latestDay,
  resolveRange,
  type Dimension,
  type Filters,
  type Granularity,
  type ProviderFilter,
} from './metrics.js';
import { isSyncRunning, runSync, type Source } from './sync.js';
import { getTurnover, getTurnoverBreakdown, TURNOVER_DIMENSIONS, type TurnoverDimension } from './turnover.js';

// одинаково работает из src/ (tsx, vitest) и из dist/ (prod)
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PROVIDERS: ProviderFilter[] = ['all', 'stripe', 'solidgate'];
const GRANULARITIES: Granularity[] = ['day', 'week', 'month'];
// Допустимые значения фильтров: код страны, способ оплаты / платёжная система (латиница), банк — любое название
const FILTER_FORMAT: Record<Dimension | TurnoverDimension, RegExp> = {
  account: /^(stripe|solidgate):[A-Za-z0-9_]{1,32}$/,
  mid: /^(stripe|solidgate):[A-Za-z0-9_-]{1,64}$/, // у Solidgate MID — UUID
  country: /^[A-Z]{2}$/,
  payment_method: /^[a-z_]{1,32}$/,
  card_brand: /^[a-z_ ]{1,32}$/,
  bank: /^.{1,120}$/,
};

function parseFilters<D extends Dimension | TurnoverDimension>(query: Record<string, unknown>, dimensions: readonly D[]) {
  const filters: Partial<Record<D, string>> = {};
  for (const dimension of dimensions) {
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
  //  &view=time|account|country|payment_method|bank|card_brand|decline_reason. Дни — местные сутки провайдера (config.timeZones).
  // Общее для обоих экранов: провайдер, шаг, период (в местных сутках) и статус синка
  const common = (query: Record<string, unknown>) => {
    const now = nowSec();
    const today = latestDay(now, config.timeZones);
    return {
      now,
      provider: PROVIDERS.find((p) => p === query.provider) ?? 'all',
      granularity: GRANULARITIES.find((g) => g === query.granularity) ?? 'day',
      range: resolveRange(config.historyFromDay, today, { period: query.period, from: query.from, to: query.to }),
      meta: {
        generated_at: now,
        time_zones: config.timeZones,
        history_from: config.historyFromDay,
        today,
        sync_running: isSyncRunning(),
        sync: store.latestRuns(),
      },
    };
  };

  app.get('/api/metrics', (req, res) => {
    const { now, provider, granularity, range, meta } = common(req.query);
    const view = [...DIMENSIONS, 'decline_reason'].find((v) => v === req.query.view) ?? 'time';
    const filters: Filters = parseFilters(req.query, DIMENSIONS);
    const options = { provider, filters, now, ...range, timeZones: config.timeZones, retryWindowDays: config.retryWindowDays };
    const { totals, series } = getMetrics(store.db, { ...options, granularity });
    res.json({
      ...meta,
      retry_window_days: config.retryWindowDays,
      range,
      filters,
      view,
      totals,
      series: view === 'time' ? series : [],
      breakdown: (DIMENSIONS as readonly string[]).includes(view) ? getBreakdown(store.db, options, view as Dimension) : [],
      reasons: view === 'decline_reason' ? getDeclineReasons(store.db, options) : [],
    });
  });

  // Оборот: те же параметры, что у /api/metrics; разрезы — mid (stripe:corp, solidgate:<uuid>), страна, способ оплаты, банк, система
  app.get('/api/turnover', (req, res) => {
    const { provider, granularity, range, meta } = common(req.query);
    const view = TURNOVER_DIMENSIONS.find((v) => v === req.query.view) ?? 'time';
    const filters = parseFilters(req.query, TURNOVER_DIMENSIONS);
    const options = { provider, filters, ...range, timeZones: config.timeZones };
    const { totals, series } = getTurnover(store.db, { ...options, granularity });
    res.json({
      ...meta,
      range,
      filters,
      view,
      totals,
      series: view === 'time' ? series : [],
      breakdown: view === 'time' ? [] : getTurnoverBreakdown(store.db, options, view),
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
