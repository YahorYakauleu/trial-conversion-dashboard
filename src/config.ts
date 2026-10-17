import { existsSync } from 'node:fs';
import type { Provider } from './db.js';
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

// Админ видит всё и запускает синк; гость только смотрит
export type Role = 'admin' | 'guest';

export interface Credentials {
  user: string;
  password: string;
}

export interface Config {
  stripeAccounts: StripeAccount[];
  solidgateAccounts: SolidgateAccount[];
  retryWindowDays: number;
  // По какому времени резать сутки — как в кабинете провайдера: Stripe — часовой пояс аккаунта, Solidgate Hub — UTC
  timeZones: Record<Provider, string>;
  historyFromDay: string; // HISTORY_FROM, YYYY-MM-DD
  historyFrom: number; // начало выгрузки, unix-секунды: самая ранняя из полуночей HISTORY_FROM по часовым поясам провайдеров
  syncCron: string;
  // Stripe-аккаунт eSIM — отдельный продукт: разовые покупки пакетов и пополнения, без подписок. Без ключа продукта eSIM нет
  esimStripeKey: string | null;
  // Порог Visa VAMP для мерчанта (Excessive): ratio и count за месяц — оба сразу
  vamp: { ratio: number; count: number };
  users: { admin: Credentials; guest: Credentials | null };
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

  const timeZones = {
    stripe: timeZone(env, 'TIMEZONE', 'America/New_York'),
    solidgate: timeZone(env, 'SOLIDGATE_TIMEZONE', 'UTC'),
  };
  const historyFromDay = date(env, 'HISTORY_FROM');

  return {
    stripeAccounts,
    solidgateAccounts,
    retryWindowDays: positiveInt(env, 'RETRY_WINDOW_DAYS', 30),
    timeZones,
    historyFromDay,
    historyFrom: Math.min(...Object.values(timeZones).map((tz) => localMidnight(historyFromDay, tz))),
    syncCron: env.SYNC_CRON?.trim() || '0 */4 * * *',
    esimStripeKey: env.ESIM_STRIPE_KEY?.trim() || null,
    vamp: { ratio: share(env, 'VAMP_RATIO_THRESHOLD', 0.015), count: positiveInt(env, 'VAMP_COUNT_THRESHOLD', 1500) },
    users: {
      // BASIC_AUTH_* — прежние имена переменных, работают как вход админа
      admin: {
        user: required(env, 'ADMIN_USER', 'BASIC_AUTH_USER'),
        password: required(env, 'ADMIN_PASSWORD', 'BASIC_AUTH_PASSWORD'),
      },
      guest: guest(env),
    },
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

function required(env: Env, name: string, legacyName?: string): string {
  const value = env[name]?.trim() || (legacyName && env[legacyName]?.trim());
  if (!value) throw new Error(`Не задана переменная ${name}`);
  return value;
}

// Гостевой вход необязателен, но логин и пароль задаются вместе
function guest(env: Env): Credentials | null {
  const user = env.GUEST_USER?.trim();
  const password = env.GUEST_PASSWORD?.trim();
  if (!user && !password) return null;
  if (!user || !password) throw new Error('GUEST_USER и GUEST_PASSWORD задаются вместе');
  return { user, password };
}

function timeZone(env: Env, name: string, fallback: string): string {
  const value = env[name]?.trim() || fallback;
  try {
    assertTimeZone(value);
  } catch {
    throw new Error(`${name}: неизвестный часовой пояс "${value}", пример — America/New_York`);
  }
  return value;
}

function date(env: Env, name: string): string {
  const raw = required(env, name);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`));
  if (!valid) throw new Error(`${name} должна быть датой в формате YYYY-MM-DD`);
  return raw;
}

// Доля: 0.015 = 1,5%
function share(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!(value > 0 && value < 1)) throw new Error(`${name} должен быть долей от 0 до 1, например 0.015`);
  return value;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} должен быть положительным целым числом`);
  return value;
}
