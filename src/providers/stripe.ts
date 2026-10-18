import Stripe from 'stripe';
import { toAlpha2 } from '../countries.js';
import type { AttemptRow, CardDetails, PaymentRow, Store, TrialRow, VampReportRow } from '../db.js';
import { forEachWindow } from '../days.js';
import type { ToUsd } from '../fx.js';
import { refreshTrialLtv, resetTrialLtv } from '../ltv.js';
import { DAY, dayKey, startOfUtcDay } from '../metrics.js';
import { refreshTrialFraud } from '../vamp.js';

export type StripeLike = Pick<Stripe, 'subscriptions' | 'invoices' | 'events' | 'charges' | 'refunds' | 'radar' | 'disputes'>;

interface StripeSyncConfig {
  historyFrom: number;
  retryWindowDays: number;
  toUsd: ToUsd;
}

// Сколько окон выгружать одновременно: каждое окно — отдельная цепочка запросов
const PARALLEL = 8;
const HOUR = 3_600;
// Ежедневный синк берёт данные с прошлого синка с запасом в час: Stripe отдаёт объекты сразу после создания.
// (Раньше запас был сутки — у Corp это ~15 тыс. списаний и столько же событий, и синк шёл ~10 минут даже сразу после предыдущего.)
const SYNC_OVERLAP = HOUR;
// Версия набора данных по триалу: 2 — способ оплаты, платёжная система, банк и попытки списания.
// База, выгруженная раньше, один раз догружает недостающее (подписки и списания, без инвойсов).
const DETAILS_VERSION = 2;
// Версия оборота: 1 — успешные списания сохраняются как платежи. База, выгруженная раньше, один раз проходит списания заново.
const PAYMENTS_VERSION = 1;
// Клиент у платежа (для LTV): база, загруженная раньше, один раз дописывает его — поиском только успешных списаний,
// их втрое меньше, чем всех (~70 с на сутки большого аккаунта). У поиска свой, более жёсткий лимит запросов —
// параллельно не больше трёх суток (при восьми на пустых днях Stripe отвечает rate limit)
const PAYMENT_CUSTOMERS_VERSION = 1;
const SEARCH_PARALLEL = 3;
// Поля подписки, появившиеся позже (1 — ID клиента, 2 — ещё и отмена): база загружена раньше — один раз
// проходим подписки без раскрытия клиента и дописываем их
const SUBSCRIPTION_FIELDS_VERSION = 2;
// В basil у charge нет ссылки на инвойс — список списаний запрашиваем в версии API, где она есть
const CHARGES_API_VERSION = '2024-06-20';
// Инвойс продления создаётся в момент окончания триала; запас — на задержки Stripe.
// Всё, что создано позже суток после конца триала, — уже не первый платный инвойс.
const FIRST_INVOICE_TOLERANCE = 3_600;
const FIRST_INVOICE_MAX_DELAY = DAY;
// Подписки Toggle не хранят карту — она висит на клиенте; разворачиваем её прямо в списке, без лишних запросов
const SUBSCRIPTION_EXPAND = ['data.customer.invoice_settings.default_payment_method'];
// Первая автоматическая попытка идёт сразу при финализации инвойса. Оплата сильно позже —
// это ретрай или ручная оплата после отказа (последняя не увеличивает attempt_count).
const FIRST_ATTEMPT_MAX_DELAY = 3_600;

export function trialFromSubscription(sub: Stripe.Subscription, account: string): TrialRow | null {
  if (!sub.trial_start || !sub.trial_end || sub.trial_end <= sub.trial_start) return null;
  return {
    provider: 'stripe',
    account,
    subscription_id: sub.id,
    trial_started_at: sub.trial_start,
    trial_ended_at: sub.trial_end,
    first_invoice_id: null,
    first_attempt_succeeded: null,
    paid_at: null,
    ...cardDetails(sub),
    mid: account, // у Stripe MID — сам аккаунт
    customer_id: customerId(sub.customer),
    ...cancellation(sub),
  };
}

// Когда попросили отменить (canceled_at — и при отмене «в конце периода») и почему; передумали — отмены нет
const cancellation = (sub: Stripe.Subscription) => ({
  canceled_at: sub.canceled_at ?? null,
  cancel_reason: sub.canceled_at ? (sub.cancellation_details?.reason ?? null) : null,
});

const customerId = (customer: Stripe.Subscription['customer'] | undefined) => (typeof customer === 'string' ? customer : (customer?.id ?? null));

// Карта подписки, иначе карта клиента по умолчанию (если развёрнуты в ответе).
// Банк Stripe для аккаунтов Toggle не отдаёт (issuer пустой) — останется null.
function cardDetails(sub: Stripe.Subscription): CardDetails {
  const own = typeof sub.default_payment_method === 'object' ? sub.default_payment_method : null;
  const customer = typeof sub.customer === 'object' && !sub.customer.deleted ? sub.customer : null;
  const customerDefault = customer?.invoice_settings?.default_payment_method;
  const pm = own ?? (typeof customerDefault === 'object' ? customerDefault : null);
  return {
    country: toAlpha2(pm?.card?.country),
    payment_method: pm?.card?.wallet?.type ?? pm?.type ?? null,
    card_brand: pm?.card?.brand ?? null,
    bank: pm?.card?.issuer ?? null,
  };
}

type LegacyCharge = Stripe.Charge & { invoice?: string | { id: string } | null };

export function chargeInvoiceId(charge: LegacyCharge): string | null {
  if (!charge.invoice) return null;
  return typeof charge.invoice === 'string' ? charge.invoice : charge.invoice.id;
}

// Списание = попытка оплаты; pending ещё не попытка. Причина: код отказа банка или правило антифрода
export function attemptFromCharge(charge: Stripe.Charge, subscriptionId: string): AttemptRow | null {
  if (charge.status === 'pending') return null;
  const approved = charge.status === 'succeeded';
  return {
    provider: 'stripe',
    attempt_id: charge.id,
    subscription_id: subscriptionId,
    attempted_at: charge.created,
    approved,
    reason: approved ? null : (charge.outcome?.reason ?? charge.failure_code ?? charge.outcome?.type ?? null),
    refunded: charge.amount_refunded > 0,
  };
}

// Успешное списание → платёж для оборота. Сумма — из balance transaction: Stripe уже перевёл её в валюту зачисления (USD).
// Списание без захвата (холд) ещё не деньги — не считаем.
export async function paymentFromCharge(charge: Stripe.Charge, account: string, toUsd: ToUsd): Promise<PaymentRow | null> {
  const balance = typeof charge.balance_transaction === 'object' ? charge.balance_transaction : null;
  if (charge.status !== 'succeeded' || !charge.captured || !balance) return null;
  const amountUsd = await toUsd(balance.amount, balance.currency, charge.created);
  if (amountUsd === null) return null;
  const details = charge.payment_method_details;
  return {
    provider: 'stripe',
    payment_id: charge.id,
    account,
    mid: account,
    paid_at: charge.created,
    amount_usd_cents: amountUsd,
    refunded_usd_cents: charge.amount > 0 ? Math.round((amountUsd * charge.amount_refunded) / charge.amount) : 0,
    customer_id: typeof charge.customer === 'string' ? charge.customer : (charge.customer?.id ?? null),
    country: toAlpha2(details?.card?.country),
    payment_method: details?.card?.wallet?.type ?? details?.type ?? null,
    card_brand: details?.card?.brand ?? null,
    bank: details?.card?.issuer ?? null,
  };
}

// --- Visa VAMP: фрод-репорты (early fraud warnings, это TC40) и диспуты (TC15) — с картой и Radar score списания.
// Что из этого идёт в VAMP (Visa, чарджбэк без RDR), решает подсчёт — src/vamp.ts

const chargeId = (charge: string | Stripe.Charge | null) => (typeof charge === 'string' ? charge : (charge?.id ?? null));

function vampCharge(charge: string | Stripe.Charge | null) {
  const full = typeof charge === 'object' ? charge : null;
  const details = full?.payment_method_details;
  const customer = full?.customer;
  return {
    payment_id: chargeId(charge),
    charged_at: full?.created ?? null,
    network: details?.card?.network ?? details?.card?.brand ?? null,
    country: toAlpha2(details?.card?.country),
    payment_method: details?.card?.wallet?.type ?? details?.type ?? null,
    customer_id: typeof customer === 'string' ? customer : (customer?.id ?? null),
    risk_score: full?.outcome?.risk_score ?? null,
    // сумма — если списание в долларах (иначе её даст платёж дашборда); вернули ли деньги — на момент загрузки
    amount_usd_cents: full?.currency === 'usd' ? full.amount : null,
    refunded: (full?.amount_refunded ?? 0) > 0,
  };
}

export function vampFromFraudWarning(efw: Stripe.Radar.EarlyFraudWarning, account: string): VampReportRow {
  return {
    provider: 'stripe', report_id: efw.id, account, mid: account, kind: 'fraud', reported_at: efw.created,
    ...vampCharge(efw.charge), reason: efw.fraud_type, case_type: null, rdr: false, lost_usd_cents: 0,
  };
}

// RDR — в network_details, сеть карты — в payment_method_details.card.network (в типах SDK их пока нет);
// списано по RDR — отрицательные проводки диспута в USD
type DisputeWithNetwork = Stripe.Dispute & { network_details?: { visa?: { rapid_dispute_resolution?: boolean } | null } | null };
type DisputeCard = Stripe.Dispute.PaymentMethodDetails.Card & { network?: string | null };

export function vampFromDispute(dispute: DisputeWithNetwork, account: string): VampReportRow {
  const rdr = dispute.network_details?.visa?.rapid_dispute_resolution === true;
  const card = dispute.payment_method_details?.card as DisputeCard | undefined;
  const charge = vampCharge(dispute.charge);
  return {
    provider: 'stripe', report_id: dispute.id, account, mid: account, kind: 'dispute', reported_at: dispute.created,
    ...charge, network: card?.network ?? card?.brand ?? charge.network, reason: dispute.reason, case_type: card?.case_type ?? null, rdr,
    lost_usd_cents: rdr ? dispute.balance_transactions.filter((t) => t.currency === 'usd' && t.amount < 0).reduce((sum, t) => sum - t.amount, 0) : 0,
  };
}

// Первый раз — с HISTORY_FROM неделями (прогресс сохраняется), дальше — с прошлого раза с запасом в сутки.
// Версия набора полей: 2 — сумма и рефанд списания; загруженное раньше один раз проходится заново
const VAMP_WINDOW = 7 * DAY;
const VAMP_VERSION = 2;
export async function syncStripeVamp(store: Store, stripe: StripeLike, account: string, historyFrom: number, now: number): Promise<void> {
  const save = async (created: Stripe.RangeQueryParam) => {
    for await (const efw of stripe.radar.earlyFraudWarnings.list({ created, limit: 100, expand: ['data.charge'] })) {
      store.upsertVampReport(vampFromFraudWarning(efw, account));
    }
    for await (const dispute of stripe.disputes.list({ created, limit: 100, expand: ['data.charge'] })) store.upsertVampReport(vampFromDispute(dispute, account));
  };
  const current = (store.getState('stripe', account, 'vamp_version') ?? 0) >= VAMP_VERSION;
  const cursor = current ? store.getState('stripe', account, 'vamp_cursor') : null;
  const progressKey = `vamp_v${VAMP_VERSION}_day`;
  if (cursor === null) {
    await forEachWindow(
      store.getState('stripe', account, progressKey) ?? historyFrom,
      now,
      VAMP_WINDOW,
      PARALLEL,
      async (from) => {
        await save({ gte: from, lt: from + VAMP_WINDOW });
        console.log(`[stripe:${account}] VAMP ${dayKey(from)} готово`);
      },
      (next) => store.setState('stripe', account, progressKey, next),
    );
    store.setState('stripe', account, 'vamp_version', VAMP_VERSION);
  } else {
    await save({ gte: cursor - DAY });
  }
  store.setState('stripe', account, 'vamp_cursor', now);
  refreshTrialFraud(store.db, 'stripe');
}

export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  // basil кладёт подписку в parent; события старых версий API — в invoice.subscription
  const legacy = (invoice as unknown as { subscription?: string | { id: string } | null }).subscription;
  const ref = invoice.parent?.subscription_details?.subscription ?? legacy ?? null;
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

export function applyInvoice(trial: TrialRow, invoice: Stripe.Invoice): TrialRow {
  const isFirstPaidCandidate =
    !!invoice.id &&
    invoice.billing_reason === 'subscription_cycle' &&
    invoice.amount_due > 0 &&
    invoice.created >= trial.trial_ended_at - FIRST_INVOICE_TOLERANCE &&
    invoice.created <= trial.trial_ended_at + FIRST_INVOICE_MAX_DELAY;
  const isSameInvoice = trial.first_invoice_id === null || trial.first_invoice_id === invoice.id;
  if (!isFirstPaidCandidate || !isSameInvoice) return trial;

  const { finalized_at: finalizedAt, paid_at: paidAt } = invoice.status_transitions;
  const paid = invoice.status === 'paid';
  const paidRightAway =
    paid && invoice.attempt_count === 1 && (paidAt ?? 0) - (finalizedAt ?? invoice.created) <= FIRST_ATTEMPT_MAX_DELAY;

  return {
    ...trial,
    first_invoice_id: invoice.id!,
    first_attempt_succeeded: invoice.attempt_count === 0 ? null : paidRightAway,
    paid_at: paid ? (paidAt ?? invoice.created) : null,
  };
}

export function createStripeClient(key: string): StripeLike {
  return new Stripe(key, { apiVersion: '2025-08-27.basil', maxNetworkRetries: 3 });
}

// Без курсора — бэкфилл с HISTORY_FROM по дням (несколько дней параллельно, прогресс сохраняется);
// затем всегда инкремент с (курсор − 1 час): новые подписки, события по инвойсам, списания и рефанды.
export async function syncStripeAccount(
  store: Store,
  stripe: StripeLike,
  account: string,
  cfg: StripeSyncConfig,
  now: number,
): Promise<number> {
  const today = startOfUtcDay(now);
  const cursor = store.getState('stripe', account, 'cursor');
  let items = 0;

  const saveSubscription = (sub: Stripe.Subscription) => {
    const row = trialFromSubscription(sub, account);
    if (!row) return;
    store.upsertTrial(row);
    items++;
  };
  const saveInvoice = (invoice: Stripe.Invoice) => {
    const subscriptionId = invoiceSubscriptionId(invoice);
    const trial = subscriptionId ? store.getTrial('stripe', subscriptionId) : null;
    if (!trial) return;
    const next = applyInvoice(trial, invoice);
    if (next === trial) return;
    store.upsertTrial(next);
    items++;
  };

  // Все подписки (триалы) с HISTORY_FROM до until; прогресс по дням хранится под progressKey
  const subscriptionsPass = (progressKey: string, until = today) =>
    forEachWindow(
      store.getState('stripe', account, progressKey) ?? cfg.historyFrom,
      until,
      DAY,
      PARALLEL,
      async (day) => {
        const params = { status: 'all' as const, created: { gte: day, lt: day + DAY }, limit: 100, expand: SUBSCRIPTION_EXPAND };
        for await (const sub of stripe.subscriptions.list(params)) saveSubscription(sub);
        console.log(`[stripe:${account}] подписки ${dayKey(day)} готово`);
      },
      (next) => store.setState('stripe', account, progressKey, next),
    );

  // Списание: попытка оплаты первого платного инвойса (инвойс уже должен быть известен — проход инвойсов раньше)
  // и, если прошло, платёж для оборота
  const saveCharge = async (charge: LegacyCharge) => {
    const invoiceId = chargeInvoiceId(charge);
    const subscriptionId = invoiceId ? store.subscriptionByFirstInvoice('stripe', invoiceId) : null;
    const attempt = subscriptionId ? attemptFromCharge(charge, subscriptionId) : null;
    if (attempt) store.upsertAttempt(attempt);
    const payment = await paymentFromCharge(charge, account, cfg.toUsd);
    if (payment) store.upsertPayment(payment);
  };
  const listCharges = (created: Stripe.RangeQueryParam) =>
    stripe.charges.list(
      { created, limit: 100, expand: ['data.balance_transaction'] },
      { apiVersion: CHARGES_API_VERSION },
    ) as AsyncIterable<LegacyCharge>;

  const invoicesPass = (progressKey: string, until = today) =>
    forEachWindow(
      store.getState('stripe', account, progressKey) ?? cfg.historyFrom,
      until,
      DAY,
      PARALLEL,
      async (day) => {
        for await (const invoice of stripe.invoices.list({ created: { gte: day, lt: day + DAY }, limit: 100 })) saveInvoice(invoice);
        console.log(`[stripe:${account}] инвойсы ${dayKey(day)} готово`);
      },
      (next) => store.setState('stripe', account, progressKey, next),
    );
  const chargesPass = (progressKey: string, until = today) =>
    forEachWindow(
      store.getState('stripe', account, progressKey) ?? cfg.historyFrom,
      until,
      DAY,
      PARALLEL,
      async (day) => {
        for await (const charge of listCharges({ gte: day, lt: day + DAY })) await saveCharge(charge);
        console.log(`[stripe:${account}] списания ${dayKey(day)} готово`);
      },
      (next) => store.setState('stripe', account, progressKey, next),
    );
  // Проход списаний, начатый с HISTORY_FROM уже в этой версии, сохранил и платежи — отдельная догрузка оборота не нужна
  // (у Corp это ещё ~полчаса). Продолженный после перезапуска проход начало истории мог пройти старым кодом.
  const chargesPassWithPayments = async (progressKey: string) => {
    const fromStart = store.getState('stripe', account, progressKey) === null;
    await chargesPass(progressKey);
    if (fromStart) store.setState('stripe', account, 'payments_version', PAYMENTS_VERSION);
  };

  if (cursor === null) {
    // Подписки (триалы) → инвойсы (первый платный) → списания (попытки) — каждый шаг опирается на предыдущий
    await subscriptionsPass('subs_day');
    await invoicesPass('invoices_day');
    await chargesPassWithPayments('charges_day');
    store.setState('stripe', account, 'details_version', DETAILS_VERSION);
    store.setState('stripe', account, 'subscription_fields_version', SUBSCRIPTION_FIELDS_VERSION); // подписки уже с клиентом и отменой
    store.setState('stripe', account, 'payment_customers_version', PAYMENT_CUSTOMERS_VERSION); // платежи уже с клиентом
    store.setState('stripe', account, 'loaded_from', cfg.historyFrom);
  } else if ((store.getState('stripe', account, 'details_version') ?? 0) < DETAILS_VERSION) {
    // База выгружена раньше: один раз догружаем данные карты (подписки) и попытки (списания), инвойсы уже есть
    await subscriptionsPass('details_subs_day');
    await chargesPassWithPayments('details_charges_day');
    store.setState('stripe', account, 'details_version', DETAILS_VERSION);
  }
  // Один раз для уже загруженных триалов: ID клиента и отмена — подписки без раскрытия клиента, это быстро
  if (cursor !== null && (store.getState('stripe', account, 'subscription_fields_version') ?? 0) < SUBSCRIPTION_FIELDS_VERSION) {
    await forEachWindow(
      store.getState('stripe', account, 'subscription_fields_day') ?? cfg.historyFrom,
      now, // включая сегодняшние подписки, загруженные до появления ID клиента
      DAY,
      PARALLEL,
      async (day) => {
        for await (const sub of stripe.subscriptions.list({ status: 'all', created: { gte: day, lt: day + DAY }, limit: 100 })) {
          const customer = customerId(sub.customer);
          if (customer) store.setCustomerId('stripe', sub.id, customer);
          const { canceled_at, cancel_reason } = cancellation(sub);
          store.setCancellation('stripe', sub.id, canceled_at, cancel_reason);
        }
        console.log(`[stripe:${account}] клиенты и отмены ${dayKey(day)} готово`);
      },
      (next) => store.setState('stripe', account, 'subscription_fields_day', next),
    );
    store.setState('stripe', account, 'subscription_fields_version', SUBSCRIPTION_FIELDS_VERSION);
  }
  if (cursor !== null && (store.getState('stripe', account, 'payment_customers_version') ?? 0) < PAYMENT_CUSTOMERS_VERSION) {
    await forEachWindow(
      store.getState('stripe', account, 'payment_customers_day') ?? cfg.historyFrom,
      now,
      DAY,
      SEARCH_PARALLEL,
      async (day) => {
        for await (const charge of stripe.charges.search({ query: `status:'succeeded' AND created>=${day} AND created<${day + DAY}`, limit: 100 })) {
          const customer = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
          if (customer) store.setPaymentCustomer('stripe', charge.id, customer);
        }
        console.log(`[stripe:${account}] клиенты платежей ${dayKey(day)} готово`);
      },
      (next) => store.setState('stripe', account, 'payment_customers_day', next),
    );
    store.setState('stripe', account, 'payment_customers_version', PAYMENT_CUSTOMERS_VERSION);
    resetTrialLtv(store.db, 'stripe', account);
  }
  if ((store.getState('stripe', account, 'payments_version') ?? 0) < PAYMENTS_VERSION) {
    await chargesPass('payments_charges_day');
    store.setState('stripe', account, 'payments_version', PAYMENTS_VERSION);
  }

  // HISTORY_FROM сдвинули раньше начала загруженного — догружаем только недостающее начало истории.
  // Первые платежи триалов из него приходят и позже: инвойсы и списания проходим до конца последнего
  // такого триала плюс окно ретраев (проход списаний заодно сохраняет оборот этих дней).
  const loadedFrom = store.getState('stripe', account, 'loaded_from') ?? store.firstTrialStart('stripe', account) ?? cfg.historyFrom;
  if (loadedFrom - cfg.historyFrom > DAY) {
    const key = (pass: string) => `history_${dayKey(cfg.historyFrom)}_${pass}_day`;
    const gapEnd = Math.min(today, loadedFrom + DAY);
    await subscriptionsPass(key('subs'), gapEnd);
    const lastTrialEnd = store.lastTrialEnd('stripe', account, gapEnd) ?? gapEnd;
    await invoicesPass(key('invoices'), Math.min(today, lastTrialEnd + DAY));
    await chargesPass(key('charges'), Math.min(today, lastTrialEnd + cfg.retryWindowDays * DAY + DAY));
  }
  store.setState('stripe', account, 'loaded_from', Math.min(loadedFrom, cfg.historyFrom));

  // Инкремент: часовыми окнами параллельно; шаги по порядку — подписки → инвойсы (события) → списания,
  // потому что каждый опирается на предыдущий (инвойс — на триал, списание — на первый инвойс)
  const since = (cursor ?? today) - SYNC_OVERLAP;
  const hourly = (fn: (from: number) => Promise<void>) => forEachWindow(since, now, HOUR, PARALLEL, fn);
  await hourly(async (from) => {
    const params = { status: 'all' as const, created: { gte: from, lt: from + HOUR }, limit: 100, expand: SUBSCRIPTION_EXPAND };
    for await (const sub of stripe.subscriptions.list(params)) saveSubscription(sub);
  });
  await hourly(async (from) => {
    const params = { types: ['invoice.paid', 'invoice.payment_failed'], created: { gte: from, lt: from + HOUR }, limit: 100 };
    for await (const event of stripe.events.list(params)) saveInvoice(event.data.object as Stripe.Invoice);
  });
  await hourly(async (from) => {
    for await (const charge of listCharges({ gte: from, lt: from + HOUR })) await saveCharge(charge);
  });
  // Отмены приходят позже оформления: по событиям об изменении подписки берём её последнее состояние
  const latest = new Map<string, { at: number; sub: Stripe.Subscription }>();
  await hourly(async (from) => {
    const params = { types: ['customer.subscription.updated', 'customer.subscription.deleted'], created: { gte: from, lt: from + HOUR }, limit: 100 };
    for await (const event of stripe.events.list(params)) {
      const sub = event.data.object as Stripe.Subscription;
      if ((latest.get(sub.id)?.at ?? -1) < event.created) latest.set(sub.id, { at: event.created, sub });
    }
  });
  for (const { sub } of latest.values()) {
    const { canceled_at, cancel_reason } = cancellation(sub);
    store.setCancellation('stripe', sub.id, canceled_at, cancel_reason);
  }
  // Рефанд приходит позже списания: помечаем попытку и обновляем возвращённую долю платежа
  for await (const refund of stripe.refunds.list({ created: { gte: since }, limit: 100, expand: ['data.charge'] })) {
    if (refund.status === 'failed' || refund.status === 'canceled') continue;
    const charge = typeof refund.charge === 'object' ? refund.charge : null;
    const chargeId = charge?.id ?? (typeof refund.charge === 'string' ? refund.charge : null);
    if (chargeId) store.markRefunded('stripe', chargeId);
    if (chargeId) store.markVampRefunded('stripe', chargeId);
    if (charge && charge.amount > 0) store.setPaymentRefundShare('stripe', charge.id, charge.amount_refunded / charge.amount);
  }
  refreshTrialLtv(store.db, 'stripe', account, now);

  store.setState('stripe', account, 'cursor', now);
  return items;
}
