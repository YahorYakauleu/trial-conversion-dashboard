import type { Db } from './db.js';
import { groupDays } from './days.js';
import { bucketDay, bucketSql, DAY, dimensionFilterSql, periodSql, type ProviderFilter } from './metrics.js';
import { addDays, localMidnight } from './time.js';

// Visa VAMP (оценка) — по календарным месяцам UTC, отдельно для каждого мерчанта (MID; у Stripe MID — сам аккаунт).
// VAMP count = фрод-репорты Visa (TC40) + Visa-чарджбэки, не закрытые через RDR (TC15); если по списанию пришло и то и другое —
// считаются оба, как у Visa. Visa — по сети, через которую прошло списание, а не по бренду карты (Visa/CB через
// Cartes Bancaires, Visa debit через Pulse — не Visa). Событие попадает в месяц, когда пришло, а не когда было списание.
// VAMP ratio = count ÷ успешные Visa-списания того же месяца. Excessive — оба порога сразу (config.vamp).

// Измерения: первые три есть и у событий, и у платежей (ratio считается), риск и тип списания — только у событий
export const VAMP_DIMENSIONS = ['mid', 'country', 'payment_method', 'risk', 'charge_type'] as const;
export type VampDimension = (typeof VAMP_DIMENSIONS)[number];
export const VAMP_FILTERS = ['mid', 'country', 'payment_method'] as const;
export type VampFilters = Partial<Record<VampDimension, string[]>>;

const UTC = { stripe: 'UTC', solidgate: 'UTC' };

// Событие → его списание в payments: у Solidgate карта, страна и MID есть только там
const REPORTS = 'vamp_reports v LEFT JOIN payments p ON p.provider = v.provider AND p.payment_id = v.payment_id';
// сеть из самого события; если её нет (чарджбэк Solidgate с незнакомым кодом) — платёжная система списания
const NETWORK = 'COALESCE(v.network, p.card_brand)';
const REPORT_SQL: Record<VampDimension, string> = {
  mid: "v.provider || ':' || COALESCE(v.mid, p.mid)",
  country: 'COALESCE(v.country, p.country)',
  payment_method: 'COALESCE(v.payment_method, p.payment_method)',
  // Radar risk score Stripe; у Solidgate его нет
  risk: `CASE WHEN v.risk_score IS NULL THEN NULL WHEN v.risk_score < 20 THEN '0–19' WHEN v.risk_score < 50 THEN '20–49'
         WHEN v.risk_score < 75 THEN '50–74' ELSE '75–99' END`,
  // первый платёж после триала — успешная попытка первого инвойса (attempts); всё остальное — продления
  charge_type: `CASE WHEN EXISTS (SELECT 1 FROM attempts a WHERE a.provider = v.provider AND a.attempt_id = v.payment_id AND a.approved = 1)
                THEN 'first_payment' ELSE 'renewal' END`,
};
const PAYMENT_SQL: Partial<Record<VampDimension, string>> = {
  mid: "p.provider || ':' || p.mid",
  country: 'p.country',
  payment_method: 'p.payment_method',
};
// В VAMP: фрод-репорт Visa; Visa-чарджбэк без RDR (запросы документов — не чарджбэк)
const FRAUD = `${NETWORK} = 'visa' AND v.kind = 'fraud'`;
const CHARGEBACK = `${NETWORK} = 'visa' AND v.kind = 'dispute' AND v.case_type = 'chargeback'`;
export const COUNTED = `((${FRAUD}) OR (${CHARGEBACK} AND v.rdr = 0))`;

export interface VampOptions {
  provider: ProviderFilter;
  filters: VampFilters;
  from: string; // первый день (UTC), обычно начало месяца
  to: string; // последний день включительно
  now: number;
}
export interface Thresholds {
  ratio: number;
  count: number;
}

interface Counts {
  fraud: number; // фрод-репорты Visa (TC40)
  disputes: number; // Visa-чарджбэки без RDR (TC15)
  rdr: number; // Visa-диспуты, закрытые через RDR, — в VAMP не идут
  rdr_lost: number; // сколько по ним списано, центы USD
  visa_sales: number; // успешные Visa-списания
}
export type VampStatus = 'excessive' | 'at_risk' | 'ok';
export interface VampTotals extends Counts {
  vamp_count: number;
  vamp_ratio: number | null;
  forecast_count: number | null; // у незакончившегося месяца — count к его концу при нынешнем темпе
  final: boolean; // месяц закончился (и прошли сутки — события доходят с задержкой)
  status: VampStatus | null; // только у одного мерчанта за один месяц
}

const zero = (): Counts => ({ fraud: 0, disputes: 0, rdr: 0, rdr_lost: 0, visa_sales: 0 });
const add = (a: Counts, b: Counts): Counts => ({
  fraud: a.fraud + b.fraud,
  disputes: a.disputes + b.disputes,
  rdr: a.rdr + b.rdr,
  rdr_lost: a.rdr_lost + b.rdr_lost,
  visa_sales: a.visa_sales + b.visa_sales,
});

export const monthStart = (day: string) => `${day.slice(0, 8)}01`;
const monthEnd = (day: string) => addDays(`${addDays(monthStart(day), 32).slice(0, 8)}01`, -1);

// Окончательность и прогноз месяца, в который входят дни from…to (UTC)
function monthState(from: string, to: string, now: number) {
  const start = localMidnight(monthStart(from), 'UTC');
  const end = localMidnight(addDays(monthEnd(to), 1), 'UTC');
  const final = end + DAY <= now;
  const elapsed = Math.min(now, end) - start;
  return { final, scale: now < end && elapsed > 0 ? (end - start) / elapsed : null };
}

export function vampStatus(count: number, ratio: number | null, forecast: number | null, t: Thresholds): VampStatus {
  const overRatio = ratio !== null && ratio >= t.ratio;
  if (overRatio && count >= t.count) return 'excessive';
  if (overRatio || Math.max(count, forecast ?? 0) >= t.count) return 'at_risk';
  return 'ok';
}

function withTotals(c: Counts, state: { final: boolean; scale: number | null }, status: (count: number, ratio: number | null, forecast: number | null) => VampStatus | null): VampTotals {
  const vamp_count = c.fraud + c.disputes;
  const vamp_ratio = c.visa_sales === 0 ? null : vamp_count / c.visa_sales;
  const forecast_count = state.scale === null ? null : Math.round(vamp_count * state.scale);
  return { ...c, vamp_count, vamp_ratio, forecast_count, final: state.final, status: status(vamp_count, vamp_ratio, forecast_count) };
}

// События за период по группам (key — SQL-выражение)
function reportCounts(db: Db, o: VampOptions, key: string) {
  const period = periodSql('v', 'v.reported_at', { ...o, timeZones: UTC });
  const filters = dimensionFilterSql(REPORT_SQL, o.filters);
  return db
    .prepare(
      `SELECT ${key} AS key,
              SUM(CASE WHEN ${FRAUD} THEN 1 ELSE 0 END) AS fraud,
              SUM(CASE WHEN ${CHARGEBACK} AND v.rdr = 0 THEN 1 ELSE 0 END) AS disputes,
              SUM(CASE WHEN ${CHARGEBACK} AND v.rdr = 1 THEN 1 ELSE 0 END) AS rdr,
              SUM(CASE WHEN ${CHARGEBACK} AND v.rdr = 1 THEN v.lost_usd_cents ELSE 0 END) AS rdr_lost
       FROM ${REPORTS}
       WHERE ${[period.sql, "(@provider = 'all' OR v.provider = @provider)", ...filters.clauses].join(' AND ')}
       GROUP BY key`,
    )
    .all({ ...period.params, ...filters.params, provider: o.provider }) as unknown as (Omit<Counts, 'visa_sales'> & { key: string | number | null })[];
}

// Успешные Visa-списания VPN за период по группам; null — у измерения нет платежей (риск, тип списания) или им фильтруют
function salesCounts(db: Db, o: VampOptions, key: string | undefined) {
  const filtered = Object.keys(o.filters).filter((d) => (o.filters[d as VampDimension] ?? []).length);
  if (key === undefined || filtered.some((d) => !PAYMENT_SQL[d as VampDimension])) return null;
  const period = periodSql('p', 'p.paid_at', { ...o, timeZones: UTC });
  const filters = dimensionFilterSql(PAYMENT_SQL, o.filters);
  const where = [period.sql, "p.product = 'vpn'", "p.card_brand = 'visa'", "(@provider = 'all' OR p.provider = @provider)", ...filters.clauses];
  return db
    .prepare(`SELECT ${key} AS key, COUNT(*) AS visa_sales FROM payments p WHERE ${where.join(' AND ')} GROUP BY key`)
    .all({ ...period.params, ...filters.params, provider: o.provider }) as unknown as { key: string | number | null; visa_sales: number }[];
}

// корзины по 15 минут → сутки UTC
const daysOf = <T extends { key: string | number | null }>(rows: T[]) => rows.map((r) => ({ ...r, key: bucketDay(r.key, UTC) }));

// Мерчанты в выборке — у одного мерчанта есть статус
function merchants(db: Db, o: VampOptions): (string | null)[] {
  const keys = new Set<string | null>(reportCounts(db, o, REPORT_SQL.mid).map((r) => (r.key === null ? null : String(r.key))));
  for (const r of salesCounts(db, o, PAYMENT_SQL.mid) ?? []) keys.add(r.key === null ? null : String(r.key));
  return [...keys];
}

// Помесячно за период (месяцы, обрезанные периодом, подписаны его днями)
export function getVampSeries(db: Db, o: VampOptions, t: Thresholds) {
  const byDay = new Map<string, Counts>();
  const put = (day: string, c: Partial<Counts>) => byDay.set(day, add(byDay.get(day) ?? zero(), { ...zero(), ...c }));
  for (const { key, ...c } of daysOf(reportCounts(db, o, bucketSql('v', 'v.reported_at')))) put(key, c);
  for (const { key, visa_sales } of daysOf(salesCounts(db, o, bucketSql('p', 'p.paid_at')) ?? [])) put(key, { visa_sales });
  const single = merchants(db, o).length === 1;
  return groupDays(byDay, { ...o, granularity: 'month' }, zero, add).map((m) => ({
    ...m,
    ...withTotals(m, monthState(m.period, m.period_end, o.now), (count, ratio, forecast) => (single ? vampStatus(count, ratio, forecast, t) : null)),
  }));
}

// Разбивка за один месяц (from…to внутри месяца): по убыванию count, «не определено» — в конце.
// Статус — только у мерчантов (MID); у риска и типа списания платежей нет — ratio нет
export function getVampBreakdown(db: Db, o: VampOptions, dimension: VampDimension, t: Thresholds) {
  const rows = new Map<string | null, Counts>();
  const put = (key: string | number | null, c: Partial<Counts>) => {
    const value = key === null ? null : String(key);
    rows.set(value, add(rows.get(value) ?? zero(), { ...zero(), ...c }));
  };
  for (const { key, ...c } of reportCounts(db, o, REPORT_SQL[dimension])) put(key, c);
  const sales = salesCounts(db, o, PAYMENT_SQL[dimension]);
  for (const { key, visa_sales } of sales ?? []) put(key, { visa_sales });
  const state = monthState(o.from, o.to, o.now);
  const total = [...rows.values()].reduce((s, c) => s + c.fraud + c.disputes, 0);
  return [...rows]
    .map(([value, c]) => {
      const totals = withTotals(c, state, (count, ratio, forecast) => (dimension === 'mid' ? vampStatus(count, ratio, forecast, t) : null));
      return { value, ...totals, vamp_ratio: sales ? totals.vamp_ratio : null, share: total === 0 ? null : totals.vamp_count / total };
    })
    .filter((r) => r.vamp_count + r.rdr > 0 || (dimension === 'mid' && r.visa_sales > 0))
    .sort((a, b) => Number(a.value === null) - Number(b.value === null) || b.vamp_count - a.vamp_count || b.visa_sales - a.visa_sales);
}

// Итог месяца: суммы и статус (если мерчант один); сколько мерчантов в каком статусе
export function getVampMonth(db: Db, o: VampOptions, t: Thresholds) {
  const byMerchant = getVampBreakdown(db, o, 'mid', t);
  const counts = byMerchant.reduce<Counts>(add, zero());
  const totals = withTotals(counts, monthState(o.from, o.to, o.now), (count, ratio, forecast) =>
    byMerchant.length === 1 ? vampStatus(count, ratio, forecast, t) : null,
  );
  const statuses = { excessive: 0, at_risk: 0, ok: 0 };
  for (const m of byMerchant) if (m.status) statuses[m.status]++;
  return { ...totals, merchants: byMerchant.length, statuses };
}

// Накопленный count по дням месяца — для этого и прошлого месяца
export function getVampDaily(db: Db, o: VampOptions, month: string) {
  const cumulative = (first: string) => {
    const last = monthEnd(first);
    const until = o.to < last && o.to >= first ? o.to : last;
    const counts = new Map<string, number>();
    for (const { key, fraud, disputes } of daysOf(reportCounts(db, { ...o, from: first, to: until }, bucketSql('v', 'v.reported_at')))) {
      counts.set(key, (counts.get(key) ?? 0) + fraud + disputes);
    }
    let sum = 0;
    const days: number[] = [];
    for (let day = first; day <= until; day = addDays(day, 1)) days.push((sum += counts.get(day) ?? 0));
    return days;
  };
  const previous = monthStart(addDays(month, -1));
  return { month, previous_month: previous, current: cumulative(month), previous: cumulative(previous) };
}

// События Visa за период — для выгрузки списком; counted — входит ли в VAMP count
export function listVampReports(db: Db, o: VampOptions, limit: number) {
  const period = periodSql('v', 'v.reported_at', { ...o, timeZones: UTC });
  const filters = dimensionFilterSql(REPORT_SQL, o.filters);
  const where = [period.sql, "(@provider = 'all' OR v.provider = @provider)", `${NETWORK} = 'visa'`, ...filters.clauses];
  return db
    .prepare(
      `SELECT v.provider, v.account, ${REPORT_SQL.mid} AS mid, v.kind, v.report_id, v.reported_at, v.payment_id,
              COALESCE(v.charged_at, p.paid_at) AS charged_at, ${REPORT_SQL.country} AS country, ${REPORT_SQL.payment_method} AS payment_method,
              v.risk_score, ${REPORT_SQL.charge_type} AS charge_type, v.reason, v.case_type, v.rdr, v.lost_usd_cents, v.customer_id,
              CASE WHEN ${COUNTED} THEN 1 ELSE 0 END AS counted
       FROM ${REPORTS} WHERE ${where.join(' AND ')}
       ORDER BY v.reported_at, v.report_id LIMIT ${limit}`,
    )
    .all({ ...period.params, ...filters.params, provider: o.provider }) as unknown as {
    provider: string; account: string; mid: string | null; kind: 'fraud' | 'dispute'; report_id: string; reported_at: number; payment_id: string | null;
    charged_at: number | null; country: string | null; payment_method: string | null; risk_score: number | null; charge_type: string;
    reason: string | null; case_type: string | null; rdr: number; lost_usd_cents: number; customer_id: string | null; counted: number;
  }[];
}
