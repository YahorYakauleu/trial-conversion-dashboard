import { describe, expect, it } from 'vitest';
import { openStore } from '../src/db.js';
import { createToUsd } from '../src/fx.js';

const AT = Date.parse('2026-10-12T15:00:00Z') / 1000;
const RATES = { eur: 0.9, huf: 326.5, jpy: 158.3, kwd: 0.31 };

function fakeFetch(available: Record<string, Record<string, number>>) {
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(url);
    const day = /currency-api@([^/]+)\//.exec(url)![1];
    const rates = available[day];
    return rates ? new Response(JSON.stringify({ date: day, usd: rates })) : new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, urls };
}

describe('createToUsd', () => {
  it('USD — как есть, без запросов', async () => {
    const { fetchFn, urls } = fakeFetch({});
    expect(await createToUsd(openStore(':memory:'), fetchFn)(1199, 'usd', AT)).toBe(1199);
    expect(urls).toEqual([]);
  });

  it('переводит по курсу дня с учётом знаков валюты (HUF — 2, JPY — 0, KWD — 3)', async () => {
    const toUsd = createToUsd(openStore(':memory:'), fakeFetch({ '2026-10-12': RATES }).fetchFn);
    expect(await toUsd(250_000, 'HUF', AT)).toBe(766); // 2 500 HUF ≈ $7.66
    expect(await toUsd(999, 'JPY', AT)).toBe(631); // ¥999 ≈ $6.31
    expect(await toUsd(3_100, 'KWD', AT)).toBe(1000); // 3.100 KWD = $10
    expect(await toUsd(100, 'XYZ', AT)).toBeNull(); // курса нет
  });

  it('курсы дня запрашиваются один раз и сохраняются в базе', async () => {
    const store = openStore(':memory:');
    const { fetchFn, urls } = fakeFetch({ '2026-10-12': RATES });
    const toUsd = createToUsd(store, fetchFn);
    await Promise.all([toUsd(1099, 'EUR', AT), toUsd(1099, 'EUR', AT + 60)]);
    expect(urls).toHaveLength(1);
    expect(await createToUsd(store, fetchFn)(1099, 'EUR', AT)).toBe(1221);
    expect(urls).toHaveLength(1);
  });

  it('курсов за день ещё нет — берёт последние', async () => {
    const { fetchFn, urls } = fakeFetch({ latest: RATES });
    expect(await createToUsd(openStore(':memory:'), fetchFn)(1099, 'EUR', AT)).toBe(1221);
    expect(urls.map((u) => /currency-api@([^/]+)\//.exec(u)![1])).toEqual(['2026-10-12', 'latest']);
  });
});
