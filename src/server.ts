import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAuth } from './auth.js';
import type { Config } from './config.js';
import { nowSec, type Store } from './db.js';
import {
  DIMENSIONS,
  getBreakdown,
  getDeclineReasons,
  getDimensionValues,
  getMetrics,
  latestDay,
  resolveRange,
  totalsOf,
  type Dimension,
  type Filters,
  type Granularity,
  type ProviderFilter,
} from './metrics.js';
import { isSyncRunning, runSync, type Source } from './sync.js';
import {
  getTurnover,
  getTurnoverBreakdown,
  getTurnoverDimensionValues,
  turnoverTotalsOf,
  TURNOVER_DIMENSIONS,
  type TurnoverDimension,
} from './turnover.js';

// одинаково работает из src/ (tsx, vitest) и из dist/ (prod)
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PROVIDERS: ProviderFilter[] = ['all', 'stripe', 'solidgate'];
const GRANULARITIES: Granularity[] = ['day', 'week', 'month'];
// «Сегодня» и окончательность цифр зависят от текущего времени — кэш живёт не дольше этого
const CACHE_TTL_MS = 5 * 60_000;
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
  const auth = createAuth(config.users);
  app.set('trust proxy', 1); // Render: https заканчивается на прокси — нужно для Secure-cookie

  // Без входа: проверка живости, форма входа, стили и иконка (public/assets)
  app.get('/health', (_req, res) => {
    res.send('ok');
  });
  app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets')));
  app.get('/favicon.ico', (_req, res) => res.redirect(301, '/assets/favicon.svg'));
  app.get('/login', auth.loginPage(path.join(PUBLIC_DIR, 'login.html')));
  app.post('/login', express.urlencoded({ extended: false }), auth.login);
  app.post('/logout', auth.logout);

  app.use(auth.requireLogin);
  app.use(express.static(PUBLIC_DIR));

  // Данные меняет только синк, поэтому посчитанный ответ отдаётся из памяти до следующего синка.
  // Пока синк идёт, база меняется на ходу — тогда считаем каждый раз.
  const cache = new Map<string, { at: number; version: number; data: unknown }>();
  const cached = <T>(key: object, compute: () => T): T => {
    if (isSyncRunning()) return compute();
    const id = JSON.stringify(key);
    const hit = cache.get(id);
    if (hit && hit.version === store.dataVersion() && Date.now() - hit.at < CACHE_TTL_MS) return hit.data as T;
    if (cache.size > 500) cache.clear();
    const data = compute();
    cache.set(id, { at: Date.now(), version: store.dataVersion(), data });
    return data;
  };

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
    // разбивка — один проход по базе, итоги — сумма её строк; динамика и причины отказа — итоги из ряда по дням
    const data = cached({ api: 'metrics', provider, granularity, range, view, filters }, () => {
      if ((DIMENSIONS as readonly string[]).includes(view)) {
        const breakdown = getBreakdown(store.db, options, view as Dimension);
        return { totals: totalsOf(breakdown), series: [], breakdown, reasons: [] };
      }
      const { totals, series } = getMetrics(store.db, { ...options, granularity });
      const reasons = view === 'decline_reason' ? getDeclineReasons(store.db, options) : [];
      return { totals, series: view === 'time' ? series : [], breakdown: [], reasons };
    });
    res.json({ ...meta, role: res.locals.role, retry_window_days: config.retryWindowDays, range, filters, view, ...data });
  });

  // Оборот: те же параметры, что у /api/metrics; разрезы — mid (stripe:corp, solidgate:<uuid>), страна, способ оплаты, банк, система
  app.get('/api/turnover', (req, res) => {
    const { provider, granularity, range, meta } = common(req.query);
    const view = TURNOVER_DIMENSIONS.find((v) => v === req.query.view) ?? 'time';
    const filters = parseFilters(req.query, TURNOVER_DIMENSIONS);
    const options = { provider, filters, ...range, timeZones: config.timeZones };
    const data = cached({ api: 'turnover', provider, granularity, range, view, filters }, () => {
      if (view !== 'time') {
        const breakdown = getTurnoverBreakdown(store.db, options, view);
        return { totals: turnoverTotalsOf(breakdown), series: [], breakdown };
      }
      return { ...getTurnover(store.db, { ...options, granularity }), breakdown: [] };
    });
    res.json({ ...meta, role: res.locals.role, range, filters, view, ...data });
  });

  // Значения измерений для фильтров в боковой панели: ?mode=conversion|turnover&provider=…
  app.get('/api/values', (req, res) => {
    const provider = PROVIDERS.find((p) => p === req.query.provider) ?? 'all';
    const turnover = req.query.mode === 'turnover';
    const values = cached({ api: 'values', turnover, provider }, () =>
      turnover ? getTurnoverDimensionValues(store.db, provider) : getDimensionValues(store.db, provider),
    );
    res.json({ values });
  });

  app.post('/api/sync', auth.requireAdmin, (_req, res) => {
    if (isSyncRunning()) {
      res.status(409).json({ status: 'running' });
      return;
    }
    void runSync(store, sources);
    res.status(202).json({ status: 'started' });
  });

  return app;
}
