import type Stripe from 'stripe';
import { toAlpha2 } from '../countries.js';
import type { EsimChargeRow, Store } from '../db.js';
import { forEachWindow } from '../days.js';
import type { ToUsd } from '../fx.js';
import { DAY, dayKey, startOfUtcDay } from '../metrics.js';
import type { StripeLike } from './stripe.js';

// eSIM — отдельный Stripe-аккаунт. Подписок нет: каждая покупка пакета или пополнение — свой PaymentIntent,
// в нём одна или несколько попыток (списаний). Что куплено — из описания платежа, которое ставит esim-service:
// «Spain - 5 GB - 7 days»; тип заказа (purchase | topup) — из метаданных.
export const ESIM_ACCOUNT = 'esim';
const PARALLEL = 8;
const HOUR = 3_600;
const SYNC_OVERLAP = HOUR; // списание может появиться в списке с задержкой — инкремент берёт с запасом

export interface EsimSyncConfig {
  historyFrom: number;
  toUsd: ToUsd;
}

// «Spain - 5 GB - 7 days» → направление «Spain», пакет «5 GB · 7 days»; другой формат — не разбираем
export function parsePackage(description: string | null | undefined): { destination: string | null; package: string | null } {
  const parts = (description ?? '').split(' - ').map((p) => p.trim());
  if (parts.length < 3 || parts.some((p) => !p)) return { destination: null, package: null };
  return { destination: parts.slice(0, -2).join(' - '), package: `${parts.at(-2)} · ${parts.at(-1)}` };
}

// Списание → строка платежа eSIM. Успешное — только захваченное: холд intro-пакета без списания денег не оборот.
// Сумма успешного — сколько Stripe зачислил в USD; отклонённого — сумма попытки по курсу дня.
export async function esimChargeRow(charge: Stripe.Charge, toUsd: ToUsd): Promise<EsimChargeRow | null> {
  const approved = charge.status === 'succeeded';
  if (charge.status === 'pending' || (approved && !charge.captured)) return null;
  const balance = typeof charge.balance_transaction === 'object' ? charge.balance_transaction : null;
  const amountUsd = approved
    ? balance && (await toUsd(balance.amount, balance.currency, charge.created))
    : await toUsd(charge.amount, charge.currency, charge.created);
  if (amountUsd === null || amountUsd === undefined) return null;
  const card = charge.payment_method_details?.card;
  const id = (ref: string | { id: string } | null) => (typeof ref === 'string' ? ref : (ref?.id ?? null));
  return {
    provider: 'stripe',
    payment_id: charge.id,
    account: ESIM_ACCOUNT,
    mid: ESIM_ACCOUNT,
    paid_at: charge.created,
    amount_usd_cents: amountUsd,
    refunded_usd_cents: approved && charge.amount > 0 ? Math.round((amountUsd * charge.amount_refunded) / charge.amount) : 0,
    country: toAlpha2(card?.country),
    payment_method: card?.wallet?.type ?? charge.payment_method_details?.type ?? null,
    card_brand: card?.brand ?? null,
    bank: card?.issuer ?? null,
    approved,
    reason: approved ? null : (charge.outcome?.reason ?? charge.failure_code ?? charge.outcome?.type ?? null),
    intent_id: id(charge.payment_intent),
    customer_id: id(charge.customer),
    ...parsePackage(charge.description),
    order_type: charge.metadata?.order_type || null,
  };
}

// Без курсора — бэкфилл списаний с HISTORY_FROM по дням (прогресс сохраняется); дальше — инкремент с (курсор − 1 час):
// новые списания, холды intro-пакетов, захваченные позже, и рефанды
export async function syncEsimAccount(store: Store, stripe: StripeLike, cfg: EsimSyncConfig, now: number): Promise<number> {
  const today = startOfUtcDay(now);
  const cursor = store.getState('stripe', ESIM_ACCOUNT, 'cursor');
  let items = 0;
  const save = async (charge: Stripe.Charge) => {
    const row = await esimChargeRow(charge, cfg.toUsd);
    if (!row) return;
    store.upsertEsimCharge(row);
    items++;
  };
  const listCharges = (created: Stripe.RangeQueryParam) => stripe.charges.list({ created, limit: 100, expand: ['data.balance_transaction'] });

  if (cursor === null) {
    await forEachWindow(
      store.getState('stripe', ESIM_ACCOUNT, 'charges_day') ?? cfg.historyFrom,
      today,
      DAY,
      PARALLEL,
      async (day) => {
        for await (const charge of listCharges({ gte: day, lt: day + DAY })) await save(charge);
        console.log(`[stripe:${ESIM_ACCOUNT}] списания ${dayKey(day)} готово`);
      },
      (next) => store.setState('stripe', ESIM_ACCOUNT, 'charges_day', next),
    );
  }

  const since = (cursor ?? today) - SYNC_OVERLAP;
  await forEachWindow(since, now, HOUR, PARALLEL, async (from) => {
    for await (const charge of listCharges({ gte: from, lt: from + HOUR })) await save(charge);
  });
  // Холд intro-пакета захватывают позже — списание становится оборотом в момент захвата
  for await (const event of stripe.events.list({ types: ['charge.captured'], created: { gte: since }, limit: 100 })) {
    const charge = event.data.object as Stripe.Charge;
    await save(await stripe.charges.retrieve(charge.id, { expand: ['balance_transaction'] }));
  }
  for await (const refund of stripe.refunds.list({ created: { gte: since }, limit: 100, expand: ['data.charge'] })) {
    if (refund.status === 'failed' || refund.status === 'canceled') continue;
    const charge = typeof refund.charge === 'object' ? refund.charge : null;
    if (charge && charge.amount > 0) store.setPaymentRefundShare('stripe', charge.id, charge.amount_refunded / charge.amount);
  }

  store.setState('stripe', ESIM_ACCOUNT, 'cursor', now);
  return items;
}
