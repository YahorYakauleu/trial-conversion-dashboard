import { describe, expect, it } from 'vitest';
import type { SgSubscription } from '../src/providers/solidgate-client.js';
import { orderCardCountry, parseSgDate, trialFromSolidgate } from '../src/providers/solidgate.js';

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

describe('orderCardCountry', () => {
  it('страна карты из транзакции, трёхбуквенный код → двухбуквенный', () => {
    expect(orderCardCountry({ order_id: 'o', transactions: [{ card: { country: 'ZAF' } }] })).toBe('ZA');
    expect(orderCardCountry({ order_id: 'o', transactions: { t1: {}, t2: { card: { country: 'USA' } } } })).toBe('US');
    expect(orderCardCountry({ order_id: 'o', geo_country: 'USA' })).toBeNull(); // гео — не страна карты
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
    });
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
