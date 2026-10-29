import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createVisitsClient, liveVisits, visitBreakdown, visitSeries, visitTotals, type VisitQuery, type VisitStats } from '../src/visits.js';

const listen = async (server: http.Server) => {
  server.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
let closers: (() => void)[] = [];
afterEach(() => {
  closers.forEach((close) => close());
  closers = [];
});

const NY = 'America/New_York';
const day = (d: string, count: number, value: string | null = null) => ({ day: d, value, count });

describe('клиент сборщика', () => {
  it('спрашивает /api/stats события visit с разрезом и фильтрами, с токеном в заголовке; ответ держит минуту', async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    const collector = http.createServer((req, res) => {
      seen.push({ url: req.url!, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ time_zone: NY, rows: [day('2026-10-20', 5)] }));
    });
    const url = await listen(collector);
    closers.push(() => collector.close());
    const client = createVisitsClient({ url, token: 'tok-123' });
    const query: VisitQuery = { from: '2026-10-20', to: '2026-10-21', group: 'os', filters: { site: ['a.example', 'b.example'], device: ['mobile'] } };

    expect(await client(query)).toEqual({ time_zone: NY, rows: [day('2026-10-20', 5)] });
    await client(query); // второй раз — из памяти
    expect(seen).toEqual([
      { url: '/api/stats?from=2026-10-20&to=2026-10-21&event=visit&group=os&site=a.example&site=b.example&device=mobile', auth: 'Bearer tok-123' },
    ]);
  });

  it('ошибка сборщика — с его статусом, без токена; ошибку не запоминает', async () => {
    let status = 401;
    const collector = http.createServer((_req, res) => {
      res.statusCode = status;
      res.end(JSON.stringify({ time_zone: NY, rows: [] }));
    });
    const url = await listen(collector);
    closers.push(() => collector.close());
    const client = createVisitsClient({ url, token: 'tok-123' });
    const query: VisitQuery = { from: '2026-10-20', to: '2026-10-20', group: null, filters: {} };

    const error = await client(query).catch((e: Error) => e);
    expect((error as Error).message).toBe('Visit collector responded 401');
    status = 200;
    expect(await client(query)).toEqual({ time_zone: NY, rows: [] }); // следующий запрос спросил снова

    collector.close();
    const down = createVisitsClient({ url, token: 'tok-123' });
    const failed = (await down(query).catch((e: Error) => e)) as Error;
    expect(failed.message).toMatch(/^Visit collector is unavailable: /);
    expect(failed.message).not.toMatch(/tok-123/);
  });
});

describe('ряд и разбивка', () => {
  const stats: VisitStats = { time_zone: NY, rows: [day('2026-10-19', 3), day('2026-10-21', 4), day('2026-10-27', 2)] };

  it('по дням — с нулевыми днями; по неделям с понедельника; по месяцам; итоги', () => {
    const range = { from: '2026-10-19', to: '2026-10-27' };
    const byDay = visitSeries(stats, { ...range, granularity: 'day' });
    expect(byDay).toHaveLength(9);
    expect(byDay.slice(0, 3)).toEqual([
      { period: '2026-10-19', period_end: '2026-10-19', visits: 3 },
      { period: '2026-10-20', period_end: '2026-10-20', visits: 0 },
      { period: '2026-10-21', period_end: '2026-10-21', visits: 4 },
    ]);
    expect(visitSeries(stats, { ...range, granularity: 'week' })).toEqual([
      { period: '2026-10-19', period_end: '2026-10-25', visits: 7 },
      { period: '2026-10-26', period_end: '2026-10-27', visits: 2 },
    ]);
    expect(visitSeries(stats, { ...range, granularity: 'month' })).toEqual([{ period: '2026-10-19', period_end: '2026-10-27', visits: 9 }]);
    expect(visitTotals(stats)).toEqual({ visits: 9 });
  });

  it('боевые визиты — без тестовых сборок лендинга: dev-, stage-, локальной и превью Cloudflare Pages', () => {
    const sites = ['toggle-vpn.com', 'www.vpntoggle.app', 'dev-www.togglevpn.org', 'stage-www.togglevpn.org', 'localhost:5173', '127.0.0.1:3000', 'abc123.landing.pages.dev', 'devices.example'];
    const stats: VisitStats = { time_zone: NY, rows: sites.map((s) => day('2026-10-20', 1, s)) };
    expect(liveVisits(stats).rows.map((r) => r.value)).toEqual(['toggle-vpn.com', 'www.vpntoggle.app', 'devices.example']);
  });

  it('разбивка: дни одного значения складываются; по убыванию, доля — от всех визитов, «не определено» — в конце', () => {
    const bySite: VisitStats = {
      time_zone: NY,
      rows: [day('2026-10-20', 2, 'b.example'), day('2026-10-20', 1, null), day('2026-10-20', 3, 'a.example'), day('2026-10-21', 2, 'b.example')],
    };
    expect(visitBreakdown(bySite)).toEqual([
      { value: 'b.example', visits: 4, share: 0.5 },
      { value: 'a.example', visits: 3, share: 0.375 },
      { value: null, visits: 1, share: 0.125 },
    ]);
  });
});

describe('экран Visits', () => {
  const env = { STRIPE_KEYS: 'org=rk', ADMIN_USER: 'billing', ADMIN_PASSWORD: 'secret', HISTORY_FROM: '2026-09-01' };
  const auth = { authorization: `Basic ${Buffer.from('billing:secret').toString('base64')}` };

  // Сборщик-заглушка: визиты с 19.10, по сайтам — два сайта
  async function start(fail = false) {
    const queries: VisitQuery[] = [];
    const visits = async (q: VisitQuery): Promise<VisitStats> => {
      queries.push(q);
      if (fail) throw new Error('Visit collector is unavailable: fetch failed');
      // по сайтам: боевые a и b и тестовая сборка лендинга dev-www — её визиты не входят в Visit → Trial
      if (q.group === 'site') return { time_zone: NY, rows: [day('2026-10-19', 3, 'a.example'), day('2026-10-20', 2, 'a.example'), day('2026-10-20', 2, 'b.example'), day('2026-10-20', 50, 'dev-www.example')] };
      return { time_zone: NY, rows: [day('2026-10-19', 3), day('2026-10-20', 54)] };
    };
    const store = openStore(':memory:');
    // триал 20.10 по Нью-Йорку — для Visit → Trial на экране Conversion
    const started = Date.parse('2026-10-20T15:00:00Z') / 1000;
    store.upsertTrial({
      provider: 'stripe', account: 'org', subscription_id: 'sub_1', trial_started_at: started, trial_ended_at: started + 3 * 86_400, first_invoice_id: null,
      first_attempt_succeeded: null, paid_at: null, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null, mid: 'org',
    });
    const app = createApp({ store, config: loadConfig(env), visits });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    closers.push(() => server.close());
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, queries };
  }
  const get = (url: string, path: string) => fetch(`${url}${path}`, { headers: auth });

  it('тренд — с первого дня, когда в сборщике есть визиты; фильтры уходят в сборщик, неверные отбрасываются', async () => {
    const { url, queries } = await start();
    const data = await (await get(url, '/api/visits?period=custom&from=2026-10-01&to=2026-10-21&site=a.example&device=phone&browser=facebook')).json();
    expect(data).toMatchObject({
      visits: true,
      time_zone: NY,
      range: { from: '2026-10-19', to: '2026-10-21' }, // раньше 19.10 визитов нет
      filters: { site: ['a.example'], browser: ['facebook'] }, // device=phone — не значение сборщика
      view: 'time',
      totals: { visits: 57 },
      breakdown: [],
      role: 'admin',
    });
    expect(data.series.map((p: { visits: number }) => p.visits)).toEqual([3, 54, 0]);
    expect(queries.at(-1)).toEqual({ from: '2026-10-19', to: '2026-10-21', group: null, filters: { site: ['a.example'], browser: ['facebook'] } });
    const byAccount = await (await get(url, '/api/visits?account=solidgate&account=stripe:org&account=org')).json();
    expect(byAccount.filters).toEqual({ account: ['solidgate', 'stripe:org'] }); // «org» — не формат аккаунта
  });

  it('разбивка по сайту и значения фильтра — без своего фильтра; в общем ответе экранов флаг visits', async () => {
    const { url, queries } = await start();
    const data = await (await get(url, '/api/visits?view=site')).json();
    // на экране Visits тестовые сайты видны
    expect(data.breakdown.map((r: { value: string; visits: number }) => [r.value, r.visits])).toEqual([['dev-www.example', 50], ['a.example', 5], ['b.example', 2]]);
    const values = await (await get(url, '/api/values?mode=visits&dimension=site&site=a.example&os=ios')).json();
    expect(values.values).toEqual([{ value: 'dev-www.example', count: 50 }, { value: 'a.example', count: 5 }, { value: 'b.example', count: 2 }]);
    expect(queries.at(-1)).toMatchObject({ group: 'site', filters: { os: ['ios'] } });
    expect((await (await get(url, '/api/turnover')).json()).visits).toBe(true);
  });

  it('сборщик недоступен — 502 с причиной только у этого экрана; без настроек — 404, флаг выключен', async () => {
    const { url } = await start(true);
    const res = await get(url, '/api/visits');
    expect([res.status, await res.json()]).toEqual([502, { error: 'Visit collector is unavailable: fetch failed' }]);
    expect((await get(url, '/api/turnover')).status).toBe(200);

    const plain = createApp({ store: openStore(':memory:'), config: loadConfig(env) }).listen(0);
    await new Promise((resolve) => plain.once('listening', resolve));
    closers.push(() => plain.close());
    const plainUrl = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
    expect((await get(plainUrl, '/api/visits')).status).toBe(404);
    expect((await (await get(plainUrl, '/api/turnover')).json()).visits).toBe(false);
    expect((await (await get(plainUrl, '/api/values?mode=visits&dimension=site')).json()).values).toEqual([]);
  });

  it('Conversion: визиты и Visit → Trial в тренде — без тестовых сайтов; до первого дня визитов — пусто; провайдер и аккаунт Stripe — по аккаунту пейволла, другие фильтры — без визитов', async () => {
    const { url, queries } = await start();
    const range = 'period=custom&from=2026-10-18&to=2026-10-20';
    const data = await (await get(url, `/api/metrics?${range}`)).json();
    expect(data.visits_status).toBe('ok');
    expect(data.series.map((p: { period: string; started: number; visits: number | null; visit_to_trial: number | null }) => [p.period, p.started, p.visits, p.visit_to_trial])).toEqual([
      ['2026-10-18', 0, null, null], // раньше первого дня визитов
      ['2026-10-19', 0, 3, 0],
      ['2026-10-20', 1, 4, 0.25],
    ]);
    // неделя с понедельника 19.10 — целиком после первого дня визитов
    const week = await (await get(url, `/api/metrics?period=custom&from=2026-10-19&to=2026-10-25&granularity=week`)).json();
    expect(week.series.map((p: { visits: number; visit_to_trial: number }) => [p.visits, p.visit_to_trial])).toEqual([[7, 1 / 7]]);
    // провайдер и аккаунт Stripe переносятся на визиты — по аккаунту пейволла
    const sentTo = async (q: string) => {
      const res = await (await get(url, `/api/metrics?${range}&${q}`)).json();
      return [res.visits_status, res.visits_status === 'ok' ? queries.at(-1)!.filters : null];
    };
    expect(await sentTo('provider=stripe')).toEqual(['ok', { account: ['stripe:org'] }]); // аккаунты Stripe из STRIPE_KEYS
    expect(await sentTo('provider=solidgate')).toEqual(['ok', { account: ['solidgate'] }]);
    expect(await sentTo('account=stripe:org')).toEqual(['ok', { account: ['stripe:org'] }]);
    // визит не знает страну, банк, способ оплаты и канал Solidgate (форма или Apple / Google Pay)
    for (const narrowed of ['country=US', 'account=solidgate:sgH2H', 'provider=solidgate&account=stripe:org']) {
      const res = await (await get(url, `/api/metrics?${range}&${narrowed}`)).json();
      expect([narrowed, res.visits_status, res.series[0].visits]).toEqual([narrowed, 'filtered', undefined]);
    }
    expect((await (await get(url, `/api/metrics?${range}&view=country`)).json()).visits_status).toBeUndefined(); // в разрезах визитов нет
  });

  it('Conversion при недоступном сборщике открывается — без визитов, с причиной', async () => {
    const { url } = await start(true);
    const res = await get(url, '/api/metrics?period=custom&from=2026-10-18&to=2026-10-20');
    const data = await res.json();
    expect([res.status, data.visits_status, data.visits_error, data.totals.started]).toEqual([200, 'unavailable', 'Visit collector is unavailable: fetch failed', 1]);
  });

  it('MCP: инструмент visits — с теми же цифрами, что у экрана', async () => {
    const { url } = await start();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: auth } }));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('visits');
    const result = await client.callTool({ name: 'visits', arguments: { view: 'site' } });
    const viaMcp = JSON.parse((result.content as { text: string }[])[0].text);
    expect(viaMcp.breakdown.map((r: { value: string }) => r.value)).toEqual(['dev-www.example', 'a.example', 'b.example']);
    await client.close();
  });
});
