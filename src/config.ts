import { existsSync } from 'node:fs';

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
  historyFrom: number; // unix-секунды, полночь UTC
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

  return {
    stripeAccounts,
    solidgateAccounts,
    retryWindowDays: positiveInt(env, 'RETRY_WINDOW_DAYS', 30),
    historyFrom: utcDate(env, 'HISTORY_FROM'),
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

function utcDate(env: Env, name: string): number {
  const raw = required(env, name);
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? Date.parse(`${raw}T00:00:00Z`) : NaN;
  if (Number.isNaN(ms)) throw new Error(`${name} должна быть датой в формате YYYY-MM-DD`);
  return ms / 1000;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} должен быть положительным целым числом`);
  return value;
}
