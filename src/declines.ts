// Причины отказа: коды Stripe (decline code / outcome) и Solidgate (error_code) сводятся к общим названиям —
// как их называет Stripe, — чтобы insufficient funds из обоих провайдеров считался одной строкой.
// К каждой группе — короткое пояснение по-русски для подсказки. Неизвестный код показывается как есть.
// Коды Stripe: https://docs.stripe.com/declines/codes, Solidgate: https://docs.solidgate.com/payments/payments-insights/error-codes/

const GROUPS: { label: string; hint: string; codes: string[] }[] = [
  { label: 'Insufficient funds', hint: 'Недостаточно средств на карте', codes: ['insufficient_funds', '3.02'] },
  {
    label: 'Do not honor / Generic decline',
    hint: 'Банк отклонил без объяснения причины',
    codes: ['do_not_honor', 'generic_decline', 'call_issuer', 'no_action_taken', 'issuer_declined', '3.04', '3.05', '3.08'],
  },
  {
    label: 'Transaction not allowed',
    hint: 'Банк запретил такую операцию для этой карты',
    codes: ['transaction_not_allowed', 'not_permitted', 'service_not_allowed', 'restricted_card', '3.12'],
  },
  { label: 'Fraudulent', hint: 'Банк заподозрил мошенничество', codes: ['fraudulent', 'security_violation', '3.10', '4.05'] },
  {
    label: 'Blocked by fraud rules',
    hint: 'Отклонил антифрод провайдера (Radar, Solidgate) — до банка платёж не дошёл',
    codes: ['rule', 'highest_risk_level', 'elevated_risk_level', 'blocked', 'blocklist', 'merchant_blacklist', '4.06', '4.07'],
  },
  { label: 'Lost or stolen card', hint: 'Карта утеряна, украдена или в чёрном списке', codes: ['stolen_card', 'lost_card', 'pickup_card', '4.01', '4.02', '4.03', '4.04'] },
  {
    label: 'Card velocity exceeded',
    hint: 'Превышен лимит карты по сумме или числу операций',
    codes: ['card_velocity_exceeded', 'withdrawal_count_limit_exceeded', 'exceeding_limit', '3.01', '3.03'],
  },
  {
    label: 'Incorrect card details',
    hint: 'Неверный номер, CVC, срок действия или PIN',
    codes: ['incorrect_number', 'invalid_number', 'invalid_account', 'incorrect_cvc', 'invalid_cvc', 'invalid_expiry_month', 'invalid_expiry_year', 'invalid_pin', '2.06', '2.08', '5.02'],
  },
  { label: 'Expired card', hint: 'Срок действия карты истёк', codes: ['expired_card'] },
  { label: 'Card not supported', hint: 'Карта не поддерживает такой платёж', codes: ['card_not_supported', '3.06', '3.07'] },
  { label: 'Invalid amount', hint: 'Банк не принял сумму платежа', codes: ['invalid_amount', '2.02'] },
  {
    label: 'Authentication required',
    hint: 'Нужна или не пройдена аутентификация (3DS)',
    codes: ['authentication_required', 'approve_with_id', '1.01', '2.11', '2.15', '3.09', '5.01'],
  },
  {
    label: 'Try again later',
    hint: 'Временная ошибка банка или сети — повтор может пройти',
    codes: ['try_again_later', 'processing_error', 'reenter_transaction', 'issuer_not_available', '5.03'],
  },
  {
    label: 'Do not retry',
    hint: 'Банк запретил повторять попытки по этой карте',
    codes: ['previously_declined_do_not_retry', 'revocation_of_authorization', 'revocation_of_all_authorizations', 'stop_payment_order', '3.11'],
  },
];

const UNKNOWN = { label: 'Unknown', hint: 'Провайдер не передал причину отказа' };
const BY_CODE = new Map(GROUPS.flatMap((g) => g.codes.map((code) => [code, g] as const)));
const HINTS = new Map([...GROUPS, UNKNOWN].map((g) => [g.label, g.hint]));

export function declineLabel(code: string | null): string {
  if (!code) return UNKNOWN.label;
  return BY_CODE.get(code)?.label ?? code;
}

// Пояснение к причине для подсказки; код без группы — как есть
export const declineHint = (label: string): string => HINTS.get(label) ?? 'Код отказа провайдера — без общей группы';

// Коды антифрода провайдера (Radar, Solidgate): заказ, отсечённый ими, — не потерянная продажа, а отсечённая атака
export const FRAUD_RULE_CODES = GROUPS.find((g) => g.label === 'Blocked by fraud rules')!.codes;

// Коды отказа группы — для выборки по строке причины: группа → её коды, Unknown → без кода, иначе — сам код
export function declineCodes(label: string): { codes: string[]; withoutCode: boolean } {
  if (label === UNKNOWN.label) return { codes: [], withoutCode: true };
  return { codes: GROUPS.find((g) => g.label === label)?.codes ?? [label], withoutCode: false };
}

// Условие «причина из группы» для строки вкладки причин (отказы списания или отмены подписки): column — колонка с кодом
export function reasonSql(column: string, label: string | null, codesOf = declineCodes) {
  if (!label) return { sql: '1 = 1', params: {} };
  const { codes, withoutCode } = codesOf(label);
  const params = Object.fromEntries(codes.map((code, i) => [`reason_${i}`, code]));
  const parts = [codes.length ? `${column} IN (${codes.map((_, i) => `@reason_${i}`).join(', ')})` : '', withoutCode ? `${column} IS NULL` : ''];
  return { sql: `(${parts.filter(Boolean).join(' OR ')})`, params };
}

// Отказы, после которых повтор бесполезен: банк закрыл или заблокировал карту, отозвал разрешение на списания,
// Stripe сам блокирует повторы по карте, карта в блок-листе. На сентябрьских когортах после них ~0,4% успешных повторов
export const NO_RETRY_CODES = [
  ...GROUPS.find((g) => g.label === 'Do not retry')!.codes,
  ...GROUPS.find((g) => g.label === 'Lost or stolen card')!.codes,
  'invalid_account',
  'incorrect_number',
  'invalid_number',
  'blocklist',
];
