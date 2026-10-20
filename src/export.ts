import { AFTER_TRIAL, cancelCodes, cancelLabel, IN_TRIAL } from './cancellations.js';
import type { Db } from './db.js';
import { declineCodes, declineLabel } from './declines.js';
import { cohortCte, ordersCte, type EsimOptions } from './esim.js';
import { DAY, trialFilter, type RangeOptions } from './metrics.js';
import { isNoRetry, listRetryAttempts } from './retries.js';
import { paymentFilter, type TurnoverOptions } from './turnover.js';
import { listVampReports, type Outcome, type VampOptions, type VampRules } from './vamp.js';

// Выгрузка списком: записи, из которых посчитана цифра на экране, — с их ID в Stripe и Solidgate,
// чтобы точечно посмотреть детали в кабинете провайдера. Для Stripe — ещё и ссылки на объект в дашборде Stripe.
export const EXPORT_LIMIT = 100_000;

export interface ExportTable {
  columns: string[];
  rows: (string | number)[][];
  truncated: boolean; // строк больше EXPORT_LIMIT — выгружены первые
}

// ID аккаунтов Stripe — для ссылок вида dashboard.stripe.com/<аккаунт>/payments/ch_…; для других аккаунтов ссылки нет
const STRIPE_ACCOUNT_IDS: Record<string, string> = {
  corp: 'acct_1TM4VlLTzrJvLtxV',
  org: 'acct_1RZWzMIKBsaJbbXt',
  incorp: 'acct_1TM3AfIV1MMFi0Ss',
  esim: 'acct_1TGeCJLBLXzWKftL',
};
const stripeLink = (provider: string, account: string, path: string, id: string | null) =>
  provider === 'stripe' && id && STRIPE_ACCOUNT_IDS[account] ? `https://dashboard.stripe.com/${STRIPE_ACCOUNT_IDS[account]}/${path}/${id}` : '';

const utc = (ts: number | null) => (ts === null ? '' : new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' '));
const dollars = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2));
const yesNo = (value: unknown) => (value === null || value === undefined ? '' : value ? 'yes' : 'no');
const text = (value: string | number | null | undefined) => value ?? '';

// Строк на одну больше лимита — чтобы понять, что выгрузка обрезана
const limited = <T>(rows: T[]) => ({ rows: rows.slice(0, EXPORT_LIMIT), truncated: rows.length > EXPORT_LIMIT });

// Условие «причина из группы» для строки вкладки причин (отказы списания или отмены подписки)
function reasonSql(column: string, label: string | null, codesOf = declineCodes) {
  if (!label) return { sql: '1 = 1', params: {} };
  const { codes, withoutCode } = codesOf(label);
  const params = Object.fromEntries(codes.map((code, i) => [`reason_${i}`, code]));
  const parts = [codes.length ? `${column} IN (${codes.map((_, i) => `@reason_${i}`).join(', ')})` : '', withoutCode ? `${column} IS NULL` : ''];
  return { sql: `(${parts.filter(Boolean).join(' OR ')})`, params };
}

// --- VPN

// Триалы когорты (Conversion: динамика и разрезы). canceled — только отменённые (Cancellations; по строке причины — её группа)
export function exportTrials(db: Db, o: RangeOptions, canceled: { reason: string | null } | null = null): ExportTable {
  const filter = trialFilter(o);
  const byReason = reasonSql('t.cancel_reason', canceled?.reason ?? null, cancelCodes);
  const onlyCanceled = canceled ? ` AND ((${IN_TRIAL}) OR (${AFTER_TRIAL})) AND ${byReason.sql}` : '';
  type Row = Record<string, string | number | null>;
  const all = db
    .prepare(`SELECT t.* FROM trials t WHERE ${filter.sql}${onlyCanceled} ORDER BY t.trial_started_at, t.subscription_id LIMIT ${EXPORT_LIMIT + 1}`)
    .all({ ...filter.params, ...(canceled ? { ...byReason.params, window: o.retryWindowDays * DAY } : {}) }) as Row[];
  const { rows, truncated } = limited(all);
  const window = o.retryWindowDays * DAY;
  return {
    columns: [
      'provider', 'account', 'subscription_id', 'customer_id', 'first_invoice_id', 'trial_started_utc', 'trial_ended_utc',
      'paid_within_30_days', 'paid_utc', 'paid_on_first_attempt', 'attempts', 'declines', 'refunded',
      'mid', 'card_country', 'payment_method', 'card_brand', 'issuing_bank',
      'canceled_utc', 'canceled_on_day', 'cancellation', 'cancel_reason', 'cancel_code', 'fraud_reported', 'vamp_events',
      'revenue_30d_usd', 'revenue_60d_usd', 'revenue_90d_usd', 'periods_paid_90d', 'subscription_link', 'customer_link',
    ],
    rows: rows.map((t) => {
      const [provider, account] = [String(t.provider), String(t.account)];
      const paid = t.paid_at !== null && Number(t.paid_at) <= Number(t.trial_ended_at) + window;
      const canceledAt = t.canceled_at === null ? null : Number(t.canceled_at);
      // день отмены от оформления (1 — первые 24 часа, как на экране); во время триала или уже после его конца
      const cancelDay = canceledAt === null ? '' : Math.floor((canceledAt - Number(t.trial_started_at)) / DAY) + 1;
      const when = canceledAt === null ? '' : canceledAt < Number(t.trial_ended_at) ? 'in trial' : 'after trial';
      return [
        provider, account, text(t.subscription_id), text(t.customer_id), text(t.first_invoice_id),
        utc(t.trial_started_at as number), utc(t.trial_ended_at as number),
        yesNo(paid), utc(t.paid_at as number | null), yesNo(t.first_attempt_succeeded), text(t.attempts), Number(t.attempts) - Number(t.approved), yesNo(t.refunded),
        text(t.mid), text(t.country), text(t.payment_method), text(t.card_brand), text(t.bank),
        utc(canceledAt), cancelDay, when, canceledAt === null ? '' : cancelLabel(t.cancel_reason as string | null), text(t.cancel_reason),
        yesNo(t.fraud_flagged), Number(t.vamp_events),
        dollars(Number(t.ltv_30)), dollars(Number(t.ltv_60)), dollars(Number(t.ltv_90)), Number(t.periods_90),
        stripeLink(provider, account, 'subscriptions', t.subscription_id as string), stripeLink(provider, account, 'customers', t.customer_id as string | null),
      ];
    }),
    truncated,
  };
}

// Отклонённые попытки первого платежа (Conversion: Decline reasons), по строке причины — только её группа
export function exportDeclinedAttempts(db: Db, o: RangeOptions, reason: string | null): ExportTable {
  const filter = trialFilter(o);
  const byReason = reasonSql('x.reason', reason);
  type Row = Record<string, string | number | null>;
  const all = db
    .prepare(
      `SELECT * FROM (
         SELECT a.*, t.account, t.customer_id,
                ROW_NUMBER() OVER (PARTITION BY a.provider, a.subscription_id ORDER BY a.attempted_at, a.attempt_id) AS attempt_number
         FROM attempts a JOIN trials t ON t.provider = a.provider AND t.subscription_id = a.subscription_id
         WHERE ${filter.sql}
       ) x WHERE x.approved = 0 AND ${byReason.sql} ORDER BY x.attempted_at, x.attempt_id LIMIT ${EXPORT_LIMIT + 1}`,
    )
    .all({ ...filter.params, ...byReason.params }) as Row[];
  const { rows, truncated } = limited(all);
  return {
    columns: ['provider', 'account', 'attempt_id', 'subscription_id', 'customer_id', 'attempted_utc', 'attempt_number', 'decline_reason', 'decline_code', 'attempt_link', 'subscription_link'],
    rows: rows.map((a) => {
      const [provider, account] = [String(a.provider), String(a.account)];
      return [
        provider, account, text(a.attempt_id), text(a.subscription_id), text(a.customer_id), utc(a.attempted_at as number), text(a.attempt_number),
        declineLabel(a.reason as string | null), text(a.reason),
        stripeLink(provider, account, 'payments', a.attempt_id as string), stripeLink(provider, account, 'subscriptions', a.subscription_id as string),
      ];
    }),
    truncated,
  };
}

// Успешные платежи (Volume)
export function exportPayments(db: Db, o: TurnoverOptions): ExportTable {
  const filter = paymentFilter(o);
  type Row = Record<string, string | number | null>;
  const all = db
    .prepare(`SELECT p.* FROM payments p WHERE ${filter.sql} ORDER BY p.paid_at, p.payment_id LIMIT ${EXPORT_LIMIT + 1}`)
    .all(filter.params) as Row[];
  const { rows, truncated } = limited(all);
  return {
    columns: ['provider', 'account', 'mid', 'payment_id', 'paid_utc', 'amount_usd', 'refunded_usd', 'card_country', 'payment_method', 'card_brand', 'issuing_bank', 'payment_link'],
    rows: rows.map((p) => {
      const [provider, account] = [String(p.provider), String(p.account)];
      return [
        provider, account, text(p.mid), text(p.payment_id), utc(p.paid_at as number), dollars(p.amount_usd_cents as number), dollars(p.refunded_usd_cents as number),
        text(p.country), text(p.payment_method), text(p.card_brand), text(p.bank), stripeLink(provider, account, 'payments', p.payment_id as string),
      ];
    }),
    truncated,
  };
}

// Ретраи: попытки списания первого платежа — все или только с этим номером, днём после первой попытки, кодом отказа
export function exportRetryAttempts(db: Db, o: RangeOptions, only: { attempt?: number; day?: number; code?: string | null }): ExportTable {
  const { rows, truncated } = limited(listRetryAttempts(db, o, only, EXPORT_LIMIT + 1));
  return {
    columns: [
      'provider', 'account', 'subscription_id', 'customer_id', 'attempt_id', 'attempt_number', 'attempted_utc', 'days_after_first_attempt',
      'approved', 'decline_code', 'decline_reason', 'no_retry_code', 'after_no_retry_decline', 'payment_link', 'subscription_link',
    ],
    rows: rows.map((a) => [
      a.provider, a.account, a.subscription_id, text(a.customer_id), a.attempt_id, a.n, utc(a.attempted_at), a.day, yesNo(a.approved),
      a.approved ? '' : text(a.reason), a.approved ? '' : declineLabel(a.reason), a.approved ? '' : yesNo(isNoRetry(a.reason)), yesNo(a.after_no_retry),
      stripeLink(a.provider, a.account, 'payments', a.attempt_id), stripeLink(a.provider, a.account, 'subscriptions', a.subscription_id),
    ]),
    truncated,
  };
}

// Visa VAMP: фрод-репорты и диспуты Visa; counted_in_vamp — входит ли в VAMP count (RDR и запросы документов — нет)
export function exportVampReports(db: Db, o: VampOptions, rules: VampRules, outcome: Outcome | null = null): ExportTable {
  const { rows, truncated } = limited(listVampReports(db, o, rules, EXPORT_LIMIT + 1, outcome));
  const event = (r: (typeof rows)[number]) =>
    r.kind === 'fraud' ? 'fraud report (TC40)' : r.case_type !== 'chargeback' ? (r.case_type ?? 'dispute') : r.rdr ? 'chargeback, RDR' : 'chargeback (TC15)';
  // номер платежа подписки: 0 — оплата триала, before_history — подписка оформлена раньше истории дашборда
  const paymentNumber = (n: string | null) => (n === 'trial_fee' ? 'trial fee' : n === 'before_history' ? 'subscription older than history' : text(n));
  return {
    columns: [
      'provider', 'account', 'visa_merchant', 'mid', 'event', 'counted_in_vamp', 'after_report', 'report_id', 'reported_utc', 'payment_id', 'charged_utc',
      'days_to_report', 'amount_usd', 'payment_number', 'card_country', 'payment_method', 'issuing_bank', 'card_type', 'radar_risk_score', 'reason',
      'utm_source', 'campaign_id', 'campaign_name', 'landing_domain', 'rdr_lost_usd', 'customer_id', 'payment_link', 'customer_link',
    ],
    rows: rows.map((r) => [
      r.provider, r.account, text(r.merchant), text(r.mid), event(r), yesNo(r.counted), text(r.outcome), r.report_id, utc(r.reported_at), text(r.payment_id), utc(r.charged_at),
      text(r.days_to_report), dollars(r.amount_usd_cents), paymentNumber(r.payment_number), text(r.country), text(r.payment_method), text(r.bank), text(r.funding),
      text(r.risk_score), text(r.reason), text(r.utm_source), text(r.campaign_id), text(r.campaign_name), text(r.landing_domain),
      r.rdr ? dollars(r.lost_usd_cents) : '', text(r.customer_id),
      stripeLink(r.provider, r.account, 'payments', r.payment_id), stripeLink(r.provider, r.account, 'customers', r.customer_id),
    ]),
    truncated,
  };
}

// --- eSIM (аккаунт Stripe esim)

// Заказы (Overview); на вкладке Decline reasons — только неоплаченные, по строке причины — с этой причиной последней попытки
export function exportOrders(db: Db, o: EsimOptions, unpaid: { reason: string | null } | null): ExportTable {
  const cte = ordersCte(o, "''");
  const byReason = reasonSql('last_reason', unpaid?.reason ?? null);
  type Row = Record<string, string | number | null>;
  const all = db
    .prepare(`${cte.sql} SELECT * FROM orders WHERE ${unpaid ? `paid = 0 AND ${byReason.sql}` : '1 = 1'} ORDER BY started_at, order_id LIMIT ${EXPORT_LIMIT + 1}`)
    .all({ ...cte.params, ...byReason.params }) as Row[];
  const { rows, truncated } = limited(all);
  return {
    columns: [
      'order_id', 'customer_id', 'started_utc', 'status', 'new_customer', 'order_type', 'destination', 'package', 'amount_usd', 'revenue_usd',
      'attempts', 'decline_reason', 'decline_code', 'card_country', 'payment_method', 'card_brand', 'issuing_bank', 'charge_ids', 'order_link', 'customer_link',
    ],
    rows: rows.map((r) => {
      const status = r.paid ? 'paid' : r.fraud ? 'blocked as fraud' : 'not paid';
      return [
        text(r.order_id), text(r.customer_id), utc(r.started_at as number), status, r.paid ? yesNo(r.first_purchase) : '', text(r.order_type),
        text(r.destination), text(r.package), dollars(r.amount as number), dollars(r.revenue as number), text(r.attempts),
        r.paid ? '' : declineLabel(r.last_reason as string | null), r.paid ? '' : text(r.last_reason),
        text(r.country), text(r.payment_method), text(r.card_brand), text(r.bank), text(r.charge_ids),
        stripeLink('stripe', 'esim', 'payments', r.order_id as string), stripeLink('stripe', 'esim', 'customers', r.customer_id as string | null),
      ];
    }),
    truncated,
  };
}

// Новые клиенты когорты (Retention)
export function exportCustomers(db: Db, o: EsimOptions): ExportTable {
  const cte = cohortCte(o);
  type Row = Record<string, string | number | null>;
  const all = db.prepare(`${cte.sql} SELECT * FROM cohort ORDER BY paid_at, customer_id LIMIT ${EXPORT_LIMIT + 1}`).all(cte.params) as Row[];
  const { rows, truncated } = limited(all);
  return {
    columns: [
      'customer_id', 'first_purchase_utc', 'first_order_id', 'destination', 'package', 'card_country', 'payment_method', 'card_brand', 'issuing_bank',
      'returned_within_30_days', 'second_purchase_utc', 'revenue_90_days_usd', 'customer_link',
    ],
    rows: rows.map((c) => {
      const first = Number(c.paid_at);
      const second = c.second_at === null ? null : Number(c.second_at);
      // ещё не прошло 30 дней и снова не покупал — пока неизвестно
      const returned = second !== null && second < first + 30 * DAY ? 'yes' : o.now < first + 30 * DAY ? 'not yet' : 'no';
      return [
        text(c.customer_id), utc(first), text(c.intent_id ?? c.payment_id), text(c.destination), text(c.package), text(c.country), text(c.payment_method), text(c.card_brand), text(c.bank),
        returned, utc(second), dollars(c.revenue_90 as number), stripeLink('stripe', 'esim', 'customers', c.customer_id as string),
      ];
    }),
    truncated,
  };
}

// CSV с BOM — чтобы Numbers и Excel сразу открыли UTF-8
export function toCsv(table: ExportTable): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [table.columns, ...table.rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
