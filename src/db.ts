import { DatabaseSync } from 'node:sqlite';
import { NO_RETRY_CODES } from './declines.js';

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
  bank: string | null; // банк-эмитент — в одном написании (bankName)
  mid: string | null; // Stripe — аккаунт; Solidgate — MID, на котором оформлен триал (через него идут и все списания)
  customer_id?: string | null; // Stripe — клиент (cus_…), Solidgate — customer_account_id (id аккаунта у нас) — для выгрузки
  // Отмена подписки: когда попросили отменить (в том числе «в конце периода») и почему —
  // Stripe: cancellation_requested | payment_failed | payment_disputed, Solidgate: код отмены (8.06 и т. п.)
  canceled_at?: number | null;
  cancel_reason?: string | null;
  funding?: string | null; // тип карты: credit, debit, prepaid
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

// Успешный платёж для оборота: любое списание (первые платежи, продления, разовые), суммы — в центах USD
export interface PaymentRow extends CardDetails {
  provider: Provider;
  payment_id: string; // Stripe charge / Solidgate order
  account: string;
  mid: string | null; // Stripe — аккаунт; Solidgate — MID из заказа
  paid_at: number;
  amount_usd_cents: number;
  refunded_usd_cents: number;
  customer_id?: string | null; // клиент — чтобы связать продления с триалом (LTV)
}

// Списание eSIM: у продукта нет подписок — только разовые покупки (PaymentIntent), поэтому храним и отклонённые
// списания (approved = false, для платёжного здоровья), и то, что купили: направление, пакет, тип заказа, клиента
export interface EsimChargeRow extends Omit<PaymentRow, 'customer_id'> {
  approved: boolean;
  reason: string | null; // код отказа
  intent_id: string | null; // PaymentIntent — одна оплата, в ней может быть несколько попыток
  customer_id: string | null;
  destination: string | null; // страна или регион пакета: «Spain»
  package: string | null; // «5 GB · 7 days»
  order_type: string | null; // purchase | topup
}

// Событие для Visa VAMP: фрод-репорт (TC40 — Stripe early fraud warning, Solidgate fraud alert) или диспут (TC15).
// Храним все сети, в VAMP идут только прошедшие через сеть Visa: фрод-репорты и чарджбэки, не закрытые через RDR.
// Поля карты у Solidgate пустые — берутся из платежа (payments) по ID заказа
export interface VampReportRow {
  provider: Provider;
  report_id: string; // Stripe issfr_… / du_…, Solidgate — id алерта или чарджбэка
  account: string;
  mid: string | null; // Stripe — аккаунт; Solidgate — из платежа
  kind: 'fraud' | 'dispute';
  reported_at: number; // когда пришёл к провайдеру — по этой дате событие попадает в месяц
  payment_id: string | null; // Stripe charge / Solidgate order
  charged_at: number | null; // когда было само списание
  // сеть, через которую прошло списание (visa, mastercard, cartes_bancaires, pulse…) — не бренд: французская Visa/CB
  // может пройти через Cartes Bancaires, и тогда в VAMP не идёт. У Solidgate — схема карты
  network: string | null;
  country: string | null;
  payment_method: string | null;
  customer_id: string | null;
  risk_score: number | null; // Stripe Radar, 0–99
  reason: string | null; // тип фрода или причина диспута
  case_type: string | null; // у диспута: chargeback | inquiry
  rdr: boolean; // диспут закрыт через Visa RDR — в VAMP не считается
  lost_usd_cents: number; // сколько списано по RDR-диспуту
  amount_usd_cents: number | null; // сумма списания в долларах, если известна (у платежей дашборда — из payments)
  refunded: boolean; // по списанию вернули деньги (на момент загрузки; рефанды потом дописываются)
}

export interface LatestRun {
  provider: Provider;
  account: string;
  last_status: RunStatus;
  last_error: string | null;
  last_success_at: number | null;
}

export type Db = DatabaseSync;

// Читаемые даты (UTC) рядом с unix-секундами — чтобы базу можно было смотреть глазами (DBeaver и т.п.).
// Вычисляемые колонки: места не занимают, в коде приложения не используются.
const READABLE_DATES: [table: string, column: string, expression: string][] = [
  ['trials', 'trial_started_utc', "datetime(trial_started_at, 'unixepoch')"],
  ['trials', 'trial_ended_utc', "datetime(trial_ended_at, 'unixepoch')"],
  ['trials', 'paid_utc', "datetime(paid_at, 'unixepoch')"],
  ['trials', 'synced_utc', "datetime(synced_at, 'unixepoch')"],
  ['attempts', 'attempted_utc', "datetime(attempted_at, 'unixepoch')"],
  ['payments', 'paid_utc', "datetime(paid_at, 'unixepoch')"],
  ['sync_runs', 'started_utc', "datetime(started_at, 'unixepoch')"],
  ['sync_runs', 'finished_utc', "datetime(finished_at, 'unixepoch')"],
  // в sync_state лежат и моменты времени (курсоры), и просто числа (версия данных) — дату показываем только для первых
  ['sync_state', 'value_utc', "CASE WHEN value > 1000000000 THEN datetime(value, 'unixepoch') END"],
];
export type Store = ReturnType<typeof openStore>;

export const nowSec = () => Math.floor(Date.now() / 1000);

// Один банк провайдеры пишут по-разному: «Al Rajhi Banking and Investment Corp.» у Stripe, «AL RAJHI BANKING AND INVESTMENT CORP»
// у Solidgate, «ABN AMRO BANK N.V» и «ABN AMRO BANK NV». Храним одно написание: заглавными, без точек и запятых
export function bankName(raw: string | null | undefined): string | null {
  return raw?.toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim() || null;
}

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
  // Колонки, появившиеся позже, — добавляем в уже существующую базу
  const columns = new Set((db.prepare('PRAGMA table_info(trials)').all() as { name: string }[]).map((c) => c.name));
  for (const column of ['country', 'payment_method', 'card_brand', 'bank', 'mid', 'customer_id', 'cancel_reason', 'funding']) {
    if (!columns.has(column)) db.exec(`ALTER TABLE trials ADD COLUMN ${column} TEXT`);
  }
  if (!columns.has('mid')) db.exec(`UPDATE trials SET mid = account WHERE provider = 'stripe'`);
  if (!columns.has('canceled_at')) db.exec('ALTER TABLE trials ADD COLUMN canceled_at INTEGER');
  // Фрод по клиенту триала — пересчитывается после загрузки событий VAMP (src/vamp.ts → refreshTrialFraud):
  // был ли фрод-репорт или чарджбэк (любая сеть) и сколько событий клиент добавил в Visa VAMP
  for (const column of ['fraud_flagged', 'vamp_events']) {
    if (!columns.has(column)) db.exec(`ALTER TABLE trials ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
  // Деньги от клиента триала за 30/60/90 дней с оформления (центы USD, за вычетом рефандов) и сколько периодов он оплатил
  // за 90 дней — пересчитываются после загрузки платежей (src/ltv.ts → refreshTrialLtv); ltv_at — когда посчитано
  for (const column of ['ltv_30', 'ltv_60', 'ltv_90', 'periods_90']) {
    if (!columns.has(column)) db.exec(`ALTER TABLE trials ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columns.has('ltv_at')) db.exec('ALTER TABLE trials ADD COLUMN ltv_at INTEGER');
  // Сумма первого платежа после триала (цена первого периода в долларах) — появилась позже: LTV один раз пересчитывается целиком
  if (!columns.has('first_payment')) {
    db.exec('ALTER TABLE trials ADD COLUMN first_payment INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE trials SET ltv_at = NULL');
  }
  // Итоги попыток прямо в строке триала: метрики считаются одним проходом по trials, без соединения с attempts
  const withoutAttemptTotals = !columns.has('attempts');
  for (const column of ['attempts', 'approved', 'refunded']) {
    if (!columns.has(column)) db.exec(`ALTER TABLE trials ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS trials_started_idx ON trials (trial_started_at);
    -- период задаётся по провайдеру (у каждого свои сутки) — без этого индекса SQLite читает триалы вразнобой
    CREATE INDEX IF NOT EXISTS trials_provider_started_idx ON trials (provider, trial_started_at);
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
    CREATE TABLE IF NOT EXISTS payments (
      provider TEXT NOT NULL,
      payment_id TEXT NOT NULL,
      account TEXT NOT NULL,
      mid TEXT,
      paid_at INTEGER NOT NULL,
      amount_usd_cents INTEGER NOT NULL,
      refunded_usd_cents INTEGER NOT NULL DEFAULT 0,
      country TEXT,
      payment_method TEXT,
      card_brand TEXT,
      bank TEXT,
      PRIMARY KEY (provider, payment_id)
    );
    CREATE INDEX IF NOT EXISTS payments_paid_idx ON payments (paid_at);
    CREATE INDEX IF NOT EXISTS payments_provider_paid_idx ON payments (provider, paid_at);
    -- курсы валют к доллару за день (JSON {валюта: сколько её за 1 USD}), чтобы не запрашивать повторно
    CREATE TABLE IF NOT EXISTS fx_rates (
      day TEXT PRIMARY KEY,
      rates TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vamp_reports (
      provider TEXT NOT NULL,
      report_id TEXT NOT NULL,
      account TEXT NOT NULL,
      mid TEXT,
      kind TEXT NOT NULL,
      reported_at INTEGER NOT NULL,
      payment_id TEXT,
      charged_at INTEGER,
      network TEXT,
      country TEXT,
      payment_method TEXT,
      customer_id TEXT,
      risk_score INTEGER,
      reason TEXT,
      case_type TEXT,
      rdr INTEGER NOT NULL DEFAULT 0,
      lost_usd_cents INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider, report_id)
    );
    CREATE INDEX IF NOT EXISTS vamp_reports_reported_idx ON vamp_reports (reported_at);
  `);
  const vampTableColumns = new Set((db.prepare('PRAGMA table_info(vamp_reports)').all() as { name: string }[]).map((c) => c.name));
  if (!vampTableColumns.has('amount_usd_cents')) db.exec('ALTER TABLE vamp_reports ADD COLUMN amount_usd_cents INTEGER');
  if (!vampTableColumns.has('refunded')) db.exec('ALTER TABLE vamp_reports ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE INDEX IF NOT EXISTS vamp_reports_customer_idx ON vamp_reports (provider, customer_id) WHERE customer_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS vamp_reports_payment_idx ON vamp_reports (provider, payment_id);
  `);
  // Триалы и платежи клиента по времени — для пересчёта фрода и LTV по триалам (src/vamp.ts, src/ltv.ts).
  // Частичный индекс по клиенту планировщик в коррелированных подзапросах не выбирал — заменён полным
  db.exec(`
    DROP INDEX IF EXISTS trials_customer_idx;
    CREATE INDEX IF NOT EXISTS trials_customer_started_idx ON trials (provider, customer_id, trial_started_at);
  `);
  // Платежи eSIM — в той же таблице (product = 'esim'), вместе с отклонёнными списаниями (approved = 0);
  // у VPN в payments только успешные списания
  const paymentColumns = new Set((db.prepare('PRAGMA table_info(payments)').all() as { name: string }[]).map((c) => c.name));
  if (!paymentColumns.has('product')) db.exec(`ALTER TABLE payments ADD COLUMN product TEXT NOT NULL DEFAULT 'vpn'`);
  if (!paymentColumns.has('approved')) db.exec('ALTER TABLE payments ADD COLUMN approved INTEGER NOT NULL DEFAULT 1');
  for (const column of ['reason', 'intent_id', 'customer_id', 'destination', 'package', 'order_type']) {
    if (!paymentColumns.has(column)) db.exec(`ALTER TABLE payments ADD COLUMN ${column} TEXT`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS payments_product_paid_idx ON payments (product, paid_at);
    CREATE INDEX IF NOT EXISTS payments_customer_idx ON payments (customer_id) WHERE customer_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS payments_customer_paid_idx ON payments (provider, customer_id, paid_at); -- LTV по триалам
    -- покрывающий для Visa-продаж VAMP: счёт по месяцам и мерчантам без чтения таблицы
    CREATE INDEX IF NOT EXISTS payments_sales_idx ON payments (product, card_brand, paid_at, provider, mid);
  `);
  // Пересчёт итогов попыток одного триала (или всех — для базы, выгруженной до появления колонок)
  const attemptTotals = `(SELECT COUNT(*), COALESCE(SUM(a.approved), 0), COALESCE(MAX(a.refunded), 0)
     FROM attempts a WHERE a.provider = trials.provider AND a.subscription_id = trials.subscription_id)`;
  if (withoutAttemptTotals) {
    db.exec(`UPDATE trials SET (attempts, approved, refunded) = ${attemptTotals}
             WHERE EXISTS (SELECT 1 FROM attempts a WHERE a.provider = trials.provider AND a.subscription_id = trials.subscription_id)`);
  }
  const refreshAttemptTotals = db.prepare(
    `UPDATE trials SET (attempts, approved, refunded) = ${attemptTotals} WHERE provider = ? AND subscription_id = ?`,
  );

  // Порядок попыток подписки — хранится у попытки, чтобы экраны не нумеровали попытки при каждом запросе (Retries,
  // причины отказа): номер попытки, время первой, был ли раньше отказ «не повторять», прошла ли следующая и любая дальнейшая.
  // Пересчитывается при записи попытки — для её подписки; база без этих колонок пересчитывается целиком один раз
  const attemptColumns = new Set((db.prepare('PRAGMA table_info(attempts)').all() as { name: string }[]).map((c) => c.name));
  const withoutSequence = !attemptColumns.has('n');
  if (withoutSequence) {
    for (const column of ['n', 'first_at', 'next_approved']) db.exec(`ALTER TABLE attempts ADD COLUMN ${column} INTEGER`);
    for (const column of ['after_no_retry', 'approved_later']) db.exec(`ALTER TABLE attempts ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
  const sequence = (where: string) => `
    WITH s AS (
      SELECT provider, attempt_id,
             ROW_NUMBER() OVER w AS n,
             MIN(attempted_at) OVER (PARTITION BY provider, subscription_id) AS first_at,
             COALESCE(MAX(CASE WHEN approved = 0 AND reason IN (${NO_RETRY_CODES.map((c) => `'${c}'`).join(', ')}) THEN 1 ELSE 0 END)
                      OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS after_no_retry,
             LEAD(approved) OVER w AS next_approved,
             COALESCE(MAX(approved) OVER (w ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING), 0) AS approved_later
      FROM attempts WHERE ${where}
      WINDOW w AS (PARTITION BY provider, subscription_id ORDER BY attempted_at, attempt_id))
    UPDATE attempts SET n = s.n, first_at = s.first_at, after_no_retry = s.after_no_retry, next_approved = s.next_approved, approved_later = s.approved_later
    FROM s WHERE attempts.provider = s.provider AND attempts.attempt_id = s.attempt_id`;
  if (withoutSequence) db.exec(sequence('1 = 1'));
  // Покрывающий индекс: экраны с попытками (Retries, причины отказа) читают их из индекса, не трогая таблицу
  db.exec(`CREATE INDEX IF NOT EXISTS attempts_sequence_idx ON attempts
             (provider, subscription_id, n, approved, reason, attempted_at, first_at, after_no_retry, next_approved, approved_later, attempt_id)`);
  const refreshSequence = db.prepare(sequence('provider = @provider AND subscription_id = @subscription_id'));

  // Банки, записанные до появления общего написания, — приводим к нему (проверка всех строк — доли секунды)
  db.function('bank_name', { deterministic: true }, (raw) => bankName(raw as string | null));
  for (const table of ['trials', 'payments']) db.exec(`UPDATE ${table} SET bank = bank_name(bank) WHERE bank IS NOT bank_name(bank)`);

  for (const [table, column, expression] of READABLE_DATES) {
    // table_xinfo, а не table_info: вычисляемые колонки table_info не показывает
    const existing = (db.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string }[]).some((c) => c.name === column);
    if (!existing) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT GENERATED ALWAYS AS (${expression}) VIRTUAL`);
  }

  // Поля оплаты сливаются через COALESCE: повторная выгрузка без инвойса не стирает уже известную оплату.
  // Неудачная первая попытка необратима: события Stripe приходят в любом порядке, а ручная оплата
  // после отказа выглядит как успешный инвойс с attempt_count = 1.
  const upsert = db.prepare(`
    INSERT INTO trials (provider, account, subscription_id, trial_started_at, trial_ended_at,
                        first_invoice_id, first_attempt_succeeded, paid_at, country, payment_method, card_brand, bank, mid, customer_id,
                        canceled_at, cancel_reason, funding, synced_at)
    VALUES (@provider, @account, @subscription_id, @trial_started_at, @trial_ended_at,
            @first_invoice_id, @first_attempt_succeeded, @paid_at, @country, @payment_method, @card_brand, @bank, @mid, @customer_id,
            @canceled_at, @cancel_reason, @funding, @synced_at)
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
      mid = COALESCE(excluded.mid, trials.mid),
      customer_id = COALESCE(excluded.customer_id, trials.customer_id),
      funding = COALESCE(excluded.funding, trials.funding),
      -- отмену подписка знает сама и может её снять (пользователь передумал) — берём как есть
      canceled_at = excluded.canceled_at,
      cancel_reason = excluded.cancel_reason,
      synced_at = excluded.synced_at
  `);
  // Данные карты из отдельного источника (заказы Solidgate) — заполняют только пустые поля
  const updateCardDetails = db.prepare(`
    UPDATE trials SET country = COALESCE(country, @country), payment_method = COALESCE(payment_method, @payment_method),
                      card_brand = COALESCE(card_brand, @card_brand), bank = COALESCE(bank, @bank), mid = COALESCE(mid, @mid)
    WHERE provider = @provider AND subscription_id = @subscription_id
  `);
  const setFundingStmt = db.prepare('UPDATE trials SET funding = COALESCE(funding, ?) WHERE provider = ? AND subscription_id = ?');
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
  // Платёж: перевыгрузка обновляет всё, кроме рефанда — он только растёт
  const upsertPaymentStmt = db.prepare(`
    INSERT INTO payments (provider, payment_id, account, mid, paid_at, amount_usd_cents, refunded_usd_cents,
                          country, payment_method, card_brand, bank, customer_id)
    VALUES (@provider, @payment_id, @account, @mid, @paid_at, @amount_usd_cents, @refunded_usd_cents,
            @country, @payment_method, @card_brand, @bank, @customer_id)
    ON CONFLICT (provider, payment_id) DO UPDATE SET
      customer_id = COALESCE(excluded.customer_id, payments.customer_id),
      account = excluded.account,
      mid = excluded.mid,
      paid_at = excluded.paid_at,
      amount_usd_cents = excluded.amount_usd_cents,
      refunded_usd_cents = MAX(excluded.refunded_usd_cents, payments.refunded_usd_cents),
      country = excluded.country,
      payment_method = excluded.payment_method,
      card_brand = excluded.card_brand,
      bank = excluded.bank
  `);
  const upsertEsimChargeStmt = db.prepare(`
    INSERT INTO payments (provider, payment_id, account, mid, paid_at, amount_usd_cents, refunded_usd_cents,
                          country, payment_method, card_brand, bank,
                          product, approved, reason, intent_id, customer_id, destination, package, order_type)
    VALUES (@provider, @payment_id, @account, @mid, @paid_at, @amount_usd_cents, @refunded_usd_cents,
            @country, @payment_method, @card_brand, @bank,
            'esim', @approved, @reason, @intent_id, @customer_id, @destination, @package, @order_type)
    ON CONFLICT (provider, payment_id) DO UPDATE SET
      paid_at = excluded.paid_at,
      amount_usd_cents = excluded.amount_usd_cents,
      refunded_usd_cents = MAX(excluded.refunded_usd_cents, payments.refunded_usd_cents),
      country = excluded.country,
      payment_method = excluded.payment_method,
      card_brand = excluded.card_brand,
      bank = excluded.bank,
      approved = excluded.approved,
      reason = excluded.reason,
      intent_id = excluded.intent_id,
      customer_id = excluded.customer_id,
      destination = excluded.destination,
      package = excluded.package,
      order_type = excluded.order_type
  `);
  const vampColumns = ['provider', 'report_id', 'account', 'mid', 'kind', 'reported_at', 'payment_id', 'charged_at', 'network', 'country',
    'payment_method', 'customer_id', 'risk_score', 'reason', 'case_type', 'rdr', 'lost_usd_cents', 'amount_usd_cents', 'refunded'];
  // перевыгрузка обновляет всё, кроме рефанда — он только появляется
  const upsertVampStmt = db.prepare(`
    INSERT INTO vamp_reports (${vampColumns.join(', ')}) VALUES (${vampColumns.map((c) => `@${c}`).join(', ')})
    ON CONFLICT (provider, report_id) DO UPDATE SET
      ${vampColumns.slice(2).map((c) => (c === 'refunded' ? 'refunded = MAX(excluded.refunded, vamp_reports.refunded)' : `${c} = excluded.${c}`)).join(',\n      ')}
  `);
  const setCancellationStmt = db.prepare('UPDATE trials SET canceled_at = ?, cancel_reason = ? WHERE provider = ? AND subscription_id = ?');
  const setCustomerIdStmt = db.prepare('UPDATE trials SET customer_id = ? WHERE provider = ? AND subscription_id = ? AND customer_id IS NULL');
  const selectByInvoice = db.prepare('SELECT subscription_id FROM trials WHERE provider = ? AND first_invoice_id = ?');
  const selectTrial = db.prepare('SELECT * FROM trials WHERE provider = ? AND subscription_id = ?');
  const selectState = db.prepare('SELECT value FROM sync_state WHERE provider = ? AND account = ? AND key = ?');
  const upsertState = db.prepare(`
    INSERT INTO sync_state (provider, account, key, value) VALUES (?, ?, ?, ?)
    ON CONFLICT (provider, account, key) DO UPDATE SET value = excluded.value
  `);

  // Версия данных: растёт с каждым законченным синком — по ней сервер сбрасывает кэш ответов
  let dataVersion = 0;

  return {
    db,

    dataVersion: () => dataVersion,

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
        bank: bankName(row.bank),
        mid: row.mid ?? null,
        customer_id: row.customer_id ?? null,
        canceled_at: row.canceled_at ?? null,
        cancel_reason: row.cancel_reason ?? null,
        funding: row.funding ?? null,
        synced_at: now,
      });
    },

    // ID клиента для старых триалов (разовая догрузка): только пустые — сохранённый раньше не трогаем
    setCustomerId(provider: Provider, subscriptionId: string, customerId: string): void {
      setCustomerIdStmt.run(customerId, provider, subscriptionId);
    },

    // Отмена по свежему состоянию подписки (события Stripe, разовая догрузка) — только у уже известных триалов
    setCancellation(provider: Provider, subscriptionId: string, canceledAt: number | null, reason: string | null): void {
      setCancellationStmt.run(canceledAt, canceledAt === null ? null : reason, provider, subscriptionId);
    },

    // Тип карты из отдельного источника (заказы Solidgate, разовый проход подписок Stripe) — только если ещё не известен
    setFunding(provider: Provider, subscriptionId: string, funding: string): void {
      setFundingStmt.run(funding, provider, subscriptionId);
    },

    setCardDetails(provider: Provider, subscriptionId: string, details: CardDetails & { mid: string | null }): void {
      updateCardDetails.run({ provider, subscription_id: subscriptionId, ...details, bank: bankName(details.bank) });
    },

    upsertAttempt(a: AttemptRow): void {
      upsertAttemptStmt.run({ ...a, approved: Number(a.approved), refunded: Number(a.refunded) });
      refreshAttemptTotals.run(a.provider, a.subscription_id);
      refreshSequence.run({ provider: a.provider, subscription_id: a.subscription_id });
    },

    // Причина отказа из отдельного источника (заказы Solidgate) и рефанды (Stripe refunds) — по id попытки
    setAttemptReason(provider: Provider, attemptId: string, reason: string): void {
      const r = db
        .prepare('UPDATE attempts SET reason = COALESCE(reason, ?) WHERE provider = ? AND attempt_id = ? RETURNING subscription_id')
        .get(reason, provider, attemptId) as { subscription_id: string } | undefined;
      if (r) refreshSequence.run({ provider, subscription_id: r.subscription_id }); // причина могла оказаться «не повторять»
    },

    markRefunded(provider: Provider, attemptId: string): void {
      const r = db
        .prepare('UPDATE attempts SET refunded = 1 WHERE provider = ? AND attempt_id = ? RETURNING subscription_id')
        .get(provider, attemptId) as { subscription_id: string } | undefined;
      if (r) refreshAttemptTotals.run(provider, r.subscription_id);
    },

    upsertPayment(p: PaymentRow): void {
      upsertPaymentStmt.run({ ...p, customer_id: p.customer_id ?? null, bank: bankName(p.bank) });
    },

    // Клиент и банк у уже загруженного платежа — разовые проходы (LTV, банк Stripe): только пустые, известные не трогаем
    setPaymentDetails(provider: Provider, paymentId: string, details: { customer_id: string | null; bank: string | null }): void {
      db.prepare('UPDATE payments SET customer_id = COALESCE(customer_id, ?), bank = COALESCE(bank, ?) WHERE provider = ? AND payment_id = ?').run(
        details.customer_id,
        bankName(details.bank),
        provider,
        paymentId,
      );
    },

    upsertVampReport(r: VampReportRow): void {
      upsertVampStmt.run({ ...r, rdr: Number(r.rdr), refunded: Number(r.refunded) });
    },

    // Рефанд, пришедший позже фрод-репорта (Stripe refunds, Solidgate — заказ с возвратом)
    markVampRefunded(provider: Provider, paymentId: string): void {
      db.prepare('UPDATE vamp_reports SET refunded = 1 WHERE provider = ? AND payment_id = ?').run(provider, paymentId);
    },

    // Клиент триала по списанию его первого платежа — у фрод-алертов Solidgate клиента нет
    customerByAttempt(provider: Provider, attemptId: string): string | null {
      const row = db
        .prepare(
          `SELECT t.customer_id FROM attempts a JOIN trials t ON t.provider = a.provider AND t.subscription_id = a.subscription_id
           WHERE a.provider = ? AND a.attempt_id = ?`,
        )
        .get(provider, attemptId) as { customer_id: string | null } | undefined;
      return row?.customer_id ?? null;
    },

    upsertEsimCharge(c: EsimChargeRow): void {
      upsertEsimChargeStmt.run({ ...c, approved: Number(c.approved), bank: bankName(c.bank) });
    },

    // Рефанд, пришедший позже платежа: доля возвращённой суммы (Stripe refunds)
    setPaymentRefundShare(provider: Provider, paymentId: string, share: number): void {
      db.prepare(
        `UPDATE payments SET refunded_usd_cents = MAX(refunded_usd_cents, CAST(ROUND(amount_usd_cents * ?) AS INTEGER))
         WHERE provider = ? AND payment_id = ?`,
      ).run(share, provider, paymentId);
    },

    getFxRates(day: string): Record<string, number> | null {
      const r = db.prepare('SELECT rates FROM fx_rates WHERE day = ?').get(day) as { rates: string } | undefined;
      return r ? (JSON.parse(r.rates) as Record<string, number>) : null;
    },

    saveFxRates(day: string, rates: Record<string, number>): void {
      db.prepare('INSERT OR REPLACE INTO fx_rates (day, rates) VALUES (?, ?)').run(day, JSON.stringify(rates));
    },

    subscriptionByFirstInvoice(provider: Provider, invoiceId: string): string | null {
      const r = selectByInvoice.get(provider, invoiceId) as { subscription_id: string } | undefined;
      return r?.subscription_id ?? null;
    },

    getAttempts(provider: Provider, subscriptionId: string): AttemptRow[] {
      const rows = db
        .prepare(
          `SELECT provider, attempt_id, subscription_id, attempted_at, approved, reason, refunded
           FROM attempts WHERE provider = ? AND subscription_id = ? ORDER BY attempted_at`,
        )
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
        mid: r.mid,
        customer_id: r.customer_id ?? null,
        canceled_at: r.canceled_at ?? null,
        cancel_reason: r.cancel_reason ?? null,
        funding: r.funding ?? null,
      };
    },

    // Начало загруженной истории аккаунта (для старой базы, где оно не записано)
    // Первый платёж продукта — у eSIM история начинается с него
    firstPaymentAt(product: string): number | null {
      const r = db.prepare('SELECT MIN(paid_at) AS v FROM payments WHERE product = ?').get(product) as { v: number | null };
      return r.v;
    },

    firstTrialStart(provider: Provider, account: string): number | null {
      const r = db.prepare('SELECT MIN(trial_started_at) AS v FROM trials WHERE provider = ? AND account = ?').get(provider, account) as { v: number | null };
      return r.v;
    },

    // Конец самого позднего триала, оформленного до startedBefore, — до него приходят первые платежи
    lastTrialEnd(provider: Provider, account: string, startedBefore: number): number | null {
      const r = db
        .prepare('SELECT MAX(trial_ended_at) AS v FROM trials WHERE provider = ? AND account = ? AND trial_started_at < ?')
        .get(provider, account, startedBefore) as { v: number | null };
      return r.v;
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
      dataVersion++;
    },

    failStaleRuns(now = nowSec()): void {
      db.prepare(
        `UPDATE sync_runs SET status = 'error', error = 'process stopped during sync', finished_at = ?
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
