// Причины отказа: коды Stripe (decline code / outcome) и Solidgate (error_code) сводятся к общим названиям,
// чтобы «недостаточно средств» из обоих провайдеров считалось одной строкой. Неизвестный код показывается как есть.
// Коды Solidgate: https://docs.solidgate.com/payments/payments-insights/error-codes/

const LABELS: [string, string[]][] = [
  ['Недостаточно средств', ['insufficient_funds', '3.02']],
  ['Отказ банка без причины', ['do_not_honor', 'generic_decline', 'call_issuer', 'no_action_taken', 'issuer_declined', '3.04', '3.05', '3.08']],
  ['Операция запрещена для карты', ['transaction_not_allowed', 'not_permitted', 'service_not_allowed', 'restricted_card', '3.12']],
  ['Подозрение на фрод (банк)', ['fraudulent', 'security_violation', '3.10', '4.05']],
  ['Заблокировано антифродом', ['rule', 'highest_risk_level', 'elevated_risk_level', 'blocked', 'blocklist', 'merchant_blacklist', '4.06', '4.07']],
  ['Карта в блок-листе / украдена', ['stolen_card', 'lost_card', 'pickup_card', '4.01', '4.02', '4.03', '4.04']],
  ['Превышен лимит карты', ['card_velocity_exceeded', 'withdrawal_count_limit_exceeded', 'exceeding_limit', '3.01', '3.03']],
  ['Неверные данные карты', ['incorrect_number', 'invalid_number', 'invalid_account', 'incorrect_cvc', 'invalid_cvc', 'invalid_expiry_month', 'invalid_expiry_year', 'invalid_pin', '2.06', '2.08', '5.02']],
  ['Карта просрочена', ['expired_card']],
  ['Карта не поддерживается', ['card_not_supported', '3.06', '3.07']],
  ['Проблема с суммой платежа', ['invalid_amount', '2.02']],
  ['3DS / аутентификация не пройдена', ['authentication_required', 'approve_with_id', '1.01', '2.11', '2.15', '3.09', '5.01']],
  ['Временная ошибка, можно повторить', ['try_again_later', 'processing_error', 'reenter_transaction', 'issuer_not_available', '5.03']],
  ['Банк запретил повторять попытки', ['previously_declined_do_not_retry', 'revocation_of_authorization', 'revocation_of_all_authorizations', 'stop_payment_order', '3.11']],
];

const BY_CODE = new Map(LABELS.flatMap(([label, codes]) => codes.map((code) => [code, label] as const)));

export function declineLabel(code: string | null): string {
  if (!code) return 'Причина не указана';
  return BY_CODE.get(code) ?? code;
}
