import { describe, expect, it } from 'vitest';
import { openStore, type VampReportRow } from '../src/db.js';
import { exportVampReports } from '../src/export.js';
import { DAY } from '../src/metrics.js';
import { syncSolidgateVamp, vampFromChargebacks, vampFromFraudAlert } from '../src/providers/solidgate.js';
import { syncStripeVamp, vampFromDispute, vampFromFraudWarning, type StripeLike } from '../src/providers/stripe.js';
import { getMetrics } from '../src/metrics.js';
import { getVampBreakdown, getVampDaily, getVampMonth, getVampOutcomes, getVampSeries, refreshTrialFraud, vampStatus } from '../src/vamp.js';

// «Сейчас» — 17 октября 12:00 UTC: сентябрь закрыт, октябрь идёт (прошло 16,5 из 31 дня)
const ts = (iso: string) => Date.parse(iso) / 1000;
const NOW = ts('2026-10-17T12:00:00Z');
// без групп: каждый MID — сам себе мерчант
const t = { ratio: 0.015, count: 1500, merchants: {} };
const base = { provider: 'all' as const, filters: {}, now: NOW };

function report(id: string, patch: Partial<VampReportRow>): VampReportRow {
  return {
    provider: 'stripe', report_id: id, account: 'corp', mid: 'corp', kind: 'fraud', reported_at: ts('2026-09-10T12:00:00Z'),
    payment_id: null, charged_at: null, network: 'visa', country: 'US', payment_method: 'apple_pay', customer_id: null,
    risk_score: null, reason: null, case_type: null, rdr: false, lost_usd_cents: 0, amount_usd_cents: null, refunded: false, ...patch,
  };
}

function storeWithData() {
  const store = openStore(':memory:');
  const sale = (provider: 'stripe' | 'solidgate', id: string, account: string, mid: string, at: string, brand = 'visa') =>
    store.upsertPayment({ provider, payment_id: id, account, mid, paid_at: ts(at), amount_usd_cents: 999, refunded_usd_cents: 0, country: 'US', payment_method: 'apple_pay', card_brand: brand, bank: null });
  // Corp: в сентябре 100 Visa-продаж (и одна Mastercard), в октябре 200
  for (let i = 0; i < 100; i++) sale('stripe', `ch_s${i}`, 'corp', 'corp', '2026-09-05T10:00:00Z');
  sale('stripe', 'ch_mc', 'corp', 'corp', '2026-09-05T10:00:00Z', 'mastercard');
  for (let i = 0; i < 200; i++) sale('stripe', `ch_o${i}`, 'corp', 'corp', '2026-10-05T10:00:00Z');
  // Solidgate, MID m1: в октябре 10 Visa-продаж
  for (let i = 0; i < 10; i++) sale('solidgate', `ord_${i}`, 'sgH2H', 'm1', '2026-10-06T10:00:00Z');
  // ch_s0 — первый платёж после триала
  store.upsertAttempt({ provider: 'stripe', attempt_id: 'ch_s0', subscription_id: 'sub_1', attempted_at: ts('2026-09-05T10:00:00Z'), approved: true, reason: null, refunded: false });

  // сентябрь, Corp: 3 фрод-репорта Visa, 1 чарджбэк, 1 RDR, 1 запрос документов, фрод-репорт Mastercard
  store.upsertVampReport(report('issfr_1', { payment_id: 'ch_s0', risk_score: 10 }));
  store.upsertVampReport(report('issfr_2', { risk_score: 60 }));
  store.upsertVampReport(report('issfr_3', { risk_score: 80, country: 'MX' }));
  store.upsertVampReport(report('du_1', { kind: 'dispute', case_type: 'chargeback' }));
  store.upsertVampReport(report('du_2', { kind: 'dispute', case_type: 'chargeback', rdr: true, lost_usd_cents: 999 }));
  store.upsertVampReport(report('du_3', { kind: 'dispute', case_type: 'inquiry' }));
  store.upsertVampReport(report('issfr_mc', { network: 'mastercard' }));
  // Visa по бренду, но прошла через Cartes Bancaires — не Visa
  store.upsertVampReport(report('du_cb', { kind: 'dispute', case_type: 'chargeback', network: 'cartes_bancaires' }));
  // октябрь: Corp — фрод-репорт 2 октября; Solidgate — алерт и чарджбэк без карты (возьмутся из платежа)
  store.upsertVampReport(report('issfr_4', { reported_at: ts('2026-10-02T12:00:00Z') }));
  const sg = { provider: 'solidgate' as const, account: 'sgH2H', mid: null, network: null, country: null, payment_method: null };
  store.upsertVampReport(report('fa_1', { ...sg, payment_id: 'ord_1', reported_at: ts('2026-10-12T08:00:00Z') }));
  store.upsertVampReport(report('cb_1', { ...sg, kind: 'dispute', case_type: 'chargeback', payment_id: 'ord_2', reported_at: ts('2026-10-16T08:00:00Z') }));
  return store;
}

describe('Visa VAMP', () => {
  it('по месяцам: count = фрод-репорты Visa + чарджбэки без RDR; ratio к Visa-продажам; прогноз у текущего месяца', () => {
    const series = getVampSeries(storeWithData().db, { ...base, from: '2026-09-01', to: '2026-10-17' }, t);
    expect(series.map((m) => [m.period, m.period_end])).toEqual([['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-17']]);
    expect(series[0]).toMatchObject({ fraud: 3, disputes: 1, rdr: 1, rdr_lost: 999, visa_sales: 100, vamp_count: 4, vamp_ratio: 0.04, final: true, forecast_count: null });
    expect(series[1]).toMatchObject({ fraud: 2, disputes: 1, visa_sales: 210, vamp_count: 3, final: false, forecast_count: Math.round((3 * 31) / 16.5) });
    expect(series.every((m) => m.status === null)).toBe(true); // мерчантов два — общий статус не имеет смысла
  });

  it('один мерчант — со статусом; фильтр мерчанта работает и для событий Solidgate (MID — из платежа)', () => {
    const corp = getVampSeries(storeWithData().db, { ...base, filters: { merchant: ['stripe:corp'] }, from: '2026-09-01', to: '2026-09-30' }, t);
    expect(corp[0]).toMatchObject({ vamp_count: 4, status: 'at_risk' }); // ratio 4% > 1,5%, count < 1 500
    const sg = getVampMonth(storeWithData().db, { ...base, filters: { merchant: ['solidgate:m1'] }, from: '2026-10-01', to: '2026-10-17' }, t);
    expect(sg).toMatchObject({ fraud: 1, disputes: 1, visa_sales: 10, vamp_ratio: 0.2, merchants: 1, status: 'at_risk' });
  });

  it('выборка, суженная не мерчантом (MID, страна), — без статуса: пороги у мерчанта целиком', () => {
    const oct = { ...base, from: '2026-10-01', to: '2026-10-17' };
    const byMid = getVampMonth(storeWithData().db, { ...oct, filters: { mid: ['solidgate:m1'] } }, t);
    expect(byMid).toMatchObject({ vamp_count: 2, status: null, statuses: null });
    expect(getVampSeries(storeWithData().db, { ...oct, filters: { country: ['US'] } }, t)[0].status).toBeNull();
    expect(getVampBreakdown(storeWithData().db, { ...oct, filters: { country: ['US'] } }, 'merchant', t).every((r) => r.status === null)).toBe(true);
  });

  it('мерчант Visa — группа MID: пороги к сумме, MID — без статуса', () => {
    const grouped = { ...t, merchants: { 'TOGGLE (10000290)': ['stripe:corp', 'solidgate:m1'] } };
    const oct = { ...base, from: '2026-10-01', to: '2026-10-17' };
    // Corp 1 из 200 и Solidgate 2 из 10 — вместе 3 из 210
    expect(getVampMonth(storeWithData().db, oct, grouped)).toMatchObject({ vamp_count: 3, visa_sales: 210, merchants: 1, status: 'ok' });
    expect(getVampBreakdown(storeWithData().db, oct, 'merchant', grouped).map((r) => [r.value, r.vamp_count, r.status])).toEqual([['TOGGLE (10000290)', 3, 'ok']]);
    expect(getVampBreakdown(storeWithData().db, oct, 'mid', grouped).map((r) => [r.value, r.vamp_count, r.status])).toEqual([
      ['solidgate:m1', 2, null],
      ['stripe:corp', 1, null],
    ]);
    const filtered = getVampMonth(storeWithData().db, { ...oct, filters: { merchant: ['TOGGLE (10000290)'] } }, grouped);
    expect(filtered).toMatchObject({ vamp_count: 3, status: 'ok' });
  });

  it('месяц: итоги и сколько мерчантов в каком статусе', () => {
    const month = getVampMonth(storeWithData().db, { ...base, from: '2026-10-01', to: '2026-10-17' }, t);
    // Corp: 1 из 200 = 0,5% — OK; Solidgate: 2 из 10 — ratio выше порога
    expect(month).toMatchObject({ vamp_count: 3, visa_sales: 210, merchants: 2, status: null, statuses: { excessive: 0, at_risk: 1, ok: 1 } });
  });

  it('разбивки: мерчанты со статусом, страны с ratio; у риска и типа списания продаж нет', () => {
    const db = storeWithData().db;
    const sept = { ...base, from: '2026-09-01', to: '2026-09-30' };
    expect(getVampBreakdown(db, sept, 'merchant', t).map((r) => [r.value, r.vamp_count, r.visa_sales, r.status])).toEqual([['stripe:corp', 4, 100, 'at_risk']]);
    expect(getVampBreakdown(db, sept, 'country', t).map((r) => [r.value, r.vamp_count, r.vamp_ratio])).toEqual([['US', 3, 0.03], ['MX', 1, null]]);
    expect(getVampBreakdown(db, sept, 'risk', t).map((r) => [r.value, r.vamp_count, r.vamp_ratio])).toEqual([
      ['0–19', 1, null], ['50–74', 1, null], ['75–99', 1, null], [null, 1, null],
    ]);
    expect(getVampBreakdown(db, sept, 'charge_type', t).map((r) => [r.value, r.vamp_count])).toEqual([['renewal', 3], ['first_payment', 1]]);
  });

  it('накопленный count по дням месяца и прошлого', () => {
    const daily = getVampDaily(storeWithData().db, { ...base, from: '2026-10-01', to: '2026-10-17' }, t, '2026-10-01');
    expect([daily.month, daily.previous_month, daily.current.length, daily.previous.length]).toEqual(['2026-10-01', '2026-09-01', 17, 30]);
    expect([daily.current[0], daily.current[1], daily.current[11], daily.current[16]]).toEqual([0, 1, 2, 3]);
    expect(daily.previous.at(-1)).toBe(4);
  });

  it('статус: Excessive — оба порога; At risk — один или прогноз', () => {
    expect(vampStatus(1500, 0.015, null, t)).toBe('excessive');
    expect(vampStatus(1500, 0.01, null, t)).toBe('at_risk');
    expect(vampStatus(100, 0.02, null, t)).toBe('at_risk');
    expect(vampStatus(800, 0.01, 1600, t)).toBe('at_risk');
    expect(vampStatus(100, 0.01, 200, t)).toBe('ok');
    expect(vampStatus(0, null, null, t)).toBe('ok');
  });

  it('выгрузка: события Visa, входит ли в VAMP, тип события', () => {
    const table = exportVampReports(storeWithData().db, { ...base, from: '2026-09-01', to: '2026-09-30' }, t);
    const rows = table.rows.map((r) => Object.fromEntries(table.columns.map((c, i) => [c, r[i]])));
    expect(rows.map((r) => [r.report_id, r.event, r.counted_in_vamp])).toEqual([
      ['du_1', 'chargeback (TC15)', 'yes'],
      ['du_2', 'chargeback, RDR', 'no'],
      ['du_3', 'inquiry', 'no'],
      ['issfr_1', 'fraud report (TC40)', 'yes'],
      ['issfr_2', 'fraud report (TC40)', 'yes'],
      ['issfr_3', 'fraud report (TC40)', 'yes'],
    ]);
    expect(rows[3]).toMatchObject({ charge: 'first payment after trial', payment_link: 'https://dashboard.stripe.com/acct_1TM4VlLTzrJvLtxV/payments/ch_s0' });
    expect(rows[1].rdr_lost_usd).toBe('9.99');
  });
});

describe('события VAMP у провайдеров', () => {
  const charge = {
    id: 'ch_1', created: 100, customer: 'cus_1', outcome: { risk_score: 67 }, amount: 999, currency: 'usd', amount_refunded: 999,
    payment_method_details: { type: 'card', card: { brand: 'visa', network: 'visa', country: 'MX', wallet: { type: 'apple_pay' } } },
  };

  it('Stripe: early fraud warning — с картой и Radar score списания', () => {
    const efw = { id: 'issfr_1', created: 200, fraud_type: 'unauthorized_use_of_card', charge };
    expect(vampFromFraudWarning(efw as never, 'corp')).toMatchObject({
      report_id: 'issfr_1', kind: 'fraud', reported_at: 200, payment_id: 'ch_1', charged_at: 100, network: 'visa', country: 'MX',
      payment_method: 'apple_pay', customer_id: 'cus_1', risk_score: 67, reason: 'unauthorized_use_of_card', mid: 'corp', amount_usd_cents: 999, refunded: true,
    });
  });

  it('Stripe: диспут — сеть (не бренд), RDR и сколько он стоил (списания минус возвраты по проводкам)', () => {
    const dispute = {
      id: 'du_1', created: 300, reason: 'fraudulent', charge: 'ch_9', payment_method_details: { card: { brand: 'visa', network: 'visa', case_type: 'chargeback' } },
      network_details: { type: 'visa', visa: { rapid_dispute_resolution: true } },
      balance_transactions: [{ amount: -1577, currency: 'usd' }, { amount: 100, currency: 'usd' }],
    };
    expect(vampFromDispute(dispute as never, 'org')).toMatchObject({ kind: 'dispute', payment_id: 'ch_9', network: 'visa', case_type: 'chargeback', rdr: true, lost_usd_cents: 1477 });
    const coBadged = { ...dispute, payment_method_details: { card: { brand: 'visa', network: 'cartes_bancaires', case_type: 'chargeback' } } };
    expect(vampFromDispute(coBadged as never, 'org').network).toBe('cartes_bancaires');
    const plain = { ...dispute, network_details: null };
    expect(vampFromDispute(plain as never, 'org')).toMatchObject({ rdr: false, lost_usd_cents: 1477 }); // стоимость — у любого диспута
  });

  it('Solidgate: фрод-алерт и чарджбэки; сеть чарджбэка — по коду причины', () => {
    const alert = { id: 7, created_at: '2026-10-12 07:30:44', order_id: 'ord_1', card_scheme: 'VISA', fraud_type: '', reason_code_description: null };
    expect(vampFromFraudAlert(alert, 'sgH2H')).toMatchObject({ report_id: 'fa_7', kind: 'fraud', network: 'visa', payment_id: 'ord_1', reported_at: ts('2026-10-12T07:30:44Z') });
    const order = {
      order_id: 'ord_2', created_at: '2026-10-09 20:28:04', customer_account_id: 'acc-1',
      chargebacks: [
        { id: '1', created_at: '2026-10-16 03:36:42', type: '1st_chb', reason_code: '10.4', reason_description: 'Fraud - Card-Absent Environment' },
        { id: '2', created_at: '2026-10-16 04:00:00', type: '1st_chb', reason_code: '4837' },
        { id: '3', created_at: '2026-10-16 05:00:00', type: 'retrieval_request', reason_code: '13.1' },
      ],
    };
    expect(vampFromChargebacks(order, 'sgH2H').map((r) => [r.report_id, r.network, r.case_type, r.charged_at, r.customer_id])).toEqual([
      ['cb_1', 'visa', 'chargeback', ts('2026-10-09T20:28:04Z'), 'acc-1'],
      ['cb_2', 'mastercard', 'chargeback', ts('2026-10-09T20:28:04Z'), 'acc-1'],
      ['cb_3', 'visa', 'inquiry', ts('2026-10-09T20:28:04Z'), 'acc-1'],
    ]);
  });

  it('загрузка Stripe: первый раз — с начала истории неделями, дальше — с прошлого раза с запасом в сутки', async () => {
    const store = openStore(':memory:');
    const calls: { list: string; created: { gte?: number; lt?: number } }[] = [];
    const list = (name: string, items: object[]) => (params: { created: { gte?: number; lt?: number } }) => {
      calls.push({ list: name, created: params.created });
      return (async function* () {
        for (const item of items as { created: number }[]) if (item.created >= (params.created.gte ?? 0) && item.created < (params.created.lt ?? Infinity)) yield item;
      })();
    };
    const from = ts('2026-09-01T00:00:00Z');
    const client = {
      radar: { earlyFraudWarnings: { list: list('efw', [{ id: 'issfr_1', created: from + 10 * DAY, fraud_type: 'misc', charge: 'ch_1' }]) } },
      disputes: { list: list('disputes', [{ id: 'du_1', created: from + 20 * DAY, reason: 'fraudulent', charge: 'ch_2', balance_transactions: [] }]) },
    } as unknown as StripeLike;
    await syncStripeVamp(store, client, 'corp', from, from + 30 * DAY);
    expect(calls.filter((c) => c.list === 'efw')).toHaveLength(5); // 30 дней — пять недельных окон
    expect(store.db.prepare('SELECT report_id FROM vamp_reports ORDER BY report_id').all()).toEqual([{ report_id: 'du_1' }, { report_id: 'issfr_1' }]);
    calls.length = 0;
    await syncStripeVamp(store, client, 'corp', from, from + 31 * DAY);
    expect(calls.map((c) => c.created)).toEqual([{ gte: from + 29 * DAY }, { gte: from + 29 * DAY }]);
  });

  it('загрузка Solidgate: окнами по 30 дней, дальше — с прошлого раза с запасом в сутки', async () => {
    const store = openStore(':memory:');
    const windows: [number, number][] = [];
    const from = ts('2026-07-01T00:00:00Z');
    const alerts = async function* (_acc: unknown, f: number, to: number) {
      windows.push([f, to]);
      if (f === from) yield { id: 1, created_at: '2026-07-05 10:00:00', order_id: 'ord_1', card_scheme: 'VISA' };
    };
    const chargebacks = async function* () {
      yield { order_id: 'ord_2', chargebacks: [{ id: '9', created_at: '2026-07-06 10:00:00', type: '1st_chb', reason_code: '10.4' }] };
    };
    const acc = { account: 'sgH2H', publicKey: 'pk', secretKey: 'sk' };
    // ord_1 — первый платёж триала клиента acc-1: клиент алерта берётся у триала
    store.upsertTrial({ provider: 'solidgate', account: 'sgH2H', subscription_id: 'sg_1', trial_started_at: from, trial_ended_at: from + 7 * DAY, first_invoice_id: null,
      first_attempt_succeeded: true, paid_at: from + 7 * DAY, country: null, payment_method: null, card_brand: null, bank: null, customer_id: 'acc-1' });
    store.upsertAttempt({ provider: 'solidgate', attempt_id: 'ord_1', subscription_id: 'sg_1', attempted_at: from + 7 * DAY, approved: true, reason: null, refunded: false });
    await syncSolidgateVamp(store, acc, from, from + 45 * DAY, alerts as never, chargebacks as never);
    expect(store.db.prepare("SELECT customer_id FROM vamp_reports WHERE report_id = 'fa_1'").get()).toEqual({ customer_id: 'acc-1' });
    expect(store.db.prepare("SELECT fraud_flagged, vamp_events FROM trials WHERE subscription_id = 'sg_1'").get()).toEqual({ fraud_flagged: 1, vamp_events: 1 });
    expect(windows).toEqual([[from, from + 30 * DAY], [from + 30 * DAY, from + 45 * DAY]]);
    expect(store.db.prepare('SELECT report_id, kind, network FROM vamp_reports ORDER BY report_id').all()).toEqual([
      { report_id: 'cb_9', kind: 'dispute', network: 'visa' },
      { report_id: 'fa_1', kind: 'fraud', network: 'visa' },
    ]);
    windows.length = 0;
    await syncSolidgateVamp(store, acc, from, from + 46 * DAY, alerts as never, chargebacks as never);
    expect(windows).toEqual([[from + 44 * DAY, from + 46 * DAY]]);
  });
});

describe('фрод по когортам и что стало после фрод-репорта', () => {
  const trialAt = ts('2026-09-01T12:00:00Z');
  function storeWithTrials() {
    const store = openStore(':memory:');
    const trial = (id: string, customer: string, paid: boolean) =>
      store.upsertTrial({
        provider: 'stripe', account: 'corp', subscription_id: id, trial_started_at: trialAt, trial_ended_at: trialAt + 7 * DAY, first_invoice_id: null,
        first_attempt_succeeded: paid, paid_at: paid ? trialAt + 7 * DAY : null, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null, customer_id: customer,
      });
    trial('sub_a', 'cus_a', true); // фрод-репорт Visa и чарджбэк — оба в VAMP
    trial('sub_b', 'cus_b', true); // фрод-репорт Mastercard — фрод, но не VAMP
    trial('sub_c', 'cus_c', true); // чисто
    trial('sub_d', 'cus_d', false); // не оплатил
    const charge = (id: string, refunded = 0) =>
      store.upsertPayment({ provider: 'stripe', payment_id: id, account: 'corp', mid: 'corp', paid_at: trialAt + 7 * DAY, amount_usd_cents: 1000, refunded_usd_cents: refunded, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null });
    charge('ch_a');
    charge('ch_r', 1000);
    const at = trialAt + 20 * DAY;
    store.upsertVampReport(report('issfr_a', { customer_id: 'cus_a', payment_id: 'ch_a', reported_at: at }));
    store.upsertVampReport(report('du_a', { kind: 'dispute', case_type: 'chargeback', customer_id: 'cus_a', payment_id: 'ch_a', reported_at: at + DAY }));
    store.upsertVampReport(report('issfr_b', { network: 'mastercard', customer_id: 'cus_b', reported_at: at }));
    // событие до оформления триала — не его
    store.upsertVampReport(report('issfr_old', { customer_id: 'cus_c', reported_at: trialAt - DAY }));
    // исходы фрод-репортов: RDR, рефанд по платежу, рефанд по самому списанию, ничего
    store.upsertVampReport(report('issfr_rdr', { payment_id: 'ch_rdr', reported_at: at }));
    store.upsertVampReport(report('du_rdr', { kind: 'dispute', case_type: 'chargeback', rdr: true, payment_id: 'ch_rdr', reported_at: at }));
    store.upsertVampReport(report('issfr_r', { payment_id: 'ch_r', reported_at: at }));
    store.upsertVampReport(report('issfr_r2', { payment_id: 'ch_r2', reported_at: at, refunded: true, amount_usd_cents: 500 }));
    store.upsertVampReport(report('issfr_open', { payment_id: 'ch_open', reported_at: at, amount_usd_cents: 700 }));
    store.upsertVampReport(report('issfr_open2', { payment_id: 'ch_open2', reported_at: at }));
    refreshTrialFraud(store.db, 'stripe');
    return store;
  }

  it('в строке триала: был ли фрод (любая сеть) и сколько событий VAMP; в конверсии — fraud rate и VAMP на 100 триалов', () => {
    const store = storeWithTrials();
    const rows = store.db.prepare('SELECT subscription_id, fraud_flagged, vamp_events FROM trials ORDER BY subscription_id').all();
    expect(rows).toEqual([
      { subscription_id: 'sub_a', fraud_flagged: 1, vamp_events: 2 },
      { subscription_id: 'sub_b', fraud_flagged: 1, vamp_events: 0 },
      { subscription_id: 'sub_c', fraud_flagged: 0, vamp_events: 0 },
      { subscription_id: 'sub_d', fraud_flagged: 0, vamp_events: 0 },
    ]);
    const metrics = getMetrics(store.db, { ...base, granularity: 'day', from: '2026-09-01', to: '2026-09-01', timeZones: { stripe: 'UTC', solidgate: 'UTC' }, retryWindowDays: 30 });
    expect(metrics.totals).toMatchObject({ started: 4, paid_retry: 3, fraud: 2, fraud_rate: 2 / 3, vamp_events: 2, vamp_per_100: 50 });
  });

  it('после фрод-репорта: чарджбэк, RDR, вернули деньги (по платежу или по самому списанию), ничего — с суммами', () => {
    const outcomes = getVampOutcomes(storeWithTrials().db, { ...base, from: '2026-09-01', to: '2026-09-30' }, t);
    expect(outcomes.map((r) => [r.outcome, r.count, r.amount, r.unknown_amount])).toEqual([
      ['chargeback', 1, 1000, 0],
      ['rdr', 1, 0, 1],
      ['refunded', 2, 1500, 0],
      ['no_action', 2, 700, 1],
    ]);
    // в выгрузке — исход у каждого фрод-репорта; по строке вкладки — только он
    const open = exportVampReports(storeWithTrials().db, { ...base, from: '2026-09-01', to: '2026-09-30' }, t, 'no_action');
    expect(open.rows.map((r) => r[open.columns.indexOf('report_id')])).toEqual(['issfr_open', 'issfr_open2']);
    expect(open.rows[0][open.columns.indexOf('amount_usd')]).toBe('7.00');
  });

  it('рефанд, пришедший позже, отмечается у фрод-репорта', () => {
    const store = storeWithTrials();
    store.markVampRefunded('stripe', 'ch_open');
    const outcomes = getVampOutcomes(store.db, { ...base, from: '2026-09-01', to: '2026-09-30' }, t);
    expect(outcomes.find((r) => r.outcome === 'no_action')!.count).toBe(1);
  });
});
