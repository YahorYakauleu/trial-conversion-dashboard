import { existsSync } from 'node:fs';
import { assertTimeZone, localMidnight } from './time.js';

export interface StripeAccount {
  account: string;
  key: string;
}

export interface SolidgateAccount {
  account: string;
  publicKey: string;
  secretKey: string;
}

export interface Config {
  stripeAccounts: StripeAccount[];
  solidgateAccounts: SolidgateAccount[];
  retryWindowDays: number;
  timeZone: string; // по какому времени резать сутки (как в Stripe-аккаунте)
  historyFrom: number; // unix-секунды, полночь HISTORY_FROM в timeZone
  syncCron: string;
  basicAuth: { user: string; password: string };
  dataDir: string;
  port: number;
}

type Env = Record<string, string | undefined>;

export function loadEnvFile(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function loadConfig(env: Env = process.env): Config {
  const stripeAccounts = pairs(env.STRIPE_KEYS).map(([account, key]) => ({ account, key }));
  const solidgateAccounts = pairs(env.SOLIDGATE_KEYS).map(([account, value]) => {
    const [publicKey, secretKey] = value.split(':');
    if (!publicKey || !secretKey) {
      throw new Error(`SOLIDGATE_KEYS: для "${account}" нужен формат public:secret`);
    }
    return { account, publicKey, secretKey };
  });

  if (stripeAccounts.length + solidgateAccounts.length === 0) {
    throw new Error('Нужен хотя бы один ключ в STRIPE_KEYS или SOLIDGATE_KEYS');
  }

  const timeZone = env.TIMEZONE?.trim() || 'America/New_York';
  try {
    assertTimeZone(timeZone);
  } catch {
    throw new Error(`TIMEZONE: неизвестный часовой пояс "${timeZone}", пример — America/New_York`);
  }

  return {
    stripeAccounts,
    solidgateAccounts,
    retryWindowDays: positiveInt(env, 'RETRY_WINDOW_DAYS', 30),
    timeZone,
    historyFrom: localMidnight(date(env, 'HISTORY_FROM'), timeZone),
    syncCron: env.SYNC_CRON?.trim() || '0 5 * * *',
    basicAuth: { user: required(env, 'BASIC_AUTH_USER'), password: required(env, 'BASIC_AUTH_PASSWORD') },
    dataDir: env.DATA_DIR?.trim() || './data',
    port: positiveInt(env, 'PORT', 3000),
  };
}

function pairs(raw: string | undefined): [string, string][] {
  if (!raw?.trim()) return [];
  return raw.split(',').map((item) => {
    const i = item.indexOf('=');
    if (i <= 0) throw new Error(`Неверный формат "${item.trim()}", ожидается name=value`);
    return [item.slice(0, i).trim(), item.slice(i + 1).trim()];
  });
}

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Не задана переменная ${name}`);
  return value;
}

function date(env: Env, name: string): string {
  const raw = required(env, name);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`));
  if (!valid) throw new Error(`${name} должна быть датой в формате YYYY-MM-DD`);
  return raw;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} должен быть положительным целым числом`);
  return value;
}
