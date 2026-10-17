// Billing Dashboard. Выбор хранится в адресе страницы (ссылкой можно поделиться);
// данные — /api/metrics (конверсия), /api/cancellations (отмены), /api/vamp (Visa VAMP), /api/turnover (оборот), /api/esim/* (eSIM), значения фильтров — /api/values, выгрузка — /api/export.

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
// Экраны по продуктам. VPN: конверсия и отмены триалов (когорты по дню оформления), оборот (успешные платежи по дню платежа).
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
  cancellations: {
    product: 'vpn',
    kind: 'cancellations',
    label: 'Cancellations',
    tip: 'Отмены подписок: сколько триалов отменили и на какой день',
    title: 'Trial cancellations',
    api: '/api/cancellations',
    charts: 'cancel-charts',
    dimensions: ['account', 'mid', 'country', 'payment_method', 'bank', 'card_brand'],
    tabs: [['time', 'Trend'], ['account', 'Accounts'], ['mid', 'MID'], ['country', 'Countries'], ['payment_method', 'Payment methods'], ['bank', 'Issuing banks'], ['card_brand', 'Card brands'], ['cancel_reason', 'Cancellation reasons']],
    hints: {
      time: 'Trials by start date: how many were cancelled before the trial ended, and how soon. A cancellation counts when it was requested, even if access lasts until the period end',
      cancel_reason: 'Cancellations during the trial and within 30 days after it. Stripe and Solidgate reasons are grouped — hover a reason for details',
    },
  },
  vamp: {
    product: 'vpn',
    kind: 'vamp',
    label: 'VAMP',
    tip: 'Visa VAMP: фрод-репорты и чарджбэки Visa к успешным Visa-списаниям — по месяцам и мерчантам',
    title: 'Visa VAMP',
    api: '/api/vamp',
    charts: 'vamp-charts',
    dimensions: ['merchant', 'mid', 'country', 'payment_method'],
    tabs: [['time', 'Trend'], ['merchant', 'Merchants'], ['outcome', 'After report'], ['mid', 'MID'], ['country', 'Countries'], ['payment_method', 'Payment methods'], ['risk', 'Radar risk'], ['charge_type', 'Charge type']],
    hints: {
      time: "A report counts in the month it reached Stripe or Solidgate (UTC); Visa dates it by when the bank reported it, so around month boundaries counts can differ by 10–15%. Visa's official figures come next month: Stripe → VAMP → Visa data",
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
  destination: 'Destination', package: 'Package', risk: 'Radar risk score', charge_type: 'Charge type', merchant: 'Visa merchant',
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
  cancel_reason: 'Почему отменили подписку',
  risk: 'Radar risk score списания — только у Stripe',
  merchant: 'Мерчант Visa: аккаунты Stripe одного бизнеса Visa считает вместе — пороги у мерчанта целиком',
  outcome: 'Что стало со списанием после фрод-репорта: чарджбэк, RDR, вернули деньги или ничего',
  charge_type: 'Первый платёж после триала или продление',
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
  download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
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
  // мерчант Visa — имя группы MID или сам MID, если он ни в какой группе
  if (dimension === 'merchant') return value?.includes(':') ? valueParts('mid', value) : [valueName(dimension, value), null];
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
  if (dimension === 'charge_type') return CHARGE_TYPES[value] ?? value;
  return value;
}
const CHARGE_TYPES = { first_payment: 'First payment after trial', renewal: 'Renewal or other' };

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
  else if (kind() === 'cancellations') renderCancelKpis(data);
  else if (kind() === 'vamp') renderVampKpis(data);
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
    kind() === 'vamp'
      ? 'Estimate · calendar months, UTC · Visa only · thresholds apply to a whole Visa merchant'
      : product() === 'esim'
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
    ['Fraud rate', pct(t.fraud_rate), `${num(t.fraud)} of ${num(t.paid_retry)} paid · ${decimal(t.vamp_per_100)} VAMP / 100 trials`, 'Доля оплативших, по чьим списаниям потом пришёл фрод-репорт или чарджбэк (любая сеть). У свежих когорт растёт: банки сообщают о фроде неделями'],
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

// Отмены: день отмены считаем от оформления, «Day 1» — первые 24 часа
const cancelDay = (day) => (day === null ? '—' : `day ${day + 1}`);

function renderCancelKpis({ totals: t, median_cancel_day: median }) {
  kpiCards([
    ['Trials started', num(t.started), 'in the selected period', 'Сколько триалов оформлено за период'],
    ['Trial cancellation rate', approxPct(t.trial_cancellation_rate, t.final_trial), `${num(t.canceled_in_trial)} of ${num(t.started)}`, 'Доля триалов, отменённых до конца пробного периода'],
    ['Cancelled within 24h', pct(t.day0_share), `${num(t.canceled_day0)} of ${num(t.canceled_in_trial)} cancellations`, 'Какая доля отмен во время триала случилась в первые сутки после оформления'],
    ['Avg. days to cancel', t.avg_cancel_day === null ? '—' : `${decimal(t.avg_cancel_day)} days`, `median: ${cancelDay(median)}`, 'Через сколько дней после оформления в среднем отменяют — среди отменивших во время триала. Медиана: к этому дню отменила половина'],
    ['Post-trial cancellation rate', approxPct(t.post_trial_cancellation_rate, t.final_after), `${num(t.canceled_after)} of ${num(t.started)} · 30 days`, 'Доля триалов, отменённых в первые 30 дней после конца триала — включая закрытые из-за неоплаты'],
  ]);
}

// Visa VAMP: карточки — за последний месяц периода; статус — у одного мерчанта, иначе сколько мерчантов в каком статусе
const pct2 = (r) => (r === null || r === undefined ? '—' : `${(r * 100).toFixed(2)}%`);
const STATUS_NAMES = { excessive: 'Excessive', at_risk: 'At risk', ok: 'OK' };
const STATUS_TIPS = {
  excessive: 'Оба порога превышены: ratio и count',
  at_risk: 'Превышен один порог — или count превысит порог к концу месяца при нынешнем темпе',
  ok: 'Ниже обоих порогов',
};
const statusBadge = (status) => (status ? `<span class="badge ${status}" data-tip="${STATUS_TIPS[status]}">${STATUS_NAMES[status]}</span>` : '—');

function renderVampKpis({ month: m, thresholds: t }) {
  const approx = (html) => (m.final || html === '—' ? html : `≈ ${html}`);
  const when = `${monthName(m.from)}${m.final ? '' : ', to date'}`;
  const statusCard = m.status
    ? ['Status', statusBadge(m.status), m.forecast_count === null ? 'month closed' : `forecast ${num(m.forecast_count)} by month end`, 'Excessive — оба порога сразу. Прогноз — count к концу месяца при нынешнем темпе']
    : m.statuses
      ? ['Excessive merchants', `${num(m.statuses.excessive)} of ${num(m.merchants)}`, `${num(m.statuses.at_risk)} at risk · ${num(m.statuses.ok)} OK`, 'Пороги VAMP — у каждого мерчанта Visa отдельно: статус каждого — во вкладке Merchants']
      : ['Status', '—', 'only for a whole merchant, without filters', 'Пороги считаются по мерчанту Visa целиком: по одной стране, способу оплаты или одному аккаунту Stripe статуса нет'];
  kpiCards([
    ['VAMP count', approx(num(m.vamp_count)), `${when} · threshold ${num(t.count)}`, 'Фрод-репорты Visa (TC40) + Visa-чарджбэки без RDR (TC15) за месяц. Порог Excessive у мерчанта — 1 500'],
    ['VAMP ratio', approx(pct2(m.vamp_ratio)), `of ${num(m.visa_sales)} Visa sales · threshold ${pct2(t.ratio)}`, 'VAMP count ÷ успешные Visa-списания за месяц. В начале месяца завышен: репорты приходят и по списаниям прошлых месяцев'],
    statusCard,
    ['Fraud reports (TC40)', num(m.fraud), 'Visa early fraud warnings', 'Банк сообщил Visa о мошенничестве по списанию (у Stripe — early fraud warning). Идут в VAMP, даже если деньги вернули'],
    ['Chargebacks (TC15)', num(m.disputes), 'Visa, not resolved by RDR', 'Visa-чарджбэки, не закрытые через RDR. Запросы документов (inquiry) не считаются'],
    ['RDR, excluded', num(m.rdr), `${usd(m.rdr_lost)} lost`, 'Visa-диспуты, закрытые через RDR: в VAMP не идут, но деньги списаны'],
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
  $('granularity').hidden = state.view !== 'time' || kind() === 'vamp'; // VAMP — только по месяцам
  const { hints } = MODES[state.mode];
  $('hint').textContent = hints[state.view] ?? hints._breakdown ?? 'Click a row to see its trend, or a column header to sort';
}

// --- таблицы: колонки описываются один раз, сортировка — по клику на заголовок
function periodLabel(p) {
  if (state.granularity === 'day') return fullDay(p.period);
  if (state.granularity === 'week') return `${shortDay(p.period)} — ${shortDay(p.period_end)}`;
  return monthLabel(p);
}
// Месяц, обрезанный периодом, — с его днями
function monthLabel(p) {
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
  // Фрод по когорте: репорты и чарджбэки приходят неделями и месяцами — у свежих когорт цифры ещё растут
  {
    key: 'fraud_rate',
    title: 'Fraud rate',
    tip: 'Доля оплативших, по чьим списаниям потом пришёл фрод-репорт или чарджбэк. У свежих когорт растёт',
    sort: (p) => p.fraud_rate,
    cell: (p) => rateCell(p.fraud_rate, p.fraud, true, `${num(p.fraud)} of ${num(p.paid_retry)} paid`),
  },
  {
    key: 'vamp_per_100',
    title: 'VAMP / 100 trials',
    tip: 'Событий Visa VAMP (фрод-репорты и чарджбэки без RDR) на 100 оформленных триалов — вклад этого трафика в VAMP count',
    sort: (p) => p.vamp_per_100,
    cell: (p) => `<td title="${num(p.vamp_events)} VAMP events">${decimal(p.vamp_per_100)}</td>`,
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
// Отмены VPN: «≈» — пока не закончились триалы когорты (во время триала) или не прошло окно 30 дней после них
const CANCEL_COLUMNS = [
  { key: 'started', title: 'Trials', tip: 'Оформлено триалов', sort: (p) => p.started, cell: (p) => `<td>${num(p.started)}</td>` },
  {
    key: 'trial_cancellation_rate',
    title: 'Trial cancellation rate',
    tip: 'Отменили до конца триала',
    sort: (p) => p.trial_cancellation_rate,
    cell: (p) => rateCell(p.trial_cancellation_rate, p.canceled_in_trial, p.final_trial, `${num(p.canceled_in_trial)} of ${num(p.started)} cancelled`),
  },
  {
    key: 'day0_share',
    title: 'Within 24h',
    tip: 'Доля отмен во время триала, случившихся в первые сутки после оформления',
    sort: (p) => p.day0_share,
    cell: (p) => rateCell(p.day0_share, p.canceled_day0, p.final_trial, `${num(p.canceled_day0)} of ${num(p.canceled_in_trial)} cancellations`),
  },
  {
    key: 'avg_cancel_day',
    title: 'Avg. days to cancel',
    tip: 'Дней от оформления до отмены в среднем — у отменивших во время триала',
    sort: (p) => p.avg_cancel_day,
    cell: (p) => pendingCell(decimal(p.avg_cancel_day), p.final_trial),
  },
  {
    key: 'post_trial_cancellation_rate',
    title: 'Post-trial cancellation',
    tip: 'Отменили в первые 30 дней после конца триала — включая закрытые из-за неоплаты',
    sort: (p) => p.post_trial_cancellation_rate,
    cell: (p) => rateCell(p.post_trial_cancellation_rate, p.canceled_after, p.final_after, `${num(p.canceled_after)} of ${num(p.started)} cancelled`),
  },
];
const CANCEL_REASON_COLUMNS = [
  { key: 'reason', title: 'Cancellation reason', tip: 'Причины отмены Stripe и Solidgate, сведённые в общие группы', text: true, sort: (r) => r.reason, cell: (r) => `<td data-tip="${esc(r.hint)}">${esc(r.reason)}</td>` },
  { key: 'count', title: 'Cancellations', tip: 'Отмены во время триала и в 30 дней после него', sort: (r) => r.count, cell: (r) => `<td>${num(r.count)}</td>` },
  { key: 'share', title: 'Share', tip: 'Доля от всех отмен', sort: (r) => r.share, cell: (r) => shareCell(r.share) },
  { key: 'in_trial', title: 'During trial', tip: 'Отменили до конца триала', sort: (r) => r.in_trial, cell: (r) => `<td>${num(r.in_trial)}</td>` },
  { key: 'after_trial', title: 'After trial', tip: 'Отменили в 30 дней после конца триала', sort: (r) => r.after_trial, cell: (r) => `<td>${num(r.after_trial)}</td>` },
];

// Visa VAMP: «≈» — месяц ещё идёт; без платежей у измерения (риск, тип списания) — продаж и ratio нет
const hasSales = () => !['risk', 'charge_type'].includes(state.view);
const VAMP_COLUMNS = [
  { key: 'vamp_count', title: 'VAMP count', tip: 'Фрод-репорты Visa + чарджбэки без RDR', sort: (p) => p.vamp_count, cell: (p) => pendingCell(num(p.vamp_count), p.final) },
  { key: 'vamp_ratio', title: 'VAMP ratio', tip: 'VAMP count ÷ Visa sales; порог — 1,5%', sort: (p) => p.vamp_ratio, cell: (p) => pendingCell(pct2(p.vamp_ratio), p.final) },
  { key: 'forecast_count', title: 'Forecast', tip: 'VAMP count к концу месяца при нынешнем темпе', sort: (p) => p.forecast_count, cell: (p) => `<td class="muted">${p.forecast_count === null ? '—' : num(p.forecast_count)}</td>` },
  { key: 'fraud', title: 'Fraud reports', tip: 'Фрод-репорты Visa (TC40)', sort: (p) => p.fraud, cell: (p) => `<td>${num(p.fraud)}</td>` },
  { key: 'disputes', title: 'Chargebacks', tip: 'Visa-чарджбэки без RDR (TC15)', sort: (p) => p.disputes, cell: (p) => `<td>${num(p.disputes)}</td>` },
  { key: 'visa_sales', title: 'Visa sales', tip: 'Успешные Visa-списания', sort: (p) => p.visa_sales, cell: (p) => `<td>${hasSales() ? num(p.visa_sales) : '—'}</td>` },
  { key: 'rdr', title: 'RDR', tip: 'Visa-диспуты, закрытые через RDR, — в VAMP не идут', sort: (p) => p.rdr, cell: (p) => `<td title="${usd(p.rdr_lost)} lost">${num(p.rdr)}</td>` },
];
// После фрод-репорта: что стало со списанием
const OUTCOME_NAMES = { chargeback: 'Became a chargeback', rdr: 'Resolved by RDR', refunded: 'Refunded', no_action: 'No action' };
const OUTCOME_TIPS = {
  chargeback: 'Банк всё равно открыл чарджбэк: в VAMP два события вместо одного, плюс сумма и комиссия за диспут',
  rdr: 'Диспут закрыт через RDR: в VAMP не идёт, но деньги списаны',
  refunded: 'Деньги вернули — чарджбэка по этому списанию уже не будет',
  no_action: 'Ни возврата, ни диспута: ещё может стать чарджбэком',
};
const OUTCOME_COLUMNS = [
  { key: 'outcome', title: 'After the fraud report', tip: 'Что стало со списанием после фрод-репорта Visa', text: true, sort: (r) => r.outcome, cell: (r) => `<td data-tip="${esc(OUTCOME_TIPS[r.outcome])}">${OUTCOME_NAMES[r.outcome]}</td>` },
  { key: 'count', title: 'Fraud reports', tip: 'Фрод-репорты Visa за месяц', sort: (r) => r.count, cell: (r) => `<td>${num(r.count)}</td>` },
  { key: 'share', title: 'Share', tip: 'Доля от всех фрод-репортов месяца', sort: (r) => r.share, cell: (r) => shareCell(r.share) },
  {
    key: 'amount',
    title: 'Amount',
    tip: 'Сумма этих списаний в долларах',
    sort: (r) => r.amount,
    cell: (r) => `<td${r.unknown_amount ? ` title="${num(r.unknown_amount)} charges without a known USD amount"` : ''}>${usd(r.amount)}</td>`,
  },
];

const STATUS_COLUMN = { key: 'status', title: 'Status', tip: 'Excessive — оба порога сразу: ratio ≥ 1,5% и count ≥ 1 500', text: true, sort: (p) => p.status, cell: (p) => `<td>${statusBadge(p.status)}</td>` };
const VAMP_SHARE_COLUMN = { key: 'share', title: 'Share', tip: 'Доля в VAMP count месяца', sort: (r) => r.share, cell: (r) => shareCell(r.share) };

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
  const sort = state.sort ?? defaultSort();
  const sorted = sortRows(rows, columns);
  const shown = limit && !state.showAll ? sorted.slice(0, ROW_LIMIT) : sorted;
  table = { columns, rows, link, limit, empty, shown };
  $('thead').innerHTML = `<tr>${columns
    .map((c) => {
      const on = sort?.key === c.key;
      const arrow = on && sort.dir === 'asc' ? '↑' : '↓';
      return `<th class="${on ? 'sorted' : ''}" aria-sort="${on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button class="sort" data-sort="${c.key}"${c.tip ? ` data-tip="${esc(c.tip)}"` : ''}>${c.title}<span class="arrow">${arrow}</span></button></th>`;
    })
    .join('')}<th class="export-cell"></th></tr>`;
  const exportCell = (i) =>
    `<td class="export-cell"><button class="row-export" data-row="${i}" data-tip="Выгрузить записи этой строки списком (CSV)" aria-label="Export rows">${ICONS.download}</button></td>`;
  $('rows').innerHTML =
    shown
      .map((r, i) => `<tr${link ? ` class="link" data-value="${esc(r.value ?? 'none')}"` : ''}>${columns.map((c) => c.cell(r)).join('')}${exportCell(i)}</tr>`)
      .join('') || `<tr><td colspan="${columns.length + 1}" class="muted">${empty}</td></tr>`;
  $('more').hidden = !limit || rows.length <= ROW_LIMIT || state.showAll;
  $('show-all').textContent = `Show all (${num(rows.length)})`;
  fitTable();
}

// Своя прокрутка у таблицы — только если она не помещается по ширине: иначе шапка прилипает к верху экрана (см. .scroll-x)
function fitTable() {
  const wrap = $('thead').closest('.table-wrap');
  wrap.classList.remove('scroll-x');
  wrap.classList.toggle('scroll-x', wrap.querySelector('table').offsetWidth > wrap.clientWidth);
}
window.addEventListener('resize', fitTable);

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
  if (kind() === 'vamp') {
    const month = `${monthName(data.month.from)}${data.month.final ? '' : ', to date'}`;
    if (state.view === 'outcome') {
      renderTable(OUTCOME_COLUMNS, data.outcomes, { empty: 'No Visa fraud reports for this month' });
      const open = data.outcomes.find((r) => r.outcome === 'no_action');
      $('hint').textContent = `${month}. ${open?.count ? `${num(open.count)} fraud reports (${usd(open.amount)}) have neither a refund nor a dispute — they can still become chargebacks` : 'Every fraud report was refunded or disputed'}`;
      return;
    }
    if (isTime) {
      const status = data.series.some((p) => p.status) ? [STATUS_COLUMN] : [];
      const monthColumn = { ...periodColumn('Month'), cell: (p) => `<td>${monthLabel(p)}</td>` }; // VAMP — всегда по месяцам
      renderTable([monthColumn, ...status, ...VAMP_COLUMNS], data.series);
      renderVampChart(data);
    } else {
      // у мерчантов главное — статус (если выборка не сужена фильтрами); у остальных разрезов — доля в count
      const [count, ...rest] = VAMP_COLUMNS;
      const columns = data.breakdown.some((r) => r.status) ? [valueColumn(), STATUS_COLUMN, ...VAMP_COLUMNS] : [valueColumn(), count, VAMP_SHARE_COLUMN, ...rest];
      renderTable(columns, data.breakdown, { link: dimensions().includes(state.view), limit: true, empty: 'No Visa fraud reports or chargebacks for this month' });
      $('hint').textContent = `${month}. Thresholds apply to a whole Visa merchant: ratio ≥ ${pct2(data.thresholds.ratio)} and count ≥ ${num(data.thresholds.count)}`;
    }
    return;
  }
  if (kind() === 'cancellations') {
    if (isTime) {
      renderTable([periodColumn(timeHead('Trial start date')), ...CANCEL_COLUMNS], data.series);
      renderCancelCharts(data);
    } else if (state.view === 'cancel_reason') {
      renderTable(CANCEL_REASON_COLUMNS, data.reasons, { empty: 'No cancellations for this period' });
    } else {
      renderTable([valueColumn(), ...CANCEL_COLUMNS], data.breakdown, breakdown);
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

// Отмены: доли по дням оформления и распределение отмен во время триала по дню от оформления (Day 1 — первые 24 часа)
function renderCancelCharts({ series, by_day: byDay }) {
  const { muted, grid, x, common } = chartBase();
  const percentAxis = { min: 0, grid: { color: grid }, border: { display: false }, ticks: { color: muted, callback: (v) => `${v}%` } };
  charts.cancelRate = new Chart($('cancel-rate-chart'), {
    type: 'line',
    data: {
      labels: chartLabels(series),
      datasets: [
        percentLine(series, 'During trial', 'trial_cancellation_rate', 'final_trial', css('--s-converted')),
        percentLine(series, 'Within 30 days after trial', 'post_trial_cancellation_rate', 'final_after', css('--s-first')),
      ],
    },
    options: { ...common, plugins: { legend: { display: false }, tooltip: chartTooltip(series, (c) => ` ${c.dataset.label}: ${c.raw ?? '—'}%`) }, scales: { x, y: percentAxis } },
  });
  charts.cancelDay = new Chart($('cancel-day-chart'), {
    type: 'bar',
    data: {
      labels: byDay.map((d) => `Day ${d.day + 1}`),
      datasets: [{ label: 'Cancellations', data: byDay.map((d) => +(d.share * 100).toFixed(1)), backgroundColor: css('--s-converted'), borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 48 }],
    },
    options: {
      ...common,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            title: (items) => (byDay[items[0].dataIndex].day === 0 ? 'Day 1 — first 24 hours' : items[0].label),
            label: (c) => ` ${num(byDay[c.dataIndex].count)} cancellations · ${c.raw}%`,
          },
        },
      },
      scales: { x, y: percentAxis },
    },
  });
}

// VAMP: накопленный count по дням месяца — этот и прошлый; порог — только у одного мерчанта (он у каждого свой)
function renderVampChart({ daily, month, thresholds }) {
  const { muted, grid, common } = chartBase();
  const days = Array.from({ length: Math.max(daily.current.length, daily.previous.length) }, (_, i) => i + 1);
  const single = month.status !== null; // один мерчант целиком
  const line = (label, data, color, dash) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.2, borderDash: dash });
  $('vamp-chart-title').textContent = `VAMP count by day, cumulative — ${monthName(daily.month)}`;
  $('vamp-legend-current').textContent = monthName(daily.month);
  $('vamp-legend-previous').textContent = monthName(daily.previous_month);
  $('vamp-legend-threshold').hidden = !single;
  charts.vamp = new Chart($('vamp-chart'), {
    type: 'line',
    data: {
      labels: days,
      datasets: [
        line(monthName(daily.month), daily.current, css('--s-converted')),
        line(monthName(daily.previous_month), daily.previous, css('--muted'), [5, 4]),
        ...(single ? [line('Excessive threshold', days.map(() => thresholds.count), css('--danger'), [2, 3])] : []),
      ],
    },
    options: {
      ...common,
      plugins: {
        legend: { display: false },
        tooltip: { padding: 10, cornerRadius: 8, callbacks: { title: (items) => `Day ${items[0].label}`, label: (c) => ` ${c.dataset.label}: ${num(c.raw)}` } },
      },
      scales: {
        x: { grid: { display: false }, border: { color: grid }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 12 } },
        y: { min: 0, grid: { color: grid }, border: { display: false }, ticks: { color: muted, callback: (v) => num(v) } },
      },
    },
  });
}

// Графики своего экрана — при смене темы перерисовываются: цвета берутся из неё
function renderModeCharts(data) {
  if (kind() === 'cancellations') return renderCancelCharts(data);
  if (kind() === 'vamp') return renderVampChart(data);
  ({ conversion: renderCharts, turnover: renderTurnoverChart, repeat: renderRepeatChart, overview: renderOverviewChart })[kind()](data.series);
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
  const exportButton = event.target.closest('.row-export');
  if (exportButton) return void exportCsv(rowPatch(table.shown[+exportButton.dataset.row]), exportButton);
  const row = event.target.closest('tr.link');
  if (loading || !row || !dimensions().includes(state.view)) return; // строки старой вкладки, пока грузится новая
  state.filters[state.view] = [row.dataset.value];
  state.view = 'time';
  state.sort = null;
  load();
});

// Выгрузка списком (CSV): записи, из которых посчитана цифра, — для текущей выборки или одной строки таблицы
async function exportCsv(patch = {}, button = $('export')) {
  const q = query();
  for (const [key, value] of Object.entries(patch)) {
    q.delete(key);
    q.append(key, value);
  }
  button.disabled = true; // без двойной выгрузки
  try {
    const res = await api(`/api/export?${q}`);
    if (res.status === 401) return location.assign('/login');
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export.csv';
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    const truncated = res.headers.get('x-export-truncated');
    if (truncated) $('status').textContent = `Exported the first ${num(+truncated)} rows — narrow the period or filters to get all of them`;
  } catch (error) {
    $('status').textContent = `Export failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

// Строка таблицы сужает выгрузку: период строки (динамика), причина отказа или значение разреза
function rowPatch(r) {
  if (state.view === 'time') return { period: 'custom', from: r.period, to: r.period_end };
  if (state.view === 'decline_reason' || state.view === 'cancel_reason') return { reason: r.reason };
  if (state.view === 'outcome') return { reason: r.outcome }; // исход после фрод-репорта
  return { [state.view]: r.value ?? 'none' };
}

$('export').addEventListener('click', () => exportCsv());

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
  if (lastData && state.view === 'time') renderModeCharts(lastData);
});

document.addEventListener('mousedown', (event) => {
  if (popover && !popover.el.contains(event.target) && !popover.anchor.contains(event.target)) closePopover();
});
addEventListener('resize', closePopover);

// «Methodology»: вкладки VPN, eSIM и Data sources — тексты в public/*.md, один источник для дашборда и репозитория.
// Открывается на вкладке продукта, который сейчас на экране; вкладка eSIM — только если он подключён
const helpCache = {};
let helpTab = null;
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
  document.querySelector('#help-tabs [data-v="methodology-esim"]').hidden = !products.includes('esim');
  showHelpTab(helpTab === 'data-sources' ? helpTab : `methodology-${product()}`);
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
