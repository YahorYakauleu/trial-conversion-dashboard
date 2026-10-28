import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { bankName, openStore, type TrialRow } from '../src/db.js';

const row: TrialRow = {
  provider: 'stripe',
  account: 'org',
  subscription_id: 'sub_1',
  trial_started_at: 1_000,
  trial_ended_at: 2_000,
  first_invoice_id: null,
  first_attempt_succeeded: null,
  paid_at: null,
  country: null,
  payment_method: null,
  card_brand: null,
  bank: null,
  mid: null,
};

describe('Store', () => {
  it('upsert идемпотентен и не затирает данные об оплате пустыми значениями', () => {
    const store = openStore(':memory:');
    store.upsertTrial({ ...row, first_invoice_id: 'in_1', first_attempt_succeeded: false, paid_at: 3_000, customer_id: 'cus_1' });
    store.upsertTrial(row); // повторная выгрузка подписки без инвойса и клиента
    expect(store.getTrial('stripe', 'sub_1')).toEqual({
      ...row,
      first_invoice_id: 'in_1',
      first_attempt_succeeded: false,
      paid_at: 3_000,
      customer_id: 'cus_1',
      canceled_at: null,
      cancel_reason: null,
      funding: null,
    });
    expect(store.countTrials()).toBe(1);
  });

  it('новое непустое значение перезаписывает старое', () => {
    const store = openStore(':memory:');
    store.upsertTrial({ ...row, first_invoice_id: 'in_1', first_attempt_succeeded: null });
    store.upsertTrial({ ...row, first_invoice_id: 'in_1', first_attempt_succeeded: true, paid_at: 2_100 });
    expect(store.getTrial('stripe', 'sub_1')?.first_attempt_succeeded).toBe(true);
  });

  it('«первая попытка не удалась» необратимо — порядок событий не важен', () => {
    const store = openStore(':memory:');
    store.upsertTrial({ ...row, first_invoice_id: 'in_1', first_attempt_succeeded: false });
    store.upsertTrial({ ...row, first_invoice_id: 'in_1', first_attempt_succeeded: true, paid_at: 2_500 });
    expect(store.getTrial('stripe', 'sub_1')).toMatchObject({ first_attempt_succeeded: false, paid_at: 2_500 });
  });

  it('данные карты: известные не стираются пустыми; setCardDetails заполняет только пустые поля', () => {
    const store = openStore(':memory:');
    store.upsertTrial({ ...row, country: 'US', payment_method: 'apple_pay' });
    store.upsertTrial(row);
    store.setCardDetails('stripe', 'sub_1', { country: 'GB', payment_method: 'google_pay', card_brand: 'visa', bank: 'Revolut' });
    expect(store.getTrial('stripe', 'sub_1')).toMatchObject({
      country: 'US',
      payment_method: 'apple_pay',
      card_brand: 'visa',
      bank: 'REVOLUT',
    });
  });

  it('банк — в одном написании: заглавными, без точек и запятых; записанный раньше приводится к нему при открытии', () => {
    expect(bankName('Al Rajhi Banking and Investment Corp.')).toBe(bankName('AL RAJHI BANKING AND INVESTMENT CORP'));
    expect(bankName('Banco de Crédito Social Cooperativo, S.A.')).toBe('BANCO DE CRÉDITO SOCIAL COOPERATIVO SA');
    expect(bankName('DANSKE BANK  A/S ')).toBe('DANSKE BANK A/S');
    expect([bankName(null), bankName(' . ')]).toEqual([null, null]);

    const store = openStore(':memory:');
    store.upsertTrial({ ...row, bank: 'ABN AMRO Bank N.V.' });
    const payment = { provider: 'stripe' as const, account: 'corp', mid: 'corp', paid_at: 1_000, amount_usd_cents: 999, refunded_usd_cents: 0, country: 'US', payment_method: 'card', card_brand: 'visa' };
    store.upsertPayment({ ...payment, payment_id: 'ch_1', bank: 'Revolut Ltd.' });
    store.setPaymentDetails('stripe', 'ch_1', { customer_id: 'cus_1', bank: 'Other bank' }); // известный банк не трогаем
    expect(store.db.prepare('SELECT customer_id, bank FROM payments').get()).toEqual({ customer_id: 'cus_1', bank: 'REVOLUT LTD' });

    // строки, записанные до общего написания (в обход store), — при следующем открытии базы
    const file = `/tmp/trial-dashboard-banks-${process.pid}.sqlite`;
    const old = openStore(file);
    old.db.prepare("INSERT INTO payments (provider, payment_id, account, paid_at, amount_usd_cents, bank) VALUES ('stripe', 'ch_2', 'corp', 1, 1, 'Revolut Ltd.')").run();
    old.db.close();
    const reopened = openStore(file);
    expect(reopened.db.prepare('SELECT bank FROM payments').get()).toEqual({ bank: 'REVOLUT LTD' });
    reopened.db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  });

  it('попытки: upsert идемпотентен, причина и рефанд не стираются, поиск триала по первому инвойсу', () => {
    const store = openStore(':memory:');
    store.upsertTrial({ ...row, first_invoice_id: 'in_1' });
    const attempt = {
      provider: 'stripe' as const,
      attempt_id: 'ch_1',
      subscription_id: 'sub_1',
      attempted_at: 2_000,
      approved: false,
      reason: 'insufficient_funds',
      refunded: false,
    };
    store.upsertAttempt(attempt);
    store.upsertAttempt({ ...attempt, reason: null });
    store.upsertAttempt({ ...attempt, attempt_id: 'ch_2', attempted_at: 3_000, approved: true, reason: null });
    store.markRefunded('stripe', 'ch_2');
    store.upsertAttempt({ ...attempt, attempt_id: 'ch_2', attempted_at: 3_000, approved: true, reason: null });
    expect(store.getAttempts('stripe', 'sub_1')).toEqual([
      { ...attempt },
      { ...attempt, attempt_id: 'ch_2', attempted_at: 3_000, approved: true, reason: null, refunded: true },
    ]);
    store.setAttemptReason('stripe', 'ch_2', 'whatever');
    expect(store.getAttempts('stripe', 'sub_1')[1].reason).toBe('whatever');
    expect(store.subscriptionByFirstInvoice('stripe', 'in_1')).toBe('sub_1');
    expect(store.subscriptionByFirstInvoice('stripe', 'in_x')).toBeNull();
  });

  it('рядом с unix-секундами есть читаемые даты (UTC) — для просмотра базы глазами', () => {
    const store = openStore(':memory:');
    store.upsertTrial({ ...row, trial_started_at: 1788393385, trial_ended_at: 1788393385 + 7 * 86_400, paid_at: null }, 1788393385);
    store.upsertAttempt({ provider: 'stripe', attempt_id: 'ch_1', subscription_id: 'sub_1', attempted_at: 1788393385, approved: true, reason: null, refunded: false });
    store.finishRun(store.startRun('stripe', 'org', 'daily', 1788393385), 'ok', 1, null, 1788393445);
    store.setState('stripe', 'org', 'cursor', 1788393385);
    store.setState('stripe', 'org', 'details_version', 2);
    const one = (sql: string) => ({ ...(store.db.prepare(sql).get() as object) });
    expect(one('SELECT trial_started_utc, trial_ended_utc, paid_utc, synced_utc FROM trials')).toEqual({
      trial_started_utc: '2026-09-02 23:56:25',
      trial_ended_utc: '2026-09-09 23:56:25',
      paid_utc: null,
      synced_utc: '2026-09-02 23:56:25',
    });
    expect(one('SELECT attempted_utc FROM attempts')).toEqual({ attempted_utc: '2026-09-02 23:56:25' });
    expect(one('SELECT started_utc, finished_utc FROM sync_runs')).toEqual({ started_utc: '2026-09-02 23:56:25', finished_utc: '2026-09-02 23:57:25' });
    expect(store.db.prepare('SELECT key, value_utc FROM sync_state ORDER BY key').all().map((r) => ({ ...r }))).toEqual([
      { key: 'cursor', value_utc: '2026-09-02 23:56:25' },
      { key: 'details_version', value_utc: null }, // не время — даты нет
    ]);
    // в объектах приложения вычисляемых колонок нет
    expect(Object.keys(store.getAttempts('stripe', 'sub_1')[0])).not.toContain('attempted_utc');
  });

  it('старая база без колонок карты получает их при открытии', () => {
    const file = `/tmp/trial-dashboard-migration-${process.pid}.sqlite`;
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE trials (provider TEXT NOT NULL, account TEXT NOT NULL, subscription_id TEXT NOT NULL,
      trial_started_at INTEGER NOT NULL, trial_ended_at INTEGER NOT NULL, first_invoice_id TEXT, first_attempt_succeeded INTEGER,
      paid_at INTEGER, synced_at INTEGER NOT NULL, PRIMARY KEY (provider, subscription_id))`);
    legacy.close();
    const store = openStore(file);
    store.upsertTrial({ ...row, bank: 'Capitec' });
    expect(store.getTrial('stripe', 'sub_1')?.bank).toBe('CAPITEC');
    expect(({ ...(store.db.prepare('SELECT trial_started_utc FROM trials').get() as object) })).toEqual({ trial_started_utc: '1970-01-01 00:16:40' });
    store.db.close();
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  });

  it('база без платы за триал получает колонку, и LTV пересчитывается целиком — иначе тип триала у старых триалов не появится', () => {
    const file = `/tmp/trial-dashboard-trial-fee-${process.pid}.sqlite`;
    const before = openStore(file);
    before.upsertTrial(row);
    before.db.exec('UPDATE trials SET ltv_at = 123; ALTER TABLE trials DROP COLUMN trial_fee');
    before.db.close();
    const store = openStore(file);
    expect({ ...(store.db.prepare('SELECT trial_fee, ltv_at FROM trials').get() as object) }).toEqual({ trial_fee: 0, ltv_at: null });
    store.db.close();
    for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
  });

  it('getTrial возвращает null для неизвестной подписки', () => {
    expect(openStore(':memory:').getTrial('stripe', 'nope')).toBeNull();
  });

  it('хранит курсоры', () => {
    const store = openStore(':memory:');
    expect(store.getState('stripe', 'org', 'cursor')).toBeNull();
    store.setState('stripe', 'org', 'cursor', 123);
    store.setState('stripe', 'org', 'cursor', 456);
    expect(store.getState('stripe', 'org', 'cursor')).toBe(456);
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
    expect(store.latestRuns()[0]).toMatchObject({
      last_status: 'error',
      last_error: 'process stopped during sync',
    });
  });

  it('итоги попыток лежат в строке триала: попытки, успешные, рефанд — обновляются вместе с попытками', () => {
    const store = openStore(':memory:');
    store.upsertTrial(row);
    const attempt = { provider: 'stripe' as const, subscription_id: 'sub_1', attempted_at: 2_100, reason: null, refunded: false };
    store.upsertAttempt({ ...attempt, attempt_id: 'ch_1', approved: false });
    store.upsertAttempt({ ...attempt, attempt_id: 'ch_2', approved: true });
    const totals = () => store.db.prepare('SELECT attempts, approved, refunded FROM trials').get();
    expect(totals()).toEqual({ attempts: 2, approved: 1, refunded: 0 });
    store.markRefunded('stripe', 'ch_2');
    expect(totals()).toEqual({ attempts: 2, approved: 1, refunded: 1 });
  });

  it('база до итогов попыток и MID: колонки добавляются, итоги и MID Stripe заполняются при открытии', () => {
    const file = `${import.meta.dirname}/old-schema.sqlite`;
    rmSync(file, { force: true });
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE trials (provider TEXT NOT NULL, account TEXT NOT NULL, subscription_id TEXT NOT NULL, trial_started_at INTEGER NOT NULL,
        trial_ended_at INTEGER NOT NULL, first_invoice_id TEXT, first_attempt_succeeded INTEGER, paid_at INTEGER, synced_at INTEGER NOT NULL,
        country TEXT, payment_method TEXT, card_brand TEXT, bank TEXT, PRIMARY KEY (provider, subscription_id));
      CREATE TABLE attempts (provider TEXT NOT NULL, attempt_id TEXT NOT NULL, subscription_id TEXT NOT NULL, attempted_at INTEGER NOT NULL,
        approved INTEGER NOT NULL, reason TEXT, refunded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (provider, attempt_id));
      INSERT INTO trials (provider, account, subscription_id, trial_started_at, trial_ended_at, synced_at) VALUES ('stripe', 'corp', 'sub_1', 1000, 2000, 0);
      INSERT INTO trials (provider, account, subscription_id, trial_started_at, trial_ended_at, synced_at) VALUES ('solidgate', 'sgH2H', 'sg_1', 1000, 2000, 0);
      INSERT INTO attempts VALUES ('stripe', 'ch_1', 'sub_1', 2100, 0, 'do_not_honor', 0), ('stripe', 'ch_2', 'sub_1', 2200, 1, NULL, 1);
    `);
    old.close();
    try {
      const store = openStore(file);
      expect(store.db.prepare('SELECT subscription_id, mid, attempts, approved, refunded FROM trials ORDER BY provider DESC').all()).toEqual([
        { subscription_id: 'sub_1', mid: 'corp', attempts: 2, approved: 1, refunded: 1 },
        { subscription_id: 'sg_1', mid: null, attempts: 0, approved: 0, refunded: 0 },
      ]);
      store.db.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
    }
  });
});
