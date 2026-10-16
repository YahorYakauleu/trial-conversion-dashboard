import type { Db } from './db.js';
import { groupDays } from './days.js';
import {
  bucketDay,
  bucketSql,
  DAY,
  DIMENSION_SQL,
  finality,
  trialFilter,
  type Dimension,
  type Granularity,
  type RangeOptions,
} from './metrics.js';

// Отмены подписок VPN — по когортам триалов, как конверсия: берём триалы, оформленные в эти дни, и смотрим, кто и когда
// отменил. Отмена — момент, когда попросили отменить (и при отмене «в конце периода»). Считаем отмены во время триала
// и в течение окна ретраев (30 дней) после его конца — чтобы когорты были сравнимы.

// Причины отмены Stripe (cancellation_details.reason) и Solidgate (код отмены) — общими группами, с пояснением по-русски
const GROUPS: { label: string; hint: string; codes: string[] }[] = [
  {
    label: 'Requested',
    hint: 'Отменили по запросу: пользователь в приложении или наш бэкенд (поддержка, рефанд, антифрод)',
    codes: ['cancellation_requested', '8.06'],
  },
  { label: 'Payment method removed', hint: 'Пользователь отвязал карту (Apple Pay, Google Pay) или истёк срок её токена', codes: ['8.11', '8.10'] },
  { label: 'Payment failed', hint: 'Подписка закрылась: так и не удалось списать оплату', codes: ['payment_failed', '8.09'] },
  { label: 'Fraud or dispute', hint: 'Отменили из-за фрода, чарджбэка или сигнала банка о мошенничестве', codes: ['payment_disputed', '8.02', '8.04', '8.05', '8.12'] },
];
const UNKNOWN = { label: 'Unknown', hint: 'Провайдер не передал причину отмены' };
const BY_CODE = new Map(GROUPS.flatMap((g) => g.codes.map((code) => [code, g] as const)));
const HINTS = new Map([...GROUPS, UNKNOWN].map((g) => [g.label, g.hint]));

export const cancelLabel = (code: string | null): string => (code ? (BY_CODE.get(code)?.label ?? code) : UNKNOWN.label);
export const cancelHint = (label: string): string => HINTS.get(label) ?? 'Код отмены провайдера — без общей группы';

// Коды группы — для выборки по строке причины (выгрузка)
export function cancelCodes(label: string): { codes: string[]; withoutCode: boolean } {
  if (label === UNKNOWN.label) return { codes: [], withoutCode: true };
  return { codes: GROUPS.find((g) => g.label === label)?.codes ?? [label], withoutCode: false };
}

// Отменён во время триала / в окне после него — SQL-условия по триалу t
export const IN_TRIAL = 't.canceled_at IS NOT NULL AND t.canceled_at < t.trial_ended_at';
export const AFTER_TRIAL = 't.canceled_at IS NOT NULL AND t.canceled_at >= t.trial_ended_at AND t.canceled_at < t.trial_ended_at + @window';

interface CancelCounts {
  started: number; // оформлено триалов
  canceled_in_trial: number; // отменили до конца триала
  canceled_day0: number; // из них — в первые сутки после оформления
  cancel_seconds: number; // сумма времени от оформления до отмены — у отменивших в триале
  canceled_after: number; // отменили в течение 30 дней после конца триала
}

export interface CancelTotals extends CancelCounts {
  trial_cancellation_rate: number | null;
  day0_share: number | null; // доля отмен в первые сутки среди отмен во время триала
  avg_cancel_day: number | null; // средний день отмены от оформления (дробный: 0,4 — через ~10 часов)
  post_trial_cancellation_rate: number | null;
  final_trial: boolean; // все триалы когорты закончились — отмены во время триала больше не прибавятся
  final_after: boolean; // и прошло окно после триала
}

const rate = (part: number, total: number) => (total === 0 ? null : part / total);
const zero = (): CancelCounts => ({ started: 0, canceled_in_trial: 0, canceled_day0: 0, cancel_seconds: 0, canceled_after: 0 });
const add = (a: CancelCounts, b: CancelCounts): CancelCounts => ({
  started: a.started + b.started,
  canceled_in_trial: a.canceled_in_trial + b.canceled_in_trial,
  canceled_day0: a.canceled_day0 + b.canceled_day0,
  cancel_seconds: a.cancel_seconds + b.cancel_seconds,
  canceled_after: a.canceled_after + b.canceled_after,
});
const withRates = <T extends CancelCounts & { final_trial: boolean; final_after: boolean }>(c: T): T & CancelTotals => ({
  ...c,
  trial_cancellation_rate: rate(c.canceled_in_trial, c.started),
  day0_share: rate(c.canceled_day0, c.canceled_in_trial),
  avg_cancel_day: c.canceled_in_trial === 0 ? null : c.cancel_seconds / c.canceled_in_trial / DAY,
  post_trial_cancellation_rate: rate(c.canceled_after, c.started),
});

// Один проход по триалам периода; max_len — самый длинный триал группы, для окончательности
function sums(db: Db, o: RangeOptions, key: string) {
  const filter = trialFilter(o);
  const count = (condition: string) => `SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END)`;
  return db
    .prepare(
      `SELECT ${key} AS key, COUNT(*) AS started,
              ${count(IN_TRIAL)} AS canceled_in_trial,
              ${count(`${IN_TRIAL} AND t.canceled_at - t.trial_started_at < ${DAY}`)} AS canceled_day0,
              SUM(CASE WHEN ${IN_TRIAL} THEN t.canceled_at - t.trial_started_at ELSE 0 END) AS cancel_seconds,
              ${count(AFTER_TRIAL)} AS canceled_after,
              MAX(t.trial_ended_at - t.trial_started_at) AS max_len
       FROM trials t WHERE ${filter.sql} GROUP BY key`,
    )
    .all({ ...filter.params, window: o.retryWindowDays * DAY }) as unknown as (CancelCounts & { key: string | number | null; max_len: number })[];
}

// Распределение отмен во время триала по дню от оформления (0 — первые сутки) и медиана
function byDay(db: Db, o: RangeOptions) {
  const filter = trialFilter(o);
  const rows = db
    .prepare(`SELECT (t.canceled_at - t.trial_started_at) / ${DAY} AS day, COUNT(*) AS count FROM trials t WHERE ${filter.sql} AND ${IN_TRIAL} GROUP BY day ORDER BY day`)
    .all(filter.params) as unknown as { day: number; count: number }[];
  const total = rows.reduce((s, r) => s + r.count, 0);
  let seen = 0;
  const median = rows.find((r) => (seen += r.count) * 2 >= total)?.day ?? null;
  return { by_day: rows.map((r) => ({ ...r, share: r.count / total })), median_cancel_day: median };
}

export function getCancellations(db: Db, o: RangeOptions & { granularity: Granularity }) {
  const days = new Map<string, CancelCounts>();
  let maxLength = 0;
  for (const { key, max_len, ...c } of sums(db, o, bucketSql('t', 't.trial_started_at'))) {
    const day = bucketDay(key, o.timeZones);
    days.set(day, add(days.get(day) ?? zero(), c));
    maxLength = Math.max(maxLength, max_len);
  }
  // окончательность группы — по её последнему дню (самый поздний триал кончается позже всех)
  const series = groupDays(days, o, zero, add).map((p) => {
    const { final_first, final_retry } = finality(o, p.period_end, maxLength);
    return withRates({ ...p, final_trial: final_first, final_after: final_retry });
  });
  const { final_first, final_retry } = finality(o, o.to, maxLength);
  const totals = withRates({ ...series.reduce<CancelCounts>(add, zero()), final_trial: final_first, final_after: final_retry });
  return { totals, series, ...byDay(db, o) };
}

// Разбивка по измерению: по убыванию триалов, «не определено» — в конце
export function getCancellationBreakdown(db: Db, o: RangeOptions, dimension: Dimension) {
  const groups = sums(db, o, DIMENSION_SQL[dimension]);
  const { final_first, final_retry } = finality(o, o.to, Math.max(0, ...groups.map((g) => g.max_len)));
  const rows = groups
    .map(({ key, max_len: _, ...c }) => withRates({ value: key === null ? null : String(key), ...c, final_trial: final_first, final_after: final_retry }))
    .sort((a, b) => Number(a.value === null) - Number(b.value === null) || b.started - a.started || String(a.value).localeCompare(String(b.value)));
  const totals = withRates({ ...rows.reduce<CancelCounts>(add, zero()), final_trial: final_first, final_after: final_retry });
  return { totals, breakdown: rows, ...byDay(db, o) };
}

// Причины отмен (во время триала и в окне после него) — общими группами Stripe и Solidgate
export function getCancellationReasons(db: Db, o: RangeOptions) {
  const filter = trialFilter(o);
  const rows = db
    .prepare(
      `SELECT t.cancel_reason AS reason, COUNT(*) AS count,
              SUM(CASE WHEN ${IN_TRIAL} THEN 1 ELSE 0 END) AS in_trial
       FROM trials t WHERE ${filter.sql} AND ((${IN_TRIAL}) OR (${AFTER_TRIAL})) GROUP BY t.cancel_reason`,
    )
    .all({ ...filter.params, window: o.retryWindowDays * DAY }) as unknown as { reason: string | null; count: number; in_trial: number }[];
  const byLabel = new Map<string, { count: number; in_trial: number }>();
  for (const r of rows) {
    const label = cancelLabel(r.reason);
    const g = byLabel.get(label) ?? { count: 0, in_trial: 0 };
    byLabel.set(label, { count: g.count + r.count, in_trial: g.in_trial + r.in_trial });
  }
  const total = [...byLabel.values()].reduce((s, g) => s + g.count, 0);
  return [...byLabel]
    .map(([reason, g]) => ({ reason, hint: cancelHint(reason), count: g.count, share: g.count / total, in_trial: g.in_trial, after_trial: g.count - g.in_trial }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, 'en'));
}
