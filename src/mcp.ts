import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RequestHandler } from 'express';
import * as z from 'zod';
import { OVERVIEW_DIMENSIONS, REPEAT_DIMENSIONS } from './esim.js';
import { DIMENSIONS } from './metrics.js';
import { TURNOVER_DIMENSIONS } from './turnover.js';
import { VAMP_DIMENSIONS, VAMP_FILTERS } from './vamp.js';

// MCP-сервер дашборда (POST /mcp, Streamable HTTP без сессий): отчёты экранов — инструментами для Claude Code и других
// клиентов. Только чтение и только агрегаты: синка и выгрузки с ID клиентов здесь нет. Вход — как у API (cookie или Basic).
// Инструменты зовут те же функции, что и экраны (src/server.ts → reports), поэтому цифры совпадают с дашбордом

type Report = (query: Record<string, unknown>) => object;
export type Reports = Record<'metrics' | 'cancellations' | 'ltv' | 'retries' | 'vamp' | 'turnover' | 'esimOverview' | 'esimRepeat' | 'values', Report>;

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const METHODOLOGY = { vpn: 'methodology-vpn.md', esim: 'methodology-esim.md', data_sources: 'data-sources.md' };

const INSTRUCTIONS = `Toggle billing dashboard, read-only.
VPN — subscriptions with a trial (Stripe accounts and Solidgate); most metrics are cohorts by trial start day. eSIM — one-off purchases.
Days are provider-local, as in the provider's dashboard: Stripe — America/New_York, Solidgate — UTC. VAMP — UTC calendar months.
final_first / final_retry / final = false means the number is not final yet (shown with ≈ on screens) and will still grow — do not compare it with closed periods.
Money is in USD cents unless a field name says otherwise; rates are shares from 0 to 1.
Call \`methodology\` before interpreting or comparing metrics. Use \`filter_values\` to find exact filter values (accounts, MIDs, banks, campaigns).
For periods longer than ~2 months use granularity week or month — daily series get large.`;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const period = {
  period: z.enum(['last7', 'last30', 'thisMonth', 'prevMonth', 'all', 'custom']).optional().describe('Preset period; default all (since history start). custom — use from/to'),
  from: day.optional().describe('First day, YYYY-MM-DD, provider-local'),
  to: day.optional().describe('Last day inclusive, YYYY-MM-DD'),
};
const provider = { provider: z.enum(['all', 'stripe', 'solidgate']).optional().describe('Payment provider; default all') };
const granularity = { granularity: z.enum(['day', 'week', 'month']).optional().describe('Step of the time series (view=time); default day') };
const filters = (dimensions: readonly string[]) => ({
  filters: z
    .object(Object.fromEntries(dimensions.map((d) => [d, z.array(z.string()).optional()])))
    .optional()
    .describe(
      'Filters by dimension: values of one dimension are OR-ed, different dimensions are AND-ed. "none" — value unknown. ' +
        'account / mid — provider:name (stripe:corp, solidgate:sgH2H); country — ISO code (US). Exact values — filter_values',
    ),
});
const view = (views: readonly string[], about: string) => ({ view: z.enum(views as [string, ...string[]]).optional().describe(`${about}; default time`) });

// Инструмент → отчёт: параметры инструмента складываются в параметры запроса, как их задаёт экран
interface Tool {
  name: string;
  report: keyof Reports;
  description: string;
  input: z.ZodRawShape;
  esim?: boolean; // только если подключён eSIM
}
const TOOLS: Tool[] = [
  {
    name: 'conversion',
    report: 'metrics',
    description:
      'VPN trial-to-paid conversion by trial-start cohort: trials, paid with the first attempt, paid within the retry window, ' +
      'approval / decline rate of payment attempts, refunds, recovery, fraud. view=time — totals and series; a dimension — breakdown; ' +
      'decline_reason — declined attempts by reason, add reason=<reason> for issuing banks of that reason',
    input: {
      ...provider, ...period, ...granularity, ...filters(DIMENSIONS),
      ...view(['time', ...DIMENSIONS, 'decline_reason'], 'time series, breakdown by a dimension or decline reasons'),
      reason: z.string().max(80).optional().describe('With view=decline_reason: reason label from the reasons list → its issuing banks'),
    },
  },
  {
    name: 'cancellations',
    report: 'cancellations',
    description: 'VPN cancellations by trial-start cohort: canceled during the trial, on the first day, after the trial, median cancel day; view=cancel_reason — reasons',
    input: { ...provider, ...period, ...granularity, ...filters(DIMENSIONS), ...view(['time', ...DIMENSIONS, 'cancel_reason'], 'time series, breakdown or cancel reasons') },
  },
  {
    name: 'ltv',
    report: 'ltv',
    description: 'VPN LTV by trial-start cohort: money from the trial customer within 30/60/90 days (net of refunds, USD cents), per trial and per payer, renewals, average first payment',
    input: { ...provider, ...period, ...granularity, ...filters(DIMENSIONS), ...view(['time', ...DIMENSIONS], 'time series or breakdown') },
  },
  {
    name: 'retries',
    report: 'retries',
    description:
      'VPN retries of the first payment after the trial: how many attempts, when and after which declines they succeed. ' +
      'view=attempt — success by attempt number; day — by day after the first decline; decline_code — by decline code; a dimension — breakdown',
    input: { ...provider, ...period, ...granularity, ...filters(DIMENSIONS), ...view(['time', 'attempt', 'day', 'decline_code', ...DIMENSIONS], 'what to group by') },
  },
  {
    name: 'vamp',
    report: 'vamp',
    description:
      'Visa VAMP estimate: Visa fraud reports (TC40) + Visa chargebacks not resolved via RDR (TC15) vs successful Visa sales, by UTC month and Visa merchant; ' +
      'status vs the Excessive thresholds, forecast for the current month. Cards, daily chart and breakdowns are for the last month of the period. ' +
      'Breakdowns include lift (row ratio ÷ overall ratio) and anomaly flags; view=outcome — what happened after a fraud report',
    input: { ...provider, ...period, ...filters(VAMP_FILTERS), ...view(['time', 'outcome', ...VAMP_DIMENSIONS], 'monthly series, breakdown by a dimension or outcomes') },
  },
  {
    name: 'volume',
    report: 'turnover',
    description: 'VPN money by payment day (not cohorts): gross volume, refunds, net, payment count, average transaction — all successful payments including renewals, USD cents',
    input: { ...provider, ...period, ...granularity, ...filters(TURNOVER_DIMENSIONS), ...view(['time', ...TURNOVER_DIMENSIONS], 'time series or breakdown') },
  },
  {
    name: 'esim_overview',
    report: 'esimOverview',
    description: 'eSIM by day: revenue, paid orders, new and repeat customers, paid share of orders, lost revenue; view=decline_reason — why orders were not paid',
    input: { ...period, ...granularity, ...filters(OVERVIEW_DIMENSIONS), ...view(['time', 'decline_reason', ...OVERVIEW_DIMENSIONS], 'time series, breakdown or unpaid reasons') },
    esim: true,
  },
  {
    name: 'esim_retention',
    report: 'esimRepeat',
    description: 'eSIM cohorts by the first purchase day: returned within 30 days, revenue per customer within 90 days',
    input: { ...period, ...granularity, ...filters(REPEAT_DIMENSIONS), ...view(['time', ...REPEAT_DIMENSIONS], 'time series or breakdown') },
    esim: true,
  },
  {
    name: 'filter_values',
    report: 'values',
    description:
      'Values of one filter dimension for the current selection (period, provider, other filters) with counts — trials, payments, VAMP events or customers, as on that screen. ' +
      'Use it to get exact values for filters',
    input: {
      mode: z.enum(['conversion', 'cancellations', 'ltv', 'retries', 'vamp', 'turnover', 'esim_overview', 'esim_repeat']).describe('Screen the filter belongs to; turnover — the volume tool'),
      dimension: z.string().describe('Dimension, e.g. country, bank, account, campaign'),
      ...provider, ...period, ...filters([...new Set([...DIMENSIONS, ...VAMP_FILTERS, ...TURNOVER_DIMENSIONS, ...OVERVIEW_DIMENSIONS])]),
    },
  },
];

// Разбивки бывают на тысячи строк (банки за месяц — больше 700 КБ): модели отдаём первые limit строк — они уже по убыванию,
// — а сколько их всего, пишем рядом. Итоги посчитаны по всем строкам
const ROW_LIMIT = 50;
const LISTS = ['breakdown', 'reasons', 'reason_banks', 'codes', 'values'];
const limit = {
  limit: z.number().int().min(1).max(1000).optional().describe(`Max rows in breakdowns and lists, largest first; default ${ROW_LIMIT}. If cut, <list>_rows_total has the full count; totals always cover all rows`),
};
function trim(data: object, rows: number) {
  const out: Record<string, unknown> = { ...data };
  for (const key of LISTS) {
    const list = out[key];
    if (Array.isArray(list) && list.length > rows) {
      out[key] = list.slice(0, rows);
      out[`${key}_rows_total`] = list.length;
    }
  }
  return out;
}

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

function createServer(reports: Reports, { esimEnabled }: { esimEnabled: boolean }) {
  const server = new McpServer({ name: 'billing-dashboard', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  for (const tool of TOOLS.filter((t) => !t.esim || esimEnabled)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: { ...tool.input, ...limit }, annotations: { readOnlyHint: true, openWorldHint: false } },
      async ({ filters, limit: rows, ...params }: Record<string, unknown>) =>
        json(trim(reports[tool.report]({ ...params, ...(filters as object | undefined) }), (rows as number | undefined) ?? ROW_LIMIT)),
    );
  }
  server.registerTool(
    'methodology',
    {
      description: 'How every metric is defined and counted (markdown, the dashboard Methodology page): vpn, esim or data_sources (where the data comes from)',
      inputSchema: { doc: z.enum(['vpn', 'esim', 'data_sources']).describe('Which page') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ doc }) => ({ content: [{ type: 'text', text: await readFile(path.join(PUBLIC_DIR, METHODOLOGY[doc]), 'utf8') }] }),
  );
  return server;
}

// Без сессий: на каждый запрос — свой сервер и транспорт, ответ — обычным JSON (без потока SSE)
export function mcpHandler(reports: Reports, options: { esimEnabled: boolean }): RequestHandler {
  return async (req, res) => {
    const server = createServer(reports, options);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
