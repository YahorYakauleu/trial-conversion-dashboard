// Разведка реальной формы ответа Solidgate Reports API. Печатает только структуру:
// статусы, даты, суммы, попытки — без email, id клиентов и данных карт.
import { loadConfig, loadEnvFile } from '../src/config.js';
import { listSubscriptions, type SgSubscription } from '../src/providers/solidgate-client.js';

loadEnvFile();
const config = loadConfig({ HISTORY_FROM: '2026-09-01', ...process.env });
const now = Math.floor(Date.now() / 1000);
const only = process.argv[2]; // необязательно: имя канала, например sgH2H

for (const acc of config.solidgateAccounts.filter((a) => !only || a.account === only)) {
  let total = 0;
  const trials: SgSubscription[] = [];
  const keys = new Set<string>();
  for await (const s of listSubscriptions(acc, now - 2 * 86_400, now, 'created_at')) {
    total++;
    Object.keys(s).forEach((k) => keys.add(k));
    if (s.product?.trial && s.started_at && trials.length < 3) trials.push(s);
  }
  console.log(`\n=== ${acc.account}: подписок, созданных за 2 дня: ${total}; с признаком триала в выборке: ${trials.length}`);
  console.log(`поля подписки: ${[...keys].sort().join(', ')}`);
  for (const s of trials) {
    console.log(
      JSON.stringify(
        {
          status: s.status,
          started_at: s.started_at,
          trial: s.trial,
          product: { trial: s.product.trial, trial_period: s.product.trial_period, amount: s.product.amount },
          invoices: Object.values(s.invoices ?? {}).map((i) => ({
            term: i.subscription_term_number,
            status: i.status,
            amount: i.amount,
            billing_period_started_at: i.billing_period_started_at,
            orders: Object.values(i.orders ?? {}).map((o) => ({
              status: o.status,
              retry_attempt: o.retry_attempt,
              created_at: o.created_at,
              processed_at: o.processed_at,
            })),
          })),
        },
        null,
        2,
      ),
    );
  }
}
