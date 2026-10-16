// Billing Dashboard. Выбор хранится в адресе страницы (ссылкой можно поделиться);
// данные — /api/metrics (конверсия), /api/turnover (оборот), значения фильтров — /api/values.

const DAY_MS = 86_400_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const PRESETS = [
  ['last7', 'Last 7 days'],
  ['last30', 'Last 30 days'],
  ['thisMonth', 'This month'],
  ['prevMonth', 'Last month'],
  ['all', 'All time'],
];
// Экраны по продуктам. VPN: конверсия триалов (когорты по дню оформления) и оборот (успешные платежи по дню платежа).
// eSIM — если подключён его Stripe-аккаунт: оборот, повторные покупки (когорты по первой покупке) и платёжное здоровье.
// kind — как рисуется экран; label и tip — кнопка в панели «Report»
const MODES = {
  conversion: {
    product: 'vpn',
    kind: 'conversion',
    label: 'Conversion',
    tip: 'Конверсия триалов в платные и платёжные метрики первого платежа',
    title: 'Trial conversion',
    api: '/api/metrics',
    charts: 'charts',
    dimensions: ['account', 'mid', 'country', 'payment_method', 'bank', 'card_brand'],
    tabs: [['time', 'Trend'], ['account', 'Accounts'], ['mid', 'MID'], ['country', 'Countries'], ['payment_method', 'Payment methods'], ['bank', 'Issuing banks'], ['card_brand', 'Card brands'], ['decline_reason', 'Decline reasons']],
    hints: {
      time: 'Trial-to-paid — paid the first billing period within 30 days after the trial ended',
      decline_reason: 'Declines — all declined first-payment attempts. Recovery rate — share of trials whose first attempt was declined for this reason that paid within 30 days after the trial ended',
    },
  },
  turnover: {
    product: 'vpn',
    kind: 'turnover',
    label: 'Volume',
    tip: 'Оборот: все успешные списания по дню платежа',
    title: 'Gross volume',
    api: '/api/turnover',
    charts: 'turnover-charts',
    dimensions: ['mid', 'country', 'payment_method', 'bank', 'card_brand'],
    tabs: [['time', 'Trend'], ['mid', 'MID'], ['country', 'Countries'], ['payment_method', 'Payment methods'], ['bank', 'Issuing banks'], ['card_brand', 'Card brands']],
    hints: { time: 'Gross volume — all successful charges by payment date, in USD' },
  },
  esim_overview: {
    product: 'esim',
    kind: 'overview',
    label: 'Overview',
    tip: 'Что случилось за день: заказы, деньги, новые клиенты и неоплаченные заказы',
    title: 'eSIM · Overview',
    api: '/api/esim/overview',
    charts: 'overview-charts',
    dimensions: ['destination', 'package', 'country', 'payment_method', 'card_brand'],
    tabs: [['time', 'Trend'], ['destination', 'Destinations'], ['package', 'Packages'], ['country', 'Countries'], ['payment_method', 'Payment methods'], ['decline_reason', 'Decline reasons']],
    hints: {
      time: 'Each row is a day: its orders, revenue and new customers. An order is one checkout — several payment attempts in it count once',
      decline_reason: 'Why orders were not paid — the reason of the last attempt. Orders blocked as fraud are not counted in payment success',
    },
  },
  esim_repeat: {
    product: 'esim',
    kind: 'repeat',
    label: 'Retention',
    tip: 'Возвращаются ли клиенты: когорты по дню первой покупки',
    title: 'eSIM · Retention',
    api: '/api/esim/repeat',
    charts: 'repeat-charts',
    dimensions: ['destination', 'package', 'country', 'payment_method', 'card_brand'],
    tabs: [['time', 'Trend'], ['destination', 'Destinations'], ['package', 'Packages'], ['country', 'Countries'], ['payment_method', 'Payment methods']],
    hints: {
      time: "Each row is the day of the customer's first purchase. Numbers marked ≈ keep growing until 30 (90) days have passed",
      _breakdown: 'Customers are split by their first purchase. Click a row to see its trend, or a column header to sort',
    },
  },
};
const PRODUCT_NAMES = { vpn: 'VPN', esim: 'eSIM' };
const DIMENSION_TITLES = {
  account: 'Account', mid: 'MID', country: 'Country', payment_method: 'Payment method', bank: 'Issuing bank', card_brand: 'Card brand',
  destination: 'Destination', package: 'Package',
};
// Интерфейс — на английском, с общепринятыми названиями метрик; при наведении — короткое пояснение по-русски (data-tip)
const TAB_TIPS = {
  time: 'Динамика по дням, неделям или месяцам',
  account: 'Аккаунт провайдера: у Stripe — юрлицо, у Solidgate — канал',
  mid: 'Мерчант-аккаунт, через который прошёл платёж',
  country: 'Страна выпуска карты',
  payment_method: 'Карта, Apple Pay, Google Pay и т. д.',
  bank: 'Банк-эмитент карты — пока только у Solidgate',
  card_brand: 'Платёжная система карты: Visa, Mastercard…',
  decline_reason: 'Почему отклонили попытки списания',
  destination: 'Страна или регион пакета eSIM',
  package: 'Объём и срок пакета eSIM',
};
const ACCOUNT_NAMES = {
  'stripe:corp': 'Stripe · Toggle Corp',
  'stripe:org': 'Stripe · Toggle Org',
  'stripe:inc': 'Stripe · Toggle Inc',
  'stripe:incorp': 'Stripe · Toggle Incorp',
  'stripe:eu': 'Stripe · Toggle EU',
  'solidgate:sg': 'Solidgate · Payment form',
  'solidgate:sgH2H': 'Solidgate · H2H (Apple / Google Pay)',
};
// MID Solidgate: по API известны только UUID и дескриптор — подписываем дескриптором, UUID показываем целиком.
// У Stripe MID = аккаунт (названия — из ACCOUNT_NAMES)
const MID_DESCRIPTORS = {
  '237b93d9-0bac-43c4-8844-938d6f354c66': 'VPN TOGGLE.ORG',
  'fb1f49fb-1fb7-4c21-b300-17334b737a47': 'VPN TOGGLE.ORG',
  '5e6da293-9dd7-4709-9502-97ac9f128471': 'ORG (via Stripe)',
  '4980d35c-f792-4ebb-895d-c161ba9b4fd5': 'toggle.org', // один тестовый заказ 23.09
};
const METHOD_NAMES = { apple_pay: 'Apple Pay', google_pay: 'Google Pay', card: 'Card', paypal: 'PayPal', link: 'Link', samsung_pay: 'Samsung Pay' };
const BRAND_NAMES = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', jcb: 'JCB', unionpay: 'UnionPay', diners: 'Diners Club', maestro: 'Maestro' };
const ROW_LIMIT = 50;
const svg = (path, width = 2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const ICONS = {
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>', 2.5),
  chevron: svg('<path d="m6 9 6 6 6-6"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>'),
  left: svg('<path d="m15 18-6-6 6-6"/>'),
  right: svg('<path d="m9 18 6-6-6-6"/>'),
  check: svg('<path d="M5 12.5 10 17.5 19 7"/>', 3),
};

// --- состояние из адреса страницы
const params = new URLSearchParams(location.search);
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
// старые ссылки на экраны eSIM ведут на обзор
const MODE_ALIASES = { esim_volume: 'esim_overview', esim_health: 'esim_overview' };
const initialMode = pick(MODE_ALIASES[params.get('mode')] ?? params.get('mode'), Object.keys(MODES), 'conversion');
const state = {
  mode: initialMode,
  provider: pick(params.get('provider'), ['all', 'stripe', 'solidgate'], 'all'),
  granularity: pick(params.get('granularity'), ['day', 'week', 'month'], 'day'),
  view: pick(params.get('view'), MODES[initialMode].tabs.map(([v]) => v), 'time'),
  preset: pick(params.get('period'), [...PRESETS.map(([v]) => v), 'custom'], params.get('from') ? 'custom' : 'all'),
  from: params.get('from') ?? '',
  to: params.get('to') ?? '',
  // фильтр — список значений: в одном фильтре они складываются (ИЛИ), разные фильтры сужают выборку (И)
  filters: Object.fromEntries(MODES[initialMode].dimensions.filter((d) => params.getAll(d).length).map((d) => [d, params.getAll(d)])),
  sort: parseSort(params.get('sort')),
  showAll: false,
};
const product = () => MODES[state.mode].product;
const kind = () => MODES[state.mode].kind;
const isTurnover = () => kind() === 'turnover';
let products = ['vpn']; // из ответа сервера: eSIM — если подключён его Stripe-аккаунт
const dimensions = () => MODES[state.mode].dimensions;

let lastData = null;
let charts = {};
let pollTimer;
let loadSeq = 0; // номер последнего запроса: ответы на устаревшие выборы не рисуем
let loading = false;
const valuesCache = new Map(); // запрос значений фильтра → { version, values }

function parseSort(raw) {
  const [key, dir] = (raw ?? '').split(':');
  return key && (dir === 'asc' || dir === 'desc') ? { key, dir } : null;
}

// От origin, а не от адреса страницы: если дашборд открыт как user:pass@host, fetch отвергает относительный URL
const api = (path, init) => fetch(new URL(path, location.origin), init);
const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => n.toLocaleString('en-US');
const decimal = (x) => (x === null || x === undefined ? '—' : x.toFixed(1));
const pct = (r) => (r === null || r === undefined ? '—' : `${(r * 100).toFixed(1)}%`);
// суммы оборота приходят в центах USD
const usdWhole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usdExact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const usdCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const usd = (cents) => usdWhole.format(cents / 100);
const usdAverage = (cents) => (cents === null ? '—' : usdExact.format(cents / 100));
const shortDay = (d) => `${MONTHS[+d.slice(5, 7) - 1].slice(0, 3)} ${+d.slice(8, 10)}`; // Sep 1
const fullDay = (d) => `${shortDay(d)}, ${d.slice(0, 4)}`; // Sep 1, 2026
const monthName = (d) => `${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
const isMonthEnd = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + DAY_MS).getUTCDate() === 1;
const addMonths = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

// Подпись значения в одну строку: в чипах, в поле фильтра, для поиска и сортировки
const valueLabel = (dimension, value) => valueParts(dimension, value).filter(Boolean).join(' · ');

// Подпись из двух частей: название и, для MID Solidgate, полный UUID — в таблице и списке он идёт второй строкой
function valueParts(dimension, value) {
  if (dimension === 'mid' && value?.startsWith('solidgate:')) {
    const mid = value.slice('solidgate:'.length);
    return [MID_DESCRIPTORS[mid] ? `Solidgate · ${MID_DESCRIPTORS[mid]}` : 'Solidgate', mid];
  }
  return [valueName(dimension, value), null];
}

function valueName(dimension, value) {
  if (value === null || value === 'none') return 'Unknown';
  if (dimension === 'country') {
    try { return `${regionNames.of(value)} (${value})`; } catch { return value; }
  }
  if (dimension === 'account') {
    const [provider, account] = value.split(':');
    return ACCOUNT_NAMES[value] ?? `${provider === 'stripe' ? 'Stripe' : 'Solidgate'} · ${account}`;
  }
  if (dimension === 'mid') return ACCOUNT_NAMES[value] ?? `Stripe · ${value.split(':')[1]}`; // MID Stripe — аккаунт
  if (dimension === 'payment_method') return METHOD_NAMES[value] ?? value;
  if (dimension === 'card_brand') return BRAND_NAMES[value] ?? value[0].toUpperCase() + value.slice(1);
  return value;
}

function query() {
  const q = new URLSearchParams({ mode: state.mode, product: product(), provider: state.provider, granularity: state.granularity, view: state.view, period: state.preset });
  if (state.preset === 'custom') {
    q.set('from', state.from);
    q.set('to', state.to);
  }
  for (const [dimension, values] of Object.entries(state.filters)) for (const value of values) q.append(dimension, value);
  return q;
}

function saveUrl() {
  const q = query();
  if (state.sort) q.set('sort', `${state.sort.key}:${state.sort.dir}`);
  history.replaceState(null, '', `${location.pathname}?${q}`);
}

// kind: 'data' — меняются цифры (фильтры, период, провайдер, экран); 'view' — только вкладка или шаг;
// 'silent' — фоновое обновление во время синка, без лоадера
async function load(kind = 'data') {
  clearTimeout(pollTimer);
  saveUrl();
  const seq = ++loadSeq;
  loading = true;
  if (kind !== 'silent') {
    markControls(); // выбранное подсвечивается сразу, не дожидаясь данных
    renderTabs();
  }
  // лоадер — только если ответ не пришёл сразу: быстрые ответы (из кэша) обходятся без мигания
  const loader = kind === 'silent' ? null : setTimeout(() => showLoading(kind), 120);
  try {
    const res = await api(`${MODES[state.mode].api}?${query()}`);
    if (seq !== loadSeq) return; // пока ждали ответа, выбрали другое
    if (res.status === 401) return location.assign('/login');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastData = await res.json();
    if (seq !== loadSeq) return;
    render(lastData);
    if (lastData.sync_running) pollTimer = setTimeout(() => load('silent'), 10_000);
  } catch (error) {
    if (seq === loadSeq) $('status').textContent = `Failed to load data: ${error.message}`;
  } finally {
    clearTimeout(loader);
    if (seq === loadSeq) {
      loading = false;
      document.body.classList.remove('is-loading', 'is-loading-data');
    }
  }
}

// Лоадер: полоска сверху, скелетон таблицы и графиков; при смене цифр мерцают и карточки
function showLoading(kind) {
  document.body.classList.add('is-loading');
  if (kind === 'data') document.body.classList.add('is-loading-data');
  const bar = (width) => `<span class="sk" style="width:${width}px"></span>`;
  if (!$('kpis').children.length) {
    $('kpis').innerHTML = `<div class="kpi"><div class="label">${bar(90)}</div><div class="value">${bar(110)}</div><div class="sub">${bar(130)}</div></div>`.repeat(6);
  }
  table = null; // в скелетоне сортировать нечего
  const cols = 6;
  $('thead').innerHTML = `<tr>${Array.from({ length: cols }, (_, i) => `<th>${bar(i ? 56 : 96)}</th>`).join('')}</tr>`;
  $('rows').innerHTML = Array.from(
    { length: 8 },
    (_, r) => `<tr>${Array.from({ length: cols }, (_, i) => `<td>${bar(i ? 36 + ((r * 7 + i * 11) % 28) : 100 + ((r * 23) % 70))}</td>`).join('')}</tr>`,
  ).join('');
  $('more').hidden = true;
  showCharts(state.view === 'time');
}

// Графики под таблицей — только на динамике и только своего экрана
function showCharts(visible) {
  for (const id of new Set(Object.values(MODES).map((m) => m.charts))) $(id).hidden = !visible || id !== MODES[state.mode].charts;
}

// Продукт и экраны продукта рисуются из MODES; провайдер есть только у VPN (у eSIM — один Stripe)
function markControls() {
  const list = products.includes(product()) ? products : [...products, product()];
  $('product-group').hidden = list.length < 2;
  $('product').innerHTML = list.map((p) => `<button data-v="${p}" class="${p === product() ? 'on' : ''}">${PRODUCT_NAMES[p]}</button>`).join('');
  $('mode').innerHTML = Object.entries(MODES)
    .filter(([, m]) => m.product === product())
    .map(([v, m]) => `<button data-v="${v}" class="${v === state.mode ? 'on' : ''}" data-tip="${m.tip}">${m.label}</button>`)
    .join('');
  $('provider-group').hidden = product() !== 'vpn';
  for (const id of ['provider', 'granularity']) {
    document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === state[id]));
  }
}

// Значения фильтра — для текущей выборки: период, провайдер и остальные фильтры (свой сервер не применяет).
// Запрашиваются, когда фильтр открывают; запоминаются до следующего синка (version — версия данных на сервере)
function loadValues(dimension) {
  const q = query();
  for (const key of ['view', 'granularity', dimension]) q.delete(key);
  q.set('dimension', dimension);
  const key = q.toString();
  const version = lastData?.data_version;
  const hit = valuesCache.get(key);
  if (hit && hit.version === version) return hit.values;
  if (valuesCache.size > 200) valuesCache.clear();
  const values = api(`/api/values?${key}`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((body) => body.values)
    .catch(() => {
      valuesCache.delete(key); // не получилось — спросим снова при следующем открытии
      return [];
    });
  valuesCache.set(key, { version, values });
  return values;
}

function render(data) {
  products = data.products ?? ['vpn'];
  renderSidebar(data);
  renderHeader(data);
  if (kind() === 'turnover') renderTurnoverKpis(data.totals, data.range);
  else if (kind() === 'repeat') renderRepeatKpis(data);
  else if (kind() === 'overview') renderOverviewKpis(data);
  else renderKpis(data.totals, data.range);
  renderTabs();
  renderView(data);
}

// --- панель выборки
function renderSidebar(data) {
  markControls();
  const presetName = PRESETS.find(([v]) => v === state.preset)?.[1] ?? 'Custom';
  $('period').innerHTML = `<span class="text"><span class="label">${presetName}</span><span class="value">${fullDay(data.range.from)} — ${fullDay(data.range.to)}</span></span>${ICONS.calendar}`;
  $('filters').innerHTML = dimensions()
    .map((d) => {
      const labels = (state.filters[d] ?? []).map((v) => valueLabel(d, v));
      // первое значение названием, остальные — счётчиком «+N»: он не обрезается, даже если название длинное
      const more = labels.length > 1 ? `<span class="more-count">+${labels.length - 1}</span>` : '';
      return `<button class="picker${labels.length ? ' active' : ''}" data-dimension="${d}" aria-haspopup="listbox" title="${esc(labels.join('\n'))}">
        <span class="text"><span class="label">${DIMENSION_TITLES[d]}</span><span class="value">${esc(labels[0] ?? 'All')}</span></span>${more}${ICONS.chevron}</button>`;
    })
    .join('');
  $('reset-filters').hidden = Object.keys(state.filters).length === 0;
  $('role').textContent = data.role === 'admin' ? 'Admin' : 'Guest';
}

function renderHeader(data) {
  $('title').textContent = MODES[state.mode].title;
  document.title = `${MODES[state.mode].title} · Billing Dashboard`;
  // сутки у провайдеров свои — как в их кабинетах
  const zone = (tz) => tz.split('/').pop().replace('_', ' ');
  $('subtitle').textContent =
    product() === 'esim'
      ? `Day boundaries: ${zone(data.time_zones.stripe)} · Stripe account Toggle eSim`
      : `Day boundaries: Stripe — ${zone(data.time_zones.stripe)}, Solidgate — ${zone(data.time_zones.solidgate)}`;
  const errors = data.sync
    .filter((s) => s.last_status === 'error')
    .map((s) => `${s.provider === 'stripe' ? 'Stripe' : 'Solidgate'} ${s.account}: sync failed — ${s.last_error ?? ''}`);
  $('status').textContent = errors.join(' · ');
  // синк запускает только админ; пока он идёт, кнопка неактивна
  const button = $('refresh');
  button.hidden = data.role !== 'admin';
  button.disabled = data.sync_running;
  button.classList.toggle('spinning', data.sync_running);
  button.querySelector('span').textContent = data.sync_running ? 'Syncing…' : 'Refresh';
  $('chips').innerHTML = Object.entries(state.filters)
    .flatMap(([d, values]) =>
      values.map(
        (v) =>
          `<span class="chip" title="${esc(valueLabel(d, v))}">${DIMENSION_TITLES[d]}: <b>${esc(valueLabel(d, v))}</b><button data-remove="${d}" data-value="${esc(v)}" aria-label="Remove filter">${ICONS.close}</button></span>`,
      ),
    )
    .join('');
}

// Карточка: название, значение, подпись и пояснение по-русски для подсказки
function kpiCards(cards) {
  $('kpis').innerHTML = cards
    .map(([label, value, sub, tip]) => `<div class="kpi"><div class="label" data-tip="${esc(tip)}">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`)
    .join('');
}

function renderKpis(t, range) {
  kpiCards([
    ['Trials started', num(t.started), `${fullDay(range.from)} — ${fullDay(range.to)}`, 'Сколько триалов оформлено за период'],
    ['Trial-to-paid rate', pct(t.rate_retry), `${num(t.paid_retry)} of ${num(t.started)}`, 'Доля триалов, оплативших первый платный период в течение 30 дней после конца триала'],
    ['First-attempt rate', pct(t.rate_first), `${num(t.paid_first)} of ${num(t.started)}`, 'Доля триалов, оплативших с первой попытки списания'],
    ['Approval rate', pct(t.approval_rate), `${num(t.approved)} of ${num(t.attempts)} attempts`, 'Доля успешных попыток списания первого платежа'],
    ['Decline rate', pct(t.decline_rate), `${num(t.attempts - t.approved)} declines`, 'Доля отклонённых попыток списания первого платежа'],
    ['Refund rate', pct(t.refund_rate), `${num(t.refunded)} of ${num(t.paid_retry)} paid`, 'Доля оплативших, кому вернули деньги'],
  ]);
}

function renderTurnoverKpis(t, range) {
  kpiCards([
    ['Gross volume', usd(t.gross), `${fullDay(range.from)} — ${fullDay(range.to)}`, 'Сумма всех успешных списаний, в долларах'],
    ['Net volume', usd(t.net), 'gross − refunds', 'Оборот за вычетом рефандов'],
    ['Refunds', usd(t.refunded), t.gross ? `${pct(t.refunded / t.gross)} of gross` : '—', 'Сколько денег вернули клиентам'],
    ['Successful payments', num(t.payments), 'successful charges', 'Число успешных списаний'],
    ['Avg. transaction value', usdAverage(t.average), 'gross ÷ payments', 'Средний чек: оборот ÷ число платежей'],
  ]);
}

// Окончательность у eSIM своя: у повторных покупок — окна 30 и 90 дней с первой покупки
const approxPct = (r, final) => `${final || r === null ? '' : '≈ '}${pct(r)}`;

function renderRepeatKpis({ totals: t, range }) {
  kpiCards([
    ['New customers', num(t.customers), `${fullDay(range.from)} — ${fullDay(range.to)}`, 'Клиенты, впервые купившие eSIM в эти дни'],
    ['Returned within 30 days', approxPct(t.repeat_rate_30, t.final_30), `${num(t.repeat_30)} of ${num(t.customers)}`, 'Доля клиентов, купивших снова — пополнение или новый пакет — в течение 30 дней после первой покупки'],
    ['Revenue per customer, 90 days', `${t.final_90 ? '' : '≈ '}${usdAverage(t.revenue_per_customer_90)}`, 'net of refunds', 'Сколько клиент принёс за 90 дней с первой покупки — включая её, за вычетом рефандов'],
  ]);
}

// Заказ — одна оплата (PaymentIntent): несколько попыток в нём (повторное нажатие, другая карта) считаются один раз
function renderOverviewKpis({ totals: t, range }) {
  const unpaid = t.orders - t.paid_orders - t.fraud_blocked;
  kpiCards([
    ['Revenue', usd(t.revenue), `${fullDay(range.from)} — ${fullDay(range.to)}`, 'Деньги за период: оплаченные заказы за вычетом рефандов'],
    ['Orders', num(t.paid_orders), `${num(t.repeat_orders)} repeat`, 'Оплаченные заказы: первые покупки новых клиентов и повторные — пополнения или новый пакет'],
    ['New customers', num(t.new_customers), 'first purchase', 'Клиенты, впервые купившие eSIM в эти дни'],
    ['Payment success', pct(t.payment_success_rate), `${num(t.paid_orders)} of ${num(t.orders - t.fraud_blocked)} orders`, 'Доля заказов, которые удалось оплатить. Заказы, отсечённые антифродом, не учитываются'],
    ['Lost revenue', usd(t.lost_revenue), `${num(unpaid)} orders not paid`, 'Сумма заказов настоящих покупателей, которые не удалось оплатить'],
    ['Blocked as fraud', num(t.fraud_blocked), 'orders', 'Заказы, которые отсёк антифрод Stripe (Radar): перебор карт и подозрительные оплаты'],
  ]);
}

function renderTabs() {
  $('view').innerHTML = MODES[state.mode].tabs
    .map(([v, title]) => `<button data-v="${v}" class="${v === state.view ? 'on' : ''}" data-tip="${TAB_TIPS[v]}">${title}</button>`)
    .join('');
  $('granularity').hidden = state.view !== 'time';
  const { hints } = MODES[state.mode];
  $('hint').textContent = hints[state.view] ?? hints._breakdown ?? 'Click a row to see its trend, or a column header to sort';
}

// --- таблицы: колонки описываются один раз, сортировка — по клику на заголовок
function periodLabel(p) {
  if (state.granularity === 'day') return fullDay(p.period);
  if (state.granularity === 'week') return `${shortDay(p.period)} — ${shortDay(p.period_end)}`;
  const name = monthName(p.period);
  return p.period.endsWith('-01') && isMonthEnd(p.period_end) ? name : `${name} (${shortDay(p.period)} — ${shortDay(p.period_end)})`;
}

// «≈» — у неокончательных цифр; у пустых (—) его не ставим. tip — подсказка к неокончательной цифре
const pendingCell = (html, final, title = '', tip = '') => {
  const approx = !final && !html.startsWith('—');
  return `<td class="${approx ? 'pending' : ''}" title="${title}"${approx && tip ? ` data-tip="${esc(tip)}"` : ''}>${approx ? '≈ ' : ''}${html}</td>`;
};
// Доля и рядом количество; нет знаменателя (некого считать) — просто «—»
const rateCell = (rate, count, final = true, title = '', tip = '') =>
  rate === null ? '<td>—</td>' : pendingCell(`${pct(rate)}<span class="n">${num(count)}</span>`, final, title, tip);
const shareCell = (share) =>
  `<td><span class="bar-cell"><span class="bar"><span style="width:${((share ?? 0) * 100).toFixed(1)}%"></span></span>${pct(share)}</span></td>`;

const periodColumn = (title) => ({ key: 'period', title, text: true, sort: (p) => p.period, cell: (p) => `<td>${periodLabel(p)}</td>` });
const valueColumn = () => ({
  key: 'value',
  title: DIMENSION_TITLES[state.view],
  tip: TAB_TIPS[state.view],
  text: true,
  sort: (r) => (r.value === null ? null : valueLabel(state.view, r.value)),
  cell: (r) => {
    const [name, sub] = valueParts(state.view, r.value);
    return `<td title="${esc(valueLabel(state.view, r.value))}">${esc(name)}${sub ? `<span class="value-id">${esc(sub)}</span>` : ''}</td>`;
  },
});
const CONVERSION_COLUMNS = [
  { key: 'started', title: 'Trials', tip: 'Оформлено триалов', sort: (p) => p.started, cell: (p) => `<td>${num(p.started)}</td>` },
  {
    key: 'rate_retry',
    title: 'Trial-to-paid',
    tip: 'Оплатили первый платный период в течение 30 дней после конца триала',
    sort: (p) => p.rate_retry,
    cell: (p) => rateCell(p.rate_retry, p.paid_retry, p.final_retry),
  },
  {
    key: 'rate_first',
    title: 'First attempt',
    tip: 'Оплатили с первой попытки списания',
    sort: (p) => p.rate_first,
    cell: (p) => rateCell(p.rate_first, p.paid_first, p.final_first),
  },
  {
    key: 'recovery_rate',
    title: 'Recovery rate',
    tip: 'Доля триалов с отклонённой первой попыткой, оплативших в течение 30 дней после конца триала',
    sort: (p) => p.recovery_rate,
    cell: (p) => rateCell(p.recovery_rate, p.recovered, p.final_retry, `${num(p.recovered)} of ${num(p.first_declined)} recovered`),
  },
  {
    key: 'approval_rate',
    title: 'Approval rate',
    tip: 'Доля успешных попыток списания',
    sort: (p) => p.approval_rate,
    cell: (p) => pendingCell(pct(p.approval_rate), p.final_retry, `${num(p.approved)} of ${num(p.attempts)} attempts`),
  },
  {
    key: 'decline_rate',
    title: 'Decline rate',
    tip: 'Доля отклонённых попыток списания',
    sort: (p) => p.decline_rate,
    cell: (p) => pendingCell(pct(p.decline_rate), p.final_retry, `${num(p.attempts - p.approved)} declines`),
  },
  {
    key: 'refund_rate',
    title: 'Refund rate',
    tip: 'Доля оплативших, кому вернули деньги',
    sort: (p) => p.refund_rate,
    cell: (p) => pendingCell(pct(p.refund_rate), p.final_retry, `${num(p.refunded)} of ${num(p.paid_retry)} paid`),
  },
];
const TURNOVER_COLUMNS = [
  { key: 'gross', title: 'Gross volume', tip: 'Сумма успешных списаний', sort: (p) => p.gross, cell: (p) => `<td>${usd(p.gross)}</td>` },
  { key: 'payments', title: 'Payments', tip: 'Число успешных списаний', sort: (p) => p.payments, cell: (p) => `<td>${num(p.payments)}</td>` },
  { key: 'average', title: 'Avg. transaction', tip: 'Средний чек: оборот ÷ число платежей', sort: (p) => p.average, cell: (p) => `<td>${usdAverage(p.average)}</td>` },
  { key: 'refunded', title: 'Refunds', tip: 'Сколько денег вернули клиентам', sort: (p) => p.refunded, cell: (p) => `<td>${usd(p.refunded)}</td>` },
  { key: 'net', title: 'Net volume', tip: 'Оборот за вычетом рефандов', sort: (p) => p.net, cell: (p) => `<td>${usd(p.net)}</td>` },
];
const SHARE_COLUMN = { key: 'share', title: 'Share of gross', tip: 'Доля в обороте за период', sort: (r) => r.share, cell: (r) => shareCell(r.share) };
const REASON_COLUMNS = [
  {
    key: 'reason',
    title: 'Decline reason',
    tip: 'Коды отказа Stripe и Solidgate, сведённые в общие группы',
    text: true,
    sort: (r) => r.reason,
    cell: (r) => `<td data-tip="${esc(r.hint)}">${esc(r.reason)}</td>`,
  },
  { key: 'count', title: 'Declines', tip: 'Все отклонённые попытки с этой причиной', sort: (r) => r.count, cell: (r) => `<td>${num(r.count)}</td>` },
  { key: 'share', title: 'Share of declines', tip: 'Доля от всех отказов', sort: (r) => r.share, cell: (r) => shareCell(r.share) },
  { key: 'first_declines', title: 'First declines', tip: 'Триалы, у которых первая попытка отклонена по этой причине', sort: (r) => r.first_declines, cell: (r) => `<td>${num(r.first_declines)}</td>` },
  {
    key: 'recovery_rate',
    title: 'Recovery rate',
    tip: 'Доля триалов с первым отказом, оплативших в течение 30 дней после конца триала',
    sort: (r) => r.recovery_rate,
    cell: (r) => rateCell(r.recovery_rate, r.recovered, r.final, `${num(r.recovered)} of ${num(r.first_declines)} recovered`), // нет — причина только на повторных попытках
  },
  { key: 'avg_attempts', title: 'Avg. attempts', tip: 'Попыток на такой триал в среднем', sort: (r) => r.avg_attempts, cell: (r) => `<td>${decimal(r.avg_attempts)}</td>` },
  { key: 'avg_days_to_pay', title: 'Days to recover', tip: 'Дней от первого отказа до оплаты — у восстановленных', sort: (r) => r.avg_days_to_pay, cell: (r) => `<td>${decimal(r.avg_days_to_pay)}</td>` },
];
// eSIM, удержание: когорты клиентов по дню первой покупки; «≈» — пока не прошли 30 (90) дней.
// В подсказке к «≈» — сколько дней окна прошло (у самых свежих клиентов группы) и когда цифра станет итоговой
const DAY_SECONDS = 86_400;
const ruDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'America/New_York' });
function windowTip(p, days) {
  const passed = Math.max(0, Math.floor((lastData.generated_at - p.last_first_at) / DAY_SECONDS));
  const freshest = p.period && p.period === p.period_end ? '' : ' у самых свежих клиентов';
  return `Прошло ${passed} из ${days} дней${freshest} — итог ${ruDate.format(new Date((p.last_first_at + days * DAY_SECONDS) * 1000))}`;
}
const REPEAT_COLUMNS = [
  { key: 'customers', title: 'New customers', tip: 'Клиенты, впервые купившие eSIM в эти дни', sort: (p) => p.customers, cell: (p) => `<td>${num(p.customers)}</td>` },
  {
    key: 'repeat_rate_30',
    title: 'Returned within 30 days',
    tip: 'Купили снова — пополнение или новый пакет — в течение 30 дней после первой покупки',
    sort: (p) => p.repeat_rate_30,
    cell: (p) => rateCell(p.repeat_rate_30, p.repeat_30, p.final_30, '', windowTip(p, 30)),
  },
  {
    key: 'revenue_per_customer_90',
    title: 'Revenue per customer, 90 days',
    tip: 'Сколько клиент принёс за 90 дней с первой покупки — включая её, за вычетом рефандов',
    sort: (p) => p.revenue_per_customer_90,
    cell: (p) => pendingCell(usdAverage(p.revenue_per_customer_90), p.final_90, '', windowTip(p, 90)),
  },
];

// eSIM, обзор: что случилось в этот день. Заказ — одна оплата, сколько бы попыток в ней ни было
const OVERVIEW_COLUMNS = [
  // суммы eSIM маленькие (пакеты от $0,99) — в таблице с центами
  { key: 'revenue', title: 'Revenue', tip: 'Оплаченные заказы за вычетом рефандов', sort: (p) => p.revenue, cell: (p) => `<td>${usdAverage(p.revenue)}</td>` },
  { key: 'paid_orders', title: 'Orders', tip: 'Оплаченные заказы', sort: (p) => p.paid_orders, cell: (p) => `<td>${num(p.paid_orders)}</td>` },
  { key: 'new_customers', title: 'New customers', tip: 'Первая покупка клиента', sort: (p) => p.new_customers, cell: (p) => `<td>${num(p.new_customers)}</td>` },
  { key: 'repeat_orders', title: 'Repeat orders', tip: 'Пополнения и новые пакеты клиентов, уже покупавших раньше', sort: (p) => p.repeat_orders, cell: (p) => `<td>${num(p.repeat_orders)}</td>` },
  {
    key: 'payment_success_rate',
    title: 'Payment success',
    tip: 'Доля заказов, которые удалось оплатить (без отсечённых антифродом)',
    sort: (p) => p.payment_success_rate,
    cell: (p) => rateCell(p.payment_success_rate, p.paid_orders, true, `${num(p.paid_orders)} of ${num(p.orders - p.fraud_blocked)} orders`),
  },
  { key: 'lost_revenue', title: 'Lost revenue', tip: 'Сумма заказов настоящих покупателей, которые не удалось оплатить', sort: (p) => p.lost_revenue, cell: (p) => `<td>${usdAverage(p.lost_revenue)}</td>` },
  { key: 'fraud_blocked', title: 'Blocked as fraud', tip: 'Заказы, которые отсёк антифрод: перебор карт и подозрительные оплаты', sort: (p) => p.fraud_blocked, cell: (p) => `<td class="muted">${num(p.fraud_blocked)}</td>` },
];
const OVERVIEW_REASON_COLUMNS = [
  { key: 'reason', title: 'Decline reason', tip: 'Почему заказ не оплачен — причина последней попытки', text: true, sort: (r) => r.reason, cell: (r) => `<td data-tip="${esc(r.hint)}">${esc(r.reason)}</td>` },
  { key: 'count', title: 'Unpaid orders', tip: 'Заказы, которые так и не оплатили', sort: (r) => r.count, cell: (r) => `<td>${num(r.count)}</td>` },
  { key: 'share', title: 'Share', tip: 'Доля от всех неоплаченных заказов', sort: (r) => r.share, cell: (r) => shareCell(r.share) },
];

// Без выбранной сортировки: динамика — свежие дни сверху, разбивки — как отдал сервер (по главной метрике)
const defaultSort = () => (state.view === 'time' ? { key: 'period', dir: 'desc' } : null);

function sortRows(rows, columns) {
  const sort = state.sort ?? defaultSort();
  const column = sort && columns.find((c) => c.key === sort.key);
  if (!column) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = column.sort(a);
    const y = column.sort(b);
    if (x === null || y === null) return Number(x === null) - Number(y === null); // пустые — всегда внизу
    return (typeof x === 'string' ? x.localeCompare(y, 'en') : x - y) * dir;
  });
}

let table = null; // текущие колонки и строки — для пересортировки без запроса

function renderTable(columns, rows, { link = false, limit = false, empty = 'No data for this period' } = {}) {
  table = { columns, rows, link, limit, empty };
  const sort = state.sort ?? defaultSort();
  const sorted = sortRows(rows, columns);
  const shown = limit && !state.showAll ? sorted.slice(0, ROW_LIMIT) : sorted;
  $('thead').innerHTML = `<tr>${columns
    .map((c) => {
      const on = sort?.key === c.key;
      const arrow = on && sort.dir === 'asc' ? '↑' : '↓';
      return `<th class="${on ? 'sorted' : ''}" aria-sort="${on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button class="sort" data-sort="${c.key}"${c.tip ? ` data-tip="${esc(c.tip)}"` : ''}>${c.title}<span class="arrow">${arrow}</span></button></th>`;
    })
    .join('')}</tr>`;
  $('rows').innerHTML =
    shown
      .map((r) => `<tr${link ? ` class="link" data-value="${esc(r.value ?? 'none')}"` : ''}>${columns.map((c) => c.cell(r)).join('')}</tr>`)
      .join('') || `<tr><td colspan="${columns.length}" class="muted">${empty}</td></tr>`;
  $('more').hidden = !limit || rows.length <= ROW_LIMIT || state.showAll;
  $('show-all').textContent = `Show all (${num(rows.length)})`;
}

function renderView(data) {
  const isTime = state.view === 'time';
  showCharts(isTime);
  const timeHead = (day) => ({ day, week: 'Week', month: 'Month' })[state.granularity];
  const breakdown = { link: true, limit: true };

  if (kind() === 'repeat') {
    if (isTime) {
      renderTable([periodColumn(timeHead('First purchase date')), ...REPEAT_COLUMNS], data.series);
      renderRepeatChart(data.series);
    } else {
      renderTable([valueColumn(), ...REPEAT_COLUMNS], data.breakdown, { ...breakdown, empty: 'No new customers for this period' });
    }
    return;
  }
  if (kind() === 'overview') {
    if (isTime) {
      renderTable([periodColumn(timeHead('Date')), ...OVERVIEW_COLUMNS], data.series);
      renderOverviewChart(data.series);
    } else if (state.view === 'decline_reason') {
      renderTable(OVERVIEW_REASON_COLUMNS, data.reasons, { empty: 'No unpaid orders for this period' });
    } else {
      renderTable([valueColumn(), ...OVERVIEW_COLUMNS], data.breakdown, { ...breakdown, empty: 'No orders for this period' });
    }
    return;
  }
  if (isTurnover()) {
    if (isTime) {
      renderTable([periodColumn(timeHead('Payment date')), ...TURNOVER_COLUMNS], data.series);
      renderTurnoverChart(data.series);
    } else {
      renderTable([valueColumn(), SHARE_COLUMN, ...TURNOVER_COLUMNS], data.breakdown, { link: true, limit: true, empty: 'No payments for this period' });
    }
    return;
  }
  if (isTime) {
    renderTable([periodColumn(timeHead('Trial start date')), ...CONVERSION_COLUMNS], data.series);
    renderCharts(data.series);
  } else if (state.view === 'decline_reason') {
    renderReasons(REASON_COLUMNS, data.reasons);
  } else {
    renderTable([valueColumn(), ...CONVERSION_COLUMNS], data.breakdown, breakdown);
  }
}

function renderReasons(columns, reasons) {
  renderTable(columns, reasons, { empty: 'No declines for this period' });
  // итог по всем причинам — в подсказке над таблицей
  const first = reasons.reduce((s, r) => s + r.first_declines, 0);
  const recovered = reasons.reduce((s, r) => s + r.recovered, 0);
  const approx = reasons.every((r) => r.final) ? '' : '≈ ';
  if (first) $('hint').textContent += `. Overall: ${approx}${pct(recovered / first)} — ${num(recovered)} of ${num(first)} recovered`;
}

// --- графики (под таблицей)
function chartBase() {
  const muted = css('--muted');
  const grid = css('--grid');
  for (const chart of Object.values(charts)) chart.destroy();
  charts = {};
  return {
    muted,
    grid,
    x: { grid: { display: false }, border: { color: grid }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 16 } },
    common: { animation: false, responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false } },
  };
}
const chartLabels = (series) => series.map((p) => (state.granularity === 'month' ? monthName(p.period) : shortDay(p.period)));
const chartTooltip = (series, label) => ({ padding: 10, cornerRadius: 8, callbacks: { title: (items) => periodLabel(series[items[0].dataIndex]), label } });

function renderCharts(series) {
  const { muted, grid, x, common } = chartBase();
  const toPct = (r) => (r === null ? null : +(r * 100).toFixed(1));
  const dashed = (key) => (ctx) => (series[ctx.p1DataIndex][key] ? undefined : [5, 4]);
  const line = (label, key, finalKey, color) => ({
    label, data: series.map((p) => toPct(p[key])), borderColor: color, backgroundColor: color,
    borderWidth: 2, pointRadius: series.length > 31 ? 0 : 3, pointHoverRadius: 5, tension: 0.25, spanGaps: true,
    segment: { borderDash: dashed(finalKey) },
  });
  charts.rate = new Chart($('rate-chart'), {
    type: 'line',
    data: {
      labels: chartLabels(series),
      datasets: [line('Trial-to-paid', 'rate_retry', 'final_retry', css('--s-converted')), line('First attempt', 'rate_first', 'final_first', css('--s-first'))],
    },
    options: {
      ...common,
      plugins: { legend: { display: false }, tooltip: chartTooltip(series, (c) => ` ${c.dataset.label}: ${c.raw ?? '—'}%`) },
      scales: { x, y: { min: 0, grid: { color: grid }, border: { display: false }, ticks: { color: muted, callback: (v) => `${v}%` } } },
    },
  });
  charts.count = new Chart($('count-chart'), {
    type: 'bar',
    data: {
      labels: chartLabels(series),
      datasets: [{ label: 'Trials started', data: series.map((p) => p.started), backgroundColor: css('--s-started'), borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 28 }],
    },
    options: {
      ...common,
      plugins: { legend: { display: false }, tooltip: chartTooltip(series, (c) => ` Trials started: ${num(c.raw)}`) },
      scales: { x, y: { grid: { color: grid }, border: { display: false }, ticks: { color: muted, callback: (v) => num(v) } } },
    },
  });
}

// Линия долей в процентах; finalKey — пунктир там, где цифра ещё неокончательная
const percentLine = (series, label, key, finalKey, color) => ({
  label, data: series.map((p) => (p[key] === null ? null : +(p[key] * 100).toFixed(1))), borderColor: color, backgroundColor: color,
  borderWidth: 2, pointRadius: series.length > 31 ? 0 : 3, pointHoverRadius: 5, tension: 0.25, spanGaps: true,
  segment: { borderDash: (ctx) => (!finalKey || series[ctx.p1DataIndex][finalKey] ? undefined : [5, 4]) },
});

function renderPercentChart(canvasId, series, datasets) {
  const { muted, grid, x, common } = chartBase();
  charts.main = new Chart($(canvasId), {
    type: 'line',
    data: { labels: chartLabels(series), datasets },
    options: {
      ...common,
      plugins: { legend: { display: false }, tooltip: chartTooltip(series, (c) => ` ${c.dataset.label}: ${c.raw ?? '—'}%`) },
      scales: { x, y: { min: 0, grid: { color: grid }, border: { display: false }, ticks: { color: muted, callback: (v) => `${v}%` } } },
    },
  });
}

const renderRepeatChart = (series) =>
  renderPercentChart('repeat-chart', series, [percentLine(series, 'Returned within 30 days', 'repeat_rate_30', 'final_30', css('--s-converted'))]);

function renderOverviewChart(series) {
  const { muted, grid, x, common } = chartBase();
  charts.main = new Chart($('overview-chart'), {
    type: 'bar',
    data: {
      labels: chartLabels(series),
      datasets: [{ label: 'Revenue', data: series.map((p) => p.revenue / 100), backgroundColor: css('--s-converted'), borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 28 }],
    },
    options: {
      ...common,
      plugins: {
        legend: { display: false },
        tooltip: chartTooltip(series, (c) => ` Revenue: ${usd(series[c.dataIndex].revenue)} · orders: ${num(series[c.dataIndex].paid_orders)}`),
      },
      scales: { x, y: { min: 0, grid: { color: grid }, border: { display: false }, ticks: { color: muted, callback: (v) => usdCompact.format(v) } } },
    },
  });
}

// Графики своего экрана — при смене темы перерисовываются: цвета берутся из неё
function renderModeCharts(series) {
  ({ conversion: renderCharts, turnover: renderTurnoverChart, repeat: renderRepeatChart, overview: renderOverviewChart })[kind()](series);
}

function renderTurnoverChart(series) {
  const { muted, grid, x, common } = chartBase();
  charts.turnover = new Chart($('turnover-chart'), {
    type: 'bar',
    data: {
      labels: chartLabels(series),
      datasets: [{ label: 'Gross volume', data: series.map((p) => p.gross / 100), backgroundColor: css('--s-converted'), borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 28 }],
    },
    options: {
      ...common,
      plugins: {
        legend: { display: false },
        tooltip: chartTooltip(series, (c) => ` Gross volume: ${usd(series[c.dataIndex].gross)} · payments: ${num(series[c.dataIndex].payments)}`),
      },
      scales: { x, y: { min: 0, grid: { color: grid }, border: { display: false }, ticks: { color: muted, callback: (v) => usdCompact.format(v) } } },
    },
  });
}

// --- выпадающие окна: список значений фильтра и выбор периода
let popover = null;

// onClose — после закрытия любым способом: кнопкой, кликом мимо, Esc, открытием другого окна
function openPopover(anchor, build, onClose = () => {}) {
  const toggle = popover?.anchor === anchor; // повторный клик по той же кнопке — закрыть
  closePopover();
  if (toggle) return;
  const el = document.createElement('div');
  el.className = 'popover';
  el.setAttribute('role', 'dialog');
  document.body.append(el);
  popover = { el, anchor, onClose };
  anchor.setAttribute('aria-expanded', 'true');
  build(el);
  placePopover();
}

// Под кнопкой; не влезает справа или снизу — сдвигаем ровно настолько, чтобы влезло
function placePopover() {
  if (!popover) return;
  const { el, anchor } = popover;
  const r = anchor.getBoundingClientRect();
  const left = Math.max(12, Math.min(r.left, innerWidth - 12 - el.offsetWidth));
  const top = Math.max(12, Math.min(r.bottom + 6, innerHeight - 12 - el.offsetHeight));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function closePopover() {
  if (!popover) return;
  const { el, anchor, onClose } = popover;
  anchor.setAttribute('aria-expanded', 'false');
  el.remove();
  popover = null;
  onClose();
}

// Фильтр с несколькими значениями: галочки отмечаются сразу, а данные пересчитываются, когда окно закрыли
async function openFilter(anchor, dimension) {
  const values = await loadValues(dimension);
  const initial = state.filters[dimension] ?? [];
  const selected = new Set(initial);
  const options = [
    ...values.filter((v) => v.value !== null).map((v) => ({ value: v.value, count: v.count })),
    ...values.filter((v) => v.value === null).map((v) => ({ value: 'none', count: v.count })),
  ];
  for (const value of initial) if (!options.some((o) => o.value === value)) options.push({ value });
  for (const o of options) [o.name, o.sub] = valueParts(dimension, o.value);

  const apply = () => {
    const next = options.map((o) => o.value).filter((v) => selected.has(v));
    if (next.length === initial.length && next.every((v) => initial.includes(v))) return; // ничего не поменяли
    if (next.length) state.filters[dimension] = next;
    else delete state.filters[dimension];
    state.showAll = false;
    load();
  };

  openPopover(
    anchor,
    (el) => {
      el.style.width = `${Math.max(anchor.offsetWidth, options.some((o) => o.sub) ? 360 : 280)}px`; // UUID — целиком
      const withSearch = options.length > 8;
      el.innerHTML = `
        ${withSearch ? `<input class="search" placeholder="Search ${DIMENSION_TITLES[dimension].toLowerCase()}" aria-label="Search" />` : ''}
        <div class="options" role="listbox" aria-multiselectable="true"></div>
        <div class="pop-foot"><button class="link-btn" data-clear>Clear</button><span class="muted" data-picked></span><button class="btn primary" data-done>Done</button></div>`;
      const list = el.querySelector('.options');
      const search = el.querySelector('.search');
      const draw = () => {
        const q = (search?.value ?? '').trim().toLowerCase();
        const shown = options.filter((o) => !q || `${o.name} ${o.sub ?? ''} ${o.value}`.toLowerCase().includes(q));
        list.innerHTML =
          shown
            .map((o) => {
              const on = selected.has(o.value);
              return `<button class="option check${on ? ' on' : ''}" role="option" aria-selected="${on}" data-value="${esc(o.value)}"><span class="box">${ICONS.check}</span><span class="name">${esc(o.name)}${o.sub ? `<span class="value-id">${esc(o.sub)}</span>` : ''}</span>${o.count ? `<span class="count">${num(o.count)}</span>` : ''}</button>`;
            })
            .join('') || '<div class="empty">Nothing found</div>';
        el.querySelector('[data-picked]').textContent = selected.size ? `Selected: ${selected.size}` : 'All';
      };
      const toggle = (value) => {
        if (selected.has(value)) selected.delete(value);
        else selected.add(value);
        draw();
      };
      draw();
      el.addEventListener('click', (event) => {
        const option = event.target.closest('.option');
        if (option) toggle(option.dataset.value);
        if (event.target.closest('[data-clear]')) {
          selected.clear();
          draw();
        }
        if (event.target.closest('[data-done]')) closePopover();
      });
      if (search) {
        search.addEventListener('input', draw);
        // Enter — отметить первое найденное
        search.addEventListener('keydown', (event) => {
          const first = list.querySelector('.option');
          if (event.key === 'Enter' && first) toggle(first.dataset.value);
        });
        requestAnimationFrame(() => search.focus());
      } else {
        requestAnimationFrame(() => list.querySelector('.option')?.focus());
      }
    },
    apply,
  );
}

// Период: пресеты слева, календарь справа — два клика по дням задают свой период
function openPeriod(anchor) {
  if (!lastData) return;
  const { range, history_from: first, today } = lastData;
  let month = range.to.slice(0, 7);
  let start = null;

  const choose = (patch) => {
    closePopover();
    Object.assign(state, patch, { showAll: false });
    load();
  };

  openPopover(anchor, (el) => {
    const draw = () => {
      const [y, m] = month.split('-').map(Number);
      const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const offset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
      const [from, to] = start ? [start, start] : [range.from, range.to];
      const cells = [];
      for (let i = 1; i <= days; i++) {
        const day = `${month}-${String(i).padStart(2, '0')}`;
        const cls = ['day', day === from || day === to ? 'edge' : day > from && day < to ? 'in' : '', day === today ? 'today' : ''].join(' ');
        cells.push(`<button class="${cls}" data-day="${day}" ${day < first || day > today ? 'disabled' : ''}>${i}</button>`);
      }
      el.innerHTML = `
        <div class="range">
          <div class="presets">${PRESETS.map(([v, name]) => `<button class="option${state.preset === v ? ' on' : ''}" data-preset="${v}"><span class="name">${name}</span></button>`).join('')}</div>
          <div class="calendar">
            <div class="cal-head">
              <button class="btn" data-month="${addMonths(month, -1)}" aria-label="Previous month" ${month <= first.slice(0, 7) ? 'disabled' : ''}>${ICONS.left}</button>
              <span>${MONTHS[m - 1]} ${y}</span>
              <button class="btn" data-month="${addMonths(month, 1)}" aria-label="Next month" ${month >= today.slice(0, 7) ? 'disabled' : ''}>${ICONS.right}</button>
            </div>
            <div class="cal-grid">${WEEKDAYS.map((d) => `<span class="dow">${d}</span>`).join('')}${'<span></span>'.repeat(offset)}${cells.join('')}</div>
            <div class="cal-hint">${start ? `From ${fullDay(start)} — pick the end date` : 'Pick a start date or a preset'}</div>
          </div>
        </div>`;
    };
    el.addEventListener('click', (event) => {
      const preset = event.target.closest('[data-preset]')?.dataset.preset;
      const nav = event.target.closest('[data-month]')?.dataset.month;
      const day = event.target.closest('[data-day]')?.dataset.day;
      if (preset) return choose({ preset });
      if (nav) {
        month = nav;
        draw();
      } else if (day && !start) {
        start = day;
        draw();
      } else if (day) {
        const [from, to] = start <= day ? [start, day] : [day, start];
        choose({ preset: 'custom', from, to });
      }
    });
    draw();
  });
}

// --- панель выборки на узком экране выезжает слева
const openSidebar = () => {
  document.body.classList.add('sidebar-open');
  $('sidebar-overlay').hidden = false;
};
const closeSidebar = () => {
  document.body.classList.remove('sidebar-open');
  $('sidebar-overlay').hidden = true;
};

// --- обработчики
// Смена экрана: фильтры, которых у него нет (аккаунт ↔ MID), снимаются; вкладка, которой нет, — на динамику
function switchMode(value) {
  state.mode = value;
  state.filters = Object.fromEntries(Object.entries(state.filters).filter(([d]) => dimensions().includes(d)));
  if (!MODES[value].tabs.some(([v]) => v === state.view)) state.view = 'time';
  state.sort = null;
  state.showAll = false;
  $('kpis').innerHTML = ''; // у другого экрана другие карточки — до ответа показываем скелетон
  load();
}

$('mode').addEventListener('click', (event) => {
  const value = event.target.closest('button')?.dataset.v;
  if (value && value !== state.mode) switchMode(value);
});

// Другой продукт — его первый экран
$('product').addEventListener('click', (event) => {
  const value = event.target.closest('button')?.dataset.v;
  if (value && value !== product()) switchMode(Object.keys(MODES).find((m) => MODES[m].product === value));
});

for (const id of ['provider', 'granularity']) {
  $(id).addEventListener('click', (event) => {
    const value = event.target.closest('button')?.dataset.v;
    if (!value || value === state[id]) return;
    state[id] = value;
    state.showAll = false;
    load(id === 'granularity' ? 'view' : 'data');
  });
}

$('view').addEventListener('click', (event) => {
  const value = event.target.closest('button')?.dataset.v;
  if (!value || value === state.view) return;
  state.view = value;
  state.sort = null; // у вкладок разные колонки
  state.showAll = false;
  load('view');
});

$('period').addEventListener('click', (event) => openPeriod(event.currentTarget));

$('filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-dimension]');
  if (button) openFilter(button, button.dataset.dimension);
});

$('reset-filters').addEventListener('click', () => {
  state.filters = {};
  state.showAll = false;
  load();
});

$('chips').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-remove]');
  if (!button) return;
  const { remove: dimension, value } = button.dataset;
  const rest = (state.filters[dimension] ?? []).filter((v) => v !== value);
  if (rest.length) state.filters[dimension] = rest;
  else delete state.filters[dimension];
  load();
});

$('thead').addEventListener('click', (event) => {
  const key = event.target.closest('[data-sort]')?.dataset.sort;
  if (!key || !table) return;
  const current = state.sort ?? defaultSort();
  const column = table.columns.find((c) => c.key === key);
  // повторный клик меняет направление; новая колонка: текст — по алфавиту, числа — от большего к меньшему
  state.sort = current?.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: column.text ? 'asc' : 'desc' };
  saveUrl();
  renderTable(table.columns, table.rows, table);
});

$('rows').addEventListener('click', (event) => {
  const row = event.target.closest('tr.link');
  if (loading || !row || !dimensions().includes(state.view)) return; // строки старой вкладки, пока грузится новая
  state.filters[state.view] = [row.dataset.value];
  state.view = 'time';
  state.sort = null;
  load();
});

$('show-all').addEventListener('click', () => {
  state.showAll = true;
  if (table) renderTable(table.columns, table.rows, table);
});

$('refresh').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (button.disabled) return;
  button.disabled = true; // сразу, не дожидаясь ответа — без двойного запуска
  const res = await api('/api/sync', { method: 'POST' });
  if (res.status === 403) $('status').textContent = 'Only admins can run a sync';
  load('silent');
});

$('menu-open').addEventListener('click', openSidebar);
$('sidebar-overlay').addEventListener('click', closeSidebar);

// Тема: светлая или тёмная; выбор хранится в браузере
const markTheme = () => document.querySelectorAll('#theme button').forEach((b) => b.classList.toggle('on', b.dataset.v === document.documentElement.dataset.theme));
$('theme').addEventListener('click', (event) => {
  const value = event.target.closest('button')?.dataset.v;
  if (!value) return;
  document.documentElement.dataset.theme = value;
  try {
    localStorage.setItem('theme', value);
  } catch {}
  markTheme();
  if (lastData && state.view === 'time') renderModeCharts(lastData.series);
});

document.addEventListener('mousedown', (event) => {
  if (popover && !popover.el.contains(event.target) && !popover.anchor.contains(event.target)) closePopover();
});
addEventListener('resize', closePopover);

// «Как считается»: тексты — public/metrics.md и public/data-sources.md, один источник для дашборда и репозитория
const helpCache = {};
let helpTab = 'metrics';
async function showHelpTab(tab) {
  helpTab = tab;
  document.querySelectorAll('#help-tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === tab);
    b.setAttribute('aria-selected', String(b.dataset.v === tab));
  });
  const body = $('help-body');
  try {
    if (!helpCache[tab]) {
      body.textContent = 'Loading…';
      const res = await api(`/${tab}.md`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      helpCache[tab] = marked.parse(await res.text());
    }
    if (helpTab === tab) body.innerHTML = helpCache[tab];
    $('help').scrollTop = 0;
  } catch (error) {
    body.textContent = `Failed to load the description: ${error.message}`;
  }
}
function openHelp() {
  $('help').hidden = false;
  $('help-overlay').hidden = false;
  $('help-close').focus();
  showHelpTab(helpTab);
}
function closeHelp() {
  $('help').hidden = true;
  $('help-overlay').hidden = true;
  $('help-open').focus();
}
$('help-open').addEventListener('click', openHelp);
$('help-tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('button')?.dataset.v;
  if (tab) showHelpTab(tab);
});
$('help-close').addEventListener('click', closeHelp);
$('help-overlay').addEventListener('click', closeHelp);

// Esc закрывает верхнее: выпадающее окно, «Как считается», панель выборки
// Подсказки: у названий метрик, колонок, вкладок и причин отказа — data-tip с коротким пояснением по-русски.
// Своя, а не title: появляется сразу при наведении и не обрезается таблицей
const tip = document.createElement('div');
tip.className = 'tip';
tip.setAttribute('role', 'tooltip');
tip.hidden = true;
document.body.append(tip);
function showTip(target) {
  const el = target instanceof Element ? target.closest('[data-tip]') : null;
  tip.hidden = !el?.dataset.tip;
  if (tip.hidden) return;
  tip.textContent = el.dataset.tip;
  // над элементом, а если сверху не влезает — под ним; по горизонтали — в пределах окна
  const r = el.getBoundingClientRect();
  const above = r.top - tip.offsetHeight - 6;
  tip.style.top = `${above < 8 ? r.bottom + 6 : above}px`;
  tip.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 8 - tip.offsetWidth))}px`;
}
const hideTip = () => (tip.hidden = true);
document.addEventListener('mouseover', (event) => showTip(event.target));
document.addEventListener('mouseout', (event) => event.relatedTarget || hideTip()); // ушли за пределы окна
document.addEventListener('focusin', (event) => showTip(event.target));
document.addEventListener('focusout', hideTip);
document.addEventListener('click', hideTip); // после клика элемент под курсором обычно перерисовывается
addEventListener('scroll', hideTip, true);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (popover) closePopover();
  else if (!$('help').hidden) closeHelp();
  else if (document.body.classList.contains('sidebar-open')) closeSidebar();
});

markTheme();
load();
