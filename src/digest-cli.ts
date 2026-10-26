import path from 'node:path';
import { loadConfig, loadEnvFile } from './config.js';
import { nowSec, openStore } from './db.js';
import { buildDigest, sendToSlack } from './digest.js';

// Сводка по локальной базе: npm run digest — напечатать, npm run digest -- --send — ещё и отправить по SLACK_WEBHOOK_URL.
// Без синка и без отметки об отправке — плановую сводку не заменяет
loadEnvFile();
const config = loadConfig();
const store = openStore(path.join(config.dataDir, 'dashboard.sqlite'));
const text = buildDigest(store, config, nowSec());
console.log(text);
if (process.argv.includes('--send')) {
  if (!config.slackWebhookUrl) throw new Error('Не задан SLACK_WEBHOOK_URL');
  await sendToSlack(config.slackWebhookUrl, text);
  console.log('Отправлено в Slack');
}
