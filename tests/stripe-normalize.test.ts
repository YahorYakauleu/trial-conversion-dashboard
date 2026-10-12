import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import type { TrialRow } from '../src/db.js';
import { applyInvoice, invoiceSubscriptionId, trialFromSubscription } from '../src/providers/stripe.js';

const sub = (p: Partial<Stripe.Subscription>) =>
  ({ id: 'sub_1', trial_start: null, trial_end: null, ...p }) as Stripe.Subscription;

// Инвойс продления создаётся в конце триала (10_000), финализируется через час, первая попытка — сразу
const inv = (p: Record<string, unknown>) =>
  ({
    id: 'in_1',
    billing_reason: 'subscription_cycle',
    amount_due: 999,
    created: 10_000,
    attempt_count: 1,
    status: 'paid',
    status_transitions: { finalized_at: 13_600, paid_at: 13_650 },
    parent: { subscription_details: { subscription: 'sub_1' } },
    ...p,
  }) as unknown as Stripe.Invoice;

const trial: TrialRow = {
  provider: 'stripe',
  account: 'org',
  subscription_id: 'sub_1',
  trial_started_at: 1_000,
  trial_ended_at: 10_000,
  first_invoice_id: null,
  first_attempt_succeeded: null,
  paid_at: null,
};

describe('trialFromSubscription', () => {
  it('null без триала', () => {
    expect(trialFromSubscription(sub({}), 'org')).toBeNull();
    expect(trialFromSubscription(sub({ trial_start: 10_000, trial_end: 10_000 }), 'org')).toBeNull();
  });

  it('строка триала с пустыми полями оплаты', () => {
    expect(trialFromSubscription(sub({ trial_start: 1_000, trial_end: 10_000 }), 'org')).toEqual(trial);
  });
});

describe('invoiceSubscriptionId', () => {
  it('basil: parent.subscription_details', () => expect(invoiceSubscriptionId(inv({}))).toBe('sub_1'));
  it('старая версия API: invoice.subscription', () =>
    expect(invoiceSubscriptionId(inv({ parent: null, subscription: 'sub_2' }))).toBe('sub_2'));
  it('развёрнутый объект подписки', () =>
    expect(invoiceSubscriptionId(inv({ parent: { subscription_details: { subscription: { id: 'sub_3' } } } }))).toBe(
      'sub_3',
    ));
  it('инвойс без подписки', () => expect(invoiceSubscriptionId(inv({ parent: null }))).toBeNull());
});

describe('applyInvoice', () => {
  it('оплачен с первой попытки', () => {
    expect(applyInvoice(trial, inv({}))).toMatchObject({
      first_invoice_id: 'in_1',
      first_attempt_succeeded: true,
      paid_at: 13_650,
    });
  });

  it('первая попытка упала, инвойс открыт', () => {
    expect(applyInvoice(trial, inv({ status: 'open', status_transitions: { finalized_at: 13_600, paid_at: null } })))
      .toMatchObject({ first_attempt_succeeded: false, paid_at: null });
  });

  it('оплачен на автоматическом ретрае', () => {
    expect(applyInvoice(trial, inv({ attempt_count: 3, status_transitions: { finalized_at: 13_600, paid_at: 400_000 } })))
      .toMatchObject({ first_attempt_succeeded: false, paid_at: 400_000 });
  });

  it('оплачен вручную после отказа: attempt_count = 1, но оплата сильно позже финализации', () => {
    expect(applyInvoice(trial, inv({ status_transitions: { finalized_at: 13_600, paid_at: 13_600 + 2 * 86_400 } })))
      .toMatchObject({ first_attempt_succeeded: false, paid_at: 13_600 + 2 * 86_400 });
  });

  it('попыток ещё не было', () => {
    expect(
      applyInvoice(trial, inv({ attempt_count: 0, status: 'draft', status_transitions: { finalized_at: null, paid_at: null } })),
    ).toMatchObject({ first_invoice_id: 'in_1', first_attempt_succeeded: null, paid_at: null });
  });

  it('игнорирует $0 инвойс старта триала, нулевые суммы, ранние инвойсы и чужой первый инвойс', () => {
    expect(applyInvoice(trial, inv({ billing_reason: 'subscription_create', amount_due: 0 }))).toBe(trial);
    expect(applyInvoice(trial, inv({ amount_due: 0 }))).toBe(trial);
    expect(applyInvoice(trial, inv({ created: 10_000 - 3_601 }))).toBe(trial);
    expect(applyInvoice({ ...trial, first_invoice_id: 'in_0' }, inv({}))).toEqual({ ...trial, first_invoice_id: 'in_0' });
  });
});
