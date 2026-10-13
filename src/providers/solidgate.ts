import type { SolidgateAccount } from '../config.js';
import { toAlpha2 } from '../countries.js';
import type { AttemptRow, CardDetails, PaymentRow, Store, TrialRow } from '../db.js';
import type { ToUsd } from '../fx.js';
import { DAY, dayKey } from '../metrics.js';
import {
  listCardOrders,
  listSubscriptions,
  type ReportFilter,
  type SgCardOrder,
  type SgInvoice,
  type SgOrder,
  type SgSubscription,
} from './solidgate-client.js';

const FIRST_INVOICE_TOLERANCE = 3_600;
// Заказ оформления создаётся на секунды раньше подписки — окно заказов начинаем на час раньше
const ORDERS_LOOKBACK = 3_600;
// Неудачная попытка — order recurring/auth_failed; успешная — order settle/settle_ok.
// refunded — значит, списание было (и потом вернули деньги).
const SUCCESS = new Set(['approved', 'settle_ok', 'auth_ok', 'refunded']);
const PENDING = new Set(['created', 'processing', '3ds_verify']);
// Версия набора данных по триалу: 2 — способ оплаты, платёжная система, банк, попытки, причины отказа, рефанды
const DETAILS_VERSION = 2;
// Версия данных из отчёта заказов: 1 — платежи для оборота, 2 — MID триала.
// База, выгруженная раньше, один раз проходит заказы с HISTORY_FROM (это минуты, поэтому и после бэкфилла тоже).
const ORDERS_VERSION = 2;
// Деньги списаны: settle_ok, а refunded — списали и потом вернули (сумма возврата — в refunded_amount)
const CHARGED = new Set(['settle_ok', 'refunded']);
// Способ оплаты Solidgate → как в Stripe. token — списание по сохранённой карте: сам способ не говорит,
// но у транзакции есть original_payment_method — каким способом карту сохранили
const PAYMENT_METHODS: Record<string, string> = { 'apple-pay': 'apple_pay', 'google-pay': 'google_pay', card: 'card', 'paypal-vault': 'paypal' };

export function parseSgDate(value: string): number {
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  const zoned = /([zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`;
  return Math.floor(Date.parse(zoned) / 1000);
}

export function trialFromSolidgate(sub: SgSubscription, account: string): TrialRow | null {
  const period = trialPeriod(sub);
  if (!period) return null;

  const row: TrialRow = {
    provider: 'solidgate',
    account,
    subscription_id: sub.id,
    trial_started_at: period.start,
    trial_ended_at: period.end,
    first_invoice_id: null,
    first_attempt_succeeded: null,
    paid_at: null,
    // в отчёте подписок данных карты и MID нет — они берутся из заказов (orderCardDetails)
    country: null,
    payment_method: null,
    card_brand: null,
    bank: null,
    mid: null,
  };

  const firstPaid = firstPaidInvoice(sub, period.end);
  if (!firstPaid) return row;

  const orders = sortedOrders(firstPaid);
  const firstSuccess = orders.find((o) => SUCCESS.has(o.status));
  return {
    ...row,
    first_invoice_id: firstPaid.id,
    first_attempt_succeeded: firstAttempt(orders[0]),
    paid_at: firstSuccess ? parseSgDate(firstSuccess.processed_at ?? firstSuccess.created_at) : null,
  };
}

// Попытки списания первого платного периода; попытки «в процессе» ещё не считаем
export function attemptsFromSolidgate(sub: SgSubscription): AttemptRow[] {
  const period = trialPeriod(sub);
  const firstPaid = period ? firstPaidInvoice(sub, period.end) : null;
  if (!firstPaid) return [];
  return sortedOrders(firstPaid)
    .filter((o) => !PENDING.has(o.status))
    .map((o) => ({
      provider: 'solidgate' as const,
      attempt_id: o.id,
      subscription_id: sub.id,
      attempted_at: parseSgDate(o.created_at),
      approved: SUCCESS.has(o.status),
      reason: null, // код отказа есть только в отчёте заказов — проставляется оттуда
      refunded: o.status === 'refunded',
    }));
}

// У неоплаченных инвойсов нет billing_period_started_at — датируем по created_at.
// Номер периода 0 — триал, 1 — первый платный; если номера нет, отбираем по времени.
function firstPaidInvoice(sub: SgSubscription, trialEnd: number): SgInvoice | null {
  const invoiceTime = (i: SgInvoice) => parseSgDate(i.created_at ?? i.billing_period_started_at);
  const isAfterTrial = (i: SgInvoice) =>
    i.subscription_term_number !== undefined ? i.subscription_term_number >= 1 : invoiceTime(i) >= trialEnd - FIRST_INVOICE_TOLERANCE;
  return (
    Object.values(sub.invoices ?? {})
      .filter((i) => i.amount > 0 && isAfterTrial(i))
      .sort((a, b) => invoiceTime(a) - invoiceTime(b))[0] ?? null
  );
}

const sortedOrders = (invoice: SgInvoice) =>
  Object.values(invoice.orders ?? {}).sort((a, b) => parseSgDate(a.created_at) - parseSgDate(b.created_at));

// Триал = продукт с триалом и подписка, которая реально стартовала. Без started_at — не прошла
// авторизация на $0 при оформлении, триала не было. Флаг sub.trial значит «сейчас в триале» — не подходит.
// trial_period — в минутах (10080 = 7 дней, проверено на живых данных sgH2H).
function trialPeriod(sub: SgSubscription): { start: number; end: number } | null {
  const minutes = sub.product?.trial ? (sub.product.trial_period ?? 0) : 0;
  if (minutes <= 0 || !sub.started_at) return null;
  const start = parseSgDate(sub.started_at);
  return { start, end: start + minutes * 60 };
}

// Данные карты из заказа: страна (трёхбуквенный код → двухбуквенный, как в Stripe), способ оплаты, система, банк
export function orderCardDetails(order: SgCardOrder): CardDetails {
  const transactions = Object.values(order.transactions ?? {});
  const card = transactions.find((t) => t.card)?.card ?? order.card;
  const savedWith = transactions.find((t) => t.original_payment_method)?.original_payment_method ?? '';
  return {
    country: toAlpha2(card?.country),
    payment_method: PAYMENT_METHODS[order.payment_method ?? ''] ?? PAYMENT_METHODS[savedWith] ?? null,
    card_brand: card?.brand ? card.brand.toLowerCase() : null,
    bank: card?.bank?.trim() || null,
  };
}

// Платный заказ, по которому списали деньги, → платёж для оборота. Заказы на $0 (проверка карты при оформлении триала) — не оборот.
// Сумму берём в валюте процессинга: Solidgate часто уже перевёл её в USD; иначе — по курсу дня.
export async function paymentFromOrder(order: SgCardOrder, account: string, toUsd: ToUsd): Promise<PaymentRow | null> {
  if (!order.amount || order.amount <= 0 || !CHARGED.has(order.status ?? '') || !order.created_at || !order.currency) return null;
  const paidAt = parseSgDate(order.created_at);
  const amountUsd = order.processing_amount && order.processing_currency
    ? await toUsd(order.processing_amount, order.processing_currency, paidAt)
    : await toUsd(order.amount, order.currency, paidAt);
  if (amountUsd === null) return null;
  return {
    provider: 'solidgate',
    payment_id: order.order_id,
    account,
    mid: order.mid ?? null,
    paid_at: paidAt,
    amount_usd_cents: amountUsd,
    // возврат — в валюте заказа, переводим той же долей
    refunded_usd_cents: Math.round((amountUsd * Math.min(order.refunded_amount ?? 0, order.amount)) / order.amount),
    ...orderCardDetails(order),
  };
}

function firstAttempt(order: SgOrder | undefined): boolean | null {
  if (!order || PENDING.has(order.status)) return null;
  return SUCCESS.has(order.status);
}

interface SolidgateSyncConfig {
  historyFrom: number;
  toUsd: ToUsd;
}

// Отчёт подписок отдаёт подписку целиком (с инвойсами и попытками) — строка триала каждый раз собирается заново.
// Отчёт заказов дополняет: данные карты (у каждого заказа есть subscription_id), код отказа и рефанд (по id попытки),
// а успешные платные заказы — это платежи для оборота.
// Без курсора — бэкфилл подписок, созданных с HISTORY_FROM; затем изменения с (курсор − 1 день):
// подписки и заказы по дате изменения — так доходят и рефанды старых платежей.
export async function syncSolidgateAccount(
  store: Store,
  acc: SolidgateAccount,
  cfg: SolidgateSyncConfig,
  now: number,
  list = listSubscriptions,
  listOrders = listCardOrders,
): Promise<number> {
  const cursor = store.getState('solidgate', acc.account, 'cursor');
  let items = 0;

  const saveSubscriptions = async (from: number, to: number, filter: ReportFilter) => {
    for await (const sub of list(acc, from, to, filter)) {
      const row = trialFromSolidgate(sub, acc.account);
      if (!row) continue;
      store.upsertTrial(row);
      for (const attempt of attemptsFromSolidgate(sub)) store.upsertAttempt(attempt);
      items++;
    }
  };
  const saveOrders = (filter: ReportFilter) => async (from: number, to: number) => {
    for await (const order of listOrders(acc, from - ORDERS_LOOKBACK, to, filter)) {
      // MID у подписки один: карту проверяют и все списания проводят через один и тот же MID
      if (order.subscription_id) store.setCardDetails('solidgate', order.subscription_id, { ...orderCardDetails(order), mid: order.mid ?? null });
      if (order.error_code) store.setAttemptReason('solidgate', order.order_id, order.error_code);
      if ((order.refunded_amount ?? 0) > 0) store.markRefunded('solidgate', order.order_id);
      const payment = await paymentFromOrder(order, acc.account, cfg.toUsd);
      if (payment) store.upsertPayment(payment);
    }
  };
  const subscriptionsAndOrders = (filter: ReportFilter) => async (from: number, to: number) => {
    await saveSubscriptions(from, to, filter);
    await saveOrders(filter)(from, to);
  };
  // Окна по суткам до now; после каждого — onWindow(начало следующего окна)
  const inWindows = async (from: number, work: (from: number, to: number) => Promise<void>, onWindow?: (next: number) => void) => {
    for (let day = from; day < now; day += DAY) {
      await work(day, Math.min(day + DAY, now));
      onWindow?.(day + DAY);
    }
  };
  const progress = (key: string) => (next: number) => {
    store.setState('solidgate', acc.account, key, next);
    console.log(`[solidgate:${acc.account}] ${dayKey(next - DAY)} готово`);
  };

  if (cursor === null) {
    const from = store.getState('solidgate', acc.account, 'backfill_day') ?? cfg.historyFrom;
    await inWindows(from, subscriptionsAndOrders('created_at'), progress('backfill_day'));
    store.setState('solidgate', acc.account, 'details_version', DETAILS_VERSION);
  } else if ((store.getState('solidgate', acc.account, 'details_version') ?? 0) < DETAILS_VERSION) {
    // База выгружена раньше — один раз проходим подписки и заказы с HISTORY_FROM заново (это быстро)
    const from = store.getState('solidgate', acc.account, 'details_day') ?? cfg.historyFrom;
    await inWindows(from, subscriptionsAndOrders('created_at'), progress('details_day'));
    store.setState('solidgate', acc.account, 'details_version', DETAILS_VERSION);
  }
  if ((store.getState('solidgate', acc.account, 'orders_version') ?? 0) < ORDERS_VERSION) {
    const progressKey = `orders_v${ORDERS_VERSION}_day`;
    const from = store.getState('solidgate', acc.account, progressKey) ?? cfg.historyFrom;
    await inWindows(from, saveOrders('created_at'), progress(progressKey));
    store.setState('solidgate', acc.account, 'orders_version', ORDERS_VERSION);
  }

  await inWindows((cursor ?? now) - DAY, subscriptionsAndOrders('updated_at'));

  store.setState('solidgate', acc.account, 'cursor', now);
  return items;
}
