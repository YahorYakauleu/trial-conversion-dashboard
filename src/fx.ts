import type { Store } from './db.js';
import { dayKey } from './metrics.js';

// Дневные курсы к доллару: бесплатный публичный API без ключа, ~340 валют, история по датам.
// Нужны для Solidgate — Stripe сам отдаёт сумму в долларах.
const RATES_URL = (day: string) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day}/v1/currencies/usd.json`;

// Сумма в минимальных единицах валюты (центы; у JPY и CLP — целые) на момент at → центы USD; null — курса нет
export type ToUsd = (amount: number, currency: string, at: number) => Promise<number | null>;

export function createToUsd(store: Store, fetchFn: typeof fetch = fetch): ToUsd {
  const byDay = new Map<string, Promise<Record<string, number>>>();

  const loadRates = async (day: string) => {
    const saved = store.getFxRates(day);
    if (saved) return saved;
    // курсы за сегодня публикуются не сразу — тогда берём последние
    let res = await fetchFn(RATES_URL(day));
    if (!res.ok) res = await fetchFn(RATES_URL('latest'));
    if (!res.ok) throw new Error(`курсы валют за ${day}: HTTP ${res.status}`);
    const rates = ((await res.json()) as { usd: Record<string, number> }).usd;
    store.saveFxRates(day, rates);
    return rates;
  };

  return async (amount, currency, at) => {
    const code = currency.toUpperCase();
    if (code === 'USD') return amount;
    const day = dayKey(at);
    if (!byDay.has(day)) byDay.set(day, loadRates(day));
    const perUsd = (await byDay.get(day)!)[code.toLowerCase()];
    const digits = minorDigits(code);
    if (!perUsd || digits === null) return null;
    return Math.round((amount / 10 ** digits / perUsd) * 100);
  };
}

// Знаков после запятой у валюты по ISO 4217: у большинства 2, у JPY и CLP 0, у KWD 3
function minorDigits(currency: string): number | null {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? null;
  } catch {
    return null;
  }
}
