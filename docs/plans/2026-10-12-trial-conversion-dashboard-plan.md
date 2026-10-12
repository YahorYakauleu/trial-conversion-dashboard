# Trial → Paid dashboard — план реализации

> Выполнять по задачам, по порядку. Шаги отмечены чекбоксами (`- [ ]`). Каждая задача заканчивается зелёными тестами и коммитом.

**Цель:** локальный веб-дашборд конверсии триалов в платные подписки (Stripe + Solidgate), готовый к деплою в Docker.

**Спека:** [`docs/specs/2026-10-12-trial-conversion-dashboard-design.md`](../specs/2026-10-12-trial-conversion-dashboard-design.md)

**Архитектура:** один Node-процесс. Провайдеры выгружают данные из API и приводят их к `TrialRow` → SQLite → `metrics.ts` считает точки по дням и неделям → Express отдаёт JSON и статическую страницу с Chart.js. Синк запускается cron'ом раз в сутки и по кнопке.

**Стек:** Node ≥ 22.13 (в Docker — 24), TypeScript (ESM, NodeNext), Express 5, встроенный `node:sqlite`, node-cron 4, stripe 18 (API `2025-08-27.basil`, как в workflow-service), vitest 4, tsx.

## Отклонения при выполнении (задачи 1–6, 2026-10-12)

Код в репозитории — источник правды; блоки кода в задачах 1–6 ниже оставлены как были в плане.

1. **`node:sqlite` вместо `better-sqlite3`.** У `better-sqlite3@12` нет готовой сборки под локальный Node 23.11, а сборка из исходников падает. Встроенный модуль работает и на 23, и на 24, и в проекте нет нативных зависимостей. Особенности: лишний именованный параметр — ошибка, boolean не биндится, поэтому `upsertTrial` передаёт колонки явно. При запуске печатается `ExperimentalWarning`.
2. **«С первой попытки» в Stripe** = `paid && attempt_count == 1 && paid_at − finalized_at ≤ 1 ч`. По документации Stripe ручная оплата после отказа не увеличивает `attempt_count`. Проверено на живых данных Toggle Org: 61 из 61 оплаты с первой попытки укладывается в час.
3. **`first_attempt_succeeded = false` необратимо** при upsert (`CASE WHEN trials.first_attempt_succeeded = 0 THEN 0 …`). Порядок событий не влияет на результат.
4. **Задачи 10–13 сделаны раньше 7–9.** `buildSources` пока собирает только Stripe и пишет предупреждение, если заданы `SOLIDGATE_KEYS`. **В задаче 9 добавить туда Solidgate-источники** (код — в задаче 10 ниже) и убрать предупреждение.
5. **Страница:** запросы к API строятся от `location.origin`. Если дашборд открыт как `user:pass@host`, `fetch` с относительным URL падает — нашлось при проверке в браузере. У графика `animation: false` и явный `type: 'bar'`; в тёмной теме столбики светлее, чтобы не забивали линии.
6. **Dockerfile:** добавлены `HEALTHCHECK` на `/health` и `--disable-warning=ExperimentalWarning`. Проверено: образ собирается, контейнер на демо-данных отвечает и получает статус `healthy`.
7. **Живые данные Toggle Org (12.10.2026):** все триалы по 7 дней; новых подписок ~23 в день; инвойсов ~2 750 в день. Бэкфилл Org — порядка 2 500 запросов, 10–15 минут. Основной поток новых подписок, видимо, идёт через другие аккаунты (Toggle Corp / Solidgate) — их ключи тоже нужны.

## Уточнения к спеке (внесены в спеку этим же коммитом)

1. **Время хранится в unix-секундах** (INTEGER), а не ISO-строками. Так окно ретраев считается простым сложением.
2. **Solidgate — несколько мерчантов.** В workflow-service два канала: `sg` (платёжная форма) и `sgH2H` (wallet, host-to-host). Формат конфига: `SOLIDGATE_KEYS=sg=<public>:<secret>,sgH2H=<public>:<secret>`.
3. **Reports API v1** (`POST https://reports.solidgate.com/api/v1/subscriptions`) отдаёт подписку вместе с `invoices` → `orders` (`status`, `retry_attempt`, `processed_at`). Запасной путь через `/subscription/status`, скорее всего, не нужен. Это подтверждается в задаче 7.
4. **Окончательность rate_retry:** `D + RETRY_WINDOW_DAYS + 1 ≤ сегодня`. Последний триал дня D заканчивается в 23:59, и ему тоже нужны полные 30 дней.
5. **Stripe basil:** id подписки в инвойсе лежит в `invoice.parent.subscription_details.subscription`. В событиях объект может прийти в старой версии API, поэтому читаем и старое поле `invoice.subscription`.
6. **Недельный вид:** первая неполная неделя в начале истории отбрасывается, иначе её `ended` занижен.

## Карта файлов

| файл | ответственность |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example` | каркас |
| `src/config.ts` | чтение `.env`, валидация, дефолты |
| `src/db.ts` | схема SQLite, `TrialRow`, `Store` (upsert с merge, state, журнал синков) |
| `src/metrics.ts` | точки по дням и неделям, флаги окончательности, карточки |
| `src/providers/stripe.ts` | нормализация Stripe + синк аккаунта (бэкфилл, ежедневно) |
| `src/providers/solidgate.ts` | клиент Reports API (подпись, пагинация, ретраи), нормализация, синк аккаунта |
| `src/sync.ts` | оркестрация источников, lock, журнал |
| `src/server.ts` | Express: basic auth, `/health`, `/api/metrics`, `/api/sync`, статика |
| `src/main.ts` | точка входа: конфиг, БД, источники, cron, автозапуск бэкфилла |
| `src/sync-cli.ts` | разовый синк из терминала |
| `scripts/probe-solidgate.ts` | разведка реальной формы ответа Solidgate (без PII) |
| `public/index.html` | дашборд |
| `tests/*.test.ts` | vitest |
| `Dockerfile`, `README.md` | деплой и запуск |

---

## Задача 0. Доступы (делает владелец проекта)

Код от этой задачи не зависит до задачи 6 (Stripe) и задачи 7 (Solidgate), поэтому её можно делать параллельно с задачами 1–5.

- [ ] **Stripe:** в каждом аккаунте, по которому нужна метрика (минимум Toggle Org), создать restricted key с правами **Read** на Subscriptions, Invoices и Events. Имя — `trial-dashboard`.
- [ ] **Solidgate:** взять public и secret key мерчантов `sg` и `sgH2H` (тех же, что в workflow-service, `SOLIDGATE_CHANNELS`). Проверить в Hub, что для них доступен Reports API.
- [ ] Вписать ключи в `.env` по образцу `.env.example` (появится в задаче 1). `.env` не коммитится.

---

## Задача 1. Каркас проекта

**Файлы:** создать `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `tests/smoke.test.ts`.

- [ ] **Шаг 1. package.json**

```json
{
  "name": "trial-conversion-dashboard",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "sync": "tsx src/sync-cli.ts",
    "probe:solidgate": "tsx scripts/probe-solidgate.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  }
}
```

- [ ] **Шаг 2. Зависимости**

```bash
npm install express@^5 better-sqlite3@^12 node-cron@^4 stripe@^18.5.0
npm install -D typescript@^5.9 tsx@^4 vitest@^4 @types/node@^24 @types/express@^5 @types/better-sqlite3@^7
```

Если `node-cron` не отдаёт свои типы (`tsc` ругается на `node-cron`), добавить `npm install -D @types/node-cron`.

- [ ] **Шаг 3. tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Шаг 4. vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
});
```

- [ ] **Шаг 5. .gitignore**

```
node_modules/
dist/
data/
.env
```

- [ ] **Шаг 6. .env.example**

```bash
# Stripe: restricted read-only ключи, через запятую: <аккаунт>=<ключ>
STRIPE_KEYS=org=rk_live_xxx,corp=rk_live_yyy
# Solidgate: <канал>=<public>:<secret>, через запятую
SOLIDGATE_KEYS=sg=api_pk_xxx:api_sk_xxx,sgH2H=api_pk_yyy:api_sk_yyy

RETRY_WINDOW_DAYS=30
HISTORY_DAYS=90
TRIAL_LOOKBACK_DAYS=31
SYNC_CRON=0 5 * * *

BASIC_AUTH_USER=billing
BASIC_AUTH_PASSWORD=change-me

DATA_DIR=./data
PORT=3000
```

- [ ] **Шаг 7. Smoke-тест** — `tests/smoke.test.ts`:

```ts
import { expect, it } from 'vitest';

it('vitest работает', () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Шаг 8. Проверить:** `npm test` → `1 passed`.
- [ ] **Шаг 9. Коммит:** `git add -A && git commit -m "chore: scaffold trial conversion dashboard"`

---

## Задача 2. Конфиг

**Файлы:** создать `src/config.ts`, `tests/config.test.ts`; удалить `tests/smoke.test.ts`.

- [ ] **Шаг 1. Тест** — `tests/config.test.ts`:

```ts
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
      retryWindowDays: 30, historyDays: 90, trialLookbackDays: 31,
      syncCron: '0 5 * * *', dataDir: './data', port: 3000,
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
```

- [ ] **Шаг 2.** `npx vitest run tests/config.test.ts` → FAIL (модуля нет).
- [ ] **Шаг 3. Реализация** — `src/config.ts`:

```ts
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
  historyDays: number;
  trialLookbackDays: number;
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
    historyDays: positiveInt(env, 'HISTORY_DAYS', 90),
    trialLookbackDays: positiveInt(env, 'TRIAL_LOOKBACK_DAYS', 31),
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

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} должен быть положительным целым числом`);
  return value;
}
```

- [ ] **Шаг 4.** `npm test` → все тесты config зелёные. Удалить `tests/smoke.test.ts`.
- [ ] **Шаг 5. Коммит:** `git commit -am "feat: config loading and validation"` (новые файлы — через `git add`).

---

## Задача 3. Хранилище (SQLite)

**Файлы:** создать `src/db.ts`, `tests/db.test.ts`.

- [ ] **Шаг 1. Тест** — `tests/db.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { openStore, type TrialRow } from '../src/db.js';

const row: TrialRow = {
  provider: 'stripe', account: 'org', subscription_id: 'sub_1',
  trial_started_at: 1_000, trial_ended_at: 2_000,
  first_invoice_id: null, first_attempt_succeeded: null, paid_at: null,
};

describe('Store', () => {
  it('upsert идемпотентен и не затирает данные об оплате пустыми значениями', () => {
    const store = openStore(':memory:');
    store.upsertTrial({ ...row, first_invoice_id: 'in_1', first_attempt_succeeded: false, paid_at: 3_000 });
    store.upsertTrial(row); // повторная выгрузка подписки без инвойса
    expect(store.getTrial('stripe', 'sub_1')).toEqual({
      ...row, first_invoice_id: 'in_1', first_attempt_succeeded: false, paid_at: 3_000,
    });
    expect(store.countTrials()).toBe(1);
  });

  it('новое непустое значение перезаписывает старое', () => {
    const store = openStore(':memory:');
    store.upsertTrial({ ...row, first_invoice_id: 'in_1', first_attempt_succeeded: null });
    store.upsertTrial({ ...row, first_invoice_id: 'in_1', first_attempt_succeeded: true, paid_at: 2_100 });
    expect(store.getTrial('stripe', 'sub_1')?.first_attempt_succeeded).toBe(true);
  });

  it('хранит курсоры', () => {
    const store = openStore(':memory:');
    expect(store.getState('stripe', 'org', 'cursor')).toBeNull();
    store.setState('stripe', 'org', 'cursor', 123);
    expect(store.getState('stripe', 'org', 'cursor')).toBe(123);
  });

  it('журнал синков: последний статус и последний успех', () => {
    const store = openStore(':memory:');
    const ok = store.startRun('stripe', 'org', 'backfill', 100);
    store.finishRun(ok, 'ok', 5, null, 200);
    const failed = store.startRun('stripe', 'org', 'daily', 300);
    store.finishRun(failed, 'error', 0, 'boom', 400);
    expect(store.latestRuns()).toEqual([
      { provider: 'stripe', account: 'org', last_status: 'error', last_error: 'boom', last_success_at: 200 },
    ]);
  });

  it('при старте помечает зависшие running как error', () => {
    const store = openStore(':memory:');
    store.startRun('solidgate', 'sg', 'daily', 100);
    store.failStaleRuns(500);
    expect(store.latestRuns()[0]).toMatchObject({ last_status: 'error', last_error: 'процесс остановился во время синка' });
  });
});
```

- [ ] **Шаг 2.** `npx vitest run tests/db.test.ts` → FAIL.
- [ ] **Шаг 3. Реализация** — `src/db.ts`:

```ts
import Database from 'better-sqlite3';

export type Provider = 'stripe' | 'solidgate';
export type RunKind = 'backfill' | 'daily';
export type RunStatus = 'running' | 'ok' | 'error';

export interface TrialRow {
  provider: Provider;
  account: string;
  subscription_id: string;
  trial_started_at: number;
  trial_ended_at: number;
  first_invoice_id: string | null;
  first_attempt_succeeded: boolean | null;
  paid_at: number | null;
}

export interface LatestRun {
  provider: Provider;
  account: string;
  last_status: RunStatus;
  last_error: string | null;
  last_success_at: number | null;
}

export type Db = Database.Database;
export type Store = ReturnType<typeof openStore>;

export const nowSec = () => Math.floor(Date.now() / 1000);

export function openStore(file: string) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS trials (
      provider TEXT NOT NULL,
      account TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      trial_started_at INTEGER NOT NULL,
      trial_ended_at INTEGER NOT NULL,
      first_invoice_id TEXT,
      first_attempt_succeeded INTEGER,
      paid_at INTEGER,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (provider, subscription_id)
    );
    CREATE INDEX IF NOT EXISTS trials_ended_idx ON trials (trial_ended_at);
    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      account TEXT NOT NULL,
      kind TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      items INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sync_state (
      provider TEXT NOT NULL,
      account TEXT NOT NULL,
      key TEXT NOT NULL,
      value INTEGER NOT NULL,
      PRIMARY KEY (provider, account, key)
    );
  `);

  // Поля оплаты сливаются через COALESCE: повторная выгрузка без инвойса не стирает уже известную оплату.
  const upsert = db.prepare(`
    INSERT INTO trials (provider, account, subscription_id, trial_started_at, trial_ended_at,
                        first_invoice_id, first_attempt_succeeded, paid_at, synced_at)
    VALUES (@provider, @account, @subscription_id, @trial_started_at, @trial_ended_at,
            @first_invoice_id, @first_attempt_succeeded, @paid_at, @synced_at)
    ON CONFLICT (provider, subscription_id) DO UPDATE SET
      account = excluded.account,
      trial_started_at = excluded.trial_started_at,
      trial_ended_at = excluded.trial_ended_at,
      first_invoice_id = COALESCE(excluded.first_invoice_id, trials.first_invoice_id),
      first_attempt_succeeded = COALESCE(excluded.first_attempt_succeeded, trials.first_attempt_succeeded),
      paid_at = COALESCE(excluded.paid_at, trials.paid_at),
      synced_at = excluded.synced_at
  `);
  const selectTrial = db.prepare('SELECT * FROM trials WHERE provider = ? AND subscription_id = ?');
  const selectState = db.prepare('SELECT value FROM sync_state WHERE provider = ? AND account = ? AND key = ?');
  const upsertState = db.prepare(`
    INSERT INTO sync_state (provider, account, key, value) VALUES (?, ?, ?, ?)
    ON CONFLICT (provider, account, key) DO UPDATE SET value = excluded.value
  `);

  return {
    db,

    upsertTrial(row: TrialRow, now = nowSec()): void {
      upsert.run({
        ...row,
        first_attempt_succeeded: row.first_attempt_succeeded === null ? null : Number(row.first_attempt_succeeded),
        synced_at: now,
      });
    },

    getTrial(provider: Provider, subscriptionId: string): TrialRow | null {
      const r = selectTrial.get(provider, subscriptionId) as (Omit<TrialRow, 'first_attempt_succeeded'> & {
        first_attempt_succeeded: number | null;
        synced_at: number;
      }) | undefined;
      if (!r) return null;
      const { synced_at: _syncedAt, ...rest } = r;
      return { ...rest, first_attempt_succeeded: r.first_attempt_succeeded === null ? null : r.first_attempt_succeeded === 1 };
    },

    countTrials(): number {
      return (db.prepare('SELECT COUNT(*) AS n FROM trials').get() as { n: number }).n;
    },

    getState(provider: Provider, account: string, key: string): number | null {
      const r = selectState.get(provider, account, key) as { value: number } | undefined;
      return r ? r.value : null;
    },

    setState(provider: Provider, account: string, key: string, value: number): void {
      upsertState.run(provider, account, key, value);
    },

    startRun(provider: Provider, account: string, kind: RunKind, now = nowSec()): number {
      const r = db
        .prepare(`INSERT INTO sync_runs (provider, account, kind, started_at, status) VALUES (?, ?, ?, ?, 'running')`)
        .run(provider, account, kind, now);
      return Number(r.lastInsertRowid);
    },

    finishRun(id: number, status: 'ok' | 'error', items: number, error: string | null, now = nowSec()): void {
      db.prepare('UPDATE sync_runs SET status = ?, items = ?, error = ?, finished_at = ? WHERE id = ?')
        .run(status, items, error, now, id);
    },

    failStaleRuns(now = nowSec()): void {
      db.prepare(`UPDATE sync_runs SET status = 'error', error = 'процесс остановился во время синка', finished_at = ?
                  WHERE status = 'running'`).run(now);
    },

    latestRuns(): LatestRun[] {
      return db.prepare(`
        SELECT r.provider, r.account, r.status AS last_status, r.error AS last_error,
               (SELECT MAX(s.finished_at) FROM sync_runs s
                 WHERE s.provider = r.provider AND s.account = r.account AND s.status = 'ok') AS last_success_at
        FROM sync_runs r
        WHERE r.id IN (SELECT MAX(id) FROM sync_runs GROUP BY provider, account)
        ORDER BY r.provider, r.account
      `).all() as LatestRun[];
    },
  };
}
```

- [ ] **Шаг 4.** `npx vitest run tests/db.test.ts` → PASS.
- [ ] **Шаг 5. Коммит:** `feat: sqlite store for trials, sync state and runs`

---

## Задача 4. Метрики

**Файлы:** создать `src/metrics.ts`, `tests/metrics.test.ts`.

Опорные даты для тестов: «сегодня» = 2026-10-12 (понедельник), `now = 2026-10-12T10:00:00Z`, окно 30 дней.

- [ ] **Шаг 1. Тест** — `tests/metrics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { openStore, type TrialRow } from '../src/db.js';
import { DAY, getMetrics } from '../src/metrics.js';

const ts = (iso: string) => Date.parse(iso) / 1000;
const NOW = ts('2026-10-12T10:00:00Z');
const opts = { provider: 'all' as const, granularity: 'day' as const, now: NOW, historyDays: 90, retryWindowDays: 30 };

let seq = 0;
function trial(endedIso: string, patch: Partial<TrialRow> = {}): TrialRow {
  const ended = ts(endedIso);
  return {
    provider: 'stripe', account: 'org', subscription_id: `sub_${++seq}`,
    trial_started_at: ended - 3 * DAY, trial_ended_at: ended,
    first_invoice_id: null, first_attempt_succeeded: null, paid_at: null, ...patch,
  };
}

function storeWith(rows: TrialRow[]) {
  const store = openStore(':memory:');
  rows.forEach((r) => store.upsertTrial(r));
  return store;
}

const day = (series: { period: string }[], period: string) => series.find((p) => p.period === period)!;

describe('getMetrics — по дням', () => {
  it('считает ended / paid_first / paid_retry с учётом окна', () => {
    const e = '2026-09-01T12:00:00Z';
    const store = storeWith([
      trial(e, { first_invoice_id: 'in', first_attempt_succeeded: true, paid_at: ts(e) + 3600 }),
      trial(e, { first_invoice_id: 'in', first_attempt_succeeded: false, paid_at: ts(e) + 5 * DAY }),
      trial(e, { first_invoice_id: 'in', first_attempt_succeeded: false, paid_at: ts(e) + 31 * DAY }),
      trial(e),
    ]);
    const p = day(getMetrics(store.db, opts).series, '2026-09-01');
    expect(p).toMatchObject({ ended: 4, paid_first: 1, paid_retry: 2, rate_first: 0.25, rate_retry: 0.5 });
  });

  it('границы суток UTC и исключение сегодняшнего дня', () => {
    const store = storeWith([
      trial('2026-10-10T23:59:59Z'),
      trial('2026-10-11T00:00:00Z'),
      trial('2026-10-12T01:00:00Z'), // сегодня — не входит
    ]);
    const { series } = getMetrics(store.db, opts);
    expect(day(series, '2026-10-10').ended).toBe(1);
    expect(day(series, '2026-10-11').ended).toBe(1);
    expect(series.at(-1)!.period).toBe('2026-10-11');
    expect(series).toHaveLength(90);
  });

  it('пустые дни заполнены нулями, rate = null', () => {
    const { series } = getMetrics(openStore(':memory:').db, opts);
    expect(series[0]).toMatchObject({ ended: 0, rate_first: null, rate_retry: null });
  });

  it('флаги окончательности', () => {
    const { series } = getMetrics(openStore(':memory:').db, opts);
    expect(day(series, '2026-10-10').final_first).toBe(true);
    expect(day(series, '2026-10-11').final_first).toBe(false);
    expect(day(series, '2026-09-11').final_retry).toBe(true);  // 11.09 + 31 д = 12.10
    expect(day(series, '2026-09-12').final_retry).toBe(false);
  });

  it('фильтр по провайдеру и сумма для «Все»', () => {
    const e = '2026-10-01T12:00:00Z';
    const store = storeWith([
      trial(e, { first_attempt_succeeded: true, paid_at: ts(e) }),
      trial(e, { provider: 'solidgate', account: 'sg' }),
    ]);
    expect(day(getMetrics(store.db, { ...opts, provider: 'stripe' }).series, '2026-10-01').ended).toBe(1);
    expect(day(getMetrics(store.db, { ...opts, provider: 'solidgate' }).series, '2026-10-01').ended).toBe(1);
    expect(day(getMetrics(store.db, opts).series, '2026-10-01')).toMatchObject({ ended: 2, paid_first: 1, rate_first: 0.5 });
  });
});

describe('getMetrics — по неделям и карточки', () => {
  it('группирует по ISO-неделе и отбрасывает неполную первую неделю', () => {
    const store = storeWith([trial('2026-10-05T12:00:00Z'), trial('2026-10-11T12:00:00Z')]);
    const { series } = getMetrics(store.db, { ...opts, granularity: 'week' });
    expect(series.at(-1)).toMatchObject({ period: '2026-10-05', ended: 2, final_first: false });
    expect(series.every((w) => new Date(w.period + 'T00:00:00Z').getUTCDay() === 1)).toBe(true);
    // 90 дней назад от 12.10 = 14.07 (вторник) — неделя 13.07 неполная и отброшена
    expect(series[0].period).toBe('2026-07-20');
  });

  it('карточки: последние 7 полных дней и последние 7 окончательных', () => {
    const store = storeWith([
      trial('2026-10-11T12:00:00Z'),
      trial('2026-10-10T12:00:00Z', { first_attempt_succeeded: true, paid_at: ts('2026-10-10T13:00:00Z') }),
      trial('2026-09-11T12:00:00Z', { first_attempt_succeeded: false, paid_at: ts('2026-09-15T12:00:00Z') }),
    ]);
    const { cards } = getMetrics(store.db, opts);
    expect(cards.ended_7d).toEqual({ value: 2, from: '2026-10-05', to: '2026-10-11' });
    expect(cards.rate_first_7d).toEqual({ rate: 1, from: '2026-10-04', to: '2026-10-10' });
    expect(cards.rate_retry_7d).toEqual({ rate: 1, from: '2026-09-05', to: '2026-09-11' });
  });
});
```

- [ ] **Шаг 2.** `npx vitest run tests/metrics.test.ts` → FAIL.
- [ ] **Шаг 3. Реализация** — `src/metrics.ts`:

```ts
import type { Db, Provider } from './db.js';

export const DAY = 86_400;
const FIRST_ATTEMPT_SETTLE_DAYS = 2;

export type ProviderFilter = Provider | 'all';
export type Granularity = 'day' | 'week';

export interface Point {
  period: string; // YYYY-MM-DD; для недели — понедельник
  ended: number;
  paid_first: number;
  paid_retry: number;
  rate_first: number | null;
  rate_retry: number | null;
  final_first: boolean;
  final_retry: boolean;
}

export interface RateCard {
  rate: number | null;
  from: string | null;
  to: string | null;
}

export interface Cards {
  ended_7d: { value: number; from: string; to: string };
  rate_first_7d: RateCard;
  rate_retry_7d: RateCard;
}

export interface MetricsOptions {
  provider: ProviderFilter;
  granularity: Granularity;
  now: number;
  historyDays: number;
  retryWindowDays: number;
}

export const startOfUtcDay = (ts: number) => Math.floor(ts / DAY) * DAY;
export const dayKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const rate = (part: number, total: number) => (total === 0 ? null : part / total);

export function getMetrics(db: Db, o: MetricsOptions): { cards: Cards; series: Point[] } {
  const days = dailyPoints(db, o);
  return { cards: cards(days), series: o.granularity === 'week' ? groupByWeek(days) : days };
}

function dailyPoints(db: Db, o: MetricsOptions): Point[] {
  const today = startOfUtcDay(o.now);
  const from = today - o.historyDays * DAY;
  const rows = db.prepare(`
    SELECT date(trial_ended_at, 'unixepoch') AS day,
           COUNT(*) AS ended,
           SUM(CASE WHEN first_attempt_succeeded = 1 THEN 1 ELSE 0 END) AS paid_first,
           SUM(CASE WHEN paid_at IS NOT NULL AND paid_at <= trial_ended_at + @window THEN 1 ELSE 0 END) AS paid_retry
    FROM trials
    WHERE trial_ended_at >= @from AND trial_ended_at < @today
      AND (@provider = 'all' OR provider = @provider)
    GROUP BY day
  `).all({ from, today, window: o.retryWindowDays * DAY, provider: o.provider }) as {
    day: string; ended: number; paid_first: number; paid_retry: number;
  }[];
  const byDay = new Map(rows.map((r) => [r.day, r]));

  const points: Point[] = [];
  for (let day = from; day < today; day += DAY) {
    const r = byDay.get(dayKey(day)) ?? { ended: 0, paid_first: 0, paid_retry: 0 };
    points.push({
      period: dayKey(day),
      ended: r.ended,
      paid_first: r.paid_first,
      paid_retry: r.paid_retry,
      rate_first: rate(r.paid_first, r.ended),
      rate_retry: rate(r.paid_retry, r.ended),
      final_first: day + FIRST_ATTEMPT_SETTLE_DAYS * DAY <= today,
      final_retry: day + (o.retryWindowDays + 1) * DAY <= today,
    });
  }
  return points;
}

function groupByWeek(days: Point[]): Point[] {
  const weeks = new Map<string, Point & { days: number }>();
  for (const d of days) {
    const ts = Date.parse(`${d.period}T00:00:00Z`) / 1000;
    const monday = dayKey(ts - ((new Date(ts * 1000).getUTCDay() + 6) % 7) * DAY);
    const w = weeks.get(monday) ?? {
      period: monday, ended: 0, paid_first: 0, paid_retry: 0,
      rate_first: null, rate_retry: null, final_first: true, final_retry: true, days: 0,
    };
    w.ended += d.ended;
    w.paid_first += d.paid_first;
    w.paid_retry += d.paid_retry;
    w.final_first &&= d.final_first;
    w.final_retry &&= d.final_retry;
    w.days += 1;
    weeks.set(monday, w);
  }
  const list = [...weeks.values()];
  if (list.length > 0 && list[0].days < 7) list.shift();
  return list.map(({ days: _days, ...w }) => ({
    ...w,
    rate_first: rate(w.paid_first, w.ended),
    rate_retry: rate(w.paid_retry, w.ended),
  }));
}

function cards(days: Point[]): Cards {
  const sum = (pts: Point[], key: 'ended' | 'paid_first' | 'paid_retry') => pts.reduce((s, p) => s + p[key], 0);
  const rateCard = (pts: Point[], key: 'paid_first' | 'paid_retry'): RateCard => ({
    rate: rate(sum(pts, key), sum(pts, 'ended')),
    from: pts[0]?.period ?? null,
    to: pts.at(-1)?.period ?? null,
  });
  const last7 = days.slice(-7);
  return {
    ended_7d: { value: sum(last7, 'ended'), from: last7[0]?.period ?? '', to: last7.at(-1)?.period ?? '' },
    rate_first_7d: rateCard(days.filter((p) => p.final_first).slice(-7), 'paid_first'),
    rate_retry_7d: rateCard(days.filter((p) => p.final_retry).slice(-7), 'paid_retry'),
  };
}
```

- [ ] **Шаг 4.** `npx vitest run tests/metrics.test.ts` → PASS.
- [ ] **Шаг 5. Коммит:** `feat: trial-to-paid metrics by day and week`

---

## Задача 5. Stripe: нормализация

**Файлы:** создать `src/providers/stripe.ts` (только чистые функции), `tests/stripe-normalize.test.ts`.

- [ ] **Шаг 1. Тест** — `tests/stripe-normalize.test.ts`:

```ts
import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import type { TrialRow } from '../src/db.js';
import { applyInvoice, invoiceSubscriptionId, trialFromSubscription } from '../src/providers/stripe.js';

const sub = (p: Partial<Stripe.Subscription>) => ({ id: 'sub_1', trial_start: null, trial_end: null, ...p }) as Stripe.Subscription;
const inv = (p: Record<string, unknown>) => ({
  id: 'in_1', billing_reason: 'subscription_cycle', amount_due: 999, created: 10_000,
  attempt_count: 1, status: 'paid', status_transitions: { paid_at: 10_050 },
  parent: { subscription_details: { subscription: 'sub_1' } }, ...p,
}) as unknown as Stripe.Invoice;

const trial: TrialRow = {
  provider: 'stripe', account: 'org', subscription_id: 'sub_1',
  trial_started_at: 1_000, trial_ended_at: 10_000,
  first_invoice_id: null, first_attempt_succeeded: null, paid_at: null,
};

describe('trialFromSubscription', () => {
  it('null без триала', () => {
    expect(trialFromSubscription(sub({}), 'org')).toBeNull();
  });
  it('строка триала с пустыми полями оплаты', () => {
    expect(trialFromSubscription(sub({ trial_start: 1_000, trial_end: 10_000 }), 'org')).toEqual(trial);
  });
});

describe('invoiceSubscriptionId', () => {
  it('basil: parent.subscription_details', () => expect(invoiceSubscriptionId(inv({}))).toBe('sub_1'));
  it('старая версия API: invoice.subscription', () =>
    expect(invoiceSubscriptionId(inv({ parent: null, subscription: 'sub_2' }))).toBe('sub_2'));
  it('развёрнутый объект подписки', () =>
    expect(invoiceSubscriptionId(inv({ parent: { subscription_details: { subscription: { id: 'sub_3' } } } }))).toBe('sub_3'));
  it('инвойс без подписки', () => expect(invoiceSubscriptionId(inv({ parent: null }))).toBeNull());
});

describe('applyInvoice', () => {
  it('оплачен с первой попытки', () => {
    expect(applyInvoice(trial, inv({}))).toMatchObject({ first_invoice_id: 'in_1', first_attempt_succeeded: true, paid_at: 10_050 });
  });
  it('первая попытка упала, инвойс открыт', () => {
    expect(applyInvoice(trial, inv({ status: 'open', status_transitions: { paid_at: null } })))
      .toMatchObject({ first_attempt_succeeded: false, paid_at: null });
  });
  it('оплачен на ретрае', () => {
    expect(applyInvoice(trial, inv({ attempt_count: 3, status_transitions: { paid_at: 400_000 } })))
      .toMatchObject({ first_attempt_succeeded: false, paid_at: 400_000 });
  });
  it('попыток ещё не было', () => {
    expect(applyInvoice(trial, inv({ attempt_count: 0, status: 'open', status_transitions: { paid_at: null } })))
      .toMatchObject({ first_invoice_id: 'in_1', first_attempt_succeeded: null, paid_at: null });
  });
  it('игнорирует $0 инвойс старта триала, нулевые суммы, ранние инвойсы и чужой первый инвойс', () => {
    expect(applyInvoice(trial, inv({ billing_reason: 'subscription_create', amount_due: 0 }))).toBe(trial);
    expect(applyInvoice(trial, inv({ amount_due: 0 }))).toBe(trial);
    expect(applyInvoice(trial, inv({ created: 10_000 - 3_601 }))).toBe(trial);
    expect(applyInvoice({ ...trial, first_invoice_id: 'in_0' }, inv({}))).toEqual({ ...trial, first_invoice_id: 'in_0' });
  });
});
```

- [ ] **Шаг 2.** FAIL → **Шаг 3. Реализация** (начало `src/providers/stripe.ts`):

```ts
import Stripe from 'stripe';
import type { TrialRow } from '../db.js';

// Инвойс продления создаётся в момент окончания триала; запас — на задержки Stripe.
const FIRST_INVOICE_TOLERANCE = 3_600;

export function trialFromSubscription(sub: Stripe.Subscription, account: string): TrialRow | null {
  if (!sub.trial_start || !sub.trial_end || sub.trial_end <= sub.trial_start) return null;
  return {
    provider: 'stripe',
    account,
    subscription_id: sub.id,
    trial_started_at: sub.trial_start,
    trial_ended_at: sub.trial_end,
    first_invoice_id: null,
    first_attempt_succeeded: null,
    paid_at: null,
  };
}

export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  // basil кладёт подписку в parent; события старых версий API — в invoice.subscription
  const legacy = (invoice as unknown as { subscription?: string | { id: string } | null }).subscription;
  const ref = invoice.parent?.subscription_details?.subscription ?? legacy ?? null;
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

export function applyInvoice(trial: TrialRow, invoice: Stripe.Invoice): TrialRow {
  const isFirstPaidCandidate =
    !!invoice.id &&
    invoice.billing_reason === 'subscription_cycle' &&
    invoice.amount_due > 0 &&
    invoice.created >= trial.trial_ended_at - FIRST_INVOICE_TOLERANCE;
  const isSameInvoice = trial.first_invoice_id === null || trial.first_invoice_id === invoice.id;
  if (!isFirstPaidCandidate || !isSameInvoice) return trial;

  const paid = invoice.status === 'paid';
  return {
    ...trial,
    first_invoice_id: invoice.id!,
    first_attempt_succeeded: invoice.attempt_count === 0 ? null : paid && invoice.attempt_count === 1,
    paid_at: paid ? (invoice.status_transitions.paid_at ?? invoice.created) : null,
  };
}
```

- [ ] **Шаг 4.** PASS → **Шаг 5. Коммит:** `feat: stripe trial and invoice normalization`

---

## Задача 6. Stripe: синк аккаунта

**Файлы:** дописать `src/providers/stripe.ts`, создать `tests/stripe-sync.test.ts`.

Алгоритм (курсор и прогресс — в `sync_state`, ключи `subs_day`, `invoices_day`, `cursor`):
1. Курсора нет → бэкфилл:
   - подписки по дням от `сегодня − (HISTORY_DAYS + TRIAL_LOOKBACK_DAYS)` до сегодня;
   - инвойсы по дням от `сегодня − (HISTORY_DAYS + 1)` до сегодня.
   После каждого дня сохраняется прогресс.
2. Затем (и при каждом следующем запуске) — инкремент:
   - `since = (cursor ?? начало_сегодня) − 1 день`;
   - подписки с `created ≥ since`;
   - события `invoice.paid` и `invoice.payment_failed` с `created ≥ since`.
3. В конце `cursor = now`.

- [ ] **Шаг 1. Тест** — `tests/stripe-sync.test.ts`. Фейковый клиент реализует только `subscriptions.list`, `invoices.list`, `events.list` в виде async-генераторов, которые фильтруют фикстуры по `created` и записывают параметры вызовов.

```ts
import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { openStore } from '../src/db.js';
import { DAY } from '../src/metrics.js';
import { syncStripeAccount, type StripeLike } from '../src/providers/stripe.js';

const NOW = Date.parse('2026-10-12T10:00:00Z') / 1000;
const TODAY = NOW - (NOW % DAY);
const cfg = { historyDays: 90, trialLookbackDays: 31 };

function fakeStripe(data: { subs: object[]; invoices: object[]; events: object[] }) {
  const calls: { method: string; params: any }[] = [];
  const inRange = (created: number, r: { gte?: number; lt?: number }) =>
    (r.gte === undefined || created >= r.gte) && (r.lt === undefined || created < r.lt);
  const list = (method: string, items: any[]) => (params: any) => {
    calls.push({ method, params });
    return (async function* () {
      for (const item of items) if (inRange(item.created, params.created)) yield item;
    })();
  };
  const client = {
    subscriptions: { list: list('subscriptions', data.subs) },
    invoices: { list: list('invoices', data.invoices) },
    events: { list: list('events', data.events) },
  } as unknown as StripeLike;
  return { client, calls };
}

const trialEnd = TODAY - 10 * DAY;
const subscription = { id: 'sub_1', created: trialEnd - 3 * DAY, trial_start: trialEnd - 3 * DAY, trial_end: trialEnd };
const invoice = (p: object) => ({
  id: 'in_1', created: trialEnd, billing_reason: 'subscription_cycle', amount_due: 999,
  attempt_count: 1, status: 'open', status_transitions: { paid_at: null },
  parent: { subscription_details: { subscription: 'sub_1' } }, ...p,
});

describe('syncStripeAccount', () => {
  it('бэкфилл: подписки, затем инвойсы; сохраняет курсор', async () => {
    const store = openStore(':memory:');
    const { client, calls } = fakeStripe({ subs: [subscription], invoices: [invoice({})], events: [] });
    const items = await syncStripeAccount(store, client, 'org', cfg, NOW);

    expect(store.getTrial('stripe', 'sub_1')).toMatchObject({ first_invoice_id: 'in_1', first_attempt_succeeded: false, paid_at: null });
    expect(store.getState('stripe', 'org', 'cursor')).toBe(NOW);
    expect(calls.find((c) => c.method === 'subscriptions')!.params).toMatchObject({ status: 'all', created: { gte: TODAY - 121 * DAY } });
    expect(calls.find((c) => c.method === 'invoices')!.params.created.gte).toBe(TODAY - 91 * DAY);
    expect(items).toBeGreaterThan(0);
  });

  it('ежедневно: события об оплате на ретрае обновляют paid_at', async () => {
    const store = openStore(':memory:');
    await syncStripeAccount(store, fakeStripe({ subs: [subscription], invoices: [invoice({})], events: [] }).client, 'org', cfg, NOW);

    const later = NOW + DAY;
    const paidEvent = {
      created: later - 3600, type: 'invoice.paid',
      data: { object: invoice({ status: 'paid', attempt_count: 2, status_transitions: { paid_at: later - 3600 } }) },
    };
    const { client, calls } = fakeStripe({ subs: [], invoices: [], events: [paidEvent] });
    await syncStripeAccount(store, client, 'org', cfg, later);

    expect(store.getTrial('stripe', 'sub_1')).toMatchObject({ first_attempt_succeeded: false, paid_at: later - 3600 });
    expect(calls.some((c) => c.method === 'invoices')).toBe(false);
    expect(calls.find((c) => c.method === 'events')!.params).toMatchObject({
      types: ['invoice.paid', 'invoice.payment_failed'], created: { gte: NOW - DAY },
    });
  });

  it('продолжает прерванный бэкфилл с сохранённого дня', async () => {
    const store = openStore(':memory:');
    store.setState('stripe', 'org', 'subs_day', TODAY - 2 * DAY);
    const { client, calls } = fakeStripe({ subs: [], invoices: [], events: [] });
    await syncStripeAccount(store, client, 'org', cfg, NOW);
    expect(calls.filter((c) => c.method === 'subscriptions')[0].params.created.gte).toBe(TODAY - 2 * DAY);
  });
});
```

- [ ] **Шаг 2.** FAIL → **Шаг 3. Реализация** (дописать в `src/providers/stripe.ts`):

```ts
// к импортам в начале файла добавить:
import type { Store } from '../db.js';
import { DAY, dayKey, startOfUtcDay } from '../metrics.js';

export type StripeLike = Pick<Stripe, 'subscriptions' | 'invoices' | 'events'>;

export function createStripeClient(key: string): StripeLike {
  return new Stripe(key, { apiVersion: '2025-08-27.basil', maxNetworkRetries: 3 });
}

interface StripeSyncConfig {
  historyDays: number;
  trialLookbackDays: number;
}

export async function syncStripeAccount(
  store: Store, stripe: StripeLike, account: string, cfg: StripeSyncConfig, now: number,
): Promise<number> {
  const today = startOfUtcDay(now);
  const cursor = store.getState('stripe', account, 'cursor');
  let items = 0;

  const saveSubscription = (sub: Stripe.Subscription) => {
    const row = trialFromSubscription(sub, account);
    if (!row) return;
    store.upsertTrial(row);
    items++;
  };
  const saveInvoice = (invoice: Stripe.Invoice) => {
    const subscriptionId = invoiceSubscriptionId(invoice);
    const trial = subscriptionId ? store.getTrial('stripe', subscriptionId) : null;
    if (!trial) return;
    const next = applyInvoice(trial, invoice);
    if (next === trial) return;
    store.upsertTrial(next);
    items++;
  };

  if (cursor === null) {
    const subsFrom = store.getState('stripe', account, 'subs_day') ?? today - (cfg.historyDays + cfg.trialLookbackDays) * DAY;
    for (let day = subsFrom; day < today; day += DAY) {
      for await (const sub of stripe.subscriptions.list({ status: 'all', created: { gte: day, lt: day + DAY }, limit: 100 })) {
        saveSubscription(sub);
      }
      store.setState('stripe', account, 'subs_day', day + DAY);
      console.log(`[stripe:${account}] подписки ${dayKey(day)} готово`);
    }

    const invoicesFrom = store.getState('stripe', account, 'invoices_day') ?? today - (cfg.historyDays + 1) * DAY;
    for (let day = invoicesFrom; day < today; day += DAY) {
      for await (const invoice of stripe.invoices.list({ created: { gte: day, lt: day + DAY }, limit: 100 })) {
        saveInvoice(invoice);
      }
      store.setState('stripe', account, 'invoices_day', day + DAY);
      console.log(`[stripe:${account}] инвойсы ${dayKey(day)} готово`);
    }
  }

  const since = (cursor ?? today) - DAY;
  for await (const sub of stripe.subscriptions.list({ status: 'all', created: { gte: since }, limit: 100 })) {
    saveSubscription(sub);
  }
  for await (const event of stripe.events.list({ types: ['invoice.paid', 'invoice.payment_failed'], created: { gte: since }, limit: 100 })) {
    saveInvoice(event.data.object as Stripe.Invoice);
  }

  store.setState('stripe', account, 'cursor', now);
  return items;
}
```

- [ ] **Шаг 4.** `npm test` → PASS; `npm run typecheck` → без ошибок.
- [ ] **Шаг 5. Коммит:** `feat: stripe account sync with backfill and daily events`

---

## Задача 7. Solidgate: разведка реальных данных (ручная проверка)

**Цель:** до написания нормализатора подтвердить на живых данных:
- в каких единицах `product.trial_period` (по докам — минуты);
- что `started_at` — это начало триала;
- какие статусы `orders` означают успешное списание;
- как выглядит инвойс платного триала.

**Файлы:** создать `src/providers/solidgate-client.ts` (часть будущего модуля: подпись + один запрос), `scripts/probe-solidgate.ts`, `tests/solidgate-client.test.ts`.

- [ ] **Шаг 1. Тест клиента** — `tests/solidgate-client.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { listSubscriptions, solidgateSignature } from '../src/providers/solidgate-client.js';

const keys = { publicKey: 'api_pk_test', secretKey: 'api_sk_test' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('solidgate client', () => {
  it('подпись = base64(hex(hmac_sha512(secret, pk + body + pk))) — как в workflow-service', () => {
    const hex = createHmac('sha512', 'api_sk_test').update('api_pk_test{}api_pk_test').digest('hex');
    expect(solidgateSignature(keys, '{}')).toBe(Buffer.from(hex).toString('base64'));
  });

  it('проходит все страницы и шлёт заголовки', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ subscriptions: { a: { id: 'a' } }, metadata: { next_page_iterator: 'p2' } }))
      .mockResolvedValueOnce(json({ subscriptions: { b: { id: 'b' } }, metadata: { next_page_iterator: null } }));
    const ids: string[] = [];
    for await (const s of listSubscriptions(keys, 0, 86_400, { fetchFn, retryDelayMs: 0 })) ids.push(s.id);

    expect(ids).toEqual(['a', 'b']);
    const [url, init] = fetchFn.mock.calls[1];
    expect(url).toBe('https://reports.solidgate.com/api/v1/subscriptions');
    expect(JSON.parse(init.body)).toMatchObject({
      date_from: '1970-01-01 00:00:00', date_to: '1970-01-02 00:00:00', filter: 'updated_at', next_page_iterator: 'p2',
    });
    expect(init.headers).toMatchObject({ merchant: 'api_pk_test', signature: solidgateSignature(keys, init.body) });
  });

  it('повторяет 429/5xx и падает на ошибке в теле', async () => {
    const retrying = vi.fn()
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json({ subscriptions: {}, metadata: { next_page_iterator: null } }));
    for await (const _ of listSubscriptions(keys, 0, 1, { fetchFn: retrying, retryDelayMs: 0 })) { /* пусто */ }
    expect(retrying).toHaveBeenCalledTimes(2);

    const failing = vi.fn().mockResolvedValue(json({ error: { code: '1.01', messages: ['Invalid credentials'] } }));
    const drain = async () => {
      for await (const _ of listSubscriptions(keys, 0, 1, { fetchFn: failing, retryDelayMs: 0 })) { /* пусто */ }
    };
    await expect(drain()).rejects.toThrow(/1.01/);
  });
});
```

- [ ] **Шаг 2.** FAIL → **Шаг 3. Реализация** — `src/providers/solidgate-client.ts`:

```ts
import { createHmac } from 'node:crypto';

const REPORTS_URL = 'https://reports.solidgate.com/api/v1/subscriptions';
const PAGE_LIMIT = 2_000;
const MAX_RETRIES = 3;

export interface SolidgateKeys {
  publicKey: string;
  secretKey: string;
}

export interface SgOrder {
  id: string;
  status: string;
  created_at: string;
  processed_at?: string | null;
  retry_attempt?: number;
}

export interface SgInvoice {
  id: string;
  status: string;
  amount: number;
  created_at: string;
  billing_period_started_at: string;
  subscription_term_number?: number;
  orders?: Record<string, SgOrder>;
}

export interface SgSubscription {
  id: string;
  status: string;
  started_at: string;
  updated_at: string;
  trial?: boolean;
  product: { id: string; trial?: boolean; trial_period?: number; amount?: number };
  invoices?: Record<string, SgInvoice>;
}

interface ClientOptions {
  fetchFn?: typeof fetch;
  retryDelayMs?: number;
}

export function solidgateSignature(keys: SolidgateKeys, body: string): string {
  const hex = createHmac('sha512', keys.secretKey).update(keys.publicKey + body + keys.publicKey).digest('hex');
  return Buffer.from(hex).toString('base64');
}

export const formatSgDate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ');

export async function* listSubscriptions(
  keys: SolidgateKeys, from: number, to: number, options: ClientOptions = {},
): AsyncGenerator<SgSubscription> {
  let iterator: string | null = null;
  do {
    const page = await post(keys, {
      date_from: formatSgDate(from),
      date_to: formatSgDate(to),
      filter: 'updated_at',
      limit: PAGE_LIMIT,
      ...(iterator ? { next_page_iterator: iterator } : {}),
    }, options);
    yield* Object.values(page.subscriptions ?? {});
    iterator = page.metadata?.next_page_iterator ?? null;
  } while (iterator);
}

interface ReportPage {
  subscriptions?: Record<string, SgSubscription>;
  metadata?: { next_page_iterator: string | null };
  error?: { code: string; messages: string[] } | null;
}

async function post(keys: SolidgateKeys, payload: object, options: ClientOptions): Promise<ReportPage> {
  const fetchFn = options.fetchFn ?? fetch;
  const delayMs = options.retryDelayMs ?? 1_000;
  const body = JSON.stringify(payload);

  for (let attempt = 0; ; attempt++) {
    const response = await fetchFn(REPORTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', merchant: keys.publicKey, signature: solidgateSignature(keys, body) },
      body,
    });
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** attempt));
      continue;
    }
    const page = (await response.json()) as ReportPage;
    if (!response.ok || page.error) {
      throw new Error(`Solidgate reports ${response.status}: ${page.error?.code ?? ''} ${page.error?.messages?.join('; ') ?? ''}`.trim());
    }
    return page;
  }
}
```

- [ ] **Шаг 4.** `npx vitest run tests/solidgate-client.test.ts` → PASS.
- [ ] **Шаг 5. Скрипт разведки** — `scripts/probe-solidgate.ts`. Печатает только структуру: email, id клиента и данные карт не выводятся.

```ts
import { loadConfig, loadEnvFile } from '../src/config.js';
import { listSubscriptions, type SgSubscription } from '../src/providers/solidgate-client.js';

loadEnvFile();
const config = loadConfig();
const now = Math.floor(Date.now() / 1000);

for (const acc of config.solidgateAccounts) {
  let total = 0;
  const trials: SgSubscription[] = [];
  for await (const s of listSubscriptions(acc, now - 2 * 86_400, now)) {
    total++;
    if ((s.product?.trial || s.trial) && trials.length < 3) trials.push(s);
  }
  console.log(`\n=== ${acc.account}: подписок за 2 дня ${total}, с триалом в выборке ${trials.length}`);
  for (const s of trials) {
    console.log(JSON.stringify({
      status: s.status, started_at: s.started_at, trial: s.trial,
      product: { trial: s.product.trial, trial_period: s.product.trial_period, amount: s.product.amount },
      invoices: Object.values(s.invoices ?? {}).map((i) => ({
        term: i.subscription_term_number, status: i.status, amount: i.amount,
        billing_period_started_at: i.billing_period_started_at,
        orders: Object.values(i.orders ?? {}).map((o) => ({ status: o.status, retry_attempt: o.retry_attempt, created_at: o.created_at, processed_at: o.processed_at })),
      })),
    }, null, 2));
  }
}
```

- [ ] **Шаг 6. Запуск** (нужны ключи из задачи 0): `npm run probe:solidgate`.

  Проверить и записать выводы в `docs/plans/solidgate-probe-notes.md` (без PII):
  1. `trial_period` в минутах? Сравнить с известной длиной триала продукта.
  2. `started_at` совпадает с началом триала (у первого инвойса `billing_period_started_at` ≈ `started_at`)?
  3. Какие статусы `orders` у успешных списаний (ожидаем `approved` / `settle_ok`), у неуспешных (`declined`, `auth_failed`) и у тех, что ещё в процессе (`created`, `processing`, `3ds_verify`)?
  4. Как выглядит платный триал: есть ли инвойс с `amount > 0` и `billing_period_started_at = started_at`?
  5. Если отчёт не отдаёт `invoices`/`orders` — **стоп**. Переключаемся на запасной путь из спеки (`POST https://subscriptions.solidgate.com/api/v1/subscription/status` по каждой подписке в окне) и меняем задачу 8.

  Если ответы расходятся с ожиданиями, поправить константы и фикстуры в задаче 8.
- [ ] **Шаг 7. Коммит:** `feat: solidgate reports client and probe script`

---

## Задача 8. Solidgate: нормализация

**Файлы:** создать `src/providers/solidgate.ts`, `tests/solidgate-normalize.test.ts`.

Правила (уточнить по итогам задачи 7):
- **Был ли триал:** `product.trial === true` и `trial_period > 0` (в минутах). `trial_started_at = started_at`, `trial_ended_at = started_at + trial_period × 60`.
- **Первый платный инвойс:** `amount > 0` и `billing_period_started_at ≥ trial_ended_at − 1 ч`; из таких берём самый ранний.
- **Попытки:** orders этого инвойса по `created_at`. Статусы:
  - успех — `approved`, `settle_ok`, `auth_ok`, `refunded` (рефанд значит, что списание было);
  - в процессе — `created`, `processing`, `3ds_verify`;
  - остальные статусы — неуспех.
- `first_attempt_succeeded`: нет orders или первая попытка ещё в процессе → `null`; иначе — успешна ли первая попытка.
- `paid_at`: `processed_at` (или `created_at`) первой успешной попытки.

- [ ] **Шаг 1. Тест** — `tests/solidgate-normalize.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { SgSubscription } from '../src/providers/solidgate-client.js';
import { parseSgDate, trialFromSolidgate } from '../src/providers/solidgate.js';

const T0 = '2026-10-01 10:00:00';
const T_END = '2026-10-04 10:00:00'; // 3 дня = 4320 минут
const ts = (s: string) => parseSgDate(s);

const sub = (invoices: SgSubscription['invoices'] = {}, product: Partial<SgSubscription['product']> = {}): SgSubscription => ({
  id: 'sg_sub_1', status: 'active', started_at: T0, updated_at: T_END,
  product: { id: 'p1', trial: true, trial_period: 4320, ...product }, invoices,
});
const order = (id: string, status: string, created_at: string, processed_at = created_at) => ({ id, status, created_at, processed_at });
const invoice = (id: string, start: string, amount: number, orders: ReturnType<typeof order>[]) => ({
  id, status: 'success', amount, created_at: start, billing_period_started_at: start,
  orders: Object.fromEntries(orders.map((o) => [o.id, o])),
});

describe('parseSgDate', () => {
  it('понимает формат Solidgate и ISO', () => {
    expect(parseSgDate('2026-10-01 10:00:00')).toBe(Date.parse('2026-10-01T10:00:00Z') / 1000);
    expect(parseSgDate('2026-10-01T10:00:00Z')).toBe(Date.parse('2026-10-01T10:00:00Z') / 1000);
    expect(parseSgDate('2026-10-01T13:00:00+03:00')).toBe(Date.parse('2026-10-01T10:00:00Z') / 1000);
  });
});

describe('trialFromSolidgate', () => {
  it('null без триала', () => {
    expect(trialFromSolidgate(sub({}, { trial: false }), 'sg')).toBeNull();
    expect(trialFromSolidgate(sub({}, { trial_period: 0 }), 'sg')).toBeNull();
  });

  it('даты триала, без инвойсов — поля оплаты пустые', () => {
    expect(trialFromSolidgate(sub(), 'sg')).toEqual({
      provider: 'solidgate', account: 'sg', subscription_id: 'sg_sub_1',
      trial_started_at: ts(T0), trial_ended_at: ts(T_END),
      first_invoice_id: null, first_attempt_succeeded: null, paid_at: null,
    });
  });

  it('платный триал игнорируется, первая попытка успешна', () => {
    const row = trialFromSolidgate(sub({
      trial_inv: invoice('trial_inv', T0, 99, [order('o0', 'approved', T0)]),
      paid_inv: invoice('paid_inv', T_END, 999, [order('o1', 'approved', T_END, '2026-10-04 10:05:00')]),
    }), 'sg');
    expect(row).toMatchObject({ first_invoice_id: 'paid_inv', first_attempt_succeeded: true, paid_at: ts('2026-10-04 10:05:00') });
  });

  it('оплачен на ретрае', () => {
    const row = trialFromSolidgate(sub({
      paid_inv: invoice('paid_inv', T_END, 999, [
        order('o2', 'approved', '2026-10-07 10:00:00'),
        order('o1', 'declined', T_END),
      ]),
    }), 'sg');
    expect(row).toMatchObject({ first_attempt_succeeded: false, paid_at: ts('2026-10-07 10:00:00') });
  });

  it('только отказы → false и без оплаты; попытка в процессе → null', () => {
    expect(trialFromSolidgate(sub({ i: invoice('i', T_END, 999, [order('o1', 'declined', T_END)]) }), 'sg'))
      .toMatchObject({ first_attempt_succeeded: false, paid_at: null });
    expect(trialFromSolidgate(sub({ i: invoice('i', T_END, 999, [order('o1', 'processing', T_END)]) }), 'sg'))
      .toMatchObject({ first_invoice_id: 'i', first_attempt_succeeded: null, paid_at: null });
  });

  it('берёт самый ранний платный инвойс после триала', () => {
    const row = trialFromSolidgate(sub({
      second: invoice('second', '2026-11-04 10:00:00', 999, [order('o2', 'approved', '2026-11-04 10:00:00')]),
      first: invoice('first', T_END, 999, [order('o1', 'declined', T_END)]),
    }), 'sg');
    expect(row?.first_invoice_id).toBe('first');
  });
});
```

- [ ] **Шаг 2.** FAIL → **Шаг 3. Реализация** — `src/providers/solidgate.ts`:

```ts
import type { TrialRow } from '../db.js';
import type { SgOrder, SgSubscription } from './solidgate-client.js';

const FIRST_INVOICE_TOLERANCE = 3_600;
const SUCCESS = new Set(['approved', 'settle_ok', 'auth_ok', 'refunded']);
const PENDING = new Set(['created', 'processing', '3ds_verify']);

export function parseSgDate(value: string): number {
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  const zoned = /([zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`;
  return Math.floor(Date.parse(zoned) / 1000);
}

export function trialFromSolidgate(sub: SgSubscription, account: string): TrialRow | null {
  const trialMinutes = sub.product?.trial ? (sub.product.trial_period ?? 0) : 0;
  if (trialMinutes <= 0) return null;

  const trialStartedAt = parseSgDate(sub.started_at);
  const trialEndedAt = trialStartedAt + trialMinutes * 60;
  const row: TrialRow = {
    provider: 'solidgate',
    account,
    subscription_id: sub.id,
    trial_started_at: trialStartedAt,
    trial_ended_at: trialEndedAt,
    first_invoice_id: null,
    first_attempt_succeeded: null,
    paid_at: null,
  };

  const firstPaid = Object.values(sub.invoices ?? {})
    .filter((i) => i.amount > 0 && parseSgDate(i.billing_period_started_at) >= trialEndedAt - FIRST_INVOICE_TOLERANCE)
    .sort((a, b) => parseSgDate(a.billing_period_started_at) - parseSgDate(b.billing_period_started_at))[0];
  if (!firstPaid) return row;

  const orders = Object.values(firstPaid.orders ?? {}).sort((a, b) => parseSgDate(a.created_at) - parseSgDate(b.created_at));
  const firstSuccess = orders.find((o) => SUCCESS.has(o.status));
  return {
    ...row,
    first_invoice_id: firstPaid.id,
    first_attempt_succeeded: firstAttempt(orders[0]),
    paid_at: firstSuccess ? parseSgDate(firstSuccess.processed_at ?? firstSuccess.created_at) : null,
  };
}

function firstAttempt(order: SgOrder | undefined): boolean | null {
  if (!order || PENDING.has(order.status)) return null;
  return SUCCESS.has(order.status);
}
```

- [ ] **Шаг 4.** PASS → **Шаг 5. Коммит:** `feat: solidgate trial normalization`

---

## Задача 9. Solidgate: синк аккаунта

**Файлы:** дописать `src/providers/solidgate.ts`, создать `tests/solidgate-sync.test.ts`.

Алгоритм: отчёт отдаёт полное состояние подписки, поэтому бэкфилл и ежедневный синк — один и тот же цикл по окнам в 1 день.
- Бэкфилл: от `backfill_day` или от `сегодня − (HISTORY_DAYS + TRIAL_LOOKBACK_DAYS)`.
- Ежедневно: от `cursor − 1 день`.
- Окно заканчивается на `min(day + 1 день, now)`. Прогресс бэкфилла сохраняется после каждого окна, в конце пишется `cursor = now`.

- [ ] **Шаг 1. Тест** — `tests/solidgate-sync.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { openStore } from '../src/db.js';
import { DAY } from '../src/metrics.js';
import type { SgSubscription } from '../src/providers/solidgate-client.js';
import { syncSolidgateAccount } from '../src/providers/solidgate.js';

const NOW = Date.parse('2026-10-12T10:00:00Z') / 1000;
const TODAY = NOW - (NOW % DAY);
const cfg = { historyDays: 90, trialLookbackDays: 31 };
const trialSub: SgSubscription = {
  id: 'sg_1', status: 'active', started_at: '2026-10-01 10:00:00', updated_at: '2026-10-04 10:00:00',
  product: { id: 'p', trial: true, trial_period: 4320 }, invoices: {},
};

function fakeList(subs: SgSubscription[]) {
  const windows: [number, number][] = [];
  const list = async function* (_keys: unknown, from: number, to: number) {
    windows.push([from, to]);
    if (from === TODAY - DAY) yield* subs;
  };
  return { list, windows };
}

describe('syncSolidgateAccount', () => {
  it('бэкфилл окнами по дню до now, затем курсор', async () => {
    const store = openStore(':memory:');
    const { list, windows } = fakeList([trialSub, { ...trialSub, id: 'no_trial', product: { id: 'p2', trial: false } }]);
    const items = await syncSolidgateAccount(store, { account: 'sg', publicKey: 'pk', secretKey: 'sk' }, cfg, NOW, list);

    expect(windows[0][0]).toBe(TODAY - 121 * DAY);
    expect(windows.at(-1)).toEqual([TODAY, NOW]);
    expect(items).toBe(1);
    expect(store.getTrial('solidgate', 'sg_1')).not.toBeNull();
    expect(store.getState('solidgate', 'sg', 'cursor')).toBe(NOW);
  });

  it('ежедневно — с cursor − 1 день', async () => {
    const store = openStore(':memory:');
    store.setState('solidgate', 'sg', 'cursor', NOW - DAY);
    const { list, windows } = fakeList([]);
    await syncSolidgateAccount(store, { account: 'sg', publicKey: 'pk', secretKey: 'sk' }, cfg, NOW, list);
    expect(windows[0][0]).toBe(NOW - 2 * DAY);
  });
});
```

- [ ] **Шаг 2.** FAIL → **Шаг 3. Реализация** (дописать в `src/providers/solidgate.ts`; импорты объединить с импортами задачи 8 в начале файла):

```ts
import type { SolidgateAccount } from '../config.js';
import type { Store } from '../db.js';
import { DAY, dayKey, startOfUtcDay } from '../metrics.js';
import { listSubscriptions } from './solidgate-client.js';

interface SolidgateSyncConfig {
  historyDays: number;
  trialLookbackDays: number;
}

export async function syncSolidgateAccount(
  store: Store, acc: SolidgateAccount, cfg: SolidgateSyncConfig, now: number, list = listSubscriptions,
): Promise<number> {
  const cursor = store.getState('solidgate', acc.account, 'cursor');
  const backfillFrom = store.getState('solidgate', acc.account, 'backfill_day')
    ?? startOfUtcDay(now) - (cfg.historyDays + cfg.trialLookbackDays) * DAY;
  let items = 0;

  for (let from = cursor !== null ? cursor - DAY : backfillFrom; from < now; from += DAY) {
    const to = Math.min(from + DAY, now);
    for await (const sub of list(acc, from, to)) {
      const row = trialFromSolidgate(sub, acc.account);
      if (!row) continue;
      store.upsertTrial(row);
      items++;
    }
    if (cursor === null) {
      store.setState('solidgate', acc.account, 'backfill_day', from + DAY);
      console.log(`[solidgate:${acc.account}] ${dayKey(from)} готово`);
    }
  }

  store.setState('solidgate', acc.account, 'cursor', now);
  return items;
}
```

- [ ] **Шаг 4.** PASS → **Шаг 5. Коммит:** `feat: solidgate account sync`

---

## Задача 10. Оркестрация синка

**Файлы:** создать `src/sync.ts`, `tests/sync.test.ts`.

- [ ] **Шаг 1. Тест** — `tests/sync.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { openStore } from '../src/db.js';
import { isSyncRunning, runSync, type Source } from '../src/sync.js';

const source = (provider: Source['provider'], account: string, run: Source['run']): Source => ({ provider, account, run });

describe('runSync', () => {
  it('ошибка одного источника не мешает остальным и пишется в журнал', async () => {
    const store = openStore(':memory:');
    await runSync(store, [
      source('stripe', 'org', async () => { throw new Error('rate limited'); }),
      source('solidgate', 'sg', async () => 7),
    ]);
    expect(store.latestRuns()).toEqual([
      { provider: 'solidgate', account: 'sg', last_status: 'ok', last_error: null, last_success_at: expect.any(Number) },
      { provider: 'stripe', account: 'org', last_status: 'error', last_error: 'rate limited', last_success_at: null },
    ]);
  });

  it('kind = backfill без курсора и daily с курсором', async () => {
    const store = openStore(':memory:');
    store.setState('solidgate', 'sg', 'cursor', 1);
    await runSync(store, [source('stripe', 'org', async () => 0), source('solidgate', 'sg', async () => 0)]);
    const kinds = store.db.prepare('SELECT provider, kind FROM sync_runs ORDER BY id').all();
    expect(kinds).toEqual([{ provider: 'stripe', kind: 'backfill' }, { provider: 'solidgate', kind: 'daily' }]);
  });

  it('второй запуск во время синка отклоняется', async () => {
    const store = openStore(':memory:');
    let release!: () => void;
    const first = runSync(store, [source('stripe', 'org', () => new Promise((r) => { release = () => r(0); }))]);
    expect(isSyncRunning()).toBe(true);
    expect(await runSync(store, [])).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(isSyncRunning()).toBe(false);
  });
});
```

- [ ] **Шаг 2.** FAIL → **Шаг 3. Реализация** — `src/sync.ts`:

```ts
import type { Config } from './config.js';
import { nowSec, type Provider, type Store } from './db.js';
import { createStripeClient, syncStripeAccount } from './providers/stripe.js';
import { syncSolidgateAccount } from './providers/solidgate.js';

export interface Source {
  provider: Provider;
  account: string;
  run: (store: Store, now: number) => Promise<number>;
}

let running = false;

export const isSyncRunning = () => running;

export async function runSync(store: Store, sources: Source[]): Promise<boolean> {
  if (running) return false;
  running = true;
  try {
    for (const source of sources) {
      const kind = store.getState(source.provider, source.account, 'cursor') === null ? 'backfill' : 'daily';
      const runId = store.startRun(source.provider, source.account, kind);
      try {
        const items = await source.run(store, nowSec());
        store.finishRun(runId, 'ok', items, null);
        console.log(`[${source.provider}:${source.account}] ${kind}: ${items} записей`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        store.finishRun(runId, 'error', 0, message);
        console.error(`[${source.provider}:${source.account}] ${kind} упал: ${message}`);
      }
    }
    return true;
  } finally {
    running = false;
  }
}

export function buildSources(config: Config): Source[] {
  const stripe = config.stripeAccounts.map(({ account, key }): Source => {
    const client = createStripeClient(key);
    return { provider: 'stripe', account, run: (store, now) => syncStripeAccount(store, client, account, config, now) };
  });
  const solidgate = config.solidgateAccounts.map((acc): Source => ({
    provider: 'solidgate',
    account: acc.account,
    run: (store, now) => syncSolidgateAccount(store, acc, config, now),
  }));
  return [...stripe, ...solidgate];
}
```

- [ ] **Шаг 4.** PASS → **Шаг 5. Коммит:** `feat: sync orchestration with lock and run journal`

---

## Задача 11. HTTP-сервер и точка входа

**Файлы:** создать `src/server.ts`, `src/main.ts`, `src/sync-cli.ts`, `tests/server.test.ts`.

- [ ] **Шаг 1. Тест** — `tests/server.test.ts` (сервер на случайном порту, встроенный `fetch`):

```ts
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { createApp } from '../src/server.js';
import type { Source } from '../src/sync.js';

const config = loadConfig({ STRIPE_KEYS: 'org=rk', BASIC_AUTH_USER: 'billing', BASIC_AUTH_PASSWORD: 'p:ss' });
const auth = { authorization: `Basic ${Buffer.from('billing:p:ss').toString('base64')}` };
let close: () => void = () => {};

async function start(sources: Source[] = []) {
  const server = createApp({ store: openStore(':memory:'), config, sources }).listen(0);
  await new Promise((r) => server.once('listening', r));
  close = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(() => close());

describe('server', () => {
  it('/health без авторизации, остальное — под basic auth', async () => {
    const url = await start();
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/api/metrics`)).status).toBe(401);
    expect((await fetch(`${url}/api/metrics`, { headers: { authorization: 'Basic d3Jvbmc6cGFzcw==' } })).status).toBe(401);
    expect((await fetch(`${url}/`, { headers: auth })).status).toBe(200);
  });

  it('/api/metrics отдаёт карточки, ряд и статус синка', async () => {
    const url = await start();
    const body = await (await fetch(`${url}/api/metrics?provider=stripe&granularity=week`, { headers: auth })).json();
    expect(body).toMatchObject({ retry_window_days: 30, sync_running: false, sync: [] });
    expect(body.cards).toHaveProperty('ended_7d');
    expect(Array.isArray(body.series)).toBe(true);
  });

  it('/api/sync: 202, а во время синка — 409', async () => {
    let release!: () => void;
    const url = await start([{ provider: 'stripe', account: 'org', run: () => new Promise((r) => { release = () => r(0); }) }]);
    expect((await fetch(`${url}/api/sync`, { method: 'POST', headers: auth })).status).toBe(202);
    expect((await fetch(`${url}/api/sync`, { method: 'POST', headers: auth })).status).toBe(409);
    release();
  });
});
```

- [ ] **Шаг 2.** FAIL → **Шаг 3. Реализация** — `src/server.ts`:

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type RequestHandler } from 'express';
import type { Config } from './config.js';
import { nowSec, type Store } from './db.js';
import { getMetrics, type ProviderFilter } from './metrics.js';
import { isSyncRunning, runSync, type Source } from './sync.js';

// одинаково работает из src/ (tsx, vitest) и из dist/ (prod)
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PROVIDERS: ProviderFilter[] = ['all', 'stripe', 'solidgate'];

export function createApp({ store, config, sources }: { store: Store; config: Config; sources: Source[] }) {
  const app = express();

  app.get('/health', (_req, res) => {
    res.send('ok');
  });
  app.use(basicAuth(config.basicAuth.user, config.basicAuth.password));
  app.use(express.static(PUBLIC_DIR));

  app.get('/api/metrics', (req, res) => {
    const provider = PROVIDERS.find((p) => p === req.query.provider) ?? 'all';
    const granularity = req.query.granularity === 'week' ? 'week' : 'day';
    const { cards, series } = getMetrics(store.db, {
      provider, granularity, now: nowSec(), historyDays: config.historyDays, retryWindowDays: config.retryWindowDays,
    });
    res.json({
      generated_at: nowSec(),
      retry_window_days: config.retryWindowDays,
      sync_running: isSyncRunning(),
      sync: store.latestRuns(),
      cards,
      series,
    });
  });

  app.post('/api/sync', (_req, res) => {
    if (isSyncRunning()) {
      res.status(409).json({ status: 'running' });
      return;
    }
    void runSync(store, sources);
    res.status(202).json({ status: 'started' });
  });

  return app;
}

function basicAuth(user: string, password: string): RequestHandler {
  const expected = hash(`${user}:${password}`);
  return (req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    const given = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString() : '';
    if (timingSafeEqual(hash(given), expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="trial-dashboard"').status(401).send('Нужна авторизация');
  };
}

const hash = (value: string) => createHash('sha256').update(value).digest();
```

`src/main.ts`:

```ts
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { loadConfig, loadEnvFile } from './config.js';
import { openStore } from './db.js';
import { createApp } from './server.js';
import { buildSources, runSync } from './sync.js';

loadEnvFile();
const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const store = openStore(path.join(config.dataDir, 'dashboard.sqlite'));
store.failStaleRuns();
const sources = buildSources(config);

createApp({ store, config, sources }).listen(config.port, () => {
  console.log(`Дашборд: http://localhost:${config.port}`);
});

cron.schedule(config.syncCron, () => void runSync(store, sources), { timezone: 'UTC' });

// Первый запуск или прерванный бэкфилл — сразу догружаем
if (sources.some((s) => store.getState(s.provider, s.account, 'cursor') === null)) {
  void runSync(store, sources);
}
```

`src/sync-cli.ts`:

```ts
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, loadEnvFile } from './config.js';
import { openStore } from './db.js';
import { buildSources, runSync } from './sync.js';

loadEnvFile();
const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const store = openStore(path.join(config.dataDir, 'dashboard.sqlite'));
store.failStaleRuns();
await runSync(store, buildSources(config));
console.table(store.latestRuns());
```

- [ ] **Шаг 4.** `npm test` → PASS; `npm run typecheck` → без ошибок. (Тест `GET /` пройдёт после задачи 12; до тех пор временно положить пустой `public/index.html`.)
- [ ] **Шаг 5. Коммит:** `feat: express server, entrypoint and sync cli`

---

## Задача 12. Страница дашборда

**Файлы:** создать `public/index.html`.

Требования из спеки (раздел 6) и утверждённого макета:
- **Шапка:** время обновления, статус синка по каждому источнику, кнопка «Обновить» (пока синк идёт — «Идёт синк…», страница опрашивает API каждые 10 с).
- **Переключатели:** Все/Stripe/Solidgate и День/Неделя.
- **Карточки:** 3 штуки с периодом в подписи.
- **График:** столбики `ended` на правой оси, линии `rate_first` (зелёная) и `rate_retry` (фиолетовая). Участки с неокончательной цифрой — пунктиром.
- **Таблица:** колонки «Период», «Триалов», «С первой попытки», «С учётом ретраев»; неокончательные значения серые с пометкой «≈».

- [ ] **Шаг 1. Разметка и скрипт:**

```html
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Trial → Paid</title>
  <style>
    :root { --text: #1f1f1f; --muted: #6b6b6b; --line: #e6e6e3; --card: #f5f5f2; --bg: #fff; --ok: #1d9e75; --err: #c0392b; }
    @media (prefers-color-scheme: dark) {
      :root { --text: #ececea; --muted: #9a9a95; --line: #33332f; --card: #232320; --bg: #161614; }
    }
    body { margin: 0; font: 14px/1.5 system-ui, sans-serif; color: var(--text); background: var(--bg); }
    main { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
    header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
    h1 { font-size: 20px; font-weight: 600; margin: 0; }
    button { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
    .muted { color: var(--muted); font-size: 13px; }
    .ok { color: var(--ok); } .err { color: var(--err); }
    .controls { display: flex; gap: 16px; margin: 16px 0; flex-wrap: wrap; }
    .seg { display: flex; gap: 4px; }
    .seg button.on { background: var(--card); font-weight: 600; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
    .card { background: var(--card); border-radius: 8px; padding: 12px 16px; }
    .card b { display: block; font-size: 24px; font-weight: 600; }
    .chart { position: relative; height: 320px; margin: 24px 0; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
    th:first-child, td:first-child { text-align: left; }
    .pending { color: var(--muted); }
  </style>
</head>
<body>
<main>
  <header>
    <div><h1>Trial → Paid</h1><div class="muted" id="status">Загрузка…</div></div>
    <button id="refresh">Обновить</button>
  </header>
  <div class="controls">
    <div class="seg" id="provider">
      <button data-v="all" class="on">Все</button><button data-v="stripe">Stripe</button><button data-v="solidgate">Solidgate</button>
    </div>
    <div class="seg" id="granularity">
      <button data-v="day" class="on">День</button><button data-v="week">Неделя</button>
    </div>
  </div>
  <div class="cards" id="cards"></div>
  <div class="chart"><canvas id="chart"></canvas></div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Период</th><th>Триалов</th><th>С первой попытки</th><th>С учётом ретраев</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
</main>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script>
  const state = { provider: 'all', granularity: 'day' };
  let chart;
  let pollTimer;

  const pct = (r) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);
  const num = (n) => n.toLocaleString('ru-RU');
  const utc = (ts) => (ts ? `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'ещё не было');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const range = (c) => (c.from ? `${c.from} — ${c.to}` : 'нет данных');

  async function load() {
    const res = await fetch(`/api/metrics?provider=${state.provider}&granularity=${state.granularity}`);
    const data = await res.json();
    renderStatus(data);
    renderCards(data.cards);
    renderChart(data.series);
    renderTable(data.series);
    clearTimeout(pollTimer);
    if (data.sync_running) pollTimer = setTimeout(load, 10_000);
  }

  function renderStatus(data) {
    const parts = data.sync.map((s) => {
      const label = `${s.provider}:${s.account}`;
      return s.last_status === 'error'
        ? `<span class="err" title="${esc(s.last_error ?? '')}">${label} — ошибка (успех: ${utc(s.last_success_at)})</span>`
        : `<span class="ok">${label}</span> ${utc(s.last_success_at)}`;
    });
    document.getElementById('status').innerHTML = parts.join(' · ') || 'Синков ещё не было';
    document.getElementById('refresh').textContent = data.sync_running ? 'Идёт синк…' : 'Обновить';
  }

  function renderCards(c) {
    document.getElementById('cards').innerHTML = [
      ['Триалов закончилось, 7 дн', num(c.ended_7d.value), range(c.ended_7d)],
      ['С первой попытки, 7 дн', pct(c.rate_first_7d.rate), range(c.rate_first_7d)],
      ['С учётом ретраев, дозревшие 7 дн', pct(c.rate_retry_7d.rate), range(c.rate_retry_7d)],
    ].map(([label, value, period]) => `<div class="card"><span class="muted">${label}</span><b>${value}</b><span class="muted">${period}</span></div>`).join('');
  }

  function renderChart(series) {
    const dashed = (key) => (ctx) => (series[ctx.p1DataIndex][key] ? undefined : [5, 4]);
    const toPct = (r) => (r === null ? null : +(r * 100).toFixed(1));
    const datasets = [
      { type: 'bar', label: 'Триалов закончилось', data: series.map((p) => p.ended), backgroundColor: '#d3d1c7', yAxisID: 'count', order: 3 },
      { type: 'line', label: 'С первой попытки', data: series.map((p) => toPct(p.rate_first)), borderColor: '#1d9e75', backgroundColor: '#1d9e75', yAxisID: 'rate', pointRadius: 2, spanGaps: true, segment: { borderDash: dashed('final_first') }, order: 1 },
      { type: 'line', label: 'С учётом ретраев', data: series.map((p) => toPct(p.rate_retry)), borderColor: '#534ab7', backgroundColor: '#534ab7', yAxisID: 'rate', pointRadius: 2, spanGaps: true, segment: { borderDash: dashed('final_retry') }, order: 2 },
    ];
    if (chart) chart.destroy();
    chart = new Chart(document.getElementById('chart'), {
      data: { labels: series.map((p) => p.period), datasets },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: { label: (c) => (c.datasetIndex === 0 ? `${c.dataset.label}: ${num(c.raw)}` : `${c.dataset.label}: ${c.raw ?? '—'}%`) } } },
        scales: {
          rate: { position: 'left', min: 0, ticks: { callback: (v) => `${v}%` } },
          count: { position: 'right', grid: { display: false } },
        },
      },
    });
  }

  function renderTable(series) {
    const cell = (n, r, final) => `<td class="${final ? '' : 'pending'}">${final ? '' : '≈ '}${num(n)} (${pct(r)})</td>`;
    document.getElementById('rows').innerHTML = [...series].reverse().map((p) =>
      `<tr><td>${p.period}</td><td>${num(p.ended)}</td>${cell(p.paid_first, p.rate_first, p.final_first)}${cell(p.paid_retry, p.rate_retry, p.final_retry)}</tr>`,
    ).join('');
  }

  for (const id of ['provider', 'granularity']) {
    document.getElementById(id).addEventListener('click', (e) => {
      const value = e.target.dataset?.v;
      if (!value) return;
      state[id] = value;
      document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === value));
      load();
    });
  }

  document.getElementById('refresh').addEventListener('click', async () => {
    await fetch('/api/sync', { method: 'POST' });
    load();
  });

  load();
</script>
</body>
</html>
```

- [ ] **Шаг 2. Ручная проверка:**
  1. `npm run dev`, открыть `http://localhost:3000`, войти под `BASIC_AUTH_*`.
  2. С пустой базой: шапка «Синков ещё не было» или статус бэкфилла, график из нулей, без ошибок в консоли браузера.
  3. Переключатели меняют данные.
  4. Кнопка «Обновить» показывает «Идёт синк…».
  5. Тёмная тема читается.
- [ ] **Шаг 3. Коммит:** `feat: dashboard page`

---

## Задача 13. Docker и README

**Файлы:** создать `Dockerfile`, `.dockerignore`, `README.md`.

- [ ] **Шаг 1. Dockerfile:**

```dockerfile
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
VOLUME /app/data
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

Нативных зависимостей нет (`node:sqlite` встроен в Node), поэтому build-инструменты в образе не нужны. Чтобы не печатать `ExperimentalWarning`, в `CMD` можно добавить `--disable-warning=ExperimentalWarning`.

- [ ] **Шаг 2. .dockerignore:** `node_modules`, `dist`, `data`, `.env`, `.git`, `docs`, `tests`.
- [ ] **Шаг 3. README.md** — коротко:
  - что считает дашборд (2 абзаца со ссылкой на спеку);
  - как завести ключи (задача 0);
  - локальный запуск: `cp .env.example .env` → заполнить → `npm install` → `npm run dev`;
  - первый бэкфилл идёт десятки минут, прогресс виден в логах, прерывание безопасно;
  - разовый синк: `npm run sync`;
  - Docker: `docker build -t trial-dashboard .` и `docker run -p 3000:3000 --env-file .env -v $(pwd)/data:/app/data trial-dashboard`;
  - деплой: любой хостинг с постоянным volume под `/app/data`, health-check — `GET /health`.
- [ ] **Шаг 4. Проверить:** `docker build -t trial-dashboard .` собирается; `docker run …` поднимает сервис, `curl localhost:3000/health` → `ok`.
- [ ] **Шаг 5. Коммит:** `chore: dockerfile and readme`

---

## Задача 14. Первый боевой прогон и сверка

- [ ] **Шаг 1.** `npm run sync`: дождаться бэкфилла по всем источникам. `console.table` в конце должна показать `ok` у каждого источника.
- [ ] **Шаг 2.** `npm run dev` → дашборд с данными.
- [ ] **Шаг 3. Сверка Stripe** (Toggle Org, 1–2 дня старше 31 дня):
  - в Dashboard → Subscriptions отфильтровать подписки с триалом, закончившимся в этот день, и сравнить с `ended`;
  - выборочно открыть 5 подписок, у которых `paid_at` пуст или есть, и проверить первый инвойс после триала.
- [ ] **Шаг 4. Сверка Solidgate:** в Hub → Subscriptions выборочно 5 подписок того же дня — статус первого инвойса после триала и число попыток.
- [ ] **Шаг 5. Порядок величины:** Trial→Paid по Stripe сравнить с Campaignswell `trial_to_paid_cvr` (там когорты по старту триала и другое окно, поэтому точного совпадения не будет; ориентир — около 30% на зрелых когортах).
- [ ] **Шаг 6.** Если нашлись расхождения — завести задачу на исправление в этом плане. Если нет — коммит README с датой первой сверки: `docs: first reconciliation notes`.

---

## Покрытие спеки

| раздел спеки | задачи |
|---|---|
| 3. Определения метрики | 4 (метрики, окончательность), 5 и 8 (что считать первой попыткой и оплатой) |
| 4. Архитектура, TrialRow, схема | 1, 3 |
| 5. Stripe | 5, 6 |
| 5. Solidgate (+ запасной путь) | 7, 8, 9 |
| 6. API и UI | 11, 12 |
| 7. Ошибки | 3 (зависшие синки), 7 (ретраи Solidgate), 6 (`maxNetworkRetries`), 10 (изоляция, lock) |
| 8. Тесты | в каждой задаче; ручная сверка — 14 |
| 9. Безопасность и деплой | 1 (`.gitignore`), 11 (basic auth), 13 (Docker) |
