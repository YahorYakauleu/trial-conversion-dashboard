import type { Db, Provider } from './db.js';
import { groupDays } from './days.js';
import { bucketDay, bucketSql, DAY, DIMENSION_SQL, trialFilter, type Dimension, type Granularity, type RangeOptions } from './metrics.js';
import { addDays, localMidnight } from './time.js';

// LTV — деньги от триала по когортам дня оформления: все успешные платежи его клиента (оплата триала, первый период,
// продления) за 30, 60 и 90 дней с оформления, в долларах, за вычетом рефандов. Платёж связан с триалом через клиента
// (Stripe — cus_…, Solidgate — ID аккаунта); если клиент оформил триал ещё раз, дальше деньги идут новому триалу.
// Периоды — сколько платежей после конца триала пришло за 90 дней (при месячном плане: 1 — первый период, 2 — первое продление).
// Первый платёж после триала — цена первого периода в долларах: по ней видно, где цены ниже (региональные цены).
// Плата за триал — платежи до конца триала (например, $0.99 при оформлении): по ней триал платный.

const WINDOWS = [30, 60, 90] as const;
const TOLERANCE = 3_600; // оплата триала проходит в момент оформления — на секунды раньше
const SETTLED = 95 * DAY; // окна закрылись (90 дней) — посчитанное больше не меняется

// В строку триала — деньги за 30/60/90 дней и оплаченные периоды. Пересчитываются триалы аккаунта, у которых окна ещё
// не закрылись к прошлому расчёту (или ещё не посчитанные)
export function refreshTrialLtv(db: Db, provider: Provider, account: string, now: number): void {
  const net = 'p.amount_usd_cents - p.refunded_usd_cents';
  const within = (days: number) => `SUM(CASE WHEN p.paid_at < trials.trial_started_at + ${days * DAY} THEN ${net} ELSE 0 END)`;
  // платежи клиента триала: от оформления до 90 дней, но не дальше его следующего триала
  const payments = `FROM payments p INDEXED BY payments_customer_paid_idx -- иначе планировщик берёт индекс по дате и перебирает все платежи окна
       WHERE p.provider = trials.provider AND p.customer_id = trials.customer_id AND p.product = 'vpn'
         AND p.paid_at >= trials.trial_started_at - ${TOLERANCE} AND p.paid_at < trials.trial_started_at + ${90 * DAY}
         AND p.paid_at < COALESCE((SELECT MIN(n.trial_started_at) - ${TOLERANCE} FROM trials n
                                   WHERE n.provider = trials.provider AND n.customer_id = trials.customer_id
                                     AND n.trial_started_at > trials.trial_started_at), ${Number.MAX_SAFE_INTEGER})`;
  const afterTrial = `p.paid_at >= trials.trial_ended_at - ${TOLERANCE}`;
  db.prepare(
    `UPDATE trials SET
       (ltv_30, ltv_60, ltv_90, periods_90, ltv_at) = (
         SELECT COALESCE(${within(30)}, 0), COALESCE(${within(60)}, 0), COALESCE(${within(90)}, 0),
                COALESCE(SUM(CASE WHEN ${afterTrial} THEN 1 ELSE 0 END), 0), @now
         ${payments}),
       first_payment = COALESCE((SELECT p.amount_usd_cents ${payments} AND ${afterTrial} ORDER BY p.paid_at LIMIT 1), 0),
       trial_fee = COALESCE((SELECT SUM(p.amount_usd_cents) ${payments} AND NOT (${afterTrial})), 0)
     WHERE provider = @provider AND account = @account AND customer_id IS NOT NULL
       AND (ltv_at IS NULL OR ltv_at < trial_started_at + ${SETTLED})`,
  ).run({ provider, account, now });
}

// Платежам проставили клиента задним числом — посчитать LTV аккаунта заново
export function resetTrialLtv(db: Db, provider: Provider, account: string): void {
  db.prepare('UPDATE trials SET ltv_at = NULL WHERE provider = ? AND account = ?').run(provider, account);
}

// Номер платежа подписки — для разбивки VAMP: платёж относится к последнему триалу клиента, оформленному не позже него
// (как в LTV: следующий триал начинает счёт заново). До конца триала — 0 (оплата триала), после — 1, 2, 3… по порядку;
// триала клиента нет в истории (подписка оформлена раньше HISTORY_FROM) — -1. Считаются ещё не посчитанные и свежие
// платежи: триал или более ранний платёж клиента могли прийти позже
const RENUMBER_RECENT = 3 * DAY;
export function refreshPaymentNumbers(db: Db, now: number): void {
  const trial = `FROM trials t WHERE t.provider = payments.provider AND t.customer_id = payments.customer_id
                   AND t.trial_started_at <= payments.paid_at + ${TOLERANCE} ORDER BY t.trial_started_at DESC LIMIT 1`;
  const earlier = `SELECT COUNT(*) FROM payments q INDEXED BY payments_customer_paid_idx
                   WHERE q.provider = payments.provider AND q.customer_id = payments.customer_id AND q.product = 'vpn'
                     AND q.paid_at >= t.trial_ended_at - ${TOLERANCE}
                     AND (q.paid_at < payments.paid_at OR (q.paid_at = payments.paid_at AND q.payment_id <= payments.payment_id))`;
  db.prepare(
    `UPDATE payments SET payment_n = COALESCE(
       (SELECT CASE WHEN payments.paid_at < t.trial_ended_at - ${TOLERANCE} THEN 0 ELSE (${earlier}) END ${trial}), -1)
     WHERE product = 'vpn' AND customer_id IS NOT NULL AND (payment_n IS NULL OR paid_at >= @recent)`,
  ).run({ recent: now - RENUMBER_RECENT });
}

// История аккаунта начинается раньше (HISTORY_FROM сдвинули) — у старых платежей могли появиться триалы
export function resetPaymentNumbers(db: Db, provider: Provider, account: string): void {
  db.prepare('UPDATE payments SET payment_n = NULL WHERE provider = ? AND account = ?').run(provider, account);
}

interface Counts {
  started: number;
  paid: number; // оплатили первый платный период в окне ретраев (как Trial-to-paid)
  paid_1: number; // был хоть один платёж после конца триала за 90 дней — знаменатель продлений и денег на оплатившего
  first_payment: number; // сумма первых платежей после триала, центы USD
  ltv_30: number; // центы USD
  ltv_60: number;
  ltv_90: number;
  renewed_2: number; // оплатили 2 периода и больше за 90 дней
  renewed_3: number; // 3 и больше
}
export interface LtvTotals extends Counts {
  trial_to_paid: number | null;
  ltv_30_per_trial: number | null; // центы на один триал
  ltv_60_per_trial: number | null;
  ltv_90_per_trial: number | null;
  ltv_90_per_paid: number | null; // центы на одного оплатившего
  avg_first_payment: number | null; // средняя цена первого периода, центы USD
  renewal_2: number | null; // доля оплативших первый период (paid_1), кто оплатил и второй
  renewal_3: number | null;
  final_30: boolean; // прошло 30 (60, 90) дней с оформления самого свежего триала группы
  final_60: boolean;
  final_90: boolean;
}

const zero = (): Counts => ({ started: 0, paid: 0, paid_1: 0, first_payment: 0, ltv_30: 0, ltv_60: 0, ltv_90: 0, renewed_2: 0, renewed_3: 0 });
const add = (a: Counts, b: Counts): Counts => ({
  started: a.started + b.started,
  paid: a.paid + b.paid,
  paid_1: a.paid_1 + b.paid_1,
  first_payment: a.first_payment + b.first_payment,
  ltv_30: a.ltv_30 + b.ltv_30,
  ltv_60: a.ltv_60 + b.ltv_60,
  ltv_90: a.ltv_90 + b.ltv_90,
  renewed_2: a.renewed_2 + b.renewed_2,
  renewed_3: a.renewed_3 + b.renewed_3,
});
const per = (total: number, n: number) => (n === 0 ? null : total / n);

// Окончательность окна: с конца последнего дня группы прошло N дней (с запасом в сутки — платежи и рефанды доходят с задержкой)
function finality(o: RangeOptions, lastDay: string) {
  const end = Math.max(...Object.values(o.timeZones).map((tz) => localMidnight(addDays(lastDay, 1), tz)));
  const passed = (days: number) => end + (days + 1) * DAY <= o.now;
  return { final_30: passed(WINDOWS[0]), final_60: passed(WINDOWS[1]), final_90: passed(WINDOWS[2]) };
}

const withRates = <T extends Counts>(c: T, lastDay: string, o: RangeOptions): T & LtvTotals => ({
  ...c,
  trial_to_paid: per(c.paid, c.started),
  ltv_30_per_trial: per(c.ltv_30, c.started),
  ltv_60_per_trial: per(c.ltv_60, c.started),
  ltv_90_per_trial: per(c.ltv_90, c.started),
  ltv_90_per_paid: per(c.ltv_90, c.paid_1),
  avg_first_payment: per(c.first_payment, c.paid_1),
  renewal_2: per(c.renewed_2, c.paid_1),
  renewal_3: per(c.renewed_3, c.paid_1),
  ...finality(o, lastDay),
});

function sums(db: Db, o: RangeOptions, key: string) {
  const filter = trialFilter(o);
  return db
    .prepare(
      `SELECT ${key} AS key, COUNT(*) AS started,
              SUM(CASE WHEN t.paid_at IS NOT NULL AND t.paid_at <= t.trial_ended_at + @window THEN 1 ELSE 0 END) AS paid,
              SUM(CASE WHEN t.periods_90 >= 1 THEN 1 ELSE 0 END) AS paid_1,
              SUM(t.first_payment) AS first_payment,
              SUM(t.ltv_30) AS ltv_30, SUM(t.ltv_60) AS ltv_60, SUM(t.ltv_90) AS ltv_90,
              SUM(CASE WHEN t.periods_90 >= 2 THEN 1 ELSE 0 END) AS renewed_2,
              SUM(CASE WHEN t.periods_90 >= 3 THEN 1 ELSE 0 END) AS renewed_3
       FROM trials t WHERE ${filter.sql} GROUP BY key`,
    )
    .all({ ...filter.params, window: o.retryWindowDays * DAY }) as unknown as (Counts & { key: string | number | null })[];
}

export function getLtv(db: Db, o: RangeOptions & { granularity: Granularity }) {
  const days = new Map<string, Counts>();
  for (const { key, ...c } of sums(db, o, bucketSql('t', 't.trial_started_at'))) {
    const day = bucketDay(key, o.timeZones);
    days.set(day, add(days.get(day) ?? zero(), c));
  }
  const series = groupDays(days, o, zero, add).map((p) => withRates(p, p.period_end, o));
  return { totals: withRates(series.reduce<Counts>(add, zero()), o.to, o), series };
}

// Разбивка по измерению триала: по убыванию числа триалов, «не определено» — в конце
export function getLtvBreakdown(db: Db, o: RangeOptions, dimension: Dimension) {
  const rows = sums(db, o, DIMENSION_SQL[dimension])
    .map(({ key, ...c }) => withRates({ value: key === null ? null : String(key), ...c }, o.to, o))
    .sort((a, b) => Number(a.value === null) - Number(b.value === null) || b.started - a.started);
  return { totals: withRates(rows.reduce<Counts>(add, zero()), o.to, o), breakdown: rows };
}
