import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAuth } from './auth.js';
import { getCancellationBreakdown, getCancellationReasons, getCancellations } from './cancellations.js';
import type { Config } from './config.js';
import { nowSec, type Store } from './db.js';
import {
  DIMENSIONS,
  getBreakdown,
  getDeclineReasons,
  getMetrics,
  latestDay,
  resolveRange,
  totalsOf,
  type Dimension,
  type Filters,
  type Granularity,
  type ProviderFilter,
} from './metrics.js';
import {
  getOverview,
  getOverviewBreakdown,
  getOverviewReasons,
  getRepeat,
  getRepeatBreakdown,
  OVERVIEW_DIMENSIONS,
  type OverviewDimension,
  REPEAT_DIMENSIONS,
  type EsimFilters,
} from './esim.js';
import {
  EXPORT_LIMIT,
  exportCustomers,
  exportDeclinedAttempts,
  exportOrders,
  exportPayments,
  exportTrials,
  exportVampReports,
  toCsv,
  type ExportTable,
} from './export.js';
import { isSyncRunning, runSync, type Source } from './sync.js';
import { localDay } from './time.js';
import {
  getTurnover,
  getTurnoverBreakdown,
  turnoverTotalsOf,
  TURNOVER_DIMENSIONS,
  type TurnoverDimension,
} from './turnover.js';
import {
  getVampBreakdown,
  getVampDaily,
  getVampMonth,
  getVampOutcomes,
  getVampSeries,
  monthStart,
  OUTCOMES,
  VAMP_DIMENSIONS,
  VAMP_FILTERS,
  type VampDimension,
} from './vamp.js';

// одинаково работает из src/ (tsx, vitest) и из dist/ (prod)
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PROVIDERS: ProviderFilter[] = ['all', 'stripe', 'solidgate'];
const GRANULARITIES: Granularity[] = ['day', 'week', 'month'];
const MAX_FILTER_VALUES = 100;
// «Сегодня» и окончательность цифр зависят от текущего времени — кэш живёт не дольше этого
const CACHE_TTL_MS = 5 * 60_000;
// Допустимые значения фильтров: код страны, способ оплаты / платёжная система (латиница), банк — любое название
type AnyDimension = Dimension | TurnoverDimension | OverviewDimension | VampDimension;
const FILTER_FORMAT: Record<AnyDimension, RegExp> = {
  account: /^(stripe|solidgate):[A-Za-z0-9_]{1,32}$/,
  mid: /^(stripe|solidgate):[A-Za-z0-9_-]{1,64}$/, // у Solidgate MID — UUID
  country: /^[A-Z]{2}$/,
  payment_method: /^[a-z_]{1,32}$/,
  card_brand: /^[a-z_ ]{1,32}$/,
  bank: /^.{1,120}$/,
  destination: /^.{1,80}$/, // eSIM: страна или регион пакета
  package: /^.{1,40}$/, // eSIM: «5 GB · 7 days»
  merchant: /^.{1,80}$/, // VAMP: мерчант Visa — имя группы MID или сам MID
  risk: /^\d{1,2}–\d{2}$/, // VAMP: полоса Radar risk score, «50–74»
  charge_type: /^(first_payment|renewal)$/, // VAMP: первый платёж после триала или продление
};

// Несколько значений одного фильтра — повторяющимся параметром: ?country=US&country=SA
function parseFilters<D extends AnyDimension>(query: Record<string, unknown>, dimensions: readonly D[]) {
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
  // first — начало истории экрана: у VPN — HISTORY_FROM, у eSIM — его первый платёж (его история грузится целиком)
  const common = (query: Record<string, unknown>, first = config.historyFromDay) => {
    const now = nowSec();
    const today = latestDay(now, config.timeZones);
    return {
      now,
      provider: PROVIDERS.find((p) => p === query.provider) ?? 'all',
      granularity: GRANULARITIES.find((g) => g === query.granularity) ?? 'day',
      range: resolveRange(first, today, { period: query.period, from: query.from, to: query.to }),
      meta: {
        generated_at: now,
        time_zones: config.timeZones,
        history_from: first,
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

  // Отмены VPN: те же параметры, что у /api/metrics; view=time|<измерение>|cancel_reason. Когорты по дню оформления триала
  app.get('/api/cancellations', (req, res) => {
    const { now, provider, granularity, range, meta } = common(req.query);
    const view = [...DIMENSIONS, 'cancel_reason'].find((v) => v === req.query.view) ?? 'time';
    const filters: Filters = parseFilters(req.query, DIMENSIONS);
    const options = { provider, filters, now, ...range, timeZones: config.timeZones, retryWindowDays: config.retryWindowDays };
    const data = cached({ api: 'cancellations', provider, granularity, range, view, filters }, () => {
      if (view === 'time') return { ...getCancellations(store.db, { ...options, granularity }), breakdown: [], reasons: [] };
      if (view === 'cancel_reason') return { ...getCancellations(store.db, { ...options, granularity }), series: [], breakdown: [], reasons: getCancellationReasons(store.db, options) };
      return { ...getCancellationBreakdown(store.db, options, view as Dimension), series: [], reasons: [] };
    });
    res.json({ ...meta, role: res.locals.role, retry_window_days: config.retryWindowDays, range, filters, view, ...data });
  });

  // Visa VAMP: календарные месяцы UTC — период расширяется до начала месяца; view=time|<измерение>|outcome (что стало после фрод-репорта).
  // Карточки, график по дням и разбивки — за последний месяц периода (VAMP считается помесячно)
  const vampScope = (range: { from: string; to: string }) => ({ months: { from: monthStart(range.from), to: range.to }, latest: { from: monthStart(range.to), to: range.to } });
  app.get('/api/vamp', (req, res) => {
    const { now, provider, range, meta } = common(req.query);
    const view = (['time', 'outcome', ...VAMP_DIMENSIONS] as const).find((v) => v === req.query.view) ?? 'time';
    const filters = parseFilters(req.query, VAMP_FILTERS);
    const { months, latest } = vampScope(range);
    const o = { provider, filters, now };
    const data = cached({ api: 'vamp', provider, months, view, filters }, () => ({
      month: { ...latest, ...getVampMonth(store.db, { ...o, ...latest }, config.vamp) },
      series: view === 'time' ? getVampSeries(store.db, { ...o, ...months }, config.vamp) : [],
      daily: view === 'time' ? getVampDaily(store.db, { ...o, ...latest }, config.vamp, latest.from) : null,
      breakdown: view === 'time' || view === 'outcome' ? [] : getVampBreakdown(store.db, { ...o, ...latest }, view, config.vamp),
      outcomes: view === 'outcome' ? getVampOutcomes(store.db, { ...o, ...latest }, config.vamp) : [],
    }));
    res.json({ ...meta, role: res.locals.role, range: months, filters, view, thresholds: { ratio: config.vamp.ratio, count: config.vamp.count }, ...data });
  });

  // Оборот VPN: те же параметры, что у /api/metrics; разрезы — mid (stripe:corp, solidgate:<uuid>), страна, способ оплаты, банк, система
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

  // История eSIM — с его первого платежа: аккаунт небольшой, грузится целиком, иначе «новые клиенты» первых когорт были бы старыми
  const esimFirstDay = () => {
    const first = store.firstPaymentAt('esim');
    return first === null ? config.historyFromDay : localDay(first, config.timeZones.stripe);
  };

  // eSIM, обзор: заказы, деньги, новые клиенты и неоплаченные заказы по дню. ?granularity&period&view=time|decline_reason|destination|…
  app.get('/api/esim/overview', (req, res) => {
    if (!esimEnabled) return void res.status(404).json({ error: 'eSIM is not connected (ESIM_STRIPE_KEY)' });
    const { now, granularity, range, meta } = common(req.query, esimFirstDay());
    const view = [...OVERVIEW_DIMENSIONS, 'decline_reason'].find((v) => v === req.query.view) ?? 'time';
    const filters: EsimFilters = parseFilters(req.query, OVERVIEW_DIMENSIONS);
    const options = { filters, ...range, timeZones: config.timeZones, now };
    const data = cached({ api: 'esim-overview', granularity, range, view, filters }, () => {
      if (view === 'decline_reason') return { ...getOverview(store.db, { ...options, granularity }), series: [], breakdown: [], reasons: getOverviewReasons(store.db, options) };
      if (view !== 'time') return { ...getOverviewBreakdown(store.db, options, view as (typeof OVERVIEW_DIMENSIONS)[number]), series: [], reasons: [] };
      return { ...getOverview(store.db, { ...options, granularity }), breakdown: [], reasons: [] };
    });
    res.json({ ...meta, role: res.locals.role, range, filters, view, ...data });
  });

  // eSIM, удержание: когорты клиентов по дню первой покупки. ?granularity&period&view=time|destination|package|country|…
  app.get('/api/esim/repeat', (req, res) => {
    if (!esimEnabled) return void res.status(404).json({ error: 'eSIM is not connected (ESIM_STRIPE_KEY)' });
    const { now, granularity, range, meta } = common(req.query, esimFirstDay());
    const view = REPEAT_DIMENSIONS.find((v) => v === req.query.view) ?? 'time';
    const filters: EsimFilters = parseFilters(req.query, REPEAT_DIMENSIONS);
    const options = { filters, ...range, timeZones: config.timeZones, now };
    const data = cached({ api: 'esim-repeat', granularity, range, view, filters }, () =>
      view === 'time' ? { ...getRepeat(store.db, { ...options, granularity }), breakdown: [] } : { ...getRepeatBreakdown(store.db, options, view), series: [] },
    );
    res.json({ ...meta, role: res.locals.role, range, filters, view, ...data });
  });

  // Значения одного фильтра: ?mode=…&dimension=…&provider&period&from&to&<остальные фильтры>. Учитывают период и остальные
  // фильтры — кроме своего, иначе в списке осталось бы только выбранное. Число у значения — то же, что во вкладке-разрезе
  // экрана (триалы, платежи, попытки, новые клиенты); значений, которых при такой выборке нет, в списке нет
  app.get('/api/values', (req, res) => {
    const mode = String(req.query.mode ?? 'conversion');
    const esim = mode.startsWith('esim_');
    if (esim && !esimEnabled) return void res.json({ values: [] });
    const { now, range, ...rest } = esim ? common(req.query, esimFirstDay()) : common(req.query);
    const provider = esim ? 'all' : rest.provider;
    const base = { now, ...range, timeZones: config.timeZones };
    // свой фильтр не применяем: иначе в списке осталось бы только уже выбранное
    const facet = <D extends AnyDimension>(dimensions: readonly D[]) => {
      const dimension = dimensions.find((d) => d === req.query.dimension);
      const filters = parseFilters(req.query, dimensions);
      if (dimension) delete filters[dimension];
      return { dimension, filters };
    };
    const compute = (): { value: string | null; count: number }[] => {
      if (mode === 'conversion' || mode === 'cancellations') {
        const { dimension, filters } = facet(DIMENSIONS);
        const options = { ...base, provider, filters, retryWindowDays: config.retryWindowDays };
        return dimension ? getBreakdown(store.db, options, dimension).map((r) => ({ value: r.value, count: r.started })) : [];
      }
      if (mode === 'turnover') {
        const { dimension, filters } = facet(TURNOVER_DIMENSIONS);
        return dimension ? getTurnoverBreakdown(store.db, { ...base, provider, filters }, dimension).map((r) => ({ value: r.value, count: r.payments })) : [];
      }
      if (mode === 'vamp') {
        const { dimension, filters } = facet(VAMP_FILTERS);
        const o = { provider, filters, now, ...vampScope(range).latest };
        return dimension ? getVampBreakdown(store.db, o, dimension, config.vamp).map((r) => ({ value: r.value, count: r.vamp_count })) : [];
      }
      if (mode === 'esim_overview') {
        const { dimension, filters } = facet(OVERVIEW_DIMENSIONS);
        return dimension ? getOverviewBreakdown(store.db, { ...base, filters }, dimension).breakdown.map((r) => ({ value: r.value, count: r.orders })) : [];
      }
      if (mode === 'esim_repeat') {
        const { dimension, filters } = facet(REPEAT_DIMENSIONS);
        return dimension ? getRepeatBreakdown(store.db, { ...base, filters }, dimension).breakdown.map((r) => ({ value: r.value, count: r.customers })) : [];
      }
      return [];
    };
    const values = cached({ api: 'values', mode, provider, range, query: req.query }, () =>
      compute()
        .filter((v) => v.count > 0)
        .sort((a, b) => b.count - a.count),
    );
    res.json({ values });
  });

  // Выгрузка списком (CSV): записи, из которых посчитана цифра, — для текущей выборки, с теми же параметрами, что у экрана.
  // Строка таблицы сужает выборку: период строки (динамика), значение разреза или &reason=<группа> (причины отказа)
  app.get('/api/export', (req, res) => {
    const mode = String(req.query.mode ?? 'conversion');
    const view = String(req.query.view ?? 'time');
    const reason = typeof req.query.reason === 'string' && req.query.reason ? req.query.reason : null;
    const esim = mode.startsWith('esim_');
    if (esim && !esimEnabled) return void res.status(404).json({ error: 'eSIM is not connected (ESIM_STRIPE_KEY)' });
    const { now, range, ...rest } = esim ? common(req.query, esimFirstDay()) : common(req.query);
    const base = { now, ...range, timeZones: config.timeZones };
    const exported = ((): [string, ExportTable] | null => {
      if (mode === 'conversion') {
        const o = { ...base, provider: rest.provider, filters: parseFilters(req.query, DIMENSIONS), retryWindowDays: config.retryWindowDays };
        return view === 'decline_reason' ? ['vpn-declined-attempts', exportDeclinedAttempts(store.db, o, reason)] : ['vpn-trials', exportTrials(store.db, o)];
      }
      if (mode === 'cancellations') {
        const o = { ...base, provider: rest.provider, filters: parseFilters(req.query, DIMENSIONS), retryWindowDays: config.retryWindowDays };
        return ['vpn-cancelled-trials', exportTrials(store.db, o, { reason: view === 'cancel_reason' ? reason : null })];
      }
      if (mode === 'vamp') {
        // строка разреза — в пределах последнего месяца, как на экране; строка месяца — её даты (period=custom)
        const { months, latest } = vampScope(range);
        const scope = view === 'time' ? months : latest;
        const outcome = view === 'outcome' ? (OUTCOMES.find((x) => x === reason) ?? null) : null; // строка вкладки After report
        const o = { provider: rest.provider, filters: parseFilters(req.query, VAMP_DIMENSIONS), now, ...scope };
        return ['vamp-reports', exportVampReports(store.db, o, config.vamp, outcome)];
      }
      if (mode === 'turnover') return ['vpn-payments', exportPayments(store.db, { ...base, provider: rest.provider, filters: parseFilters(req.query, TURNOVER_DIMENSIONS) })];
      if (mode === 'esim_overview') {
        const o = { ...base, filters: parseFilters(req.query, OVERVIEW_DIMENSIONS) };
        return view === 'decline_reason' ? ['esim-unpaid-orders', exportOrders(store.db, o, { reason })] : ['esim-orders', exportOrders(store.db, o, null)];
      }
      if (mode === 'esim_repeat') return ['esim-new-customers', exportCustomers(store.db, { ...base, filters: parseFilters(req.query, REPEAT_DIMENSIONS) })];
      return null;
    })();
    if (!exported) return void res.status(404).json({ error: `Unknown report: ${mode}` });
    const [name, table] = exported;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}_${range.from}_${range.to}.csv"`);
    if (table.truncated) res.setHeader('X-Export-Truncated', String(EXPORT_LIMIT)); // выгружены первые EXPORT_LIMIT строк
    res.send(toCsv(table));
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
