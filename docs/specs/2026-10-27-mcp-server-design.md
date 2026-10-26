# MCP-сервер дашборда — дизайн

Дата: 2026-10-27 · Автор: Yahor Yakauleu · Статус: согласован в обсуждении, реализован сразу

## 1. Цель

Спрашивать цифры дашборда из Claude Code: инструменты MCP вместо ручных запросов к API. Цифры — те же, что на экранах.

## 2. Решения

- **Где:** эндпоинт `POST /mcp` в самом дашборде (`src/mcp.ts`), официальный `@modelcontextprotocol/sdk`. Streamable HTTP без сессий, ответ — JSON: на каждый запрос свой сервер и транспорт. `GET`/`DELETE /mcp` — 405.
- **Те же отчёты:** тела эндпоинтов экранов вынесены в `reports` (`src/server.ts`) — их зовут и API, и инструменты, с тем же кэшем.
- **Вход:** как у API — cookie или Basic, без входа 401. Гостевого логина достаточно.
- **Только чтение и агрегаты:** нет синка и `/api/export` (там ID клиентов). У всех инструментов `readOnlyHint`.
- **Тело запроса:** `express.json({ inflate: false, limit: '100kb' })` после проверки входа — сжатые тела не принимаются (обход GHSA-27r3-jxmh-p828 в body-parser 2.3.0 до обновления на 2.4.0).

## 3. Инструменты

| Инструмент | Отчёт | view |
|---|---|---|
| `conversion` | `/api/metrics` | time, измерения, decline_reason (+ reason → банки) |
| `cancellations` | `/api/cancellations` | time, измерения, cancel_reason |
| `ltv` | `/api/ltv` | time, измерения |
| `retries` | `/api/retries` | time, attempt, day, decline_code, измерения |
| `vamp` | `/api/vamp` | time, outcome, измерения VAMP |
| `volume` | `/api/turnover` | time, измерения оборота |
| `esim_overview`, `esim_retention` | `/api/esim/*` — только если подключён eSIM | |
| `filter_values` | `/api/values` | — |
| `methodology` | страницы методологии (vpn, esim, data_sources) | — |

Общие параметры: `provider`, `period` / `from` / `to`, `granularity`, `filters` (объект измерение → значения), `limit`.

- **Подсказка модели** (`instructions`): сутки провайдеров, VAMP по UTC, `final_* = false` — цифра ещё растёт, деньги в центах USD, сначала `methodology`, для длинных периодов — week/month.
- **Размер ответа:** разбивки, причины, коды и значения фильтров — первые `limit` строк (по умолчанию 50; строки уже по убыванию), полное число — в `<список>_rows_total`. Без этого банки за 30 дней — 709 КБ; с ним — 27 КБ.

## 4. Тесты

- Без входа 401, неверный пароль 401, `GET` — 405.
- Список инструментов, `readOnlyHint`, без eSIM — без его инструментов, подсказка модели.
- Ответ `conversion` совпадает с `/api/metrics` при тех же параметрах; `filter_values` — с `/api/values`.
- Обрезка разбивки по `limit`, итоги — по всем строкам.
- Методология отдаётся; неверный параметр — ошибка инструмента.
