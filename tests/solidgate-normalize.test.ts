import { describe, expect, it } from 'vitest';
import type { SgCardOrder, SgSubscription } from '../src/providers/solidgate-client.js';
import { attemptsFromSolidgate, orderCardDetails, parseSgDate, paymentFromOrder, trialFromSolidgate } from '../src/providers/solidgate.js';

const T0 = '2026-10-01 10:00:00';
const T_END = '2026-10-04 10:00:00'; // 3 дня = 4320 минут
const ts = (s: string) => parseSgDate(s);

const sub = (
  invoices: SgSubscription['invoices'] = {},
  product: Partial<SgSubscription['product']> = {},
  patch: Partial<SgSubscription> = {},
): SgSubscription => ({
  id: 'sg_sub_1',
  status: 'active',
  started_at: T0,
  updated_at: T_END,
  product: { id: 'p1', trial: true, trial_period: 4320, ...product },
  invoices,
  ...patch,
});
const order = (id: string, status: string, created_at: string, processed_at = created_at) => ({
  id,
  status,
  created_at,
  processed_at,
});
const invoice = (id: string, start: string, amount: number, orders: ReturnType<typeof order>[]) => ({
  id,
  status: 'success',
  amount,
  created_at: start,
  billing_period_started_at: start,
  orders: Object.fromEntries(orders.map((o) => [o.id, o])),
});

describe('parseSgDate', () => {
  it('понимает формат Solidgate и ISO', () => {
    const expected = Date.parse('2026-10-01T10:00:00Z') / 1000;
    expect(parseSgDate('2026-10-01 10:00:00')).toBe(expected);
    expect(parseSgDate('2026-10-01T10:00:00Z')).toBe(expected);
    expect(parseSgDate('2026-10-01T13:00:00+03:00')).toBe(expected);
  });
});

describe('orderCardDetails', () => {
  it('страна (трёхбуквенный код → двухбуквенный), способ оплаты, система и банк из карты заказа', () => {
    expect(
      orderCardDetails({
        order_id: 'o',
        payment_method: 'google-pay',
        transactions: [{ card: { country: 'ZAF', brand: 'VISA', bank: ' CAPITEC BANK LTD ' } }],
      }),
    ).toEqual({ country: 'ZA', payment_method: 'google_pay', card_brand: 'visa', bank: 'CAPITEC BANK LTD' });
    expect(orderCardDetails({ order_id: 'o', transactions: { t1: { card: { country: 'USA' } } } }).country).toBe('US');
  });

  it('списание по токену: способ — каким карту сохранили; без этого — не определён; гео — не страна карты', () => {
    expect(orderCardDetails({ order_id: 'o', payment_method: 'token', transactions: [{ original_payment_method: 'apple-pay' }] }).payment_method).toBe('apple_pay');
    expect(orderCardDetails({ order_id: 'o', payment_method: 'token', geo_country: 'USA' })).toEqual({
      country: null,
      payment_method: null,
      card_brand: null,
      bank: null,
    });
  });
});

describe('attemptsFromSolidgate', () => {
  it('попытки первого платного периода: успех, отказ, рефанд; «в процессе» не считается; триал-инвойс не считается', () => {
    const attempts = attemptsFromSolidgate(
      sub({
        t0: { ...invoice('t0', T0, 0, [order('o0', 'auth_ok', T0)]), subscription_term_number: 0 },
        t1: {
          ...invoice('t1', T_END, 999, [
            order('o1', 'auth_failed', T_END),
            order('o2', 'refunded', '2026-10-05 10:00:00'),
            order('o3', 'processing', '2026-10-06 10:00:00'),
          ]),
          subscription_term_number: 1,
        },
      }),
    );
    expect(attempts.map((a) => [a.attempt_id, a.approved, a.refunded])).toEqual([
      ['o1', false, false],
      ['o2', true, true],
    ]);
    expect(attempts[0]).toMatchObject({ provider: 'solidgate', subscription_id: 'sg_sub_1', attempted_at: ts(T_END), reason: null });
  });

  it('без триала или без платного инвойса — попыток нет', () => {
    expect(attemptsFromSolidgate(sub({}, { trial: false }))).toEqual([]);
    expect(attemptsFromSolidgate(sub())).toEqual([]);
  });
});

describe('trialFromSolidgate', () => {
  it('null без триала', () => {
    expect(trialFromSolidgate(sub({}, { trial: false }), 'sgH2H')).toBeNull();
    expect(trialFromSolidgate(sub({}, { trial_period: 0 }), 'sgH2H')).toBeNull();
  });

  it('даты триала из продукта; без инвойсов — поля оплаты пустые', () => {
    expect(trialFromSolidgate(sub(), 'sgH2H')).toEqual({
      provider: 'solidgate',
      account: 'sgH2H',
      subscription_id: 'sg_sub_1',
      trial_started_at: ts(T0),
      trial_ended_at: ts(T_END),
      first_invoice_id: null,
      first_attempt_succeeded: null,
      paid_at: null,
      country: null,
      payment_method: null,
      card_brand: null,
      bank: null,
      mid: null, // MID — из заказов
      customer_id: null,
    });
    // клиент — id аккаунта у нас (customer_account_id); email не берём
    const withCustomer = sub({}, {}, { customer: { customer_account_id: 'acc-42', customer_email: 'a@b.c' } } as never);
    expect(trialFromSolidgate(withCustomer, 'sgH2H')?.customer_id).toBe('acc-42');
  });

  it('подписка без started_at — авторизация при оформлении не прошла, триала не было', () => {
    expect(trialFromSolidgate(sub({}, {}, { started_at: undefined, status: 'expired' }), 'sgH2H')).toBeNull();
  });

  it('по живым данным: триал $0 — период 0, первый платный — период 1; неоплаченный без billing_period', () => {
    const row = trialFromSolidgate(
      sub({
        t0: { ...invoice('t0', T0, 0, [order('o0', 'auth_ok', T0)]), subscription_term_number: 0 },
        t1: {
          id: 't1',
          status: 'retry',
          amount: 1499,
          created_at: T_END,
          subscription_term_number: 1,
          orders: { o1: order('o1', 'auth_failed', T_END), o2: order('o2', 'auth_failed', '2026-10-05 10:00:00') },
        },
      }),
      'sgH2H',
    );
    expect(row).toMatchObject({ first_invoice_id: 't1', first_attempt_succeeded: false, paid_at: null });
  });

  it('успешный ретрай: auth_failed, затем settle_ok', () => {
    const row = trialFromSolidgate(
      sub({
        t1: {
          ...invoice('t1', '2026-10-06 10:00:00', 1499, [
            order('o1', 'auth_failed', T_END),
            order('o2', 'settle_ok', '2026-10-06 10:00:00', '2026-10-06 10:00:05'),
          ]),
          created_at: T_END,
          subscription_term_number: 1,
        },
      }),
      'sgH2H',
    );
    expect(row).toMatchObject({ first_attempt_succeeded: false, paid_at: ts('2026-10-06 10:00:05') });
  });

  it('платный триал игнорируется, первая попытка успешна', () => {
    const row = trialFromSolidgate(
      sub({
        trial_inv: invoice('trial_inv', T0, 99, [order('o0', 'approved', T0)]),
        paid_inv: invoice('paid_inv', T_END, 999, [order('o1', 'approved', T_END, '2026-10-04 10:05:00')]),
      }),
      'sgH2H',
    );
    expect(row).toMatchObject({
      first_invoice_id: 'paid_inv',
      first_attempt_succeeded: true,
      paid_at: ts('2026-10-04 10:05:00'),
    });
  });

  it('оплачен на ретрае', () => {
    const row = trialFromSolidgate(
      sub({
        paid_inv: invoice('paid_inv', T_END, 999, [
          order('o2', 'approved', '2026-10-07 10:00:00'),
          order('o1', 'declined', T_END),
        ]),
      }),
      'sgH2H',
    );
    expect(row).toMatchObject({ first_attempt_succeeded: false, paid_at: ts('2026-10-07 10:00:00') });
  });

  it('только отказы → false и без оплаты; попытка в процессе → null', () => {
    expect(trialFromSolidgate(sub({ i: invoice('i', T_END, 999, [order('o1', 'declined', T_END)]) }), 'sgH2H')).toMatchObject({
      first_attempt_succeeded: false,
      paid_at: null,
    });
    expect(trialFromSolidgate(sub({ i: invoice('i', T_END, 999, [order('o1', 'processing', T_END)]) }), 'sgH2H')).toMatchObject({
      first_invoice_id: 'i',
      first_attempt_succeeded: null,
      paid_at: null,
      country: null,
    });
  });

  it('берёт самый ранний платный инвойс после триала', () => {
    const row = trialFromSolidgate(
      sub({
        second: invoice('second', '2026-11-04 10:00:00', 999, [order('o2', 'approved', '2026-11-04 10:00:00')]),
        first: invoice('first', T_END, 999, [order('o1', 'declined', T_END)]),
      }),
      'sgH2H',
    );
    expect(row?.first_invoice_id).toBe('first');
  });
});

describe('paymentFromOrder', () => {
  const paid = (p: Partial<SgCardOrder>): SgCardOrder => ({
    order_id: 'o1',
    status: 'settle_ok',
    created_at: T_END,
    amount: 5_999,
    currency: 'SAR',
    processing_amount: 1_601,
    processing_currency: 'USD',
    mid: 'mid-uuid',
    payment_method: 'google-pay',
    transactions: [{ card: { country: 'SAU', brand: 'VISA', bank: 'AL RAJHI BANK' } }],
    ...p,
  });
  // курс для теста: 1 USD = 3.75 SAR
  const toUsd = async (amount: number, currency: string) => (currency === 'USD' ? amount : currency === 'SAR' ? Math.round(amount / 3.75) : null);

  it('списанный заказ → платёж: сумма в валюте процессинга (уже USD), MID и карта из заказа', async () => {
    expect(await paymentFromOrder(paid({}), 'sgH2H', toUsd)).toEqual({
      provider: 'solidgate',
      payment_id: 'o1',
      account: 'sgH2H',
      mid: 'mid-uuid',
      paid_at: ts(T_END),
      amount_usd_cents: 1_601,
      refunded_usd_cents: 0,
      country: 'SA',
      payment_method: 'google_pay',
      card_brand: 'visa',
      bank: 'AL RAJHI BANK',
    });
  });

  it('процессинг в местной валюте — по курсу; возврат — той же долей', async () => {
    const refunded = paid({ status: 'refunded', processing_amount: 5_999, processing_currency: 'SAR', refunded_amount: 5_999 });
    expect(await paymentFromOrder(refunded, 'sgH2H', toUsd)).toMatchObject({ amount_usd_cents: 1_600, refunded_usd_cents: 1_600 });
  });

  it('проверка карты на $0, отказ и неизвестная валюта — не оборот', async () => {
    expect(await paymentFromOrder(paid({ amount: 0, processing_amount: 0 }), 'sgH2H', toUsd)).toBeNull();
    expect(await paymentFromOrder(paid({ status: 'auth_failed' }), 'sgH2H', toUsd)).toBeNull();
    expect(await paymentFromOrder(paid({ processing_currency: 'XYZ' }), 'sgH2H', toUsd)).toBeNull();
  });
});
