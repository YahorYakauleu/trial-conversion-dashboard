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
        synced_at: now,
      });
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
