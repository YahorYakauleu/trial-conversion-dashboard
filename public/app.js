// Billing Dashboard. Выбор хранится в адресе страницы (ссылкой можно поделиться);
// данные — /api/metrics (конверсия), /api/ltv (деньги от триала), /api/cancellations (отмены), /api/retries (ретраи), /api/vamp (Visa VAMP), /api/turnover (оборот), /api/visits (визиты из сборщика), /api/esim/* (eSIM), значения фильтров — /api/values, выгрузка — /api/export.

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
    dimensions: ['trial_type', 'trial_length', 'account', 'mid', 'country', 'payment_method', 'bank', 'card_brand', 'funding'],
    tabs: [['time', 'Trend'], ['trial_type', 'Trial types'], ['trial_length', 'Trial lengths'], ['account', 'Accounts'], ['mid', 'MID'], ['country', 'Countries'], ['payment_method', 'Payment methods'], ['bank', 'Issuing banks'], ['card_brand', 'Card brands'], ['funding', 'Card types'], ['decline_reason', 'Decline reasons']],
    hints: {
      time: 'Trial-to-paid — paid the first billing period within 30 days after the trial ended',
      trial_type: 'Paid — the customer paid a trial fee at sign-up (e.g. $0.99). Trial-to-paid counts only the first full period after the trial, not the fee. Unknown — not computed yet (a few minutes after a sync)',
      decline_reason: 'Declines — all declined first-payment attempts. Recovery rate — share of trials whose first attempt was declined for this reason that paid within 30 days after the trial ended. Click a reason to see its issuing banks',
    },
  },
  ltv: {
    product: 'vpn',
    kind: 'ltv',
    label: 'LTV',
    tip: 'Сколько денег приносит триал за 30, 60 и 90 дней с оформления и сколько оплативших продлевают',
    title: 'Revenue per trial (LTV)',
    api: '/api/ltv',
    charts: 'ltv-charts',
    dimensions: ['trial_type', 'trial_length', 'account', 'mid', 'country', 'payment_method', 'bank', 'card_brand', 'funding'],
    tabs: [['time', 'Trend'], ['trial_type', 'Trial types'], ['trial_length', 'Trial lengths'], ['account', 'Accounts'], ['mid', 'MID'], ['country', 'Countries'], ['payment_method', 'Payment methods'], ['bank', 'Issuing banks'], ['card_brand', 'Card brands'], ['funding', 'Card types']],
    hints: {
      time: 'All money from the trial’s customer — trial fee, first period, renewals — within 30/60/90 days of the trial start, net of refunds, in USD. Numbers marked ≈ grow until the window closes',
      trial_type: 'Paid — the customer paid a trial fee at sign-up (e.g. $0.99); LTV includes the fee',
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
    dimensions: ['trial_type', 'trial_length', 'account', 'mid', 'country', 'payment_method', 'bank', 'card_brand', 'funding'],
    tabs: [['time', 'Trend'], ['trial_type', 'Trial types'], ['trial_length', 'Trial lengths'], ['account', 'Accounts'], ['mid', 'MID'], ['country', 'Countries'], ['payment_method', 'Payment methods'], ['bank', 'Issuing banks'], ['card_brand', 'Card brands'], ['funding', 'Card types'], ['cancel_reason', 'Cancellation reasons']],
    hints: {
      time: 'Trials by start date: how many were cancelled before the trial ended, and how soon. A cancellation counts when it was requested, even if access lasts until the period end',
      cancel_reason: 'Cancellations during the trial and within 30 days after it. Stripe and Solidgate reasons are grouped — hover a reason for details',
    },
  },
  retries: {
    product: 'vpn',
    kind: 'retries',
    label: 'Retries',
    tip: 'Повторные попытки списать первый платёж после триала: сколько их, когда и после каких отказов они проходят',
    title: 'Payment retries',
    api: '/api/retries',
    charts: 'retry-charts',
    dimensions: ['trial_type', 'trial_length', 'account', 'mid', 'country', 'payment_method', 'bank', 'card_brand', 'funding'],
    tabs: [['time', 'Trend'], ['attempt', 'Attempt number'], ['day', 'Days after decline'], ['decline_code', 'Decline codes'], ['trial_type', 'Trial types'], ['trial_length', 'Trial lengths'], ['account', 'Accounts'], ['mid', 'MID'], ['country', 'Countries'], ['payment_method', 'Payment methods'], ['card_brand', 'Card brands'], ['funding', 'Card types']],
    hints: {
      time: 'Trials by start date whose first payment attempt was declined, and the retries made for them. Retries are scheduled by Stripe Billing and Solidgate, not by our backend',
      attempt: 'How often each attempt succeeds — where retries stop paying off. Recoveries so far: share of all recoveries made by this attempt or earlier',
      day: 'Retries by days since the first (declined) attempt — when recoveries still come',
      decline_code: 'What happened after a decline with this code: was it retried and did the next or any later attempt succeed. «No retry» — the bank or Stripe says retrying will not help',
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
    dimensions: ['merchant', 'mid', 'country', 'payment_method', 'bank', 'funding', 'payment_number', 'reason', 'days_to_report', 'utm_source', 'campaign', 'landing_domain', 'risk'],
    tabs: [
      ['time', 'Trend'], ['merchant', 'Merchants'], ['outcome', 'After report'], ['mid', 'MID'], ['country', 'Countries'], ['payment_method', 'Payment methods'],
      ['bank', 'Issuing banks'], ['funding', 'Card types'], ['payment_number', 'Payment number'], ['reason', 'Reasons'], ['days_to_report', 'Days to report'],
      ['utm_source', 'Traffic sources'], ['campaign', 'Campaigns'], ['landing_domain', 'Landing domains'], ['risk', 'Radar risk'],
    ],
    hints: {
      time: "A report counts in the month it reached Stripe or Solidgate (UTC); Visa dates it by when the bank reported it, so around month boundaries counts can differ by 10–15%. Visa's official figures come next month: Stripe → VAMP → Visa data",
      bank: 'Issuing bank of the charged card. × avg — how many times the ratio is above the whole selection; highlighted from 2× with at least 10 events',
      funding: 'Debit, credit or prepaid card. × avg — how many times the ratio is above the whole selection',
      payment_number: 'Which payment of the subscription was reported. Subscriptions started before the dashboard history (July 1) are counted together',
      reason: 'Fraud type of the report or reason of the chargeback. No Visa sales here — share only',
      days_to_report: 'Days from the charge to the report or chargeback. No Visa sales here — share only',
      utm_source: 'Where the Stripe customer came from (customer metadata). Solidgate has no traffic data — Unknown',
      campaign: 'Campaign of the Stripe customer, by campaign ID. Solidgate has no traffic data — Unknown',
      landing_domain: 'Landing domain of the Stripe customer. Solidgate has no traffic data — Unknown',
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
  visits: {
    product: 'vpn',
    kind: 'visits',
    label: 'Visits',
    tip: 'Уникальные визиты на пейволл: браузер считается один раз, когда впервые увидел пейволл',
    title: 'Paywall visits',
    api: '/api/visits',
    charts: 'visits-charts',
    dimensions: ['site', 'device', 'os', 'browser'],
    tabs: [['time', 'Trend'], ['site', 'Domains'], ['device', 'Devices'], ['os', 'OS'], ['browser', 'Browsers']],
    hints: {
      time: 'Unique visits — browsers that saw the paywall for the first time, by day (New York)',
    },
    collector: true, // экран есть, только если подключён сборщик визитов
    noExport: true, // сборщик хранит только счётчики — выгружать списком нечего
  },
  esim_overview: {
    product: 'esim',
    kind: 'overview',
    label: 'Overview',
    tip: 'Что случилось за день: заказы, деньги, новые клиенты и неоплаченные заказы',
    title: 'eSIM · Overview',
    api: '/api/esim/overview',
    charts: 'overview-charts',
    dimensions: ['destination', 'package', 'country', 'payment_method', 'bank', 'card_brand'],
    tabs: [['time', 'Trend'], ['destination', 'Destinations'], ['package', 'Packages'], ['country', 'Countries'], ['payment_method', 'Payment methods'], ['bank', 'Issuing banks'], ['decline_reason', 'Decline reasons']],
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
    dimensions: ['destination', 'package', 'country', 'payment_method', 'bank', 'card_brand'],
    tabs: [['time', 'Trend'], ['destination', 'Destinations'], ['package', 'Packages'], ['country', 'Countries'], ['payment_method', 'Payment methods'], ['bank', 'Issuing banks']],
    hints: {
      time: "Each row is the day of the customer's first purchase. Numbers marked ≈ keep growing until 14, 30 or 60 days have passed",
      _breakdown: 'Customers are split by their first purchase. Click a row to see its trend, or a column header to sort',
    },
  },
};
const PRODUCT_NAMES = { vpn: 'VPN', esim: 'eSIM' };
const DIMENSION_TITLES = {
  account: 'Account', mid: 'MID', country: 'Country', payment_method: 'Payment method', bank: 'Issuing bank', card_brand: 'Card brand',
  destination: 'Destination', package: 'Package', risk: 'Radar risk score', merchant: 'Visa merchant', funding: 'Card type',
  trial_type: 'Trial type', trial_length: 'Trial length', site: 'Domain', device: 'Device', os: 'OS', browser: 'Browser',
  payment_number: 'Payment number', reason: 'Reason', days_to_report: 'Days to report', utm_source: 'Traffic source', campaign: 'Campaign', landing_domain: 'Landing domain',
};
// Интерфейс — на английском, с общепринятыми названиями метрик; при наведении — короткое пояснение по-русски (data-tip)
const TAB_TIPS = {
  time: 'Динамика по дням, неделям или месяцам',
  account: 'Аккаунт провайдера: у Stripe — юрлицо, у Solidgate — канал',
  mid: 'Мерчант-аккаунт, через который прошёл платёж',
  country: 'Страна выпуска карты',
  payment_method: 'Карта, Apple Pay, Google Pay и т. д.',
  bank: 'Банк-эмитент карты',
  card_brand: 'Платёжная система карты: Visa, Mastercard…',
  funding: 'Тип карты: дебетовая, кредитная, предоплаченная',
  trial_type: 'Бесплатный триал или платный — с платой при оформлении (например, $0.99)',
  trial_length: 'Длина триала в днях',
  decline_reason: 'Почему отклонили попытки списания',
  cancel_reason: 'Почему отменили подписку',
  risk: 'Radar risk score списания — только у Stripe',
  merchant: 'Мерчант Visa: аккаунты Stripe одного бизнеса Visa считает вместе — пороги у мерчанта целиком',
  outcome: 'Что стало со списанием после фрод-репорта: чарджбэк, RDR, вернули деньги или ничего',
  attempt: 'Отдача от попытки по её номеру',
  day: 'Повторы по дням после первой попытки',
  decline_code: 'Что было после отказа с этим кодом',
  payment_number: 'Каким по счёту платежом подписки было списание: оплата триала, 1-й после триала, 2-й…',
  reason: 'Тип фрода у фрод-репорта, причина у чарджбэка',
  days_to_report: 'Сколько дней прошло от списания до фрод-репорта или чарджбэка',
  utm_source: 'Источник трафика клиента Stripe (utm_source в metadata клиента)',
  campaign: 'Кампания клиента Stripe — по campaign_id, подписана campaign_name',
  landing_domain: 'Домен лендинга, с которого пришёл клиент Stripe',
  site: 'Домен лендинга',
  device: 'Телефон, планшет или компьютер — по User-Agent',
  os: 'Операционная система — по User-Agent',
  browser: 'Браузер по User-Agent. Встроенные браузеры Facebook, Instagram, TikTok, Snapchat — отдельно: там иначе работают Apple Pay и Google Pay',
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
  eyeOff: svg('<path d="M9.9 9.9a3 3 0 1 0 4.2 4.2"/><path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13 13 0 0 1-1.7 2.7"/><path d="M6.6 6.6A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="m2 2 20 20"/>'),
  marker: svg('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
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
  // Conversion → Decline reasons: открытая причина — её банки (строка таблицы причин)
  drill: initialMode === 'conversion' && params.get('view') === 'decline_reason' ? params.get('reason') || null : null,
};
const product = () => MODES[state.mode].product;
const kind = () => MODES[state.mode].kind;
const isTurnover = () => kind() === 'turnover';
let products = ['vpn']; // из ответа сервера: eSIM — если подключён его Stripe-аккаунт
let collectorConnected = false; // из ответа сервера: экран Visits — если подключён сборщик визитов
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
  // кампания — по ID; имя приходит с данными (разбивка, значения фильтра)
  if (dimension === 'campaign' && value && value !== 'none') return campaignNames.has(value) ? [campaignNames.get(value), value] : [value, null];
  return [valueName(dimension, value), null];
}
const campaignNames = new Map();
const rememberCampaigns = (rows) => rows?.forEach((r) => r.label && campaignNames.set(r.value, r.label));

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
  if (dimension === 'funding') return value[0].toUpperCase() + value.slice(1);
  if (dimension === 'trial_type') return value === 'paid' ? 'Paid' : 'Free';
  if (dimension === 'trial_length') return `${value} ${value === '1' ? 'day' : 'days'}`;
  if (dimension === 'payment_number') return PAYMENT_NUMBERS[value] ?? value;
  if (dimension === 'reason') {
    const [kind, code] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)];
    return `${kind === 'fraud' ? 'Fraud report' : 'Chargeback'} · ${REASON_NAMES[code] ?? code.replaceAll('_', ' ')}`;
  }
  if (dimension === 'days_to_report') return `${value} days`;
  if (dimension === 'utm_source' || dimension === 'device') return value[0].toUpperCase() + value.slice(1);
  if (dimension === 'os') return OS_NAMES[value] ?? value;
  if (dimension === 'browser') return BROWSER_NAMES[value] ?? value;
  return value;
}
const OS_NAMES = { ios: 'iOS', android: 'Android', windows: 'Windows', macos: 'macOS', linux: 'Linux', other: 'Other' };
const BROWSER_NAMES = {
  safari: 'Safari', chrome: 'Chrome', samsung: 'Samsung Internet', edge: 'Edge', opera: 'Opera', yandex: 'Yandex Browser', firefox: 'Firefox',
  facebook: 'Facebook (in-app)', instagram: 'Instagram (in-app)', tiktok: 'TikTok (in-app)', snapchat: 'Snapchat (in-app)', webview: 'Other in-app (WebView)', other: 'Other',
};
const PAYMENT_NUMBERS = {
  trial_fee: 'Trial fee', 1: '1st after trial', 2: '2nd', 3: '3rd', 4: '4th', '5+': '5th and later', before_history: 'Subscription older than history',
};
// типы фрода (Stripe early fraud warning) и причины диспутов Stripe; у Solidgate — описание кода как есть
const REASON_NAMES = {
  unauthorized_use_of_card: 'Unauthorized use of card', made_with_counterfeit_card: 'Counterfeit card', made_with_lost_card: 'Lost card',
  made_with_stolen_card: 'Stolen card', card_never_received: 'Card never received', fraudulent_card_application: 'Fraudulent card application', misc: 'Other',
  fraudulent: 'Fraudulent', subscription_canceled: 'Subscription canceled', product_unacceptable: 'Product unacceptable', credit_not_processed: 'Credit not processed',
  product_not_received: 'Product not received', general: 'General', unrecognized: 'Unrecognized', duplicate: 'Duplicate',
};

function query() {
  const q = new URLSearchParams({ mode: state.mode, product: product(), provider: state.provider, granularity: state.granularity, view: state.view, period: state.preset });
  if (state.preset === 'custom') {
    q.set('from', state.from);
    q.set('to', state.to);
  }
  for (const [dimension, values] of Object.entries(state.filters)) for (const value of values) q.append(dimension, value);
  if (state.drill) q.set('reason', state.drill);
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
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
    lastData = await res.json();
    if (seq !== loadSeq) return;
    render(lastData);
    if (lastData.sync_running) pollTimer = setTimeout(() => load('silent'), 10_000);
  } catch (error) {
    if (seq !== loadSeq) return;
    $('status').textContent = `Failed to load data: ${error.message}`;
    if (kind !== 'silent') showFailed();
  } finally {
    clearTimeout(loader);
    if (seq === loadSeq) {
      loading = false;
      document.body.classList.remove('is-loading', 'is-loading-data');
    }
  }
}

// Экран не загрузился (например, недоступен сборщик визитов): его заголовок и пустая таблица, а не цифры прошлого экрана
function showFailed() {
  $('title').textContent = MODES[state.mode].title;
  document.title = `${MODES[state.mode].title} · Billing Dashboard`;
  $('subtitle').textContent = '';
  renderFilters();
  $('kpis').innerHTML = '';
  table = null;
  $('thead').innerHTML = '';
  $('rows').innerHTML = '<tr><td class="muted">No data — see the error above</td></tr>';
  $('more').hidden = true;
  showCharts(false);
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
    .filter(([v, m]) => m.product === product() && (!m.collector || collectorConnected || v === state.mode))
    .map(([v, m]) => `<button data-v="${v}" class="${v === state.mode ? 'on' : ''}" data-tip="${m.tip}">${m.label}</button>`)
    .join('');
  $('provider-group').hidden = product() !== 'vpn' || kind() === 'visits'; // у визитов провайдера нет
  $('export').hidden = Boolean(MODES[state.mode].noExport);
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
    .then((body) => (rememberCampaigns(body.values), body.values))
    .catch(() => {
      valuesCache.delete(key); // не получилось — спросим снова при следующем открытии
      return [];
    });
  valuesCache.set(key, { version, values });
  return values;
}

function render(data) {
  products = data.products ?? ['vpn'];
  collectorConnected = Boolean(data.visits);
  renderSidebar(data);
  renderHeader(data);
  if (kind() === 'turnover') renderTurnoverKpis(data.totals, data.range);
  else if (kind() === 'visits') renderVisitsKpis(data.totals, data.range);
  else if (kind() === 'repeat') renderRepeatKpis(data);
  else if (kind() === 'overview') renderOverviewKpis(data);
  else if (kind() === 'cancellations') renderCancelKpis(data);
  else if (kind() === 'retries') renderRetryKpis(data);
  else if (kind() === 'ltv') renderLtvKpis(data);
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
  renderFilters();
  $('role').textContent = data.role === 'admin' ? 'Admin' : 'Guest';
}

function renderFilters() {
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
      : kind() === 'visits'
      ? `Day boundaries: ${zone(data.time_zone)} · from the paywall visit collector · not linked to trials`
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

function renderVisitsKpis(t, range) {
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / DAY_MS) + 1;
  kpiCards([
    ['Unique visits', num(t.visits), `${fullDay(range.from)} — ${fullDay(range.to)}`, 'Браузеры, впервые увидевшие пейволл: повторные заходы и перезагрузки не считаются'],
    ['Avg. per day', num(Math.round(t.visits / days)), `over ${num(days)} ${days === 1 ? 'day' : 'days'}`, 'Уникальные визиты за период ÷ число дней'],
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

// LTV: деньги от триала; «≈» — окно (30/60/90 дней с оформления) у самых свежих триалов ещё не закрылось
const approxUsd = (cents, final) => (cents === null ? '—' : `${final ? '' : '≈ '}${usdAverage(cents)}`);

function renderLtvKpis({ totals: t }) {
  kpiCards([
    ['Trials started', num(t.started), `${pct(t.trial_to_paid)} trial-to-paid`, 'Сколько триалов оформлено и какая доля оплатила первый период'],
    ['Revenue per trial, 30 days', approxUsd(t.ltv_30_per_trial, t.final_30), 'net of refunds', 'Деньги от триала за 30 дней с оформления: оплата триала, первый период, продления — за вычетом рефандов'],
    ['Revenue per trial, 90 days', approxUsd(t.ltv_90_per_trial, t.final_90), 'net of refunds', 'То же за 90 дней'],
    ['Avg. first payment', usdAverage(t.avg_first_payment), 'price of the 1st period, USD', 'Средняя сумма первого платежа после триала — цена первого периода в долларах. Ниже там, где региональные цены ниже'],
    ['Revenue per payer, 90 days', approxUsd(t.ltv_90_per_paid, t.final_90), 'per customer who paid the 1st period', 'Деньги за 90 дней на одного оплатившего первый период'],
    ['2nd period paid', approxPct(t.renewal_2, t.final_90), `${num(t.renewed_2)} of ${num(t.paid_1)} who paid the 1st`, 'Доля оплативших первый период, кто оплатил и второй — за 90 дней с оформления'],
  ]);
}

// Ретраи: первый платёж после триала; «≈» — у когорт, где окно ретраев ещё не закрылось
function renderRetryKpis({ totals: t }) {
  kpiCards([
    ['First attempt declined', num(t.first_declined), 'trials sent to retries', 'Триалы, у которых первая попытка списания отклонена — их и повторяют'],
    ['Recovery rate', approxPct(t.recovery_rate, t.final), `${num(t.recovered)} of ${num(t.first_declined)}`, 'Доля таких триалов, оплативших на повторе в течение 30 дней после конца триала'],
    ['Retries', num(t.retries), `${pct(t.retry_success)} succeeded`, 'Повторные попытки списания и доля прошедших'],
    ['Retries per recovery', decimal(t.retries_per_recovery), 'retries spent per recovered trial', 'Сколько повторов уходит на одно восстановление'],
    ['After a no-retry decline', num(t.no_retry_retries), `${pct(t.no_retry_share)} of retries · ${num(t.no_retry_recovered)} succeeded`, 'Повторы после отказа «не повторять»: карта украдена или закрыта, банк отозвал разрешение, Stripe сам блокирует повтор. Почти никогда не проходят'],
  ]);
}

// Окончательность у eSIM своя: у повторных покупок — окна 14, 30 и 60 дней с первой покупки
const approxPct = (r, final) => `${final || r === null ? '' : '≈ '}${pct(r)}`;

function renderRepeatKpis({ totals: t, range }) {
  kpiCards([
    ['New customers', num(t.customers), `${fullDay(range.from)} — ${fullDay(range.to)}`, 'Клиенты, впервые купившие eSIM в эти дни'],
    ['Returned within 30 days', approxPct(t.repeat_rate_30, t.final_30), `${num(t.repeat_30)} of ${num(t.customers)}`, 'Доля клиентов, купивших снова — пополнение или новый пакет — в течение 30 дней после первой покупки'],
    ['Revenue per customer, 14 days', `${t.final_14 ? '' : '≈ '}${usdAverage(t.revenue_per_customer_14)}`, 'net of refunds', 'Сколько клиент принёс за 14 дней с первой покупки — включая её, за вычетом рефандов'],
    ['Revenue per customer, 30 days', `${t.final_30 ? '' : '≈ '}${usdAverage(t.revenue_per_customer_30)}`, 'net of refunds', 'Сколько клиент принёс за 30 дней с первой покупки — включая её, за вычетом рефандов'],
    ['Revenue per customer, 60 days', `${t.final_60 ? '' : '≈ '}${usdAverage(t.revenue_per_customer_60)}`, 'net of refunds', 'Сколько клиент принёс за 60 дней с первой покупки — включая её, за вычетом рефандов'],
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
// Визиты на пейволл из сборщика — на тренде Conversion. Visit → Trial — оценка: в триалах есть и подписки мимо пейволла
const VISITS_COLUMN = {
  key: 'visits',
  title: 'Visits',
  tip: 'Уникальные визиты на пейволл в эти дни — из сборщика визитов. «—» — визитов ещё не собирали',
  sort: (p) => p.visits ?? null,
  cell: (p) => `<td>${p.visits === null || p.visits === undefined ? '—' : num(p.visits)}</td>`,
};
const VISIT_TO_TRIAL_COLUMN = {
  key: 'visit_to_trial',
  title: 'Visit → Trial',
  tip: 'Триалы ÷ уникальные визиты. Оценка, завышенная: в триалах есть и подписки мимо пейволла (Funnelfox), а визит и триал одного человека бывают в разные дни — по неделям и месяцам ровнее',
  sort: (p) => p.visit_to_trial ?? null,
  cell: (p) => `<td>${pct(p.visit_to_trial)}</td>`,
};
const TURNOVER_COLUMNS = [
  { key: 'gross', title: 'Gross volume', tip: 'Сумма успешных списаний', sort: (p) => p.gross, cell: (p) => `<td>${usd(p.gross)}</td>` },
  { key: 'payments', title: 'Payments', tip: 'Число успешных списаний', sort: (p) => p.payments, cell: (p) => `<td>${num(p.payments)}</td>` },
  { key: 'average', title: 'Avg. transaction', tip: 'Средний чек: оборот ÷ число платежей', sort: (p) => p.average, cell: (p) => `<td>${usdAverage(p.average)}</td>` },
  { key: 'refunded', title: 'Refunds', tip: 'Сколько денег вернули клиентам', sort: (p) => p.refunded, cell: (p) => `<td>${usd(p.refunded)}</td>` },
  { key: 'net', title: 'Net volume', tip: 'Оборот за вычетом рефандов', sort: (p) => p.net, cell: (p) => `<td>${usd(p.net)}</td>` },
];
const VISIT_COLUMNS = [
  { key: 'visits', title: 'Unique visits', tip: 'Браузеры, впервые увидевшие пейволл', sort: (p) => p.visits, cell: (p) => `<td>${num(p.visits)}</td>` },
];
const VISIT_SHARE_COLUMN = { key: 'share', title: 'Share of visits', tip: 'Доля в уникальных визитах за период', sort: (r) => r.share, cell: (r) => shareCell(r.share) };
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
// LTV: колонки динамики и разрезов
const usdCell = (cents, final) => pendingCell(cents === null ? '—' : usdAverage(cents), final);
const LTV_COLUMNS = [
  { key: 'started', title: 'Trials', tip: 'Оформлено триалов', sort: (p) => p.started, cell: (p) => `<td>${num(p.started)}</td>` },
  { key: 'trial_to_paid', title: 'Trial-to-paid', tip: 'Оплатили первый платный период', sort: (p) => p.trial_to_paid, cell: (p) => rateCell(p.trial_to_paid, p.paid) },
  { key: 'ltv_30_per_trial', title: 'Revenue / trial, 30d', tip: 'Деньги на один триал за 30 дней с оформления', sort: (p) => p.ltv_30_per_trial, cell: (p) => usdCell(p.ltv_30_per_trial, p.final_30) },
  { key: 'ltv_60_per_trial', title: 'Revenue / trial, 60d', tip: 'Деньги на один триал за 60 дней', sort: (p) => p.ltv_60_per_trial, cell: (p) => usdCell(p.ltv_60_per_trial, p.final_60) },
  { key: 'ltv_90_per_trial', title: 'Revenue / trial, 90d', tip: 'Деньги на один триал за 90 дней', sort: (p) => p.ltv_90_per_trial, cell: (p) => usdCell(p.ltv_90_per_trial, p.final_90) },
  { key: 'avg_first_payment', title: 'Avg. first payment', tip: 'Средняя цена первого периода в долларах — по первому платежу после триала', sort: (p) => p.avg_first_payment, cell: (p) => `<td>${usdAverage(p.avg_first_payment)}</td>` },
  { key: 'ltv_90_per_paid', title: 'Revenue / paying, 90d', tip: 'Деньги за 90 дней на одного оплатившего', sort: (p) => p.ltv_90_per_paid, cell: (p) => usdCell(p.ltv_90_per_paid, p.final_90) },
  { key: 'renewal_2', title: '2nd period', tip: 'Оплатили и второй период — доля оплативших первый', sort: (p) => p.renewal_2, cell: (p) => rateCell(p.renewal_2, p.renewed_2, p.final_90, `${num(p.renewed_2)} of ${num(p.paid_1)}`) },
  { key: 'renewal_3', title: '3rd period', tip: 'Оплатили три периода и больше — доля оплативших первый', sort: (p) => p.renewal_3, cell: (p) => rateCell(p.renewal_3, p.renewed_3, p.final_90, `${num(p.renewed_3)} of ${num(p.paid_1)}`) },
];

// Ретраи: колонки динамики и разрезов, отдача по номеру попытки, по дням, по кодам отказа
const RETRY_COLUMNS = [
  { key: 'first_declined', title: 'First declined', tip: 'Триалы с отклонённой первой попыткой', sort: (p) => p.first_declined, cell: (p) => `<td>${num(p.first_declined)}</td>` },
  { key: 'retries', title: 'Retries', tip: 'Повторные попытки', sort: (p) => p.retries, cell: (p) => `<td>${num(p.retries)}</td>` },
  { key: 'recovery_rate', title: 'Recovery rate', tip: 'Оплатили на повторе в течение 30 дней после конца триала', sort: (p) => p.recovery_rate, cell: (p) => rateCell(p.recovery_rate, p.recovered, p.final) },
  { key: 'retry_success', title: 'Retry success', tip: 'Доля повторов, которые прошли', sort: (p) => p.retry_success, cell: (p) => pendingCell(pct(p.retry_success), p.final) },
  { key: 'retries_per_recovery', title: 'Retries per recovery', tip: 'Повторов на одно восстановление', sort: (p) => p.retries_per_recovery, cell: (p) => pendingCell(decimal(p.retries_per_recovery), p.final) },
  {
    key: 'no_retry_retries',
    title: 'After no-retry decline',
    tip: 'Повторы после отказа «не повторять» и их доля среди всех повторов',
    sort: (p) => p.no_retry_retries,
    cell: (p) => (p.retries ? `<td title="${num(p.no_retry_recovered)} succeeded">${pct(p.no_retry_share)}<span class="n">${num(p.no_retry_retries)}</span></td>` : '<td>—</td>'),
  },
];
const ordinal = (n) => (n === 1 ? 'First attempt' : n >= 10 ? 'Attempt 10+' : `Attempt ${n}`);
const CURVE_COLUMNS = [
  { key: 'attempt', title: 'Attempt', tip: 'Номер попытки: первая — списание в конце триала, дальше — повторы', sort: (r) => r.attempt, cell: (r) => `<td>${ordinal(r.attempt)}</td>` },
  { key: 'attempts', title: 'Attempts', tip: 'Попыток с этим номером', sort: (r) => r.attempts, cell: (r) => `<td>${num(r.attempts)}</td>` },
  { key: 'approved', title: 'Succeeded', tip: 'Из них прошли', sort: (r) => r.approved, cell: (r) => `<td>${num(r.approved)}</td>` },
  { key: 'approval_rate', title: 'Approval rate', tip: 'Доля прошедших среди попыток с этим номером', sort: (r) => r.approval_rate, cell: (r) => `<td>${pct(r.approval_rate)}</td>` },
  { key: 'recovered_share', title: 'Recoveries so far', tip: 'Доля всех восстановлений, сделанных этой попыткой или раньше', sort: (r) => r.recovered_share, cell: (r) => (r.recovered_share === null ? '<td>—</td>' : shareCell(r.recovered_share)) },
];
const DAY_COLUMNS = [
  { key: 'day', title: 'Days after first attempt', tip: 'Сколько суток прошло от первой попытки', sort: (r) => r.day, cell: (r) => `<td>${r.day >= 31 ? '31+' : `Day ${r.day}`}</td>` },
  { key: 'retries', title: 'Retries', tip: 'Повторов в этот день', sort: (r) => r.retries, cell: (r) => `<td>${num(r.retries)}</td>` },
  { key: 'approved', title: 'Succeeded', tip: 'Из них прошли', sort: (r) => r.approved, cell: (r) => `<td>${num(r.approved)}</td>` },
  { key: 'approval_rate', title: 'Approval rate', tip: 'Доля прошедших', sort: (r) => r.approval_rate, cell: (r) => `<td>${pct(r.approval_rate)}</td>` },
];
const CODE_COLUMNS = [
  {
    key: 'code',
    title: 'Decline code',
    tip: 'Код отказа провайдера; ниже — общая группа',
    text: true,
    sort: (r) => r.code,
    cell: (r) =>
      `<td data-tip="${esc(r.hint)}">${esc(r.code ?? 'Unknown')}${r.no_retry ? ' <span class="badge excessive">No retry</span>' : ''}<span class="value-id">${esc(r.group)}</span></td>`,
  },
  { key: 'declines', title: 'Declines', tip: 'Отказов с этим кодом', sort: (r) => r.declines, cell: (r) => `<td>${num(r.declines)}</td>` },
  { key: 'retried_share', title: 'Retried', tip: 'Доля отказов, после которых была ещё попытка', sort: (r) => r.retried_share, cell: (r) => rateCell(r.retried_share, r.retried) },
  { key: 'next_approval', title: 'Next attempt succeeded', tip: 'Прошла ли следующая попытка', sort: (r) => r.next_approval, cell: (r) => rateCell(r.next_approval, r.next_approved) },
  { key: 'later_approval', title: 'Any later attempt succeeded', tip: 'Прошла ли хоть одна из дальнейших попыток', sort: (r) => r.later_approval, cell: (r) => rateCell(r.later_approval, r.approved_later) },
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

// Visa VAMP: «≈» — месяц ещё идёт; у измерений без продаж (причина, дни до события, риск) и при фильтре по ним —
// продаж и ratio нет
const EVENT_ONLY = ['risk', 'reason', 'days_to_report'];
const hasSales = () => !EVENT_ONLY.includes(state.view) && !EVENT_ONLY.some((d) => state.filters[d]?.length);
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
const VAMP_LIFT_COLUMN = {
  key: 'lift',
  title: '× avg',
  tip: 'Во сколько раз ratio строки выше ratio всей выборки. Подсвечено — от 2× и хотя бы 10 событий',
  sort: (r) => r.lift,
  cell: (r) => `<td${r.anomaly ? ' class="lift-high"' : ''}>${r.lift === null ? '—' : `${r.lift.toFixed(1)}×`}</td>`,
};

// eSIM, удержание: когорты клиентов по дню первой покупки; «≈» — пока не прошли 14, 30 или 60 дней.
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
    key: 'revenue_per_customer_14',
    title: 'Revenue per customer, 14 days',
    tip: 'Сколько клиент принёс за 14 дней с первой покупки — включая её, за вычетом рефандов',
    sort: (p) => p.revenue_per_customer_14,
    cell: (p) => pendingCell(usdAverage(p.revenue_per_customer_14), p.final_14, '', windowTip(p, 14)),
  },
  {
    key: 'revenue_per_customer_30',
    title: 'Revenue per customer, 30 days',
    tip: 'Сколько клиент принёс за 30 дней с первой покупки — включая её, за вычетом рефандов',
    sort: (p) => p.revenue_per_customer_30,
    cell: (p) => pendingCell(usdAverage(p.revenue_per_customer_30), p.final_30, '', windowTip(p, 30)),
  },
  {
    key: 'revenue_per_customer_60',
    title: 'Revenue per customer, 60 days',
    tip: 'Сколько клиент принёс за 60 дней с первой покупки — включая её, за вычетом рефандов',
    sort: (p) => p.revenue_per_customer_60,
    cell: (p) => pendingCell(usdAverage(p.revenue_per_customer_60), p.final_60, '', windowTip(p, 60)),
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
  {
    key: 'lost_revenue',
    title: 'Lost revenue',
    tip: 'Сумма заказов настоящих покупателей, которые не удалось оплатить; рядом — сколько таких заказов',
    sort: (p) => p.lost_revenue,
    // неоплаченные — без отсечённых антифродом, как в карточке
    cell: (p) => `<td>${usdAverage(p.lost_revenue)}<span class="n">${num(p.orders - p.paid_orders - p.fraud_blocked)}</span></td>`,
  },
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

// Скрытые колонки — по экранам, в этом браузере. Нет доступа к хранилищу (приватный режим) — помним до перезагрузки
const HIDDEN_KEY = 'hidden-columns';
const hiddenColumns = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
})();
const hiddenSet = () => new Set(hiddenColumns[state.mode] ?? []);
function saveHidden(keys) {
  if (keys.length) hiddenColumns[state.mode] = keys;
  else delete hiddenColumns[state.mode];
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(hiddenColumns));
  } catch {}
}

// Выделение для фокуса: закреплённые колонки (по ключу) и строки (по периоду или значению) живут, пока открыт этот экран и вкладка
const pins = { scope: '', columns: new Set(), rows: new Set() };
const rowKey = (r) => String(r.period ?? r.value ?? r.reason ?? r.code ?? r.outcome ?? r.attempt ?? r.day ?? '');
let hoverColumn = 0; // номер колонки под курсором (с 1), 0 — нет

function renderTable(columns, rows, { link = false, limit = false, empty = 'No data for this period' } = {}) {
  const sort = state.sort ?? defaultSort();
  const sorted = sortRows(rows, columns);
  const shown = limit && !state.showAll ? sorted.slice(0, ROW_LIMIT) : sorted;
  const hidden = hiddenSet();
  // первая колонка — дата или значение разреза — не скрывается
  const visible = columns.filter((c, i) => i === 0 || !hidden.has(c.key));
  const scope = `${state.mode}|${state.view}|${state.drill ?? ''}`;
  if (pins.scope !== scope) Object.assign(pins, { scope, columns: new Set(), rows: new Set() });
  table = { columns, rows, link, limit, empty, shown, visible };
  const canExport = !MODES[state.mode].noExport;
  const tools = (c) =>
    `<span class="col-tools"><button class="col-tool${pins.columns.has(c.key) ? ' on' : ''}" data-mark-col="${c.key}" data-tip="Выделить колонку" aria-label="Highlight column">${ICONS.marker}</button><button class="col-tool" data-hide-col="${c.key}" data-tip="Скрыть колонку — вернуть можно в Columns" aria-label="Hide column">${ICONS.eyeOff}</button></span>`;
  $('thead').innerHTML = `<tr>${visible
    .map((c, i) => {
      const on = sort?.key === c.key;
      const arrow = on && sort.dir === 'asc' ? '↑' : '↓';
      return `<th class="${on ? 'sorted' : ''}" aria-sort="${on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${i ? tools(c) : ''}<button class="sort" data-sort="${c.key}"${c.tip ? ` data-tip="${esc(c.tip)}"` : ''}>${c.title}<span class="arrow">${arrow}</span></button></th>`;
    })
    .join('')}${canExport ? '<th class="export-cell"></th>' : ''}</tr>`;
  const exportCell = (i) =>
    canExport
      ? `<td class="export-cell"><button class="row-export" data-row="${i}" data-tip="Выгрузить записи этой строки списком (CSV)" aria-label="Export rows">${ICONS.download}</button></td>`
      : '';
  // маркер выделения строки — в начале первой ячейки, виден при наведении
  const rowMark = (i) => `<button class="row-mark" data-mark-row="${i}" data-tip="Выделить строку" aria-label="Highlight row">${ICONS.marker}</button>`;
  $('rows').innerHTML =
    shown
      .map((r, i) => {
        const cls = [link && 'link', r.anomaly && 'anomaly', pins.rows.has(rowKey(r)) && 'hl'].filter(Boolean).join(' '); // anomaly — строка VAMP с ratio заметно выше среднего
        const cells = visible.map((c, j) => (j ? c.cell(r) : c.cell(r).replace(/^<td([^>]*)>/, `<td$1>${rowMark(i)}`))).join('');
        return `<tr${cls ? ` class="${cls}"` : ''}${link ? ` data-value="${esc(r.value ?? 'none')}"` : ''}>${cells}${exportCell(i)}</tr>`;
      })
      .join('') || `<tr><td colspan="${visible.length + Number(canExport)}" class="muted">${empty}</td></tr>`;
  $('more').hidden = !limit || rows.length <= ROW_LIMIT || state.showAll;
  $('show-all').textContent = `Show all (${num(rows.length)})`;
  const hiddenCount = columns.length - visible.length;
  $('columns').querySelector('span').textContent = hiddenCount ? `Columns · ${hiddenCount} hidden` : 'Columns';
  $('columns').classList.toggle('active', hiddenCount > 0);
  buildFloatHead();
  paintHighlights();
}

// Подсветка колонок — одним правилом CSS на колонку (по номеру среди видимых), а не классами на тысячах ячеек
function paintHighlights() {
  const cells = (n) => `.table-wrap tr > :nth-child(${n})::before, .float-head tr > :nth-child(${n})::before`;
  const layer = (n, color) => `${cells(n)} { content: ''; position: absolute; inset: 0; pointer-events: none; background: ${color}; }`;
  const rules = [];
  if (hoverColumn) rules.push(layer(hoverColumn, 'var(--hl-hover)'));
  for (const key of pins.columns) {
    const n = (table?.visible ?? []).findIndex((c) => c.key === key) + 1;
    if (n) rules.push(layer(n, 'var(--hl)'));
  }
  $('highlight-style').textContent = rules.join('\n');
  $('clear-highlights').hidden = !pins.columns.size && !pins.rows.size;
}

function hideColumn(key) {
  saveHidden([...hiddenSet(), key]);
  pins.columns.delete(key);
  renderTable(table.columns, table.rows, table);
}

function toggleColumnPin(key) {
  if (pins.columns.has(key)) pins.columns.delete(key);
  else pins.columns.add(key);
  renderTable(table.columns, table.rows, table);
}

// Шапка таблицы при прокрутке страницы. У таблицы своя прокрутка вбок, а с ней CSS sticky не работает, поэтому —
// копия шапки, закреплённая у верха экрана, пока настоящая за его краем, а таблица ещё видна.
// Колонки — той же ширины, что у настоящей, сдвиг вбок — вместе с таблицей
const floatHead = $('float-head');
const tableWrap = $('thead').closest('.table-wrap');
// Полосы прокрутки вбок над таблицей и под копией шапки — двигаются вместе с таблицей
const scrollers = [tableWrap, $('x-scroll'), floatHead.querySelector('.x-scroll')];

function placeFloatHead() {
  const { top, bottom, left } = tableWrap.getBoundingClientRect();
  floatHead.hidden = !(top < 0 && bottom > $('thead').offsetHeight);
  if (floatHead.hidden) return;
  floatHead.style.left = `${left}px`;
  floatHead.style.width = `${tableWrap.clientWidth}px`;
  floatHead.firstElementChild.style.transform = `translateX(${-tableWrap.scrollLeft}px)`;
  const first = floatHead.querySelector('th');
  if (first) first.style.transform = `translateX(${tableWrap.scrollLeft}px)`; // первый столбец — на месте, как в таблице
}

function buildFloatHead() {
  const copy = floatHead.firstElementChild;
  copy.querySelector('thead').innerHTML = $('thead').innerHTML;
  copy.querySelectorAll('button').forEach((b) => (b.tabIndex = -1)); // с клавиатуры — настоящая шапка
  copy.style.width = `${tableWrap.querySelector('table').offsetWidth}px`;
  const widths = [...$('thead').querySelectorAll('th')].map((th) => th.getBoundingClientRect().width);
  copy.querySelectorAll('th').forEach((th, i) => (th.style.width = `${widths[i]}px`));
  const overflow = tableWrap.scrollWidth > tableWrap.clientWidth + 1;
  for (const bar of scrollers.slice(1)) {
    bar.hidden = !overflow;
    bar.firstElementChild.style.width = `${tableWrap.scrollWidth}px`;
  }
  placeFloatHead();
}

// Прокрутили одну полосу — остальные следом. Выставленное здесь значение запоминается: событие прокрутки от него приходит
// позже, и без этого оно вернуло бы ведущую полосу назад, пока её ещё тянут. Допуск — scrollLeft бывает дробным
const syncedTo = new Map();
function syncScroll(source) {
  if (syncedTo.get(source) === source.scrollLeft) return void syncedTo.delete(source);
  for (const el of scrollers) {
    if (el === source || Math.abs(el.scrollLeft - source.scrollLeft) < 1) continue;
    el.scrollLeft = source.scrollLeft;
    syncedTo.set(el, el.scrollLeft);
  }
}
for (const el of scrollers) el.addEventListener('scroll', () => syncScroll(el), { passive: true });

// Перекрестие: колонка под курсором подсвечивается вместе со строкой (строку подсвечивает CSS)
tableWrap.addEventListener('mouseover', (event) => {
  const cell = event.target.closest('td, th');
  const n = cell && !cell.classList.contains('export-cell') && cell.colSpan === 1 ? cell.cellIndex + 1 : 0;
  if (n === hoverColumn) return;
  hoverColumn = n;
  paintHighlights();
});
tableWrap.addEventListener('mouseleave', () => {
  hoverColumn = 0;
  paintHighlights();
});

$('clear-highlights').addEventListener('click', () => {
  pins.columns.clear();
  pins.rows.clear();
  renderTable(table.columns, table.rows, table);
});

// Колонки таблицы: какие показывать. Галочка меняет таблицу сразу; выбор запоминается для этого экрана
$('columns').addEventListener('click', () => {
  if (!table) return;
  const options = table.columns.slice(1);
  openPopover($('columns'), (el) => {
    el.style.width = '260px';
    const draw = () => {
      const hidden = hiddenSet();
      el.innerHTML = `
        <div class="options" role="listbox" aria-multiselectable="true">${options
          .map((c) => {
            const on = !hidden.has(c.key);
            return `<button class="option check${on ? ' on' : ''}" role="option" aria-selected="${on}" data-key="${c.key}"><span class="box">${ICONS.check}</span><span class="name">${c.title}</span></button>`;
          })
          .join('')}</div>
        <div class="pop-foot"><button class="link-btn" data-show-all>Show all</button><span class="muted">${hidden.size ? `Hidden: ${options.filter((c) => hidden.has(c.key)).length}` : 'All shown'}</span><button class="btn primary" data-done>Done</button></div>`;
    };
    draw();
    el.addEventListener('click', (event) => {
      const option = event.target.closest('.option');
      if (option) {
        const hidden = hiddenSet();
        if (hidden.has(option.dataset.key)) hidden.delete(option.dataset.key);
        else hidden.add(option.dataset.key);
        saveHidden([...hidden]);
        renderTable(table.columns, table.rows, table);
        draw();
      }
      if (event.target.closest('[data-show-all]')) {
        saveHidden([]);
        renderTable(table.columns, table.rows, table);
        draw();
      }
      if (event.target.closest('[data-done]')) closePopover();
    });
  });
});

window.addEventListener('scroll', placeFloatHead, { passive: true });
tableWrap.addEventListener('scroll', placeFloatHead, { passive: true });
window.addEventListener('resize', buildFloatHead);

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
      const [count, ratio, ...rest] = VAMP_COLUMNS;
      rememberCampaigns(data.breakdown);
      const columns = data.breakdown.some((r) => r.status)
        ? [valueColumn(), STATUS_COLUMN, ...VAMP_COLUMNS]
        : [valueColumn(), count, VAMP_SHARE_COLUMN, ratio, ...(hasSales() ? [VAMP_LIFT_COLUMN] : []), ...rest];
      renderTable(columns, data.breakdown, { link: dimensions().includes(state.view), limit: true, empty: 'No Visa fraud reports or chargebacks for this month' });
      const tabHint = MODES.vamp.hints[state.view] ?? `Thresholds apply to a whole Visa merchant: ratio ≥ ${pct2(data.thresholds.ratio)} and count ≥ ${num(data.thresholds.count)}`;
      $('hint').textContent = `${month}. ${tabHint}`;
    }
    return;
  }
  if (kind() === 'ltv') {
    if (isTime) {
      renderTable([periodColumn(timeHead('Trial start date')), ...LTV_COLUMNS], data.series);
      renderLtvChart(data);
    } else {
      renderTable([valueColumn(), ...LTV_COLUMNS], data.breakdown, breakdown);
    }
    return;
  }
  if (kind() === 'retries') {
    if (isTime) {
      renderTable([periodColumn(timeHead('Trial start date')), ...RETRY_COLUMNS], data.series);
      renderRetryChart(data);
    } else if (state.view === 'attempt') {
      renderTable(CURVE_COLUMNS, data.curve, { empty: 'No payment attempts for this period' });
    } else if (state.view === 'day') {
      renderTable(DAY_COLUMNS, data.days, { empty: 'No retries for this period' });
    } else if (state.view === 'decline_code') {
      renderTable(CODE_COLUMNS, data.codes, { limit: true, empty: 'No declines for this period' });
    } else {
      renderTable([valueColumn(), ...RETRY_COLUMNS], data.breakdown, breakdown);
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
  if (kind() === 'visits') {
    if (isTime) {
      renderTable([periodColumn(timeHead('Date')), ...VISIT_COLUMNS], data.series);
      renderVisitsChart(data.series);
    } else {
      renderTable([valueColumn(), VISIT_SHARE_COLUMN, ...VISIT_COLUMNS], data.breakdown, { ...breakdown, empty: 'No visits for this period' });
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
    // визиты — первой колонкой, Visit → Trial — сразу после триалов; без фильтров и по всем провайдерам (src/server.ts)
    const [trials, ...rest] = CONVERSION_COLUMNS;
    const withVisits = data.visits_status === 'ok' || data.visits_status === 'unavailable';
    renderTable([periodColumn(timeHead('Trial start date')), ...(withVisits ? [VISITS_COLUMN, trials, VISIT_TO_TRIAL_COLUMN, ...rest] : CONVERSION_COLUMNS)], data.series);
    renderCharts(data.series);
    if (data.visits_status === 'filtered') $('hint').textContent += '. Visits and Visit → Trial are shown only without filters and for all providers: visits are not split by account, country or bank';
    if (data.visits_status === 'unavailable') $('hint').textContent += `. Visits are unavailable: ${data.visits_error}`;
  } else if (state.view === 'decline_reason' && data.reason_banks) {
    renderTable(DECLINE_BANK_COLUMNS, data.reason_banks, { limit: true, empty: 'No declines for this reason in this period' });
    $('hint').innerHTML = `<button class="link-btn" id="drill-back">← All decline reasons</button> · ${esc(data.reason)}: declines by the issuing bank of the trial's card`;
  } else if (state.view === 'decline_reason') {
    renderReasons(REASON_COLUMNS, data.reasons);
  } else {
    // доля триалов строки — от всех триалов выборки, включая Unknown и строки за пределами показанных
    const total = data.breakdown.reduce((s, r) => s + r.started, 0);
    const shareOfTotal = { key: 'share_of_total', title: 'Share of total', tip: 'Доля триалов строки от всех триалов выборки', sort: (r) => r.started, cell: (r) => shareCell(total ? r.started / total : null) };
    const bankCountry = state.view === 'bank' ? [BANK_COUNTRY_COLUMN] : [];
    renderTable([valueColumn(), ...bankCountry, shareOfTotal, ...CONVERSION_COLUMNS], data.breakdown, breakdown);
  }
}

// Строка причины отказа → её банки; назад — ссылкой над таблицей или повторным кликом по вкладке
function openReason(reason) {
  state.drill = reason;
  state.sort = null;
  state.showAll = false;
  load('view');
}
$('hint').addEventListener('click', (event) => {
  if (!event.target.closest('#drill-back')) return;
  state.drill = null;
  state.sort = null;
  state.showAll = false;
  load('view');
});
// Страна банка — страна выпуска его карт; у банка с картами нескольких стран — основная, остальные — «+N» с подсказкой
const BANK_COUNTRY_COLUMN = {
  key: 'bank_country',
  title: 'Bank country',
  tip: 'Страна выпуска карт банка. Если карты из нескольких стран (Revolut и т. п.) — самая частая, остальные — в подсказке',
  text: true,
  sort: (r) => (r.bank_countries?.length ? valueLabel('country', r.bank_countries[0].country) : null),
  cell: (r) => {
    const [main, ...rest] = r.bank_countries ?? [];
    if (!main) return '<td class="muted">—</td>';
    const all = r.bank_countries.reduce((s, c) => s + c.count, 0);
    const tip = rest.length ? r.bank_countries.map((c) => `${valueLabel('country', c.country)} — ${pct(c.count / all)}`).join('\n') : '';
    return `<td${tip ? ` title="${esc(tip)}"` : ''}>${esc(valueLabel('country', main.country))}${rest.length ? `<span class="n">+${rest.length}</span>` : ''}</td>`;
  },
};
const DECLINE_BANK_COLUMNS = [
  {
    key: 'value',
    title: 'Issuing bank',
    tip: 'Банк карты триала: у Stripe — карта клиента, у Solidgate — карта заказа',
    text: true,
    sort: (r) => (r.value === null ? null : valueLabel('bank', r.value)),
    cell: (r) => `<td title="${esc(valueLabel('bank', r.value))}">${esc(valueLabel('bank', r.value))}</td>`,
  },
  BANK_COUNTRY_COLUMN,
  { key: 'count', title: 'Declines', tip: 'Отклонённые попытки с этой причиной', sort: (r) => r.count, cell: (r) => `<td>${num(r.count)}</td>` },
  { key: 'share', title: 'Share of declines', tip: 'Доля от всех отказов по этой причине', sort: (r) => r.share, cell: (r) => shareCell(r.share) },
];

function renderReasons(columns, reasons) {
  // строка причины открывает её банки
  renderTable(columns, reasons.map((r) => ({ ...r, value: r.reason })), { link: true, empty: 'No declines for this period' });
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

// LTV: деньги на триал за 30/60/90 дней по когортам; пунктир — окно ещё не закрылось
function renderLtvChart({ series }) {
  const { muted, grid, x, common } = chartBase();
  const line = (label, key, finalKey, color) => ({
    label, data: series.map((p) => (p[key] === null ? null : +(p[key] / 100).toFixed(2))), borderColor: color, backgroundColor: color,
    borderWidth: 2, pointRadius: series.length > 31 ? 0 : 3, pointHoverRadius: 5, tension: 0.25, spanGaps: true,
    segment: { borderDash: (ctx) => (series[ctx.p1DataIndex][finalKey] ? undefined : [5, 4]) },
  });
  charts.ltv = new Chart($('ltv-chart'), {
    type: 'line',
    data: {
      labels: chartLabels(series),
      datasets: [
        line('90 days', 'ltv_90_per_trial', 'final_90', css('--s-converted')),
        line('60 days', 'ltv_60_per_trial', 'final_60', css('--s-started')),
        line('30 days', 'ltv_30_per_trial', 'final_30', css('--s-first')),
      ],
    },
    options: {
      ...common,
      plugins: { legend: { display: false }, tooltip: chartTooltip(series, (c) => ` ${c.dataset.label}: ${c.raw === null ? '—' : usdExact.format(c.raw)}`) },
      scales: { x, y: { min: 0, grid: { color: grid }, border: { display: false }, ticks: { color: muted, callback: (v) => usdExact.format(v) } } },
    },
  });
}

// Ретраи: approval rate по номеру попытки — где повторы перестают окупаться
function renderRetryChart({ curve }) {
  const { muted, grid, common } = chartBase();
  charts.retryCurve = new Chart($('retry-chart'), {
    type: 'bar',
    data: {
      labels: curve.map((r) => (r.attempt === 1 ? 'First' : r.attempt >= 10 ? '10+' : `#${r.attempt}`)),
      datasets: [{ label: 'Approval rate', data: curve.map((r) => +((r.approval_rate ?? 0) * 100).toFixed(1)), backgroundColor: css('--s-converted'), borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 48 }],
    },
    options: {
      ...common,
      plugins: {
        legend: { display: false },
        tooltip: { padding: 10, cornerRadius: 8, callbacks: { title: (items) => ordinal(curve[items[0].dataIndex].attempt), label: (c) => ` ${c.raw}% · ${num(curve[c.dataIndex].approved)} of ${num(curve[c.dataIndex].attempts)}` } },
      },
      scales: {
        x: { grid: { display: false }, border: { color: grid }, ticks: { color: muted } },
        y: { min: 0, grid: { color: grid }, border: { display: false }, ticks: { color: muted, callback: (v) => `${v}%` } },
      },
    },
  });
}

// Графики своего экрана — при смене темы перерисовываются: цвета берутся из неё
function renderModeCharts(data) {
  if (kind() === 'cancellations') return renderCancelCharts(data);
  if (kind() === 'retries') return renderRetryChart(data);
  if (kind() === 'ltv') return renderLtvChart(data);
  if (kind() === 'vamp') return renderVampChart(data);
  ({ conversion: renderCharts, turnover: renderTurnoverChart, visits: renderVisitsChart, repeat: renderRepeatChart, overview: renderOverviewChart })[kind()](data.series);
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

function renderVisitsChart(series) {
  const { muted, grid, x, common } = chartBase();
  charts.visits = new Chart($('visits-chart'), {
    type: 'bar',
    data: {
      labels: chartLabels(series),
      datasets: [{ label: 'Unique visits', data: series.map((p) => p.visits), backgroundColor: css('--s-converted'), borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 28 }],
    },
    options: {
      ...common,
      plugins: {
        legend: { display: false },
        tooltip: chartTooltip(series, (c) => ` Unique visits: ${num(series[c.dataIndex].visits)}`),
      },
      scales: { x, y: { min: 0, grid: { color: grid }, border: { display: false }, ticks: { color: muted, precision: 0 } } },
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
  state.drill = null;
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
  if (!value || (value === state.view && !state.drill)) return; // повторный клик по Decline reasons — назад ко всем причинам
  state.view = value;
  state.drill = null;
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

// Сортировка — кликом по заголовку, и в самой таблице, и в закреплённой копии шапки
function sortByHeader(event) {
  const key = event.target.closest('[data-sort]')?.dataset.sort;
  if (!key || !table) return;
  const current = state.sort ?? defaultSort();
  const column = table.columns.find((c) => c.key === key);
  // повторный клик меняет направление; новая колонка: текст — по алфавиту, числа — от большего к меньшему
  state.sort = current?.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: column.text ? 'asc' : 'desc' };
  saveUrl();
  renderTable(table.columns, table.rows, table);
}
// Шапка: значки «выделить» и «скрыть» у колонки, иначе — сортировка
function onHeadClick(event) {
  const hide = event.target.closest('[data-hide-col]');
  if (hide) return hideColumn(hide.dataset.hideCol);
  const mark = event.target.closest('[data-mark-col]');
  if (mark) return toggleColumnPin(mark.dataset.markCol);
  sortByHeader(event);
}
$('thead').addEventListener('click', onHeadClick);
floatHead.addEventListener('click', onHeadClick);

$('rows').addEventListener('click', (event) => {
  const exportButton = event.target.closest('.row-export');
  if (exportButton) return void exportCsv(rowPatch(table.shown[+exportButton.dataset.row]), exportButton);
  const markButton = event.target.closest('.row-mark');
  if (markButton) {
    const key = rowKey(table.shown[+markButton.dataset.markRow]);
    if (pins.rows.has(key)) pins.rows.delete(key);
    else pins.rows.add(key);
    markButton.closest('tr').classList.toggle('hl', pins.rows.has(key));
    return void paintHighlights();
  }
  const row = event.target.closest('tr.link');
  if (loading || !row) return; // строки старой вкладки, пока грузится новая
  if (kind() === 'conversion' && state.view === 'decline_reason' && !state.drill) return void openReason(row.dataset.value);
  if (!dimensions().includes(state.view)) return;
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
  if (state.view === 'decline_reason' && state.drill) return { bank: r.value ?? 'none' }; // банк открытой причины (она уже в запросе)
  if (state.view === 'decline_reason' || state.view === 'cancel_reason') return { reason: r.reason };
  if (state.view === 'outcome') return { reason: r.outcome }; // исход после фрод-репорта
  if (state.view === 'attempt') return { attempt: r.attempt };
  if (state.view === 'day') return { day: r.day };
  if (state.view === 'decline_code') return { reason: r.code ?? 'none' };
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
