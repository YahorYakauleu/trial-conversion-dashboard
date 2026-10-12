import { DatabaseSync } from 'node:sqlite';

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
  country: string | null; // страна карты, двухбуквенный код (US, GB, …)
  payment_method: string | null; // apple_pay, google_pay, card, paypal…
  card_brand: string | null; // visa, mastercard…
  bank: string | null; // банк-эмитент (есть только у Solidgate)
}

// Одна попытка списания первого платного периода (Stripe charge / Solidgate order)
export interface AttemptRow {
  provider: Provider;
  attempt_id: string;
  subscription_id: string;
  attempted_at: number;
  approved: boolean;
  reason: string | null; // код причины отказа провайдера
  refunded: boolean;
}

export interface CardDetails {
  country: string | null;
  payment_method: string | null;
  card_brand: string | null;
  bank: string | null;
}

export interface LatestRun {
  provider: Provider;
  account: string;
  last_status: RunStatus;
  last_error: string | null;
  last_success_at: number | null;
}

export type Db = DatabaseSync;
export type Store = ReturnType<typeof openStore>;

export const nowSec = () => Math.floor(Date.now() / 1000);

export function openStore(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
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
  // Колонки карты появились позже — добавляем в уже существующую базу
  const columns = new Set((db.prepare('PRAGMA table_info(trials)').all() as { name: string }[]).map((c) => c.name));
  for (const column of ['country', 'payment_method', 'card_brand', 'bank']) {
    if (!columns.has(column)) db.exec(`ALTER TABLE trials ADD COLUMN ${column} TEXT`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS trials_started_idx ON trials (trial_started_at);
    CREATE INDEX IF NOT EXISTS trials_first_invoice_idx ON trials (provider, first_invoice_id);
    CREATE TABLE IF NOT EXISTS attempts (
      provider TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      attempted_at INTEGER NOT NULL,
      approved INTEGER NOT NULL,
      reason TEXT,
      refunded INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider, attempt_id)
    );
    CREATE INDEX IF NOT EXISTS attempts_subscription_idx ON attempts (provider, subscription_id);
  `);

  // Поля оплаты сливаются через COALESCE: повторная выгрузка без инвойса не стирает уже известную оплату.
  // Неудачная первая попытка необратима: события Stripe приходят в любом порядке, а ручная оплата
  // после отказа выглядит как успешный инвойс с attempt_count = 1.
  const upsert = db.prepare(`
    INSERT INTO trials (provider, account, subscription_id, trial_started_at, trial_ended_at,
                        first_invoice_id, first_attempt_succeeded, paid_at, country, payment_method, card_brand, bank, synced_at)
    VALUES (@provider, @account, @subscription_id, @trial_started_at, @trial_ended_at,
            @first_invoice_id, @first_attempt_succeeded, @paid_at, @country, @payment_method, @card_brand, @bank, @synced_at)
    ON CONFLICT (provider, subscription_id) DO UPDATE SET
      account = excluded.account,
      trial_started_at = excluded.trial_started_at,
      trial_ended_at = excluded.trial_ended_at,
      first_invoice_id = COALESCE(excluded.first_invoice_id, trials.first_invoice_id),
      first_attempt_succeeded = CASE WHEN trials.first_attempt_succeeded = 0 THEN 0
                                     ELSE COALESCE(excluded.first_attempt_succeeded, trials.first_attempt_succeeded) END,
      paid_at = COALESCE(excluded.paid_at, trials.paid_at),
      country = COALESCE(excluded.country, trials.country),
      payment_method = COALESCE(excluded.payment_method, trials.payment_method),
      card_brand = COALESCE(excluded.card_brand, trials.card_brand),
      bank = COALESCE(excluded.bank, trials.bank),
      synced_at = excluded.synced_at
  `);
  // Данные карты из отдельного источника (заказы Solidgate) — заполняют только пустые поля
  const updateCardDetails = db.prepare(`
    UPDATE trials SET country = COALESCE(country, @country), payment_method = COALESCE(payment_method, @payment_method),
                      card_brand = COALESCE(card_brand, @card_brand), bank = COALESCE(bank, @bank)
    WHERE provider = @provider AND subscription_id = @subscription_id
  `);
  // Попытка: результат обновляется, причина и рефанд не стираются
  const upsertAttemptStmt = db.prepare(`
    INSERT INTO attempts (provider, attempt_id, subscription_id, attempted_at, approved, reason, refunded)
    VALUES (@provider, @attempt_id, @subscription_id, @attempted_at, @approved, @reason, @refunded)
    ON CONFLICT (provider, attempt_id) DO UPDATE SET
      subscription_id = excluded.subscription_id,
      attempted_at = excluded.attempted_at,
      approved = excluded.approved,
      reason = COALESCE(excluded.reason, attempts.reason),
      refunded = MAX(excluded.refunded, attempts.refunded)
  `);
  const selectByInvoice = db.prepare('SELECT subscription_id FROM trials WHERE provider = ? AND first_invoice_id = ?');
  const selectTrial = db.prepare('SELECT * FROM trials WHERE provider = ? AND subscription_id = ?');
  const selectState = db.prepare('SELECT value FROM sync_state WHERE provider = ? AND account = ? AND key = ?');
  const upsertState = db.prepare(`
    INSERT INTO sync_state (provider, account, key, value) VALUES (?, ?, ?, ?)
    ON CONFLICT (provider, account, key) DO UPDATE SET value = excluded.value
  `);

  return {
    db,

    upsertTrial(row: TrialRow, now = nowSec()): void {
      // node:sqlite не принимает лишние именованные параметры и boolean — передаём ровно колонки
      upsert.run({
        provider: row.provider,
        account: row.account,
        subscription_id: row.subscription_id,
        trial_started_at: row.trial_started_at,
        trial_ended_at: row.trial_ended_at,
        first_invoice_id: row.first_invoice_id,
        first_attempt_succeeded: row.first_attempt_succeeded === null ? null : Number(row.first_attempt_succeeded),
        paid_at: row.paid_at,
        country: row.country,
        payment_method: row.payment_method,
        card_brand: row.card_brand,
        bank: row.bank,
        synced_at: now,
      });
    },

    setCardDetails(provider: Provider, subscriptionId: string, details: CardDetails): void {
      updateCardDetails.run({ provider, subscription_id: subscriptionId, ...details });
    },

    upsertAttempt(a: AttemptRow): void {
      upsertAttemptStmt.run({ ...a, approved: Number(a.approved), refunded: Number(a.refunded) });
    },

    // Причина отказа из отдельного источника (заказы Solidgate) и рефанды (Stripe refunds) — по id попытки
    setAttemptReason(provider: Provider, attemptId: string, reason: string): void {
      db.prepare('UPDATE attempts SET reason = COALESCE(reason, ?) WHERE provider = ? AND attempt_id = ?').run(reason, provider, attemptId);
    },

    markRefunded(provider: Provider, attemptId: string): void {
      db.prepare('UPDATE attempts SET refunded = 1 WHERE provider = ? AND attempt_id = ?').run(provider, attemptId);
    },

    subscriptionByFirstInvoice(provider: Provider, invoiceId: string): string | null {
      const r = selectByInvoice.get(provider, invoiceId) as { subscription_id: string } | undefined;
      return r?.subscription_id ?? null;
    },

    getAttempts(provider: Provider, subscriptionId: string): AttemptRow[] {
      const rows = db
        .prepare('SELECT * FROM attempts WHERE provider = ? AND subscription_id = ? ORDER BY attempted_at')
        .all(provider, subscriptionId) as unknown as (Omit<AttemptRow, 'approved' | 'refunded'> & { approved: number; refunded: number })[];
      return rows.map((r) => ({ ...r, approved: r.approved === 1, refunded: r.refunded === 1 }));
    },

    getTrial(provider: Provider, subscriptionId: string): TrialRow | null {
      const r = selectTrial.get(provider, subscriptionId) as
        | (Omit<TrialRow, 'first_attempt_succeeded'> & { first_attempt_succeeded: number | null })
        | undefined;
      if (!r) return null;
      return {
        provider: r.provider,
        account: r.account,
        subscription_id: r.subscription_id,
        trial_started_at: r.trial_started_at,
        trial_ended_at: r.trial_ended_at,
        first_invoice_id: r.first_invoice_id,
        first_attempt_succeeded: r.first_attempt_succeeded === null ? null : r.first_attempt_succeeded === 1,
        paid_at: r.paid_at,
        country: r.country,
        payment_method: r.payment_method,
        card_brand: r.card_brand,
        bank: r.bank,
      };
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
      db.prepare('UPDATE sync_runs SET status = ?, items = ?, error = ?, finished_at = ? WHERE id = ?').run(
        status,
        items,
        error,
        now,
        id,
      );
    },

    failStaleRuns(now = nowSec()): void {
      db.prepare(
        `UPDATE sync_runs SET status = 'error', error = 'процесс остановился во время синка', finished_at = ?
         WHERE status = 'running'`,
      ).run(now);
    },

    latestRuns(): LatestRun[] {
      const rows = db
        .prepare(
          `SELECT r.provider, r.account, r.status AS last_status, r.error AS last_error,
                  (SELECT MAX(s.finished_at) FROM sync_runs s
                    WHERE s.provider = r.provider AND s.account = r.account AND s.status = 'ok') AS last_success_at
           FROM sync_runs r
           WHERE r.id IN (SELECT MAX(id) FROM sync_runs GROUP BY provider, account)
           ORDER BY r.provider, r.account`,
        )
        .all() as unknown as LatestRun[];
      return rows.map((r) => ({ ...r }));
    },
  };
}
