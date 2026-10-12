import type { SolidgateAccount } from '../config.js';
import type { Store, TrialRow } from '../db.js';
import { DAY, dayKey } from '../metrics.js';
import { listSubscriptions, type SgInvoice, type SgOrder, type SgSubscription } from './solidgate-client.js';

const FIRST_INVOICE_TOLERANCE = 3_600;
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

function firstAttempt(order: SgOrder | undefined): boolean | null {
  if (!order || PENDING.has(order.status)) return null;
  return SUCCESS.has(order.status);
}

interface SolidgateSyncConfig {
  historyFrom: number;
}

// Отчёт отдаёт подписку целиком (с инвойсами и попытками), поэтому строка триала каждый раз собирается заново.
// Без курсора — бэкфилл подписок, созданных с HISTORY_FROM; затем изменения с (курсор − 1 день).
export async function syncSolidgateAccount(
  store: Store,
  acc: SolidgateAccount,
  cfg: SolidgateSyncConfig,
  now: number,
  list = listSubscriptions,
): Promise<number> {
  const cursor = store.getState('solidgate', acc.account, 'cursor');
  let items = 0;

  const fetchWindows = async (from: number, filter: 'created_at' | 'updated_at', onWindow?: (next: number) => void) => {
    for (let day = from; day < now; day += DAY) {
      for await (const sub of list(acc, day, Math.min(day + DAY, now), filter)) {
        const row = trialFromSolidgate(sub, acc.account);
        if (!row) continue;
        store.upsertTrial(row);
        items++;
      }
      onWindow?.(day + DAY);
    }
  };

  if (cursor === null) {
    await fetchWindows(store.getState('solidgate', acc.account, 'backfill_day') ?? cfg.historyFrom, 'created_at', (next) => {
      store.setState('solidgate', acc.account, 'backfill_day', next);
      console.log(`[solidgate:${acc.account}] подписки ${dayKey(next - DAY)} готово`);
    });
  }
  await fetchWindows((cursor ?? now) - DAY, 'updated_at');

  store.setState('solidgate', acc.account, 'cursor', now);
  return items;
}
