import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openStore, type TrialRow } from '../src/db.js';
import { DAY } from '../src/metrics.js';
import { createApp } from '../src/server.js';

const config = loadConfig({
  STRIPE_KEYS: 'corp=rk',
  SOLIDGATE_KEYS: 'sgH2H=pk:sk',
  ADMIN_USER: 'billing',
  ADMIN_PASSWORD: 'secret',
  GUEST_USER: 'guest',
  GUEST_PASSWORD: 'g-pass',
  HISTORY_FROM: '2026-09-01',
});
const basic = (user: string, password: string) => ({ authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` });
const guest = basic('guest', 'g-pass');
const ts = (iso: string) => Date.parse(iso) / 1000;

let seq = 0;
function trial(startedIso: string, patch: Partial<TrialRow> = {}): TrialRow {
  const started = ts(startedIso);
  return {
    provider: 'stripe', account: 'corp', subscription_id: `sub_${++seq}`, trial_started_at: started, trial_ended_at: started + 7 * DAY,
    first_invoice_id: null, first_attempt_succeeded: null, paid_at: null, country: 'US', payment_method: 'apple_pay', card_brand: 'visa', bank: null, mid: 'corp',
    ...patch,
  };
}

let close: () => void = () => {};
async function start() {
  const store = openStore(':memory:');
  [
    trial('2026-09-10T12:00:00Z', { first_attempt_succeeded: true }),
    trial('2026-09-10T13:00:00Z', { first_attempt_succeeded: false, country: 'DE' }),
    trial('2026-09-11T12:00:00Z', { provider: 'solidgate', account: 'sgH2H', mid: 'm1', payment_method: 'google_pay' }),
  ].forEach((t) => store.upsertTrial(t));
  const server = createApp({ store, config }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  close = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function connect(url: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: guest } }));
  return client;
}
const text = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as { text: string }[])[0].text;
// поля, которые зависят от момента ответа или от того, кто спрашивает
const stable = ({ generated_at: _, role: __, ...rest }: Record<string, unknown>) => rest;

afterEach(() => close());

describe('MCP', () => {
  it('вход — как у API: без него 401; только POST', async () => {
    const url = await start();
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    const post = (headers: Record<string, string>) =>
      fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(init) });
    expect((await post({})).status).toBe(401);
    expect((await post(basic('guest', 'wrong'))).status).toBe(401);
    expect((await post(guest)).status).toBe(200);
    expect((await fetch(`${url}/mcp`, { headers: guest })).status).toBe(405);
  });

  it('инструменты — только чтение; eSIM — только если он подключён; подсказка для модели', async () => {
    const client = await connect(await start());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['cancellations', 'conversion', 'filter_values', 'ltv', 'methodology', 'retries', 'vamp', 'volume']);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(client.getInstructions()).toMatch(/America\/New_York/);
    await client.close();
  });

  it('цифры — те же, что у API экрана: те же параметры, фильтры и разбивка', async () => {
    const url = await start();
    const client = await connect(url);
    const args = { provider: 'stripe', period: 'custom', from: '2026-09-01', to: '2026-09-30', view: 'country', filters: { payment_method: ['apple_pay'] } };
    const viaMcp = JSON.parse(text(await client.callTool({ name: 'conversion', arguments: args })));
    const query = 'provider=stripe&period=custom&from=2026-09-01&to=2026-09-30&view=country&payment_method=apple_pay';
    const viaApi = await (await fetch(`${url}/api/metrics?${query}`, { headers: guest })).json();
    expect(stable(viaMcp)).toEqual(stable(viaApi));
    expect(viaMcp.totals).toMatchObject({ started: 2, paid_first: 1 });
    expect(viaMcp.breakdown.map((r: { value: string }) => r.value)).toEqual(['DE', 'US']);

    const values = JSON.parse(text(await client.callTool({ name: 'filter_values', arguments: { mode: 'conversion', dimension: 'account', period: 'all' } })));
    expect(values.values).toEqual([{ value: 'stripe:corp', count: 2 }, { value: 'solidgate:sgH2H', count: 1 }]);
    await client.close();
  });

  it('длинная разбивка — первые limit строк и сколько их всего; итоги — по всем строкам', async () => {
    const client = await connect(await start());
    const cut = JSON.parse(text(await client.callTool({ name: 'conversion', arguments: { view: 'country', limit: 1 } })));
    expect(cut.breakdown).toHaveLength(1);
    expect(cut).toMatchObject({ breakdown_rows_total: 2, totals: { started: 3 } });
    const full = JSON.parse(text(await client.callTool({ name: 'conversion', arguments: { view: 'country' } })));
    expect(full.breakdown).toHaveLength(2);
    expect(full).not.toHaveProperty('breakdown_rows_total');
    await client.close();
  });

  it('методология — страница дашборда; неверный параметр — ошибка инструмента, а не падение', async () => {
    const client = await connect(await start());
    expect(text(await client.callTool({ name: 'methodology', arguments: { doc: 'vpn' } }))).toMatch(/^# VPN: как считаются метрики/);
    const wrong = await client.callTool({ name: 'conversion', arguments: { view: 'everything' } });
    expect(wrong.isError).toBe(true);
    await client.close();
  });
});
