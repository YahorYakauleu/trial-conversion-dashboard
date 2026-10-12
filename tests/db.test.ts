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

  it('страна: известная не стирается пустой; setCountry — только если страны ещё нет', () => {
    const store = openStore(':memory:');
    store.upsertTrial({ ...row, country: 'US' });
    store.upsertTrial(row);
    expect(store.getTrial('stripe', 'sub_1')?.country).toBe('US');
    expect(store.setCountry('stripe', 'sub_1', 'GB')).toBe(false);
    store.upsertTrial({ ...row, subscription_id: 'sub_2' });
    expect(store.setCountry('stripe', 'sub_2', 'GB')).toBe(true);
    expect(store.getTrial('stripe', 'sub_2')?.country).toBe('GB');
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
