import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { listSubscriptions, solidgateSignature } from '../src/providers/solidgate-client.js';

const keys = { publicKey: 'api_pk_test', secretKey: 'api_sk_test' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function drain(iterable: AsyncIterable<{ id: string }>) {
  const ids: string[] = [];
  for await (const s of iterable) ids.push(s.id);
  return ids;
}

describe('solidgate client', () => {
  it('подпись = base64(hex(hmac_sha512(secret, pk + body + pk))) — как в workflow-service', () => {
    const hex = createHmac('sha512', 'api_sk_test').update('api_pk_test{}api_pk_test').digest('hex');
    expect(solidgateSignature(keys, '{}')).toBe(Buffer.from(hex).toString('base64'));
  });

  it('проходит все страницы и шлёт заголовки и фильтр', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json({ subscriptions: { a: { id: 'a' } }, metadata: { next_page_iterator: 'p2' } }))
      .mockResolvedValueOnce(json({ subscriptions: { b: { id: 'b' } }, metadata: { next_page_iterator: null } }));

    expect(await drain(listSubscriptions(keys, 0, 86_400, 'created_at', { fetchFn, retryDelayMs: 0 }))).toEqual(['a', 'b']);

    const [url, init] = fetchFn.mock.calls[1];
    expect(url).toBe('https://reports.solidgate.com/api/v1/subscriptions');
    expect(JSON.parse(init.body)).toMatchObject({
      date_from: '1970-01-01 00:00:00',
      date_to: '1970-01-02 00:00:00',
      filter: 'created_at',
      next_page_iterator: 'p2',
    });
    expect(init.headers).toMatchObject({ merchant: 'api_pk_test', signature: solidgateSignature(keys, init.body) });
  });

  it('повторяет 429/5xx и падает на ошибке в теле', async () => {
    const retrying = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json({}, 502))
      .mockResolvedValueOnce(json({ subscriptions: {}, metadata: { next_page_iterator: null } }));
    expect(await drain(listSubscriptions(keys, 0, 1, 'updated_at', { fetchFn: retrying, retryDelayMs: 0 }))).toEqual([]);
    expect(retrying).toHaveBeenCalledTimes(3);

    const failing = vi.fn().mockResolvedValue(json({ error: { code: '1.01', messages: ['Invalid credentials'] } }));
    await expect(drain(listSubscriptions(keys, 0, 1, 'updated_at', { fetchFn: failing, retryDelayMs: 0 }))).rejects.toThrow(
      /1\.01.*Invalid credentials/,
    );
  });
});
