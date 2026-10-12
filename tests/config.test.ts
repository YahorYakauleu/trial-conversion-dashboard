import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  STRIPE_KEYS: 'org=rk_live_a, corp=rk_live_b',
  SOLIDGATE_KEYS: 'sg=api_pk_1:api_sk_1',
  BASIC_AUTH_USER: 'billing',
  BASIC_AUTH_PASSWORD: 'secret',
};

describe('loadConfig', () => {
  it('разбирает ключи и подставляет дефолты', () => {
    const c = loadConfig(base);
    expect(c.stripeAccounts).toEqual([
      { account: 'org', key: 'rk_live_a' },
      { account: 'corp', key: 'rk_live_b' },
    ]);
    expect(c.solidgateAccounts).toEqual([{ account: 'sg', publicKey: 'api_pk_1', secretKey: 'api_sk_1' }]);
    expect(c).toMatchObject({
      retryWindowDays: 30,
      historyDays: 90,
      trialLookbackDays: 31,
      syncCron: '0 5 * * *',
      dataDir: './data',
      port: 3000,
      basicAuth: { user: 'billing', password: 'secret' },
    });
  });

  it('требует хотя бы один ключ провайдера', () => {
    expect(() => loadConfig({ BASIC_AUTH_USER: 'u', BASIC_AUTH_PASSWORD: 'p' })).toThrow(/STRIPE_KEYS или SOLIDGATE_KEYS/);
  });

  it('требует basic auth', () => {
    expect(() => loadConfig({ STRIPE_KEYS: 'org=rk' })).toThrow(/BASIC_AUTH_USER/);
  });

  it('ругается на кривой формат', () => {
    expect(() => loadConfig({ ...base, STRIPE_KEYS: 'rk_live_a' })).toThrow(/name=value/);
    expect(() => loadConfig({ ...base, SOLIDGATE_KEYS: 'sg=only_public' })).toThrow(/public:secret/);
    expect(() => loadConfig({ ...base, RETRY_WINDOW_DAYS: '0' })).toThrow(/RETRY_WINDOW_DAYS/);
  });
});
