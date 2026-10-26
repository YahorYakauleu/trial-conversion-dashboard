import { IN_TRIAL } from './cancellations.js';
import type { Config } from './config.js';
import { nowSec, type Db, type Store } from './db.js';
import { getBreakdown, getMetrics, latestDay, periodSql, startOfUtcDay, type RangeOptions, type TimeZones, type Totals } from './metrics.js';
import { addDays, localDay, localMidnight } from './time.js';
import { getVampBreakdown, monthStart, type VampStatus } from './vamp.js';

// Утренняя сводка в Slack: вчерашние триалы, первые платежи последних окончательных когорт, вчерашние отмены и Visa VAMP
// по мерчантам — итогом и по каждому аккаунту. Цифры — из тех же функций, что и экраны; только отмены здесь по дню отмены
// (на экране Cancellations — по дню оформления триала). Δ — к среднему за 7 предыдущих дней; у долей — разница в п.п.
// с долей за эти 7 дней вместе. Отправляет поток синка (src/sync-worker.ts) в 06:00 UTC после свежего синка:
// вчерашние сутки Stripe (по Нью-Йорку) к этому времени закончились
export const DIGEST_CRON = '0 6 * * *';
const DIGEST_AT = 6 * 3600;
const BASE_DAYS = 7;

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const STATUSES: Record<VampStatus, string> = { ok: '🟢 OK', at_risk: '🟡 At risk', excessive: '🔴 Excessive' };
const PROVIDER_NAMES = { stripe: 'Stripe', solidgate: 'Solidgate' };

const dayLabel = (day: string) => `${Number(day.slice(8))} ${MONTHS_SHORT[Number(day.slice(5, 7)) - 1]}`;
const weekday = (day: string) => WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];
const moment = (ts: number) => `${dayLabel(localDay(ts, 'UTC'))} ${new Date(ts * 1000).toISOString().slice(11, 16)}`;
const int = (n: number) => n.toLocaleString('ru-RU');
const percent = (r: number | null, digits = 1) => (r === null ? '—' : `${(r * 100).toFixed(digits).replace('.', ',')}%`);
const signed = (x: number, text: string) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${text}`;

// Количество к среднему за день: +12%
function countDelta(value: number, average: number): string {
  if (average === 0) return '—';
  const d = Math.round((value / average - 1) * 100);
  return signed(d, `${Math.abs(d)}%`);
}

// Доля к базовой доле, в процентных пунктах: −2,1
function rateDelta(value: number | null, base: number | null): string {
  if (value === null || base === null) return '—';
  const pp = Math.round((value - base) * 1000) / 10;
  return signed(pp, Math.abs(pp).toFixed(1).replace('.', ','));
}

// Таблица моноширинным блоком; align — по колонке: l или r
function table(rows: string[][], align: string): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const lines = rows.map((r) => r.map((cell, i) => (align[i] === 'l' ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ').trimEnd());
  return ['```', ...lines, '```'].join('\n');
}

type Range = (from: string, to: string) => RangeOptions;
// Строки сводки: «Всего» и аккаунты VPN из настроек (stripe:corp, solidgate:sgH2H); null — у аккаунта нет триалов
type Row = { label: string; totals: Totals | null };

function byAccount(db: Db, o: RangeOptions, accounts: string[]): Row[] {
  const rows = new Map(getBreakdown(db, o, 'account').map((r) => [r.value, r]));
  return [
    { label: 'Всего', totals: getMetrics(db, { ...o, granularity: 'day' }).totals },
    ...accounts.map((a) => ({ label: a.slice(a.indexOf(':') + 1), totals: rows.get(a) ?? null })),
  ];
}

function trialsSection(db: Db, range: Range, accounts: string[], day: string): string {
  const current = byAccount(db, range(day, day), accounts);
  const base = byAccount(db, range(addDays(day, -BASE_DAYS), addDays(day, -1)), accounts);
  const rows = current.map((r, i) => {
    const started = r.totals?.started ?? 0;
    return [r.label, int(started), countDelta(started, (base[i].totals?.started ?? 0) / BASE_DAYS)];
  });
  return `*Триалы — оформлено ${dayLabel(day)}*\n${table([['', 'триалы', 'Δ'], ...rows], 'lrr')}`;
}

// Последний день оформления (не позже day), у которого цифра уже окончательная — без «≈» на экране Conversion.
// Один день на все строки: у аккаунта триалы не длиннее, чем у всех вместе, — его цифра тоже окончательная
function lastFinalDay(db: Db, range: Range, day: string, first: string, flag: 'final_first' | 'final_retry'): string | null {
  for (let d = day; d >= first; d = addDays(d, -1)) {
    const { totals } = getMetrics(db, { ...range(d, d), granularity: 'day' });
    if (totals.started > 0 && totals[flag]) return d;
  }
  return null;
}

function paymentsSection(db: Db, range: Range, accounts: string[], day: string, historyFrom: string): string {
  const firstDay = lastFinalDay(db, range, day, historyFrom, 'final_first');
  if (!firstDay) return '*Первые платежи* — окончательных когорт ещё нет';
  const retryDay = lastFinalDay(db, range, firstDay, historyFrom, 'final_retry');
  // когорта дня и база — 7 дней оформления перед ним
  const cohort = (d: string) => ({ current: byAccount(db, range(d, d), accounts), base: byAccount(db, range(addDays(d, -BASE_DAYS), addDays(d, -1)), accounts) });
  const rate = (c: ReturnType<typeof cohort>, i: number, key: 'rate_first' | 'approval_rate' | 'rate_retry') => {
    const value = c.current[i].totals?.[key] ?? null;
    return [percent(value), rateDelta(value, c.base[i].totals?.[key] ?? null)];
  };
  const first = cohort(firstDay);
  const retry = retryDay ? cohort(retryDay) : null;
  const rows = first.current.map((r, i) => [
    r.label,
    ...rate(first, i, 'rate_first'),
    ...(retry ? [...rate(retry, i, 'approval_rate'), ...rate(retry, i, 'rate_retry')] : []),
  ]);
  const header = ['', 'first-attempt', 'Δ п.п.', ...(retry ? ['approval', 'Δ п.п.', 'trial-to-paid', 'Δ п.п.'] : [])];
  const title = `*Первые платежи* — first-attempt у когорты ${dayLabel(firstDay)}${
    retryDay ? `, approval и trial-to-paid — у когорты ${dayLabel(retryDay)} (закрылось окно ретраев)` : ''
  }`;
  return `${title}\n${table([header, ...rows], 'lrrrrrr')}`;
}

// Отмены по дню отмены (в сутках провайдера): во время триала и после его конца
function cancellationCounts(db: Db, o: { from: string; to: string; timeZones: TimeZones }) {
  const period = periodSql('t', 't.canceled_at', o);
  const rows = db
    .prepare(
      `SELECT t.provider || ':' || t.account AS account,
              SUM(CASE WHEN ${IN_TRIAL} THEN 1 ELSE 0 END) AS in_trial,
              SUM(CASE WHEN t.canceled_at >= t.trial_ended_at THEN 1 ELSE 0 END) AS after
       FROM trials t WHERE t.canceled_at IS NOT NULL AND ${period.sql} GROUP BY account`,
    )
    .all(period.params) as unknown as { account: string; in_trial: number; after: number }[];
  const all = rows.reduce((s, r) => ({ in_trial: s.in_trial + r.in_trial, after: s.after + r.after }), { in_trial: 0, after: 0 });
  return { all, byAccount: new Map(rows.map(({ account, ...c }) => [account, c])) };
}

function cancellationsSection(db: Db, timeZones: TimeZones, accounts: string[], day: string): string {
  const current = cancellationCounts(db, { from: day, to: day, timeZones });
  const base = cancellationCounts(db, { from: addDays(day, -BASE_DAYS), to: addDays(day, -1), timeZones });
  const none = { in_trial: 0, after: 0 };
  const row = (label: string, c: typeof none, b: typeof none) => [
    label, int(c.in_trial), countDelta(c.in_trial, b.in_trial / BASE_DAYS), int(c.after), countDelta(c.after, b.after / BASE_DAYS),
  ];
  const rows = [
    row('Всего', current.all, base.all),
    ...accounts.map((a) => row(a.slice(a.indexOf(':') + 1), current.byAccount.get(a) ?? none, base.byAccount.get(a) ?? none)),
  ];
  return `*Отмены ${dayLabel(day)}*\n${table([['', 'в триале', 'Δ', 'после', 'Δ'], ...rows], 'lrrrr')}`;
}

// Мерчант Visa: имя группы MID (VAMP_MERCHANTS) или MID вне групп — у Solidgate UUID, показываем его начало
function merchantName(value: string | null): string {
  if (value === null) return 'Unknown';
  if (value.startsWith('solidgate:')) return `Solidgate ${value.slice('solidgate:'.length, 'solidgate:'.length + 8)}`;
  return value.startsWith('stripe:') ? value.slice('stripe:'.length) : value;
}

// VAMP — по суткам UTC, как у Visa: месяц вчерашнего дня по вчера включительно. «Сейчас» для прогноза — конец вчерашних
// суток: прогноз по полным дням, как и сами цифры (на экране VAMP прогноз считается и по части сегодняшнего дня)
function vampSection(db: Db, config: Config, now: number): string {
  const today = localDay(now, 'UTC');
  const day = addDays(today, -1);
  const o = { provider: 'all' as const, filters: {}, now: localMidnight(today, 'UTC') };
  const rows = getVampBreakdown(db, { ...o, from: monthStart(day), to: day }, 'merchant', config.vamp);
  const lastDay = new Map(getVampBreakdown(db, { ...o, from: day, to: day }, 'merchant', config.vamp).map((r) => [r.value, r.vamp_count]));
  const title = `*VAMP · ${MONTHS[Number(day.slice(5, 7)) - 1]}, по ${dayLabel(day)} (UTC)*`;
  if (rows.length === 0) return `${title} — событий и Visa-продаж нет`;
  const lines = rows.map((r) => [
    merchantName(r.value),
    int(r.vamp_count),
    percent(r.vamp_ratio, 2),
    r.forecast_count === null ? '—' : int(r.forecast_count),
    `+${int(lastDay.get(r.value) ?? 0)}`,
    r.status ? STATUSES[r.status] : '—',
  ]);
  return `${title}\n${table([['', 'count', 'ratio', 'прогноз', 'вчера', 'статус'], ...lines], 'lrrrrl')}`;
}

// Источники, чей последний синк упал: их цифры в сводке — на время последней удачной загрузки
function failedSources(store: Store): string[] {
  return store
    .latestRuns()
    .filter((r) => r.last_status === 'error')
    .map((r) => {
      const data = r.last_success_at === null ? 'данных ещё нет' : `данные на ${moment(r.last_success_at)} UTC`;
      return `⚠️ ${PROVIDER_NAMES[r.provider]} ${r.account}: последняя загрузка упала — ${data}`;
    });
}

export function buildDigest(store: Store, config: Config, now: number): string {
  const { db } = store;
  const range: Range = (from, to) => ({ provider: 'all', filters: {}, now, from, to, timeZones: config.timeZones, retryWindowDays: config.retryWindowDays });
  const accounts = [...config.stripeAccounts.map((a) => `stripe:${a.account}`), ...config.solidgateAccounts.map((a) => `solidgate:${a.account}`)];
  // вчера — по самым поздним из местных суток провайдеров, как «сегодня» на экранах
  const day = addDays(latestDay(now, config.timeZones), -1);
  return [
    `*Billing · сводка за ${weekday(day)}, ${dayLabel(day)}*\n_Δ — к среднему за 7 предыдущих дней, у долей — в процентных пунктах_`,
    trialsSection(db, range, accounts, day),
    paymentsSection(db, range, accounts, day, config.historyFromDay),
    cancellationsSection(db, config.timeZones, accounts, day),
    vampSection(db, config, now),
    ...failedSources(store),
    ...(config.dashboardUrl ? [`<${config.dashboardUrl}|Открыть дашборд>`] : []),
  ].join('\n\n');
}

const SEND_ATTEMPTS = 3;
const SEND_PAUSE_MS = 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Повтор — при сбое сети, 429 и 5xx; другие ответы (неверный адрес, удалённый вебхук) повтором не исправить.
// Адрес вебхука — секрет: в текст ошибки он не попадает
export async function sendToSlack(url: string, text: string, pause: (ms: number) => Promise<unknown> = sleep): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let error = '';
    let retry = true;
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (response.ok) return;
      retry = response.status === 429 || response.status >= 500;
      error = `Slack ответил ${response.status}: ${(await response.text()).slice(0, 200)}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (!retry || attempt === SEND_ATTEMPTS) throw new Error(error);
    await pause(SEND_PAUSE_MS);
  }
}

// Пора отправлять: 06:00 UTC прошло, а в эти сутки (UTC) сводки ещё не было
export function digestDue(store: Store, now: number): boolean {
  const today = startOfUtcDay(now);
  return now >= today + DIGEST_AT && (store.getState('slack', 'digest', 'sent_day') ?? 0) < today;
}

let sending = false;
// Сводка по расписанию и при старте потока синка (перезапуск после 06:00 UTC — догоняем сегодняшнюю): свежий синк
// (идущий — дожидаемся), сборка, отправка, отметка дня. Не дошла до Slack — ошибка в журнал, отметки нет:
// следующий старт потока в те же сутки отправит снова
export async function runDigest(store: Store, config: Config, sync: () => Promise<unknown>, clock = nowSec): Promise<boolean> {
  const url = config.slackWebhookUrl;
  if (!url || sending || !digestDue(store, clock())) return false;
  sending = true;
  const today = startOfUtcDay(clock());
  try {
    await sync();
    await sendToSlack(url, buildDigest(store, config, clock()));
    store.setState('slack', 'digest', 'sent_day', today);
    console.log('Сводка отправлена в Slack');
    return true;
  } catch (error) {
    console.error(`Сводка в Slack не отправлена: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    sending = false;
  }
}
