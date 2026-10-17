import type { Db } from './db.js';
import { groupDays } from './days.js';
import { declineHint, declineLabel, NO_RETRY_CODES } from './declines.js';
import { bucketDay, bucketSql, DAY, DIMENSION_SQL, finality, trialFilter, type Dimension, type Granularity, type RangeOptions } from './metrics.js';

// Ретраи первого платежа после триала — когорты по дню оформления, как в Conversion. Попытки одной подписки идут по порядку:
// первая — само списание в конце триала, дальше — повторы. После отказа «не повторять» (NO_RETRY_CODES: карта украдена
// или закрыта, банк отозвал разрешение, Stripe сам блокирует повтор) повтор почти никогда не проходит — такие повторы
// считаются отдельно.

const NO_RETRY = `(${NO_RETRY_CODES.map((c) => `'${c}'`).join(', ')})`;

// Попытки триалов периода: номер попытки, дни от первой, был ли раньше отказ «не повторять», что стало дальше.
// key — группа (SQL по триалу t)
function attemptsCte(o: RangeOptions, key: string) {
  const filter = trialFilter(o);
  return {
    sql: `WITH x AS (
      SELECT ${key} AS key, a.provider, a.subscription_id, a.attempt_id, a.attempted_at, a.approved, a.reason,
             t.trial_started_at, t.trial_ended_at, t.account, t.customer_id,
             ROW_NUMBER() OVER w AS n,
             (a.attempted_at - MIN(a.attempted_at) OVER (PARTITION BY a.provider, a.subscription_id)) / ${DAY} AS day,
             COALESCE(MAX(CASE WHEN a.approved = 0 AND a.reason IN ${NO_RETRY} THEN 1 ELSE 0 END)
                      OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS after_no_retry,
             LEAD(a.approved) OVER w AS next_approved,
             COALESCE(MAX(a.approved) OVER (w ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING), 0) AS approved_later
      FROM attempts a JOIN trials t ON t.provider = a.provider AND t.subscription_id = a.subscription_id
      WHERE ${filter.sql}
      WINDOW w AS (PARTITION BY a.provider, a.subscription_id ORDER BY a.attempted_at, a.attempt_id))`,
    params: filter.params as Record<string, string | number>,
  };
}

interface Counts {
  first_declined: number; // триалы, у которых первая попытка отклонена
  retries: number; // повторные попытки
  recovered: number; // повтор прошёл в окне ретраев (30 дней после конца триала)
  no_retry_retries: number; // повторы после отказа «не повторять»
  no_retry_recovered: number; // из них прошли
}
export interface RetryTotals extends Counts {
  recovery_rate: number | null; // восстановленные / первая попытка отклонена
  retry_success: number | null; // восстановленные / повторы
  retries_per_recovery: number | null; // сколько повторов уходит на одно восстановление
  no_retry_share: number | null; // доля повторов после отказа «не повторять»
  final: boolean; // окно ретраев закрыто у всех триалов группы
}

const rate = (part: number, total: number) => (total === 0 ? null : part / total);
const zero = (): Counts => ({ first_declined: 0, retries: 0, recovered: 0, no_retry_retries: 0, no_retry_recovered: 0 });
const add = (a: Counts, b: Counts): Counts => ({
  first_declined: a.first_declined + b.first_declined,
  retries: a.retries + b.retries,
  recovered: a.recovered + b.recovered,
  no_retry_retries: a.no_retry_retries + b.no_retry_retries,
  no_retry_recovered: a.no_retry_recovered + b.no_retry_recovered,
});
const withRates = <T extends Counts & { final: boolean }>(c: T): T & RetryTotals => ({
  ...c,
  recovery_rate: rate(c.recovered, c.first_declined),
  retry_success: rate(c.recovered, c.retries),
  retries_per_recovery: c.recovered === 0 ? null : c.retries / c.recovered,
  no_retry_share: rate(c.no_retry_retries, c.retries),
});

function sums(db: Db, o: RangeOptions, key: string) {
  const cte = attemptsCte(o, key);
  const recovered = 'n > 1 AND approved = 1 AND attempted_at <= trial_ended_at + @window';
  return db
    .prepare(
      `${cte.sql}
       SELECT key,
              SUM(CASE WHEN n = 1 AND approved = 0 THEN 1 ELSE 0 END) AS first_declined,
              SUM(CASE WHEN n > 1 THEN 1 ELSE 0 END) AS retries,
              SUM(CASE WHEN ${recovered} THEN 1 ELSE 0 END) AS recovered,
              SUM(CASE WHEN n > 1 AND after_no_retry = 1 THEN 1 ELSE 0 END) AS no_retry_retries,
              SUM(CASE WHEN ${recovered} AND after_no_retry = 1 THEN 1 ELSE 0 END) AS no_retry_recovered,
              MAX(trial_ended_at - trial_started_at) AS max_len
       FROM x GROUP BY key`,
    )
    .all({ ...cte.params, window: o.retryWindowDays * DAY }) as unknown as (Counts & { key: string | number | null; max_len: number })[];
}

export function getRetries(db: Db, o: RangeOptions & { granularity: Granularity }) {
  const days = new Map<string, Counts>();
  let maxLength = 0;
  for (const { key, max_len, ...c } of sums(db, o, bucketSql('t', 't.trial_started_at'))) {
    const day = bucketDay(key, o.timeZones);
    days.set(day, add(days.get(day) ?? zero(), c));
    maxLength = Math.max(maxLength, max_len);
  }
  const series = groupDays(days, o, zero, add).map((p) => withRates({ ...p, final: finality(o, p.period_end, maxLength).final_retry }));
  const totals = withRates({ ...series.reduce<Counts>(add, zero()), final: finality(o, o.to, maxLength).final_retry });
  return { totals, series };
}

// Разбивка по измерению триала: по убыванию числа триалов с отказом, «не определено» — в конце
export function getRetryBreakdown(db: Db, o: RangeOptions, dimension: Dimension) {
  const groups = sums(db, o, DIMENSION_SQL[dimension]);
  const final = finality(o, o.to, Math.max(0, ...groups.map((g) => g.max_len))).final_retry;
  const rows = groups
    .map(({ key, max_len: _, ...c }) => withRates({ value: key === null ? null : String(key), ...c, final }))
    .filter((r) => r.first_declined + r.retries > 0)
    .sort((a, b) => Number(a.value === null) - Number(b.value === null) || b.first_declined - a.first_declined);
  return { totals: withRates({ ...rows.reduce<Counts>(add, zero()), final }), breakdown: rows };
}

// Отдача по номеру попытки: сколько попыток с этим номером и сколько прошло; 10 и дальше — одной строкой.
// recovered_share — какая доля всех восстановлений пришлась на попытки до этой включительно
export function getRetryCurve(db: Db, o: RangeOptions) {
  const cte = attemptsCte(o, "''");
  const rows = db
    .prepare(`${cte.sql} SELECT MIN(n, 10) AS attempt, COUNT(*) AS attempts, SUM(approved) AS approved FROM x GROUP BY attempt ORDER BY attempt`)
    .all(cte.params) as unknown as { attempt: number; attempts: number; approved: number }[];
  const recovered = rows.filter((r) => r.attempt > 1).reduce((s, r) => s + r.approved, 0);
  let cumulative = 0;
  return rows.map((r) => {
    if (r.attempt > 1) cumulative += r.approved;
    return { ...r, approval_rate: rate(r.approved, r.attempts), recovered_share: r.attempt === 1 ? null : rate(cumulative, recovered) };
  });
}

// Повторы по дням после первой попытки (31 и дальше — одной строкой): когда восстановления ещё приходят
export function getRetryDays(db: Db, o: RangeOptions) {
  const cte = attemptsCte(o, "''");
  const rows = db
    .prepare(`${cte.sql} SELECT MIN(day, 31) AS day, COUNT(*) AS retries, SUM(approved) AS approved FROM x WHERE n > 1 GROUP BY 1 ORDER BY 1`)
    .all(cte.params) as unknown as { day: number; retries: number; approved: number }[];
  return rows.map((r) => ({ ...r, approval_rate: rate(r.approved, r.retries) }));
}

// Что было после отказа с этим кодом: повторили ли и прошла ли следующая (или любая дальнейшая) попытка
export function getRetryCodes(db: Db, o: RangeOptions) {
  const cte = attemptsCte(o, "''");
  const rows = db
    .prepare(
      `${cte.sql}
       SELECT reason AS code, COUNT(*) AS declines, SUM(CASE WHEN next_approved IS NOT NULL THEN 1 ELSE 0 END) AS retried,
              SUM(CASE WHEN next_approved = 1 THEN 1 ELSE 0 END) AS next_approved, SUM(approved_later) AS approved_later
       FROM x WHERE approved = 0 GROUP BY reason`,
    )
    .all(cte.params) as unknown as { code: string | null; declines: number; retried: number; next_approved: number; approved_later: number }[];
  return rows
    .map((r) => {
      const group = declineLabel(r.code);
      return {
        ...r,
        group,
        hint: declineHint(group),
        no_retry: r.code !== null && NO_RETRY_CODES.includes(r.code),
        retried_share: rate(r.retried, r.declines),
        next_approval: rate(r.next_approved, r.retried),
        later_approval: rate(r.approved_later, r.retried),
      };
    })
    .sort((a, b) => b.declines - a.declines);
}

// Попытки для выгрузки: все попытки выборки или только с этим номером, днём после первой, кодом отказа
export function listRetryAttempts(db: Db, o: RangeOptions, only: { attempt?: number; day?: number; code?: string | null }, limit: number) {
  const cte = attemptsCte(o, "''");
  const where = ['1 = 1'];
  const params: Record<string, string | number> = { ...cte.params };
  // node:sqlite не принимает лишние параметры — передаём только используемые
  if (only.attempt !== undefined) {
    where.push(only.attempt >= 10 ? 'n >= 10' : 'n = @attempt');
    if (only.attempt < 10) params.attempt = only.attempt;
  }
  if (only.day !== undefined) {
    where.push('n > 1', only.day >= 31 ? 'day >= 31' : 'day = @day');
    if (only.day < 31) params.day = only.day;
  }
  if (only.code !== undefined) {
    where.push(only.code === null ? 'approved = 0 AND reason IS NULL' : 'approved = 0 AND reason = @code');
    if (only.code !== null) params.code = only.code;
  }
  return db
    .prepare(`${cte.sql} SELECT * FROM x WHERE ${where.join(' AND ')} ORDER BY trial_started_at, subscription_id, n LIMIT ${limit}`)
    .all(params) as unknown as {
    provider: string; account: string; subscription_id: string; customer_id: string | null; attempt_id: string; attempted_at: number;
    approved: number; reason: string | null; n: number; day: number; after_no_retry: number;
  }[];
}

export const isNoRetry = (code: string | null) => code !== null && NO_RETRY_CODES.includes(code);
