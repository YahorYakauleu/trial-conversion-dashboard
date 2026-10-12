import { createHmac } from 'node:crypto';

const REPORTS_URL = 'https://reports.solidgate.com/api/v1';
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
  billing_period_started_at?: string; // только у оплаченных
  subscription_term_number?: number; // 0 — триал, 1 — первый платный период
  orders?: Record<string, SgOrder>;
}

export interface SgSubscription {
  id: string;
  status: string;
  started_at?: string; // нет, если авторизация при оформлении не прошла
  updated_at: string;
  trial?: boolean; // «сейчас в триале», после окончания триала — false
  product: { id: string; trial?: boolean; trial_period?: number; amount?: number };
  invoices?: Record<string, SgInvoice>;
}

// Заказ из отчёта card-orders: нужен ради страны карты и связи с подпиской
export interface SgCard {
  country?: string | null; // alpha-3
  brand?: string | null;
  bank?: string | null;
}

export interface SgCardOrder {
  order_id: string;
  subscription_id?: string | null;
  geo_country?: string | null; // страна по IP, которую передаёт workflow-service (alpha-3)
  payment_method?: string | null; // google-pay, apple-pay, card, token…
  error_code?: string | null; // код отказа, например 3.02
  refunded_amount?: number | null;
  card?: SgCard;
  transactions?: Record<string, { card?: SgCard }> | { card?: SgCard }[];
}

export type ReportFilter = 'created_at' | 'updated_at';

interface ClientOptions {
  fetchFn?: typeof fetch;
  retryDelayMs?: number;
}

interface ReportPage {
  subscriptions?: Record<string, SgSubscription>;
  orders?: SgCardOrder[] | Record<string, SgCardOrder>;
  metadata?: { next_page_iterator: string | null };
  error?: { code: string; messages?: string[] } | null;
}

// Та же схема подписи, что в workflow-service (solidgate.service.ts → generateApiSignature)
export function solidgateSignature(keys: SolidgateKeys, body: string): string {
  const hex = createHmac('sha512', keys.secretKey).update(keys.publicKey + body + keys.publicKey).digest('hex');
  return Buffer.from(hex).toString('base64');
}

export const formatSgDate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ');

export function listSubscriptions(
  keys: SolidgateKeys,
  from: number,
  to: number,
  filter: ReportFilter,
  options: ClientOptions = {},
): AsyncGenerator<SgSubscription> {
  return paginate(keys, 'subscriptions', from, to, filter, options, (page) => page.subscriptions);
}

export function listCardOrders(
  keys: SolidgateKeys,
  from: number,
  to: number,
  filter: ReportFilter,
  options: ClientOptions = {},
): AsyncGenerator<SgCardOrder> {
  return paginate(keys, 'card-orders', from, to, filter, options, (page) => page.orders);
}

async function* paginate<T>(
  keys: SolidgateKeys,
  report: 'subscriptions' | 'card-orders',
  from: number,
  to: number,
  filter: ReportFilter,
  options: ClientOptions,
  items: (page: ReportPage) => T[] | Record<string, T> | undefined,
): AsyncGenerator<T> {
  let iterator: string | null = null;
  do {
    const page = await post(
      `${REPORTS_URL}/${report}`,
      keys,
      {
        date_from: formatSgDate(from),
        date_to: formatSgDate(to),
        filter,
        limit: PAGE_LIMIT,
        ...(iterator ? { next_page_iterator: iterator } : {}),
      },
      options,
    );
    yield* Object.values(items(page) ?? {});
    iterator = page.metadata?.next_page_iterator ?? null;
  } while (iterator);
}

async function post(url: string, keys: SolidgateKeys, payload: object, options: ClientOptions): Promise<ReportPage> {
  const fetchFn = options.fetchFn ?? fetch;
  const delayMs = options.retryDelayMs ?? 1_000;
  const body = JSON.stringify(payload);

  for (let attempt = 0; ; attempt++) {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', merchant: keys.publicKey, signature: solidgateSignature(keys, body) },
      body,
    });
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** attempt));
      continue;
    }
    const page = (await response.json().catch(() => ({}))) as ReportPage;
    if (!response.ok || page.error) {
      const details = [page.error?.code, ...(page.error?.messages ?? [])].filter(Boolean).join(' ');
      throw new Error(`Solidgate reports ${response.status}: ${details || 'нет описания ошибки'}`);
    }
    return page;
  }
}
