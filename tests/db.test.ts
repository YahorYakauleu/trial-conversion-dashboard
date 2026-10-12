import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openStore, type TrialRow } from '../src/db.js';

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
};

describe('Store', () => {
  it('upsert идемпотентен и не затирает данные об оплате пустыми значениями', () => {
    const store = openStore(':memory:');
    store.upsertTrial({ ...row, first_invoice_id: 'in_1', first_attempt_succeeded: false, paid_at: 3_000 });
    store.upsertTrial(row); // повторная выгрузка подписки без инвойса
    expect(store.getTrial('stripe', 'sub_1')).toEqual({
      ...row,
      first_invoice_id: 'in_1',
      first_attempt_succeeded: false,
      paid_at: 3_000,
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
      bank: 'Revolut',
    });
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

  it('старая база без колонок карты получает их при открытии', () => {
    const file = `/tmp/trial-dashboard-migration-${process.pid}.sqlite`;
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE trials (provider TEXT NOT NULL, account TEXT NOT NULL, subscription_id TEXT NOT NULL,
      trial_started_at INTEGER NOT NULL, trial_ended_at INTEGER NOT NULL, first_invoice_id TEXT, first_attempt_succeeded INTEGER,
      paid_at INTEGER, synced_at INTEGER NOT NULL, PRIMARY KEY (provider, subscription_id))`);
    legacy.close();
    const store = openStore(file);
    store.upsertTrial({ ...row, bank: 'Capitec' });
    expect(store.getTrial('stripe', 'sub_1')?.bank).toBe('Capitec');
    store.db.close();
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
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
      last_error: 'процесс остановился во время синка',
    });
  });
});
