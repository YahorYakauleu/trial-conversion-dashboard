import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  STRIPE_KEYS: 'org=rk_live_a, corp=rk_live_b',
  SOLIDGATE_KEYS: 'sg=api_pk_1:api_sk_1',
  BASIC_AUTH_USER: 'billing',
  BASIC_AUTH_PASSWORD: 'secret',
  HISTORY_FROM: '2026-09-01',
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
      timeZones: { stripe: 'America/New_York', solidgate: 'UTC' },
      historyFromDay: '2026-09-01',
      historyFrom: Date.parse('2026-09-01T00:00:00Z') / 1000, // самая ранняя полночь — по UTC (Solidgate)
      syncCron: '0 */4 * * *',
      dataDir: './data',
      port: 3000,
      users: { admin: { user: 'billing', password: 'secret' }, guest: null }, // BASIC_AUTH_* — вход админа
      vamp: { ratio: 0.015, count: 1500 }, // порог Visa VAMP Excessive
    });
    expect(loadConfig({ ...base, VAMP_RATIO_THRESHOLD: '0.022', VAMP_COUNT_THRESHOLD: '1000' }).vamp).toEqual({ ratio: 0.022, count: 1000 });
  });

  it('требует хотя бы один ключ провайдера', () => {
    expect(() => loadConfig({ BASIC_AUTH_USER: 'u', BASIC_AUTH_PASSWORD: 'p' })).toThrow(/STRIPE_KEYS или SOLIDGATE_KEYS/);
  });

  it('требует basic auth и дату начала истории', () => {
    expect(() => loadConfig({ STRIPE_KEYS: 'org=rk', HISTORY_FROM: '2026-09-01' })).toThrow(/ADMIN_USER/);
    expect(() => loadConfig({ ...base, HISTORY_FROM: undefined })).toThrow(/HISTORY_FROM/);
  });

  it('ругается на кривой формат', () => {
    expect(() => loadConfig({ ...base, STRIPE_KEYS: 'rk_live_a' })).toThrow(/name=value/);
    expect(() => loadConfig({ ...base, SOLIDGATE_KEYS: 'sg=only_public' })).toThrow(/public:secret/);
    expect(() => loadConfig({ ...base, RETRY_WINDOW_DAYS: '0' })).toThrow(/RETRY_WINDOW_DAYS/);
    expect(() => loadConfig({ ...base, VAMP_RATIO_THRESHOLD: '1.5' })).toThrow(/VAMP_RATIO_THRESHOLD/); // доля, а не проценты
    expect(() => loadConfig({ ...base, HISTORY_FROM: '01.09.2026' })).toThrow(/YYYY-MM-DD/);
    expect(() => loadConfig({ ...base, HISTORY_FROM: '2026-13-01' })).toThrow(/YYYY-MM-DD/);
    expect(() => loadConfig({ ...base, TIMEZONE: 'Mars/Olympus' })).toThrow(/TIMEZONE/);
    expect(() => loadConfig({ ...base, SOLIDGATE_TIMEZONE: 'Mars/Olympus' })).toThrow(/SOLIDGATE_TIMEZONE/);
  });

  it('выгрузка начинается с самой ранней полуночи HISTORY_FROM по часовым поясам провайдеров', () => {
    const ny = { ...base, SOLIDGATE_TIMEZONE: 'America/New_York' };
    expect(loadConfig(ny).historyFrom).toBe(Date.parse('2026-09-01T04:00:00Z') / 1000);
    expect(loadConfig({ ...ny, TIMEZONE: 'Asia/Tokyo' }).historyFrom).toBe(Date.parse('2026-08-31T15:00:00Z') / 1000);
  });

  it('админ и гость: ADMIN_* важнее старых BASIC_AUTH_*; гостевые логин и пароль — только вместе', () => {
    const users = loadConfig({ ...base, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'a', GUEST_USER: 'guest', GUEST_PASSWORD: 'g' }).users;
    expect(users).toEqual({ admin: { user: 'admin', password: 'a' }, guest: { user: 'guest', password: 'g' } });
    expect(() => loadConfig({ ...base, GUEST_USER: 'guest' })).toThrow(/GUEST_USER и GUEST_PASSWORD/);
  });
});
