import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { refreshTrialLtv } from '../src/ltv.js';
import { createApp } from '../src/server.js';
import type { Source } from '../src/sync.js';

const env = {
  STRIPE_KEYS: 'org=rk',
  BASIC_AUTH_USER: 'billing',
  BASIC_AUTH_PASSWORD: 'p:ss',
  GUEST_USER: 'guest',
  GUEST_PASSWORD: 'g-pass',
  HISTORY_FROM: '2026-09-01',
};
const config = loadConfig(env);
const auth = { authorization: `Basic ${Buffer.from('billing:p:ss').toString('base64')}` };
let close: () => void = () => {};

async function start(sources: Source[] = []) {
  const server = createApp({ store: openStore(':memory:'), config, sources }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  close = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(() => close());

describe('server', () => {
  it('/health, форма входа и иконка — без входа; страницы ведут на вход, API — 401; Basic тоже принимается', async () => {
    const url = await start();
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/login`)).status).toBe(200);
    expect((await fetch(`${url}/assets/favicon.svg`)).status).toBe(200);
    expect((await fetch(`${url}/assets/app.css`)).status).toBe(200);
    expect((await fetch(`${url}/api/metrics`)).status).toBe(401);
    const page = await fetch(`${url}/?mode=turnover`, { redirect: 'manual' });
    expect([page.status, page.headers.get('location')]).toEqual([303, '/login?next=%2F%3Fmode%3Dturnover']);
    const wrong = { authorization: `Basic ${Buffer.from('wrong:pass').toString('base64')}` };
    expect((await fetch(`${url}/api/metrics`, { headers: wrong })).status).toBe(401);
    expect((await fetch(`${url}/`, { headers: auth })).status).toBe(200);
  });

  it('вход по форме: cookie сессии и роль; гость не запускает синк; выход', async () => {
    const url = await start([{ provider: 'stripe', account: 'org', run: async () => 0 }]);
    const login = (user: string, password: string, next = '/') =>
      fetch(`${url}/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ user, password, next }) });

    const failed = await login('guest', 'wrong', '/?mode=turnover');
    expect([failed.status, failed.headers.get('location'), failed.headers.get('set-cookie')]).toEqual([
      303,
      '/login?error=1&next=%2F%3Fmode%3Dturnover',
      null,
    ]);
    expect((await login('guest', 'g-pass', '//evil.example')).headers.get('location')).toBe('/'); // только свой сайт

    const asGuest = await login('guest', 'g-pass', '/?mode=turnover');
    expect(asGuest.headers.get('location')).toBe('/?mode=turnover'); // обратно на ссылку, с которой пришли
    const cookie = { cookie: asGuest.headers.get('set-cookie')!.split(';')[0] };
    expect(asGuest.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect((await (await fetch(`${url}/api/metrics`, { headers: cookie })).json()).role).toBe('guest');
    expect((await fetch(`${url}/api/sync`, { method: 'POST', headers: cookie })).status).toBe(403);
    expect((await fetch(`${url}/login`, { headers: cookie, redirect: 'manual' })).status).toBe(303); // уже вошёл

    const forged = { cookie: cookie.cookie.replace('guest.', 'admin.') };
    expect((await fetch(`${url}/api/metrics`, { headers: forged })).status).toBe(401);

    const asAdmin = await login('billing', 'p:ss');
    const adminCookie = { cookie: asAdmin.headers.get('set-cookie')!.split(';')[0] };
    expect((await (await fetch(`${url}/api/metrics`, { headers: adminCookie })).json()).role).toBe('admin');
    expect((await fetch(`${url}/api/sync`, { method: 'POST', headers: adminCookie })).status).toBe(202);

    const out = await fetch(`${url}/logout`, { method: 'POST', headers: adminCookie, redirect: 'manual' });
    expect([out.headers.get('location'), out.headers.get('set-cookie')]).toEqual(['/login', expect.stringMatching(/bd_session=;/)]);
  });

  it('/api/metrics отдаёт итоги за период, ряд и статус синка', async () => {
    const url = await start();
    const query = 'provider=stripe&granularity=month&period=custom&from=2026-09-10&to=2026-09-20';
    const body = await (await fetch(`${url}/api/metrics?${query}`, { headers: auth })).json();
    expect(body).toMatchObject({
      retry_window_days: 30,
      history_from: '2026-09-01',
      range: { from: '2026-09-10', to: '2026-09-20' },
      sync_running: false,
      sync: [],
      totals: { started: 0 },
    });
    expect(body.series).toHaveLength(1);
    expect(body.series[0]).toMatchObject({ period: '2026-09-10', period_end: '2026-09-20' });
    expect(body).toMatchObject({ view: 'time', filters: {}, breakdown: [], reasons: [] });
    expect(body.totals).toMatchObject({ attempts: 0, approval_rate: null, decline_rate: null, refund_rate: null });
  });

  it('/api/metrics: фильтры, разбивки по измерению и причины отказа', async () => {
    const store = openStore(':memory:');
    const started = Date.parse('2026-09-10T12:00:00Z') / 1000;
    const rows = [
      ['a', 'US', 'apple_pay', 'SUTTON BANK'],
      ['b', 'US', 'google_pay', null],
      ['c', null, 'apple_pay', null],
    ] as const;
    for (const [id, country, method, bank] of rows) {
      store.upsertTrial({
        provider: 'stripe', account: 'corp', subscription_id: id, trial_started_at: started, trial_ended_at: started + 7 * 86_400,
        first_invoice_id: `in_${id}`, first_attempt_succeeded: false, paid_at: null, country, payment_method: method, card_brand: 'visa', bank,
      });
    }
    store.upsertAttempt({ provider: 'stripe', attempt_id: 'ch_a', subscription_id: 'a', attempted_at: started + 7 * 86_400, approved: false, reason: 'do_not_honor', refunded: false });
    const server = createApp({ store, config, sources: [] }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (q: string) => (await fetch(`${url}/api/metrics?period=custom&from=2026-09-10&to=2026-09-10&${q}`, { headers: auth })).json();

    expect((await get('country=us')).totals.started).toBe(2);
    expect((await get('country=none')).totals.started).toBe(1);
    expect((await get('country=US&payment_method=google_pay')).totals.started).toBe(1);
    // несколько значений — повторяющимся параметром; без повторов и в одном порядке
    const multi = await get('country=us&country=none&country=US');
    expect([multi.totals.started, multi.filters]).toEqual([3, { country: ['US', 'none'] }]);
    expect((await get('country=US&country=<script>')).filters).toEqual({ country: ['US'] });
    expect((await get(`bank=${encodeURIComponent('SUTTON BANK')}`)).totals.started).toBe(1);
    expect((await get('country=<script>')).filters).toEqual({});
    expect((await get('account=stripe:corp')).totals.started).toBe(3);
    expect((await get('account=stripe:org')).totals.started).toBe(0);
    expect((await get('account=corp')).filters).toEqual({}); // без провайдера — не принимается
    expect((await get('view=account')).breakdown.map((r: { value: string | null }) => r.value)).toEqual(['stripe:corp']);

    const byMethod = await get('view=payment_method');
    expect(byMethod.breakdown.map((r: { value: string | null; started: number }) => [r.value, r.started])).toEqual([
      ['apple_pay', 2],
      ['google_pay', 1],
    ]);
    expect(byMethod.series).toEqual([]);
    expect((await get('view=decline_reason')).reasons).toEqual([
      { reason: 'Do not honor / Generic decline', hint: 'Банк отклонил без объяснения причины', count: 1, share: 1, first_declines: 1, recovered: 0, recovery_rate: 0, avg_attempts: 1, avg_days_to_pay: null, final: expect.any(Boolean) }, // окончательность — от текущей даты
    ]);
    expect((await get('view=bank')).breakdown.map((r: { value: string | null }) => r.value)).toEqual(['SUTTON BANK', null]);
  });

  it('/api/cancellations: итоги, разбивки и причины отмены; значения фильтра и выгрузка', async () => {
    const store = openStore(':memory:');
    const started = Date.parse('2026-09-10T12:00:00Z') / 1000;
    for (const [id, method, cancel] of [['a', 'apple_pay', 3600], ['b', 'google_pay', null], ['c', 'apple_pay', 9 * 86_400]] as const) {
      store.upsertTrial({
        provider: 'stripe', account: 'corp', subscription_id: id, trial_started_at: started, trial_ended_at: started + 7 * 86_400,
        first_invoice_id: null, first_attempt_succeeded: null, paid_at: null, country: 'US', payment_method: method, card_brand: 'visa', bank: null,
        canceled_at: cancel === null ? null : started + cancel, cancel_reason: cancel === null ? null : 'cancellation_requested',
      });
    }
    const server = createApp({ store, config, sources: [] }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const period = 'period=custom&from=2026-09-10&to=2026-09-10';
    const get = async (q: string) => (await fetch(`${url}/api/cancellations?${period}&${q}`, { headers: auth })).json();

    const trend = await get('');
    expect(trend.totals).toMatchObject({ started: 3, canceled_in_trial: 1, canceled_day0: 1, canceled_after: 1 });
    expect([trend.series.length, trend.by_day, trend.median_cancel_day]).toEqual([1, [{ day: 0, count: 1, share: 1 }], 0]);
    expect((await get('payment_method=google_pay')).totals.started).toBe(1);
    const byMethod = await get('view=payment_method');
    expect([byMethod.series, byMethod.breakdown.map((r: { value: string; started: number }) => [r.value, r.started])]).toEqual([[], [['apple_pay', 2], ['google_pay', 1]]]);
    expect((await get('view=cancel_reason')).reasons).toMatchObject([{ reason: 'Requested', count: 2, in_trial: 1, after_trial: 1 }]);

    const values = await (await fetch(`${url}/api/values?mode=cancellations&dimension=payment_method&${period}`, { headers: auth })).json();
    expect(values.values).toEqual([{ value: 'apple_pay', count: 2 }, { value: 'google_pay', count: 1 }]);
    const csv = await fetch(`${url}/api/export?mode=cancellations&view=cancel_reason&reason=Requested&${period}`, { headers: auth });
    expect(csv.headers.get('content-disposition')).toBe('attachment; filename="vpn-cancelled-trials_2026-09-10_2026-09-10.csv"');
    expect((await csv.text()).trim().split('\r\n')).toHaveLength(3); // заголовок и два отменённых
  });

  it('/api/ltv: деньги на триал по когортам и разрезы; выгрузка триалов с LTV', async () => {
    const store = openStore(':memory:');
    const started = Date.parse('2026-09-10T12:00:00Z') / 1000;
    store.upsertTrial({
      provider: 'stripe', account: 'corp', subscription_id: 's1', trial_started_at: started, trial_ended_at: started + 7 * 86_400, first_invoice_id: 'in_1',
      first_attempt_succeeded: true, paid_at: started + 7 * 86_400, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null, customer_id: 'cus_1',
    });
    store.upsertPayment({ provider: 'stripe', payment_id: 'ch_1', account: 'corp', mid: 'corp', paid_at: started + 7 * 86_400, amount_usd_cents: 999, refunded_usd_cents: 0, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null, customer_id: 'cus_1' });
    refreshTrialLtv(store.db, 'stripe', 'corp', Date.now() / 1000);
    const server = createApp({ store, config, sources: [] }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const period = 'period=custom&from=2026-09-10&to=2026-09-10';
    const get = async (q: string) => (await fetch(`${url}/api/ltv?${period}&${q}`, { headers: auth })).json();
    expect((await get('')).totals).toMatchObject({ started: 1, paid: 1, ltv_30: 999, ltv_30_per_trial: 999, final_30: true });
    expect((await get('view=country')).breakdown).toMatchObject([{ value: 'US', ltv_90: 999 }]);
    const csv = await (await fetch(`${url}/api/export?mode=ltv&${period}`, { headers: auth })).text();
    expect(csv.split('\r\n')[0]).toContain('revenue_30d_usd');
    expect(csv.split('\r\n')[1]).toContain('9.99');
  });

  it('/api/retries: итоги, отдача по номеру попытки, по дням и кодам; выгрузка строки', async () => {
    const store = openStore(':memory:');
    const started = Date.parse('2026-09-10T12:00:00Z') / 1000;
    const end = started + 7 * 86_400;
    store.upsertTrial({
      provider: 'stripe', account: 'corp', subscription_id: 's1', trial_started_at: started, trial_ended_at: end, first_invoice_id: 'in_1',
      first_attempt_succeeded: false, paid_at: end + 3 * 86_400, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null,
    });
    store.upsertAttempt({ provider: 'stripe', attempt_id: 'ch_1', subscription_id: 's1', attempted_at: end, approved: false, reason: 'insufficient_funds', refunded: false });
    store.upsertAttempt({ provider: 'stripe', attempt_id: 'ch_2', subscription_id: 's1', attempted_at: end + 3 * 86_400, approved: true, reason: null, refunded: false });
    const server = createApp({ store, config, sources: [] }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const period = 'period=custom&from=2026-09-10&to=2026-09-10';
    const get = async (q: string) => (await fetch(`${url}/api/retries?${period}&${q}`, { headers: auth })).json();

    const trend = await get('');
    expect(trend.totals).toMatchObject({ first_declined: 1, retries: 1, recovered: 1, recovery_rate: 1 });
    expect(trend.curve.map((r: { attempt: number; approved: number }) => [r.attempt, r.approved])).toEqual([[1, 0], [2, 1]]);
    expect((await get('view=day')).days).toMatchObject([{ day: 3, retries: 1, approved: 1 }]);
    expect((await get('view=decline_code')).codes).toMatchObject([{ code: 'insufficient_funds', declines: 1, next_approved: 1 }]);
    expect((await get('view=payment_method')).breakdown).toMatchObject([{ value: 'apple_pay', retries: 1 }]);
    const csv = await fetch(`${url}/api/export?mode=retries&view=attempt&attempt=2&${period}`, { headers: auth });
    expect(csv.headers.get('content-disposition')).toContain('vpn-retry-attempts_');
    expect((await csv.text()).trim().split('\r\n')).toHaveLength(2);
  });

  it('/api/vamp: месяцы, итог месяца по мерчантам, разбивки; значения фильтра и выгрузка', async () => {
    const store = openStore(':memory:');
    const at = Date.parse('2026-09-10T12:00:00Z') / 1000;
    for (let i = 0; i < 20; i++) {
      store.upsertPayment({ provider: 'stripe', payment_id: `ch_${i}`, account: 'org', mid: 'org', paid_at: at, amount_usd_cents: 999, refunded_usd_cents: 0, country: 'US', payment_method: 'card', card_brand: 'visa', bank: null });
    }
    const report = { provider: 'stripe' as const, account: 'org', mid: 'org', reported_at: at, payment_id: 'ch_1', charged_at: at, network: 'visa', country: 'US',
      payment_method: 'card', customer_id: null, risk_score: 70, reason: null, case_type: null, rdr: false, lost_usd_cents: 0, amount_usd_cents: null, refunded: false };
    store.upsertVampReport({ ...report, report_id: 'issfr_1', kind: 'fraud' });
    store.upsertVampReport({ ...report, report_id: 'du_1', kind: 'dispute', case_type: 'chargeback' });
    const server = createApp({ store, config, sources: [] }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // период — с середины месяца: расширяется до его начала
    const period = 'period=custom&from=2026-09-15&to=2026-09-30';
    const get = async (q: string) => (await fetch(`${url}/api/vamp?${period}&${q}`, { headers: auth })).json();

    const trend = await get('');
    expect([trend.range, trend.thresholds]).toEqual([{ from: '2026-09-01', to: '2026-09-30' }, { ratio: 0.015, count: 1500 }]);
    expect(trend.month).toMatchObject({ from: '2026-09-01', vamp_count: 2, visa_sales: 20, vamp_ratio: 0.1, merchants: 1, status: 'at_risk', final: true });
    // аккаунты Stripe по умолчанию — один мерчант Visa
    expect(trend.series).toHaveLength(1);
    expect(trend.daily.current).toHaveLength(30);
    expect((await get('view=merchant')).breakdown.map((r: { value: string; status: string }) => [r.value, r.status])).toEqual([['TOGGLE (10000290)', 'at_risk']]);
    expect((await get('view=mid')).breakdown.map((r: { value: string; status: string }) => [r.value, r.status])).toEqual([['stripe:org', null]]);
    expect((await get(`merchant=${encodeURIComponent('TOGGLE (10000290)')}`)).month.status).toBe('at_risk');
    expect((await get('view=risk')).breakdown.map((r: { value: string }) => r.value)).toEqual(['50–74']);
    // после фрод-репорта: по ch_1 пришёл и чарджбэк — сумма из платежа
    const after = await get('view=outcome');
    expect(after.outcomes.map((r: { outcome: string; count: number; amount: number }) => [r.outcome, r.count, r.amount])).toEqual([
      ['chargeback', 1, 999], ['rdr', 0, 0], ['refunded', 0, 0], ['no_action', 0, 0],
    ]);
    const csvOf = async (outcome: string) =>
      (await (await fetch(`${url}/api/export?mode=vamp&view=outcome&reason=${outcome}&${period}`, { headers: auth })).text()).trim().split('\r\n');
    expect([(await csvOf('chargeback')).length, (await csvOf('no_action')).length]).toEqual([2, 1]); // заголовок и строки

    const values = await (await fetch(`${url}/api/values?mode=vamp&dimension=country&${period}`, { headers: auth })).json();
    expect(values.values).toEqual([{ value: 'US', count: 2 }]);
    const csv = await fetch(`${url}/api/export?mode=vamp&view=risk&risk=${encodeURIComponent('50–74')}&${period}`, { headers: auth });
    expect(csv.headers.get('content-disposition')).toContain('vamp-reports_');
    expect((await csv.text()).trim().split('\r\n')).toHaveLength(3);
  });

  it('eSIM: продукт есть только с ключом; оборот — только VPN; обзор и удержание eSIM', async () => {
    const store = openStore(':memory:');
    const at = Date.parse('2026-09-10T12:00:00Z') / 1000;
    const esim = { provider: 'stripe' as const, account: 'esim', mid: 'esim', refunded_usd_cents: 0, country: 'ES', payment_method: 'apple_pay', card_brand: 'visa', bank: null,
      customer_id: 'cus_1', destination: 'Spain', package: '5 GB · 7 days', order_type: 'purchase' };
    store.upsertEsimCharge({ ...esim, payment_id: 'ch_1', intent_id: 'pi_1', paid_at: at, amount_usd_cents: 800, approved: false, reason: 'insufficient_funds' });
    store.upsertEsimCharge({ ...esim, payment_id: 'ch_2', intent_id: 'pi_1', paid_at: at + 60, amount_usd_cents: 800, approved: true, reason: null });
    store.upsertPayment({ provider: 'stripe', payment_id: 'ch_vpn', account: 'corp', mid: 'corp', paid_at: at, amount_usd_cents: 999, refunded_usd_cents: 0, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null });
    const withEsim = loadConfig({ ...env, ESIM_STRIPE_KEY: 'rk_esim' });
    const server = createApp({ store, config: withEsim, sources: [] }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (path: string) => (await fetch(`${url}${path}${path.includes('?') ? '&' : '?'}period=custom&from=2026-09-10&to=2026-09-10`, { headers: auth })).json();

    const vpn = await get('/api/turnover');
    expect([vpn.products, vpn.totals.gross]).toEqual([['vpn', 'esim'], 999]); // оборот — только VPN
    const overview = await get('/api/esim/overview');
    expect(overview.totals).toMatchObject({ orders: 1, paid_orders: 1, new_customers: 1, revenue: 800, payment_success_rate: 1 });
    expect((await get('/api/esim/overview?view=destination')).breakdown.map((r: { value: string }) => r.value)).toEqual(['Spain']);
    expect((await get('/api/esim/overview?view=decline_reason')).reasons).toEqual([]); // единственный заказ оплачен
    expect((await get('/api/esim/repeat')).totals).toMatchObject({ customers: 1, repeat_30: 0 });
    const values = async (q: string) => (await (await fetch(`${url}/api/values?${q}`, { headers: auth })).json()).values;
    // в Японию — только неоплаченный заказ: в списке остаётся, с нулём
    store.upsertEsimCharge({ ...esim, customer_id: 'cus_2', destination: 'Japan', payment_id: 'ch_3', intent_id: 'pi_2', paid_at: at + 120, amount_usd_cents: 500, approved: false, reason: 'insufficient_funds' });
    expect(await values('mode=esim_overview&dimension=destination')).toEqual([{ value: 'Spain', count: 1 }, { value: 'Japan', count: 0 }]); // оплаченные заказы, как в Orders
    expect(await values('mode=esim_repeat&dimension=destination&destination=Japan')).toEqual([{ value: 'Spain', count: 1 }]); // клиенты

    // без ключа eSIM нет: эндпоинты — 404, оборот — всегда VPN
    server.close();
    const plain = await start();
    expect((await fetch(`${plain}/api/esim/overview`, { headers: auth })).status).toBe(404);
    expect((await (await fetch(`${plain}/api/turnover`, { headers: auth })).json()).products).toEqual(['vpn']);
  });

  it('/api/export: CSV текущей выборки — имя файла с экраном и периодом; строка причины; без eSIM — 404', async () => {
    const url = await start();
    const res = await fetch(`${url}/api/export?mode=conversion&period=custom&from=2026-09-10&to=2026-09-12`, { headers: auth });
    expect([res.status, res.headers.get('content-type'), res.headers.get('content-disposition')]).toEqual([
      200,
      'text/csv; charset=utf-8',
      'attachment; filename="vpn-trials_2026-09-10_2026-09-12.csv"',
    ]);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM — чтобы Numbers и Excel открыли UTF-8 (fetch при чтении текстом его срезает)
    expect(new TextDecoder().decode(bytes).split('\r\n')[0]).toMatch(/^provider,account,subscription_id,customer_id,/);
    const reasons = await fetch(`${url}/api/export?mode=conversion&view=decline_reason&reason=Fraudulent&period=custom&from=2026-09-10&to=2026-09-10`, { headers: auth });
    expect(reasons.headers.get('content-disposition')).toContain('vpn-declined-attempts_');
    expect((await fetch(`${url}/api/export?mode=turnover`, { headers: auth })).headers.get('content-disposition')).toContain('vpn-payments_');
    expect((await fetch(`${url}/api/export?mode=esim_overview`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${url}/api/export`)).status).toBe(401);
  });

  it('/api/sync: 202, а во время синка — 409', async () => {
    let release!: () => void;
    const url = await start([
      { provider: 'stripe', account: 'org', run: () => new Promise((resolve) => (release = () => resolve(0))) },
    ]);
    expect((await fetch(`${url}/api/sync`, { method: 'POST', headers: auth })).status).toBe(202);
    expect((await fetch(`${url}/api/sync`, { method: 'POST', headers: auth })).status).toBe(409);
    release();
  });

  it('/api/turnover: итоги, разбивка по MID с долями, фильтры', async () => {
    const store = openStore(':memory:');
    const paidAt = Date.parse('2026-09-10T12:00:00Z') / 1000;
    const base = { account: 'corp', paid_at: paidAt, refunded_usd_cents: 0, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null };
    store.upsertPayment({ ...base, provider: 'stripe', payment_id: 'ch_1', mid: 'corp', amount_usd_cents: 3_000 });
    store.upsertPayment({ ...base, provider: 'solidgate', payment_id: 'o1', account: 'sgH2H', mid: '237b93d9-0bac-43c4-8844-938d6f354c66', amount_usd_cents: 1_000 });
    const server = createApp({ store, config, sources: [] }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (q: string) => (await fetch(`${url}/api/turnover?period=custom&from=2026-09-10&to=2026-09-10&${q}`, { headers: auth })).json();

    const all = await get('');
    expect(all).toMatchObject({ view: 'time', range: { from: '2026-09-10', to: '2026-09-10' }, sync_running: false, breakdown: [] });
    expect(all.totals).toEqual({ payments: 2, gross: 4_000, refunded: 0, net: 4_000, average: 2_000 });
    expect(all.series).toHaveLength(1);

    const byMid = await get('view=mid');
    expect(byMid.breakdown.map((r: { value: string; share: number }) => [r.value, r.share])).toEqual([
      ['stripe:corp', 0.75],
      ['solidgate:237b93d9-0bac-43c4-8844-938d6f354c66', 0.25],
    ]);
    expect(byMid.series).toEqual([]);
    expect((await get('mid=solidgate:237b93d9-0bac-43c4-8844-938d6f354c66')).totals.gross).toBe(1_000);
    expect((await get('mid=<script>')).filters).toEqual({});
    expect((await get('account=stripe:corp')).filters).toEqual({}); // у оборота нет разреза «аккаунт» — есть MID
  });

  it('/api/values: значения одного фильтра для текущей выборки — период, провайдер и остальные фильтры, кроме своего', async () => {
    const store = openStore(':memory:');
    const started = Date.parse('2026-09-10T12:00:00Z') / 1000;
    const trial = (id: string, provider: 'stripe' | 'solidgate', country: string | null) =>
      store.upsertTrial({
        provider, account: provider === 'stripe' ? 'corp' : 'sgH2H', subscription_id: id, trial_started_at: started, trial_ended_at: started + 7 * 86_400,
        first_invoice_id: null, first_attempt_succeeded: null, paid_at: null, country, payment_method: 'apple_pay', card_brand: 'visa', bank: null,
      });
    trial('a', 'stripe', 'US');
    trial('b', 'stripe', 'US');
    trial('c', 'solidgate', 'SA');
    trial('d', 'solidgate', null);
    store.upsertTrial({ ...store.getTrial('stripe', 'a')!, subscription_id: 'e', trial_started_at: started - 5 * 86_400 }); // 05.09
    const server = createApp({ store, config, sources: [] }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const values = async (q: string) => (await (await fetch(`${url}/api/values?${q}`, { headers: auth })).json()).values;

    expect(await values('dimension=country')).toEqual([{ value: 'US', count: 3 }, { value: 'SA', count: 1 }, { value: null, count: 1 }]);
    expect(await values('dimension=country&period=custom&from=2026-09-10&to=2026-09-10')).toEqual([
      { value: 'US', count: 2 }, // 05.09 — вне периода
      { value: 'SA', count: 1 },
      { value: null, count: 1 },
    ]);
    expect(await values('dimension=account&provider=solidgate')).toEqual([{ value: 'solidgate:sgH2H', count: 2 }]);
    expect(await values('dimension=account&country=US')).toEqual([{ value: 'stripe:corp', count: 3 }]); // другой фильтр сужает
    expect(await values('dimension=country&country=US')).toHaveLength(3); // свой — нет: иначе осталось бы только выбранное
    expect(await values('mode=turnover&dimension=mid')).toEqual([]); // платежей нет — значений нет
    expect(await values('dimension=nope')).toEqual([]);
  });

  it('ответ кэшируется до следующего синка: новые данные видны после того, как синк закончился', async () => {
    const store = openStore(':memory:');
    const started = Date.parse('2026-09-10T12:00:00Z') / 1000;
    const trial = (id: string) =>
      store.upsertTrial({
        provider: 'stripe', account: 'corp', subscription_id: id, trial_started_at: started, trial_ended_at: started + 7 * 86_400,
        first_invoice_id: null, first_attempt_succeeded: null, paid_at: null, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null, mid: 'corp',
      });
    trial('a');
    const server = createApp({ store, config, sources: [] }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const started_ = async () =>
      (await (await fetch(`${url}/api/metrics?period=custom&from=2026-09-10&to=2026-09-10&view=country`, { headers: auth })).json()).totals.started;

    expect(await started_()).toBe(1);
    const version = async () => (await (await fetch(`${url}/api/metrics`, { headers: auth })).json()).data_version;
    const before = await version();
    trial('b'); // синк пишет в базу…
    expect(await started_()).toBe(1); // …а до его конца отдаётся посчитанное
    store.finishRun(store.startRun('stripe', 'corp', 'daily'), 'ok', 1, null);
    expect(await started_()).toBe(2);
    expect(await version()).not.toBe(before); // браузер по ней перезапрашивает значения фильтров
  });
});
