import Stripe from 'stripe';
import { toAlpha2 } from '../countries.js';
import type { AttemptRow, CardDetails, Store, TrialRow } from '../db.js';
import { forEachDay } from '../days.js';
import { DAY, dayKey, startOfUtcDay } from '../metrics.js';

export type StripeLike = Pick<Stripe, 'subscriptions' | 'invoices' | 'events' | 'charges' | 'refunds'>;

interface StripeSyncConfig {
  historyFrom: number;
}

// Сколько дней выгружать одновременно: каждый день — отдельная цепочка запросов
const PARALLEL_DAYS = 8;
// Версия набора данных по триалу: 2 — способ оплаты, платёжная система, банк и попытки списания.
// База, выгруженная раньше, один раз догружает недостающее (подписки и списания, без инвойсов).
const DETAILS_VERSION = 2;
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
  };
}

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
// затем всегда инкремент с (курсор − 1 день): новые подписки, события по инвойсам, списания и рефанды.
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

  // Все подписки (триалы) с HISTORY_FROM; прогресс по дням хранится под progressKey
  const subscriptionsPass = (progressKey: string) =>
    forEachDay(
      store.getState('stripe', account, progressKey) ?? cfg.historyFrom,
      today,
      PARALLEL_DAYS,
      async (day) => {
        const params = { status: 'all' as const, created: { gte: day, lt: day + DAY }, limit: 100, expand: SUBSCRIPTION_EXPAND };
        for await (const sub of stripe.subscriptions.list(params)) saveSubscription(sub);
        console.log(`[stripe:${account}] подписки ${dayKey(day)} готово`);
      },
      (next) => store.setState('stripe', account, progressKey, next),
    );

  // Списания первых платных инвойсов: инвойс уже должен быть известен (проход инвойсов — раньше)
  const saveCharge = (charge: LegacyCharge) => {
    const invoiceId = chargeInvoiceId(charge);
    const subscriptionId = invoiceId ? store.subscriptionByFirstInvoice('stripe', invoiceId) : null;
    const attempt = subscriptionId ? attemptFromCharge(charge, subscriptionId) : null;
    if (attempt) store.upsertAttempt(attempt);
  };
  const listCharges = (created: Stripe.RangeQueryParam) =>
    stripe.charges.list({ created, limit: 100 }, { apiVersion: CHARGES_API_VERSION }) as AsyncIterable<LegacyCharge>;

  const invoicesPass = (progressKey: string) =>
    forEachDay(
      store.getState('stripe', account, progressKey) ?? cfg.historyFrom,
      today,
      PARALLEL_DAYS,
      async (day) => {
        for await (const invoice of stripe.invoices.list({ created: { gte: day, lt: day + DAY }, limit: 100 })) saveInvoice(invoice);
        console.log(`[stripe:${account}] инвойсы ${dayKey(day)} готово`);
      },
      (next) => store.setState('stripe', account, progressKey, next),
    );
  const chargesPass = (progressKey: string) =>
    forEachDay(
      store.getState('stripe', account, progressKey) ?? cfg.historyFrom,
      today,
      PARALLEL_DAYS,
      async (day) => {
        for await (const charge of listCharges({ gte: day, lt: day + DAY })) saveCharge(charge);
        console.log(`[stripe:${account}] списания ${dayKey(day)} готово`);
      },
      (next) => store.setState('stripe', account, progressKey, next),
    );

  if (cursor === null) {
    // Подписки (триалы) → инвойсы (первый платный) → списания (попытки) — каждый шаг опирается на предыдущий
    await subscriptionsPass('subs_day');
    await invoicesPass('invoices_day');
    await chargesPass('charges_day');
    store.setState('stripe', account, 'details_version', DETAILS_VERSION);
  } else if ((store.getState('stripe', account, 'details_version') ?? 0) < DETAILS_VERSION) {
    // База выгружена раньше: один раз догружаем данные карты (подписки) и попытки (списания), инвойсы уже есть
    await subscriptionsPass('details_subs_day');
    await chargesPass('details_charges_day');
    store.setState('stripe', account, 'details_version', DETAILS_VERSION);
  }

  const since = (cursor ?? today) - DAY;
  for await (const sub of stripe.subscriptions.list({ status: 'all', created: { gte: since }, limit: 100, expand: SUBSCRIPTION_EXPAND })) {
    saveSubscription(sub);
  }
  for await (const event of stripe.events.list({
    types: ['invoice.paid', 'invoice.payment_failed'],
    created: { gte: since },
    limit: 100,
  })) {
    saveInvoice(event.data.object as Stripe.Invoice);
  }
  for await (const charge of listCharges({ gte: since })) saveCharge(charge);
  for await (const refund of stripe.refunds.list({ created: { gte: since }, limit: 100 })) {
    const chargeId = typeof refund.charge === 'string' ? refund.charge : refund.charge?.id;
    if (chargeId && refund.status !== 'failed' && refund.status !== 'canceled') store.markRefunded('stripe', chargeId);
  }

  store.setState('stripe', account, 'cursor', now);
  return items;
}
