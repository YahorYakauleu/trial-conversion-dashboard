import Stripe from 'stripe';
import type { TrialRow } from '../db.js';

// Инвойс продления создаётся в момент окончания триала; запас — на задержки Stripe.
const FIRST_INVOICE_TOLERANCE = 3_600;
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
    invoice.created >= trial.trial_ended_at - FIRST_INVOICE_TOLERANCE;
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
