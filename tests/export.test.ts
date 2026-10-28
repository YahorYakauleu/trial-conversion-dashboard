import { describe, expect, it } from 'vitest';
import { openStore, type EsimChargeRow } from '../src/db.js';
import { exportCustomers, exportDeclinedAttempts, exportOrders, exportPayments, exportTrials, toCsv } from '../src/export.js';
import { refreshTrialLtv } from '../src/ltv.js';
import { DAY } from '../src/metrics.js';

const ts = (iso: string) => Date.parse(iso) / 1000;
const NOW = ts('2026-10-16T12:00:00Z');
const timeZones = { stripe: 'UTC', solidgate: 'UTC' };
const vpn = { provider: 'all' as const, filters: {}, now: NOW, from: '2026-09-10', to: '2026-09-10', timeZones, retryWindowDays: 30 };
const started = ts('2026-09-10T12:00:00Z');

function vpnStore() {
  const store = openStore(':memory:');
  const trial = (id: string, provider: 'stripe' | 'solidgate', account: string, customer: string, paid: boolean) =>
    store.upsertTrial({
      provider, account, subscription_id: id, trial_started_at: started, trial_ended_at: started + 7 * DAY,
      first_invoice_id: `in_${id}`, first_attempt_succeeded: false, paid_at: paid ? started + 9 * DAY : null,
      country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null, mid: account, customer_id: customer,
    });
  trial('sub_a', 'stripe', 'corp', 'cus_a', true);
  trial('sg_b', 'solidgate', 'sgH2H', 'acc-b', false);
  const attempt = (id: string, sub: string, provider: 'stripe' | 'solidgate', n: number, approved: boolean, reason: string | null) =>
    store.upsertAttempt({ provider, attempt_id: id, subscription_id: sub, attempted_at: started + 7 * DAY + n * DAY, approved, reason, refunded: false });
  attempt('ch_1', 'sub_a', 'stripe', 0, false, 'insufficient_funds');
  attempt('ch_2', 'sub_a', 'stripe', 2, true, null);
  attempt('o_1', 'sg_b', 'solidgate', 0, false, '3.02');
  attempt('o_2', 'sg_b', 'solidgate', 1, false, 'do_not_honor');
  store.upsertPayment({ provider: 'stripe', payment_id: 'ch_2', account: 'corp', mid: 'corp', paid_at: started + 9 * DAY, amount_usd_cents: 999, refunded_usd_cents: 0, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null });
  return store;
}

describe('выгрузка списком', () => {
  it('VPN, триалы: ID подписки, клиента и инвойса, итог по триалу и ссылки на Stripe (у Solidgate — без ссылок)', () => {
    const table = exportTrials(vpnStore().db, vpn);
    const rows = table.rows.map((r) => Object.fromEntries(table.columns.map((c, i) => [c, r[i]])));
    // одинаковое время старта — по ID подписки
    expect(rows).toMatchObject([
      { provider: 'solidgate', subscription_id: 'sg_b', customer_id: 'acc-b', paid_within_30_days: 'no', declines: 2, subscription_link: '' },
      {
        provider: 'stripe', subscription_id: 'sub_a', customer_id: 'cus_a', first_invoice_id: 'in_sub_a', trial_started_utc: '2026-09-10 12:00:00',
        paid_within_30_days: 'yes', paid_on_first_attempt: 'no', attempts: 2, declines: 1,
        subscription_link: 'https://dashboard.stripe.com/acct_1TM4VlLTzrJvLtxV/subscriptions/sub_a',
        customer_link: 'https://dashboard.stripe.com/acct_1TM4VlLTzrJvLtxV/customers/cus_a',
      },
    ]);
    expect(table.truncated).toBe(false);
  });

  it('VPN, триалы: тип, длина и плата за триал — как в разрезах Trial type и Trial length', () => {
    const store = vpnStore();
    const columns = ['subscription_id', 'trial_type', 'trial_length_days', 'trial_fee_usd'];
    const pick = () => {
      const table = exportTrials(store.db, vpn);
      return table.rows.map((r) => columns.map((c) => r[table.columns.indexOf(c)]));
    };
    expect(pick()).toEqual([['sg_b', '', 7, '0.00'], ['sub_a', '', 7, '0.00']]); // LTV ещё не посчитан — тип не определён
    store.upsertPayment({ provider: 'stripe', payment_id: 'ch_fee', account: 'corp', mid: 'corp', paid_at: started, amount_usd_cents: 99, refunded_usd_cents: 0, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null, customer_id: 'cus_a' });
    refreshTrialLtv(store.db, 'stripe', 'corp', NOW);
    refreshTrialLtv(store.db, 'solidgate', 'sgH2H', NOW);
    expect(pick()).toEqual([['sg_b', 'free', 7, '0.00'], ['sub_a', 'paid', 7, '0.99']]);
  });

  it('VPN, отменённые триалы: только отменённые, день и причина отмены; по строке причины — её группа', () => {
    const store = vpnStore();
    store.setCancellation('solidgate', 'sg_b', started + 3 * 3600, '8.06');
    const table = exportTrials(store.db, vpn, { reason: null });
    const rows = table.rows.map((r) => Object.fromEntries(table.columns.map((c, i) => [c, r[i]])));
    expect(rows).toEqual([
      expect.objectContaining({ subscription_id: 'sg_b', canceled_utc: '2026-09-10 15:00:00', canceled_on_day: 1, cancellation: 'in trial', cancel_reason: 'Requested', cancel_code: '8.06' }),
    ]);
    expect(exportTrials(store.db, vpn, { reason: 'Requested' }).rows).toHaveLength(1);
    expect(exportTrials(store.db, vpn, { reason: 'Payment failed' }).rows).toEqual([]);
    // в выгрузке Conversion — все триалы; у неотменённых колонки отмены пустые
    const all = exportTrials(store.db, vpn);
    const cancelColumns = ['canceled_utc', 'canceled_on_day', 'cancellation', 'cancel_reason', 'cancel_code'].map((c) => all.columns.indexOf(c));
    expect(all.rows.map((r) => cancelColumns.map((i) => r[i]))).toEqual([
      ['2026-09-10 15:00:00', 1, 'in trial', 'Requested', '8.06'],
      ['', '', '', '', ''],
    ]);
  });

  it('VPN, отклонённые попытки: все или только одной группы причин; номер попытки', () => {
    const all = exportDeclinedAttempts(vpnStore().db, vpn, null);
    expect(all.rows.map((r) => [r[2], r[6], r[7]])).toEqual([
      ['ch_1', 1, 'Insufficient funds'],
      ['o_1', 1, 'Insufficient funds'],
      ['o_2', 2, 'Do not honor / Generic decline'],
    ]);
    expect(exportDeclinedAttempts(vpnStore().db, vpn, 'Insufficient funds').rows.map((r) => r[2])).toEqual(['ch_1', 'o_1']);
    expect(exportDeclinedAttempts(vpnStore().db, vpn, 'Unknown').rows).toEqual([]);
  });

  it('VPN, оборот: платежи периода в долларах', () => {
    const table = exportPayments(vpnStore().db, { provider: 'all', filters: {}, from: '2026-09-19', to: '2026-09-19', timeZones });
    expect(table.rows).toEqual([['stripe', 'corp', 'corp', 'ch_2', '2026-09-19 12:00:00', '9.99', '0.00', 'US', 'apple_pay', 'visa', '', 'https://dashboard.stripe.com/acct_1TM4VlLTzrJvLtxV/payments/ch_2']]);
  });

  it('eSIM: заказы со статусом и новыми клиентами; неоплаченные по причине; новые клиенты когорты', () => {
    const store = openStore(':memory:');
    const charge = (customer: string, intent: string, iso: string, p: Partial<EsimChargeRow> = {}): EsimChargeRow => ({
      provider: 'stripe', payment_id: `ch_${intent}_${iso}`, account: 'esim', mid: 'esim', paid_at: ts(iso), amount_usd_cents: 99, refunded_usd_cents: 0,
      country: 'US', payment_method: 'card', card_brand: 'visa', bank: null, approved: true, reason: null, intent_id: intent, customer_id: customer,
      destination: 'United States', package: '1 GB · 30 days', order_type: 'purchase', ...p,
    });
    store.upsertEsimCharge(charge('A', 'pi_a', '2026-10-13T08:23:00Z'));
    store.upsertEsimCharge(charge('B', 'pi_b', '2026-10-13T11:54:00Z', { approved: false, reason: 'transaction_not_allowed' }));
    store.upsertEsimCharge(charge('E', 'pi_e', '2026-10-13T01:34:00Z', { approved: false, reason: 'highest_risk_level' }));
    const o = { filters: {}, from: '2026-10-13', to: '2026-10-13', timeZones, now: NOW };

    const orders = exportOrders(store.db, o, null);
    expect(orders.rows.map((r) => [r[0], r[3], r[4], r[11]])).toEqual([
      ['pi_e', 'blocked as fraud', '', 'Blocked by fraud rules'],
      ['pi_a', 'paid', 'yes', ''],
      ['pi_b', 'not paid', '', 'Transaction not allowed'],
    ]);
    expect(orders.rows[1].at(-2)).toBe('https://dashboard.stripe.com/acct_1TGeCJLBLXzWKftL/payments/pi_a');
    expect(exportOrders(store.db, o, { reason: 'Transaction not allowed' }).rows.map((r) => r[0])).toEqual(['pi_b']);

    const customers = exportCustomers(store.db, o);
    expect(customers.rows.map((r) => [r[0], r[2], r[customers.columns.indexOf('returned_within_30_days')]])).toEqual([['A', 'pi_a', 'not yet']]); // 30 дней ещё не прошло
  });

  it('CSV: BOM, кавычки и запятые экранируются', () => {
    expect(toCsv({ columns: ['a', 'b'], rows: [['x, y', 'say "hi"']], truncated: false })).toBe('﻿a,b\r\n"x, y","say ""hi"""\r\n');
  });
});
