import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import type { TrialRow } from '../src/db.js';
import { applyInvoice, attemptFromCharge, chargeInvoiceId, invoiceSubscriptionId, paymentFromCharge, trialFromSubscription } from '../src/providers/stripe.js';

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
  country: null,
  payment_method: null,
  card_brand: null,
  bank: null,
  mid: 'org', // у Stripe MID — сам аккаунт
};

describe('trialFromSubscription', () => {
  it('null без триала', () => {
    expect(trialFromSubscription(sub({}), 'org')).toBeNull();
    expect(trialFromSubscription(sub({ trial_start: 10_000, trial_end: 10_000 }), 'org')).toBeNull();
  });

  it('строка триала с пустыми полями оплаты', () => {
    expect(trialFromSubscription(sub({ trial_start: 1_000, trial_end: 10_000 }), 'org')).toEqual(trial);
  });

  it('данные карты — из карты клиента по умолчанию (развёрнутой в списке) или карты подписки', () => {
    const withTrial = { trial_start: 1_000, trial_end: 10_000 };
    const card = { country: 'sa', brand: 'visa', wallet: { type: 'apple_pay' }, issuer: null };
    const customer = { id: 'cus', invoice_settings: { default_payment_method: { type: 'card', card } } };
    expect(trialFromSubscription(sub({ ...withTrial, customer } as never), 'corp')).toMatchObject({
      country: 'SA',
      payment_method: 'apple_pay',
      card_brand: 'visa',
      bank: null,
    });
    const plainCard = { type: 'card', card: { country: 'GB', brand: 'mastercard', wallet: null, issuer: 'Monzo' } };
    expect(trialFromSubscription(sub({ ...withTrial, customer, default_payment_method: plainCard } as never), 'corp')).toMatchObject({
      country: 'GB',
      payment_method: 'card',
      bank: 'Monzo',
    });
    expect(
      trialFromSubscription(sub({ ...withTrial, customer, default_payment_method: { card: { country: 'GB' } } } as never), 'corp')?.country,
    ).toBe('GB');
    expect(trialFromSubscription(sub({ ...withTrial, customer: 'cus_not_expanded' } as never), 'corp')?.country).toBeNull();
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
    expect(applyInvoice(trial, inv({ created: 10_000 + 86_401 }))).toBe(trial); // инвойс второго месяца
    expect(applyInvoice({ ...trial, first_invoice_id: 'in_0' }, inv({}))).toEqual({ ...trial, first_invoice_id: 'in_0' });
  });
});

describe('attemptFromCharge', () => {
  const charge = (p: Record<string, unknown>) =>
    ({ id: 'ch_1', created: 10_100, status: 'failed', amount_refunded: 0, outcome: { type: 'issuer_declined', reason: 'insufficient_funds' }, failure_code: 'card_declined', invoice: 'in_1', ...p }) as unknown as Stripe.Charge;

  it('отказ — с кодом причины; успех — без; рефанд по amount_refunded; pending не считается', () => {
    expect(attemptFromCharge(charge({}), 'sub_1')).toEqual({
      provider: 'stripe',
      attempt_id: 'ch_1',
      subscription_id: 'sub_1',
      attempted_at: 10_100,
      approved: false,
      reason: 'insufficient_funds',
      refunded: false,
    });
    expect(attemptFromCharge(charge({ status: 'succeeded', outcome: { type: 'authorized' }, amount_refunded: 999 }), 'sub_1')).toMatchObject({
      approved: true,
      reason: null,
      refunded: true,
    });
    expect(attemptFromCharge(charge({ outcome: { type: 'blocked', reason: 'highest_risk_level' } }), 'sub_1')?.reason).toBe('highest_risk_level');
    expect(attemptFromCharge(charge({ status: 'pending' }), 'sub_1')).toBeNull();
  });

  it('ссылка на инвойс — строкой или развёрнутым объектом', () => {
    expect(chargeInvoiceId(charge({}))).toBe('in_1');
    expect(chargeInvoiceId(charge({ invoice: { id: 'in_2' } }))).toBe('in_2');
    expect(chargeInvoiceId(charge({ invoice: null }))).toBeNull();
  });
});

describe('paymentFromCharge', () => {
  // Списание в HUF; Stripe зачислил $7.66 — эту сумму и берём
  const charge = (p: Record<string, unknown>) =>
    ({
      id: 'ch_1',
      created: 10_100,
      status: 'succeeded',
      captured: true,
      amount: 250_000,
      amount_refunded: 0,
      currency: 'huf',
      balance_transaction: { amount: 766, currency: 'usd' },
      payment_method_details: { type: 'card', card: { country: 'HU', brand: 'visa', wallet: { type: 'google_pay' }, issuer: null } },
      ...p,
    }) as unknown as Stripe.Charge;
  const toUsd = async (amount: number, currency: string) => (currency === 'usd' ? amount : null);

  it('успешное списание → платёж в долларах с данными карты; MID — аккаунт', async () => {
    expect(await paymentFromCharge(charge({}), 'corp', toUsd)).toEqual({
      provider: 'stripe',
      payment_id: 'ch_1',
      account: 'corp',
      mid: 'corp',
      paid_at: 10_100,
      amount_usd_cents: 766,
      refunded_usd_cents: 0,
      country: 'HU',
      payment_method: 'google_pay',
      card_brand: 'visa',
      bank: null,
    });
  });

  it('частичный рефанд — той же долей; не прошло, холд без захвата или без balance transaction — не оборот', async () => {
    expect((await paymentFromCharge(charge({ amount_refunded: 125_000 }), 'corp', toUsd))?.refunded_usd_cents).toBe(383);
    expect(await paymentFromCharge(charge({ status: 'failed', balance_transaction: null }), 'corp', toUsd)).toBeNull();
    expect(await paymentFromCharge(charge({ captured: false }), 'corp', toUsd)).toBeNull();
    expect(await paymentFromCharge(charge({ balance_transaction: 'txn_1' }), 'corp', toUsd)).toBeNull();
  });
});
