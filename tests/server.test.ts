import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { createApp } from '../src/server.js';
import type { Source } from '../src/sync.js';

const config = loadConfig({
  STRIPE_KEYS: 'org=rk',
  BASIC_AUTH_USER: 'billing',
  BASIC_AUTH_PASSWORD: 'p:ss',
  HISTORY_FROM: '2026-09-01',
});
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
  it('/health без авторизации, остальное — под basic auth', async () => {
    const url = await start();
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/api/metrics`)).status).toBe(401);
    const wrong = { authorization: `Basic ${Buffer.from('wrong:pass').toString('base64')}` };
    expect((await fetch(`${url}/api/metrics`, { headers: wrong })).status).toBe(401);
    expect((await fetch(`${url}/`, { headers: auth })).status).toBe(200);
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
});
