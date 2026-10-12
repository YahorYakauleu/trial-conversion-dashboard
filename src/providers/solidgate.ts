import type { SolidgateAccount } from '../config.js';
import { toAlpha2 } from '../countries.js';
import type { Store, TrialRow } from '../db.js';
import { DAY, dayKey } from '../metrics.js';
import {
  listCardOrders,
  listSubscriptions,
  type ReportFilter,
  type SgCardOrder,
  type SgInvoice,
  type SgOrder,
  type SgSubscription,
} from './solidgate-client.js';

const FIRST_INVOICE_TOLERANCE = 3_600;
// Заказ оформления создаётся на секунды раньше подписки — окно заказов начинаем на час раньше
const ORDERS_LOOKBACK = 3_600;
// Неудачная попытка — order recurring/auth_failed; успешная — order settle/settle_ok.
// refunded — значит, списание было; рефанды в v1 не вычитаем.
const SUCCESS = new Set(['approved', 'settle_ok', 'auth_ok', 'refunded']);
const PENDING = new Set(['created', 'processing', '3ds_verify']);

export function parseSgDate(value: string): number {
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  const zoned = /([zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`;
  return Math.floor(Date.parse(zoned) / 1000);
}

export function trialFromSolidgate(sub: SgSubscription, account: string): TrialRow | null {
  const period = trialPeriod(sub);
  if (!period) return null;

  const row: TrialRow = {
    provider: 'solidgate',
    account,
    subscription_id: sub.id,
    trial_started_at: period.start,
    trial_ended_at: period.end,
    first_invoice_id: null,
    first_attempt_succeeded: null,
    paid_at: null,
    country: null, // в отчёте подписок страны нет — берётся из заказов (orderCardCountry)
  };

  // У неоплаченных инвойсов нет billing_period_started_at — датируем по created_at.
  // Номер периода 0 — триал, 1 — первый платный; если номера нет, отбираем по времени.
  const invoiceTime = (i: SgInvoice) => parseSgDate(i.created_at ?? i.billing_period_started_at);
  const isAfterTrial = (i: SgInvoice) =>
    i.subscription_term_number !== undefined
      ? i.subscription_term_number >= 1
      : invoiceTime(i) >= period.end - FIRST_INVOICE_TOLERANCE;
  const firstPaid = Object.values(sub.invoices ?? {})
    .filter((i) => i.amount > 0 && isAfterTrial(i))
    .sort((a, b) => invoiceTime(a) - invoiceTime(b))[0];
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

// Триал = продукт с триалом и подписка, которая реально стартовала. Без started_at — не прошла
// авторизация на $0 при оформлении, триала не было. Флаг sub.trial значит «сейчас в триале» — не подходит.
// trial_period — в минутах (10080 = 7 дней, проверено на живых данных sgH2H).
function trialPeriod(sub: SgSubscription): { start: number; end: number } | null {
  const minutes = sub.product?.trial ? (sub.product.trial_period ?? 0) : 0;
  if (minutes <= 0 || !sub.started_at) return null;
  const start = parseSgDate(sub.started_at);
  return { start, end: start + minutes * 60 };
}

// Страна карты из заказа; трёхбуквенный код приводим к двухбуквенному, как в Stripe
export function orderCardCountry(order: SgCardOrder): string | null {
  const transaction = Object.values(order.transactions ?? {}).find((t) => t.card?.country);
  return toAlpha2(transaction?.card?.country ?? order.card?.country);
}

function firstAttempt(order: SgOrder | undefined): boolean | null {
  if (!order || PENDING.has(order.status)) return null;
  return SUCCESS.has(order.status);
}

interface SolidgateSyncConfig {
  historyFrom: number;
}

// Отчёт подписок отдаёт подписку целиком (с инвойсами и попытками) — строка триала каждый раз собирается заново.
// Страну карты берём из отчёта заказов: у каждого заказа есть subscription_id.
// Без курсора — бэкфилл подписок, созданных с HISTORY_FROM; затем изменения с (курсор − 1 день).
export async function syncSolidgateAccount(
  store: Store,
  acc: SolidgateAccount,
  cfg: SolidgateSyncConfig,
  now: number,
  list = listSubscriptions,
  listOrders = listCardOrders,
): Promise<number> {
  const cursor = store.getState('solidgate', acc.account, 'cursor');
  let items = 0;

  const saveSubscriptions = async (from: number, to: number, filter: ReportFilter) => {
    for await (const sub of list(acc, from, to, filter)) {
      const row = trialFromSolidgate(sub, acc.account);
      if (!row) continue;
      store.upsertTrial(row);
      items++;
    }
  };
  const saveCountries = async (from: number, to: number) => {
    for await (const order of listOrders(acc, from - ORDERS_LOOKBACK, to, 'created_at')) {
      const country = orderCardCountry(order);
      if (order.subscription_id && country) store.setCountry('solidgate', order.subscription_id, country);
    }
  };
  // Окна по суткам до now; после каждого — onWindow(начало следующего окна)
  const inWindows = async (from: number, work: (from: number, to: number) => Promise<void>, onWindow?: (next: number) => void) => {
    for (let day = from; day < now; day += DAY) {
      await work(day, Math.min(day + DAY, now));
      onWindow?.(day + DAY);
    }
  };
  const progress = (key: string) => (next: number) => {
    store.setState('solidgate', acc.account, key, next);
    console.log(`[solidgate:${acc.account}] ${dayKey(next - DAY)} готово`);
  };

  if (cursor === null) {
    const backfillFrom = store.getState('solidgate', acc.account, 'backfill_day') ?? cfg.historyFrom;
    await inWindows(
      backfillFrom,
      async (from, to) => {
        await saveSubscriptions(from, to, 'created_at');
        await saveCountries(from, to);
      },
      progress('backfill_day'),
    );
    store.setState('solidgate', acc.account, 'country_done', 1);
  } else if (store.getState('solidgate', acc.account, 'country_done') === null) {
    // База выгружена до появления стран — один раз проходим заказы с HISTORY_FROM
    await inWindows(store.getState('solidgate', acc.account, 'country_day') ?? cfg.historyFrom, saveCountries, progress('country_day'));
    store.setState('solidgate', acc.account, 'country_done', 1);
  }

  await inWindows((cursor ?? now) - DAY, async (from, to) => {
    await saveSubscriptions(from, to, 'updated_at');
    await saveCountries(from, to);
  });

  store.setState('solidgate', acc.account, 'cursor', now);
  return items;
}
