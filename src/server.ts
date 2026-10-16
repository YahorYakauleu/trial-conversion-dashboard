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
  type Product,
  type ProviderFilter,
} from './metrics.js';
import {
  getHealth,
  getHealthBreakdown,
  getHealthReasons,
  getRepeat,
  getRepeatBreakdown,
  HEALTH_DIMENSIONS,
  REPEAT_DIMENSIONS,
  type EsimFilters,
} from './esim.js';
import { isSyncRunning, runSync, type Source } from './sync.js';
import { localDay } from './time.js';
import {
  getTurnover,
  getTurnoverBreakdown,
  getTurnoverDimensionValues,
  turnoverTotalsOf,
  turnoverDimensions,
  type TurnoverDimension,
} from './turnover.js';

// одинаково работает из src/ (tsx, vitest) и из dist/ (prod)
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PROVIDERS: ProviderFilter[] = ['all', 'stripe', 'solidgate'];
const GRANULARITIES: Granularity[] = ['day', 'week', 'month'];
const MAX_FILTER_VALUES = 100;
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
  destination: /^.{1,80}$/, // eSIM: страна или регион пакета
  package: /^.{1,40}$/, // eSIM: «5 GB · 7 days»
  order_type: /^[a-z_]{1,20}$/, // eSIM: purchase | topup
};

// Несколько значений одного фильтра — повторяющимся параметром: ?country=US&country=SA
function parseFilters<D extends Dimension | TurnoverDimension>(query: Record<string, unknown>, dimensions: readonly D[]) {
  const filters: Partial<Record<D, string[]>> = {};
  for (const dimension of dimensions) {
    const raw = query[dimension];
    const values = (Array.isArray(raw) ? raw : [raw])
      .filter((v): v is string => typeof v === 'string' && v !== '')
      .map((v) => (dimension === 'country' && v !== 'none' ? v.toUpperCase() : v))
      .filter((v) => v === 'none' || FILTER_FORMAT[dimension].test(v));
    // без повторов и в одном порядке — одинаковые выборки попадают в кэш под одним ключом
    const unique = [...new Set(values)].sort().slice(0, MAX_FILTER_VALUES);
    if (unique.length) filters[dimension] = unique;
  }
  return filters;
}

export function createApp({ store, config, sources }: { store: Store; config: Config; sources: Source[] }) {
  const app = express();
  const auth = createAuth(config.users);
  const esimEnabled = Boolean(config.esimStripeKey);
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
        data_version: store.dataVersion(), // меняется после каждого синка — по ней браузер обновляет значения фильтров
        products: esimEnabled ? ['vpn', 'esim'] : ['vpn'], // eSIM — если подключён его Stripe-аккаунт
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

  // Оборот: те же параметры, что у /api/metrics, плюс &product=vpn|esim. Разрезы VPN — mid (stripe:corp, solidgate:<uuid>),
  // страна, способ оплаты, банк, система; eSIM — направление, пакет, тип заказа, страна, способ оплаты, система
  app.get('/api/turnover', (req, res) => {
    const { granularity, meta, ...rest } = common(req.query);
    const product: Product = esimEnabled && req.query.product === 'esim' ? 'esim' : 'vpn';
    const range = product === 'esim' ? esimRange(rest.range) : rest.range;
    const provider = product === 'esim' ? 'all' : rest.provider; // у eSIM только Stripe
    const dimensions = turnoverDimensions(product);
    const view = dimensions.find((v) => v === req.query.view) ?? 'time';
    const filters = parseFilters(req.query, dimensions);
    const options = { product, provider, filters, ...range, timeZones: config.timeZones };
    const data = cached({ api: 'turnover', product, provider, granularity, range, view, filters }, () => {
      if (view !== 'time') {
        const breakdown = getTurnoverBreakdown(store.db, options, view);
        return { totals: turnoverTotalsOf(breakdown), series: [], breakdown };
      }
      return { ...getTurnover(store.db, { ...options, granularity }), breakdown: [] };
    });
    res.json({ ...meta, role: res.locals.role, product, range, filters, view, ...data });
  });

  // У eSIM ряд начинается с его первого платежа: аккаунт моложе HISTORY_FROM — пустые дни до него только шум
  const esimRange = (range: { from: string; to: string }) => {
    const first = store.firstPaymentAt('esim');
    const day = first === null ? null : localDay(first, config.timeZones.stripe);
    return day && day > range.from && day <= range.to ? { ...range, from: day } : range;
  };

  // eSIM: платёжное здоровье — попытки и оплаты. ?granularity&period&view=time|decline_reason|destination|package|order_type|country|…
  app.get('/api/esim/health', (req, res) => {
    if (!esimEnabled) return void res.status(404).json({ error: 'eSIM is not connected (ESIM_STRIPE_KEY)' });
    const { now, granularity, meta, ...rest } = common(req.query);
    const range = esimRange(rest.range);
    const view = [...HEALTH_DIMENSIONS, 'decline_reason'].find((v) => v === req.query.view) ?? 'time';
    const filters: EsimFilters = parseFilters(req.query, HEALTH_DIMENSIONS);
    const options = { filters, ...range, timeZones: config.timeZones, now };
    const data = cached({ api: 'esim-health', granularity, range, view, filters }, () => {
      if (view === 'decline_reason') return { ...getHealth(store.db, { ...options, granularity }), series: [], breakdown: [], reasons: getHealthReasons(store.db, options) };
      if (view !== 'time') return { ...getHealthBreakdown(store.db, options, view as (typeof HEALTH_DIMENSIONS)[number]), series: [], reasons: [] };
      return { ...getHealth(store.db, { ...options, granularity }), breakdown: [], reasons: [] };
    });
    res.json({ ...meta, role: res.locals.role, range, filters, view, ...data });
  });

  // eSIM: повторные покупки — когорты клиентов по дню первой покупки. ?granularity&period&view=time|destination|package|country|…
  app.get('/api/esim/repeat', (req, res) => {
    if (!esimEnabled) return void res.status(404).json({ error: 'eSIM is not connected (ESIM_STRIPE_KEY)' });
    const { now, granularity, meta, ...rest } = common(req.query);
    const range = esimRange(rest.range);
    const view = REPEAT_DIMENSIONS.find((v) => v === req.query.view) ?? 'time';
    const filters: EsimFilters = parseFilters(req.query, REPEAT_DIMENSIONS);
    const options = { filters, ...range, timeZones: config.timeZones, now };
    const data = cached({ api: 'esim-repeat', granularity, range, view, filters }, () =>
      view === 'time' ? { ...getRepeat(store.db, { ...options, granularity }), breakdown: [] } : { ...getRepeatBreakdown(store.db, options, view), series: [] },
    );
    res.json({ ...meta, role: res.locals.role, range, filters, view, ...data });
  });

  // Значения измерений для фильтров в боковой панели: ?mode=conversion|turnover|esim_volume|esim_repeat|esim_health&provider=…
  app.get('/api/values', (req, res) => {
    const provider = PROVIDERS.find((p) => p === req.query.provider) ?? 'all';
    const mode = String(req.query.mode ?? 'conversion');
    const esim = esimEnabled && mode.startsWith('esim_');
    const values = cached({ api: 'values', mode: esim ? 'esim' : mode, provider }, () => {
      if (esim) return getTurnoverDimensionValues(store.db, 'all', 'esim');
      return mode === 'turnover' ? getTurnoverDimensionValues(store.db, provider) : getDimensionValues(store.db, provider);
    });
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
