import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openStore, type AttemptRow, type TrialRow, type VampReportRow } from '../src/db.js';
import { buildDigest, digestDue, runDigest, sendToSlack } from '../src/digest.js';
import { DAY } from '../src/metrics.js';

// «Сейчас» — понедельник 12 октября 06:30 UTC: сводка за воскресенье 11 октября. Сутки обоих провайдеров — UTC, триалы по 7 дней
const ts = (iso: string) => Date.parse(iso) / 1000;
const NOW = ts('2026-10-12T06:30:00Z');
const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/secret';
const env = {
  STRIPE_KEYS: 'corp=rk_a,org=rk_b',
  SOLIDGATE_KEYS: 'sgH2H=pk:sk',
  ADMIN_USER: 'admin',
  ADMIN_PASSWORD: 'secret',
  HISTORY_FROM: '2026-09-01',
  TIMEZONE: 'UTC',
};
const config = loadConfig(env);

let seq = 0;
function trial(startedIso: string, patch: Partial<TrialRow> = {}): TrialRow {
  const started = ts(startedIso);
  return {
    provider: 'stripe', account: 'corp', subscription_id: `sub_${++seq}`, trial_started_at: started, trial_ended_at: started + 7 * DAY,
    first_invoice_id: null, first_attempt_succeeded: null, paid_at: null, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null, mid: 'corp',
    ...patch,
  };
}
const sg = { provider: 'solidgate' as const, account: 'sgH2H', mid: 'm1' };

function storeWith(rows: TrialRow[]) {
  const store = openStore(':memory:');
  rows.forEach((r) => store.upsertTrial(r));
  return store;
}

// Строки таблицы под заголовком раздела: ячейки, разделённые двумя и более пробелами
function table(text: string, title: string): string[][] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`*${title}`));
  const open = lines.indexOf('```', start);
  const close = lines.indexOf('```', open + 1);
  return lines.slice(open + 1, close).map((l) => l.trim().split(/\s{2,}/));
}
const row = (rows: string[][], label: string) => rows.find((r) => r[0] === label);

describe('сводка в Slack — текст', () => {
  it('триалы за вчера — итог и каждый аккаунт, Δ к среднему за 7 дней до этого', () => {
    const days = ['04', '05', '06', '07', '08', '09', '10'];
    const store = storeWith([
      // corp: вчера 3, раньше по одному в день → +200%
      ...[1, 2, 3].map(() => trial('2026-10-11T10:00:00Z')),
      ...days.map((d) => trial(`2026-10-${d}T10:00:00Z`)),
      // sgH2H: вчера 1, раньше по два в день → −50%
      trial('2026-10-11T10:00:00Z', sg),
      ...days.flatMap((d) => [trial(`2026-10-${d}T10:00:00Z`, sg), trial(`2026-10-${d}T11:00:00Z`, sg)]),
    ]);
    const text = buildDigest(store, config, NOW);
    expect(text.startsWith('*Billing · сводка за вс, 11 окт*')).toBe(true);
    const rows = table(text, 'Триалы');
    expect(rows[0]).toEqual(['триалы', 'Δ']);
    expect(row(rows, 'Всего')).toEqual(['Всего', '4', '+33%']);
    expect(row(rows, 'corp')).toEqual(['corp', '3', '+200%']);
    expect(row(rows, 'org')).toEqual(['org', '0', '—']); // ни вчера, ни раньше — сравнивать не с чем
    expect(row(rows, 'sgH2H')).toEqual(['sgH2H', '1', '−50%']);
  });

  it('первые платежи — у последних когорт с окончательной цифрой; Δ — в п.п. к доле за 7 дней вместе', () => {
    // первая попытка окончательна у когорт по 3 октября (конец триала + сутки), окно ретраев — по 4 сентября (+ 30 дней)
    const end = (iso: string) => ts(iso) + 7 * DAY;
    const store = storeWith([
      trial('2026-10-10T10:00:00Z', { first_attempt_succeeded: true }), // ещё не окончательная — пропускается
      trial('2026-10-03T10:00:00Z', { first_attempt_succeeded: true }),
      trial('2026-10-03T10:00:00Z', { first_attempt_succeeded: false }),
      // база: 4 триала за 26 сен — 2 окт, один оплатил с первой попытки → 25%
      trial('2026-09-27T10:00:00Z', { first_attempt_succeeded: true }),
      ...[1, 2, 3].map(() => trial('2026-09-28T10:00:00Z', { first_attempt_succeeded: false })),
      // когорта 4 сентября: r1 оплатил сразу, r2 — дважды отказ и не оплатил
      trial('2026-09-04T10:00:00Z', { subscription_id: 'r1', first_invoice_id: 'in_1', first_attempt_succeeded: true, paid_at: end('2026-09-04T10:00:00Z') + 60 }),
      trial('2026-09-04T10:00:00Z', { subscription_id: 'r2', first_invoice_id: 'in_2', first_attempt_succeeded: false }),
    ]);
    const attempt = (sub: string, n: number, approved: boolean): AttemptRow => ({
      provider: 'stripe', attempt_id: `${sub}_${n}`, subscription_id: sub, attempted_at: end('2026-09-04T10:00:00Z') + n * DAY,
      approved, reason: approved ? null : 'insufficient_funds', refunded: false,
    });
    store.upsertAttempt(attempt('r1', 0, true));
    store.upsertAttempt(attempt('r2', 0, false));
    store.upsertAttempt(attempt('r2', 1, false));

    const text = buildDigest(store, config, NOW);
    expect(text).toContain('first-attempt у когорты 3 окт, approval и trial-to-paid — у когорты 4 сен');
    const rows = table(text, 'Первые платежи');
    expect(rows[0]).toEqual(['first-attempt', 'Δ п.п.', 'approval', 'Δ п.п.', 'trial-to-paid', 'Δ п.п.']);
    // базы у 4 сентября нет — история с 1 сентября, триалов раньше нет
    expect(row(rows, 'corp')).toEqual(['corp', '50,0%', '+25,0', '33,3%', '—', '50,0%', '—']);
    expect(row(rows, 'sgH2H')).toEqual(['sgH2H', '—', '—', '—', '—', '—', '—']);
  });

  it('отмены — по дню отмены: во время триала и после его конца', () => {
    const store = storeWith([
      trial('2026-10-05T10:00:00Z', { canceled_at: ts('2026-10-11T09:00:00Z') }), // до конца триала 12 октября
      trial('2026-09-20T10:00:00Z', { canceled_at: ts('2026-10-11T09:00:00Z') }), // триал кончился 27 сентября
      trial('2026-09-20T10:00:00Z', { ...sg, canceled_at: ts('2026-10-11T23:00:00Z') }),
      trial('2026-10-04T10:00:00Z', { canceled_at: ts('2026-10-06T09:00:00Z') }), // база: одна отмена в триале за 7 дней
      trial('2026-10-04T10:00:00Z', { canceled_at: ts('2026-10-12T01:00:00Z') }), // уже сегодня — не в сводке
    ]);
    const rows = table(buildDigest(store, config, NOW), 'Отмены');
    expect(rows[0]).toEqual(['в триале', 'Δ', 'после', 'Δ']);
    expect(row(rows, 'Всего')).toEqual(['Всего', '1', '+600%', '2', '—']);
    expect(row(rows, 'corp')).toEqual(['corp', '1', '+600%', '1', '—']);
    expect(row(rows, 'sgH2H')).toEqual(['sgH2H', '0', '—', '1', '—']);
  });

  it('VAMP — по мерчантам: count и ratio с начала месяца, прогноз по полным дням, события за вчера, статус', () => {
    const store = openStore(':memory:');
    for (let i = 0; i < 100; i++) {
      store.upsertPayment({ provider: 'stripe', payment_id: `ch_${i}`, account: 'corp', mid: 'corp', paid_at: ts('2026-10-05T10:00:00Z'), amount_usd_cents: 999, refunded_usd_cents: 0, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null });
    }
    const report = (id: string, at: string): VampReportRow => ({
      provider: 'stripe', report_id: id, account: 'corp', mid: 'corp', kind: 'fraud', reported_at: ts(at), payment_id: null, charged_at: null, network: 'visa',
      country: 'US', payment_method: 'apple_pay', customer_id: null, risk_score: null, reason: null, case_type: null, rdr: false, lost_usd_cents: 0, amount_usd_cents: null, refunded: false,
    });
    for (let i = 0; i < 10; i++) store.upsertVampReport(report(`issfr_${i}`, '2026-10-03T10:00:00Z'));
    store.upsertVampReport(report('issfr_y', '2026-10-11T10:00:00Z'));
    store.upsertVampReport(report('issfr_t', '2026-10-12T01:00:00Z')); // сегодня — не в сводке

    const text = buildDigest(store, config, NOW);
    expect(text).toContain('*VAMP · октябрь, по 11 окт (UTC)*');
    // 11 событий за 11 дней → к концу месяца 31; ratio 11% выше порога 1,5%, count ниже 1 500 — At risk
    expect(row(table(text, 'VAMP'), 'TOGGLE (10000290)')).toEqual(['TOGGLE (10000290)', '11', '11,00%', '31', '+1', '🟡 At risk']);
  });

  it('предупреждение — только об источниках, чей последний синк упал; ссылка на дашборд — если задана', () => {
    const store = openStore(':memory:');
    const ok = store.startRun('stripe', 'corp', 'daily', ts('2026-10-12T02:00:00Z'));
    store.finishRun(ok, 'ok', 1, null, ts('2026-10-12T02:01:00Z'));
    const failed = store.startRun('stripe', 'corp', 'daily', ts('2026-10-12T06:00:00Z'));
    store.finishRun(failed, 'error', 0, 'rate limited', ts('2026-10-12T06:01:00Z'));
    const fine = store.startRun('solidgate', 'sgH2H', 'daily', ts('2026-10-12T06:00:00Z'));
    store.finishRun(fine, 'ok', 1, null, ts('2026-10-12T06:01:00Z'));

    const text = buildDigest(store, loadConfig({ ...env, DASHBOARD_URL: 'https://billpulse.app' }), NOW);
    expect(text).toContain('⚠️ Stripe corp: последняя загрузка упала — данные на 12 окт 02:01 UTC');
    expect(text).not.toContain('Solidgate sgH2H: последняя');
    expect(text.endsWith('<https://billpulse.app|Открыть дашборд>')).toBe(true);
    expect(buildDigest(openStore(':memory:'), config, NOW)).not.toMatch(/⚠️|Открыть дашборд/);
  });
});

describe('сводка в Slack — отправка', () => {
  const withWebhook = loadConfig({ ...env, SLACK_WEBHOOK_URL: WEBHOOK });
  const ok = () => vi.fn(async () => new Response('ok'));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('в 06:00 UTC: свежий синк, отправка, отметка — второй раз в те же сутки не уходит', async () => {
    const fetch = ok();
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = openStore(':memory:');
    const sync = vi.fn(async () => {});

    expect(await runDigest(store, withWebhook, sync, () => ts('2026-10-12T05:59:00Z'))).toBe(false); // ещё рано
    expect(sync).not.toHaveBeenCalled();

    expect(await runDigest(store, withWebhook, sync, () => NOW)).toBe(true);
    expect(sync).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(JSON.parse(init.body as string).text).toContain('*Billing · сводка за вс, 11 окт*');

    // перезапуск потока вечером — сегодня уже отправлено; на следующие сутки — снова пора
    expect(await runDigest(store, withWebhook, sync, () => ts('2026-10-12T20:00:00Z'))).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(digestDue(store, ts('2026-10-13T06:00:00Z'))).toBe(true);
  });

  it('без вебхука ничего не делает', async () => {
    const sync = vi.fn(async () => {});
    expect(await runDigest(openStore(':memory:'), config, sync, () => NOW)).toBe(false);
    expect(sync).not.toHaveBeenCalled();
  });

  it('Slack отказал — ошибка в журнал без адреса вебхука, отметки нет: следующий старт потока отправит снова', async () => {
    const fetch = vi.fn(async () => new Response('invalid_token', { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = openStore(':memory:');
    expect(await runDigest(store, withWebhook, async () => {}, () => NOW)).toBe(false);
    expect(fetch).toHaveBeenCalledOnce(); // 403 повтором не исправить
    expect(error.mock.calls[0][0]).toContain('Slack ответил 403: invalid_token');
    expect(error.mock.calls[0][0]).not.toContain('secret');
    expect(digestDue(store, NOW)).toBe(true);
  });

  it('сбой сети, 429 и 5xx — до трёх попыток с паузой в минуту', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    const pause = vi.fn(async () => {});
    await sendToSlack(WEBHOOK, 'text', pause);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledWith(60_000);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));
    await expect(sendToSlack(WEBHOOK, 'text', pause)).rejects.toThrow('Slack ответил 429: slow down');
  });
});
