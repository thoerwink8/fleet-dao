// 法国接口的 MCP 客户端（#3739 第四片，决定 0122）：本机会话、Mirasim 里的 Claude Code、法国 harness 的指挥官装同一组工具，
// 经法国的 /api/nodes/* 开单、派单、领活、读账本。通行证只在内存里随请求头走，不进工具回包。
//
// 约定：
// - 法国没回、回错、回的东西认不出，一律 isError 并写明原因，不拿空结果冒充成功。
// - 来源 source.kind 从环境变量 FLEET_MCP_SOURCE 读（fleetMcpSourceKind），ref 由调用方传。
// - 请求体、回包的字段以法国那边 packages/shared 的 node-dispatch.ts（派单，#3745）和开单、读账本的 schema 为准；
//   conventions 是零安装区的老规矩，这里不引 shared，手写请求和解析，字段变了改这里。
// - 领活不另写一套：经 pnpm work claim 同一个 work()（查有没有别的 PR、法国登记、记租约、贴「本机做」）。
import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DOMAIN_VALUES, KIND_LABELS, NATURE_VALUES } from './labels.ts';
import type { ClaimsEndpoint } from './work.ts';

const TOKEN_HEADER = 'X-Fleet-Node-Token';
const TIMEOUT_MS = 20_000;
const DEFAULT_REPO = 'thoerwink8/fleet-dao';
const BODY_SHOW_MAX = 2000;

export const FLEET_MCP_SOURCE_KINDS = [
  'local-session',
  'mirasim',
  'harness-commander',
  'harness-chat',
] as const;
export type FleetMcpSourceKind = (typeof FLEET_MCP_SOURCE_KINDS)[number];

/** 从环境变量读来源；没设是 local-session，设了认不出就抛（不悄悄当本机会话，来源进操作记录，错了比没有更糟）。 */
export function fleetMcpSourceKind(env: NodeJS.ProcessEnv): FleetMcpSourceKind {
  const v = env.FLEET_MCP_SOURCE;
  if (v === undefined || v === '') return 'local-session';
  const hit = FLEET_MCP_SOURCE_KINDS.find((k) => k === v);
  if (!hit) throw new Error(`FLEET_MCP_SOURCE 认不出：${v}（只能是 ${FLEET_MCP_SOURCE_KINDS.join('、')}）`);
  return hit;
}

export interface ClaimRun {
  code: number;
  out: string[];
  err: string[];
}

export interface FleetMcpDeps {
  source: FleetMcpSourceKind;
  /** 法国地址和通行证；读不到抛错（每次调用时才读，装完通行证不用重启服务）。 */
  endpoint: () => ClaimsEndpoint;
  fetch: typeof fetch;
  /** 本机领单：真装配是 pnpm work claim <号> 的 work()；返回退出码和它打的行。 */
  claim: (issue: number) => Promise<ClaimRun>;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const show = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > BODY_SHOW_MAX ? `${s.slice(0, BODY_SHOW_MAX)}…（后面截掉了）` : s;
};
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface Reply {
  status: number;
  json: unknown;
  raw: string;
}

/** 调法国。网络不通、超时、通行证读不到都抛，由 guard 变成 isError；回包不是 JSON 时 json 是 undefined、raw 留着。 */
async function call(
  deps: FleetMcpDeps,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Reply> {
  const { url, token } = deps.endpoint();
  let res: Response;
  try {
    res = await deps.fetch(`${url.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        [TOKEN_HEADER]: token,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`法国没回（${msg(e)}）：这次没成，不知道法国那边有没有收到；先别当成做了`);
  }
  const raw = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, raw };
}

/** 非 2xx 或认不出的回包，原样把法国的话交给模型。 */
function refusal(what: string, r: Reply): ToolResult {
  const errMsg = isObj(r.json) && isObj(r.json.error) ? r.json.error.message : undefined;
  const lines = [`${what}没成：法国回 ${r.status}`];
  if (typeof errMsg === 'string') lines.push(errMsg);
  if (r.status === 401) lines.push('通行证缺或不对：重装本机会话上报（pnpm local-sessions install）');
  if (r.status === 503)
    lines.push('法国没查成（库、GitHub 或 Temporal 读不到），不知道有没有做成，别当成没做也别当成做了');
  lines.push(r.json === undefined ? `回的内容认不出：${show(r.raw)}` : `回包：${show(r.json)}`);
  return fail(lines.join('\n'));
}

async function guard(what: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return fail(`${what}没成：${msg(e)}`);
  }
}

const RepoArg = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/, 'owner/name')
  .default(DEFAULT_REPO)
  .describe(`仓，owner/name。不写就是 ${DEFAULT_REPO}。`);
const RefArg = z
  .string()
  .min(1)
  .max(100)
  .describe('这次是谁、因为什么：会话编号、相关单号之类的短指针，只进法国的操作记录，别放密码和长文。');

export const issueOpenInput = {
  repo: RepoArg,
  kind: z.enum(KIND_LABELS).describe('类别：需求（新功能、改规矩）、缺陷（出错了）、杂项（不属于前两样）。'),
  domain: z.enum(DOMAIN_VALUES).describe('域：engine 法国引擎、api 驾驶舱后端、mirasim。'),
  nature: z.enum(NATURE_VALUES).describe('性质：bug 出错、perf 性能、process 流程。'),
  milestone: z.enum(['当前', '未排期']).describe('当前＝这一周的版本；以后再做的写未排期。'),
  title: z.string().min(1).max(200).describe('一句话标题。'),
  body: z
    .string()
    .min(1)
    .describe(
      '正文，Markdown。要有「## 场景」「## 原话」「## 已知的模块」「## 怎么算做完」四节（缺陷再加写了字的「## 影响」），缺了法国会回 422 列出问题。',
    ),
  local: z
    .boolean()
    .describe(
      'true＝这张单自己在本机做（开完马上 fleet_claim），false＝交给法国引擎做（开完用 fleet_dispatch）。',
    ),
  ref: RefArg,
  idempotencyKey: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      '重试用的钥匙：同一钥匙重发不会开出第二张。不写就按仓、类别、标题、正文自动算，原样重试也安全。',
    ),
  force: z
    .boolean()
    .optional()
    .describe('法国说「像是已有的单」（409）时，确认真的是新事再写 true 硬开。先看候选，别一上来就写。'),
  mergeInto: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('409 候选里确实就是同一件事时，写那张单的号，把这次的内容并进去而不新开。'),
};

export const dispatchInput = {
  repo: RepoArg,
  issueNumber: z.number().int().positive().describe('要交给法国做的单号。'),
  ref: RefArg,
};

export const claimInput = {
  issueNumber: z.number().int().positive().describe('要在本机做的单号（本仓 fleet-dao 的单）。'),
};

export const eventsInput = {
  after: z
    .union([z.number().int().nonnegative(), z.string().min(1)])
    .optional()
    .describe('从这个事件编号之后读（上一次回包里的 next）。不写从头读。'),
  limit: z.number().int().min(1).max(200).default(50).describe('最多读几条，1 到 200，默认 50。'),
};

const IssueOpenArgs = z.object(issueOpenInput);
const DispatchArgs = z.object(dispatchInput);
const ClaimArgs = z.object(claimInput);
const EventsArgs = z.object(eventsInput);

export async function issueOpen(deps: FleetMcpDeps, a: z.infer<typeof IssueOpenArgs>): Promise<ToolResult> {
  return guard('开单', async () => {
    const idempotencyKey =
      a.idempotencyKey ??
      createHash('sha256').update([a.repo, a.kind, a.title, a.body].join('\n')).digest('hex').slice(0, 32);
    const r = await call(deps, 'POST', '/api/nodes/issues', {
      repo: a.repo,
      kind: a.kind,
      domain: a.domain,
      nature: a.nature,
      milestone: a.milestone,
      title: a.title,
      body: a.body,
      local: a.local,
      source: { kind: deps.source, ref: a.ref },
      idempotencyKey,
      ...(a.force !== undefined ? { force: a.force } : {}),
      ...(a.mergeInto !== undefined ? { mergeInto: a.mergeInto } : {}),
    });
    if (r.status === 409) {
      return fail(
        `没开：法国觉得和已有的单撞了（409）。候选在下面：确实是同一件事就带 mergeInto=<那张单号> 重来；确认是新事再带 force=true。\n回包：${show(r.json ?? r.raw)}`,
      );
    }
    if (r.status === 422) {
      return fail(`没开：单不合格（422），按下面的问题改了再来。\n回包：${show(r.json ?? r.raw)}`);
    }
    if (r.status < 200 || r.status >= 300) return refusal('开单', r);
    const j = r.json;
    if (!isObj(j) || typeof j.number !== 'number' || typeof j.url !== 'string') {
      return fail(
        `开单没确认：法国回 ${r.status}，但回包里没有 number 和 url，不知道开成没有。\n回包：${show(r.json ?? r.raw)}`,
      );
    }
    const head = j.created === false ? `已有同一份，没重复开：#${j.number}` : `已开单 #${j.number}`;
    const merged = j.merged !== undefined ? `\n并入情况：${show(j.merged)}` : '';
    return ok(`${head}\n${j.url}${merged}`);
  });
}

export async function dispatch(deps: FleetMcpDeps, a: z.infer<typeof DispatchArgs>): Promise<ToolResult> {
  return guard('派单', async () => {
    const r = await call(deps, 'POST', '/api/nodes/dispatch', {
      repo: a.repo,
      issueNumber: a.issueNumber,
      source: { kind: deps.source, ref: a.ref },
    });
    if (r.status === 409 && isObj(r.json) && r.json.result === 'refused') {
      const reasons = Array.isArray(r.json.reasons) ? r.json.reasons : [];
      const lines = reasons.map((x) =>
        isObj(x) ? `- ${String(x.reason)}：${String(x.why)}` : `- ${show(x)}`,
      );
      const text = typeof r.json.text === 'string' ? `\n${r.json.text}` : '';
      return fail(
        `没派：法国准入没过（${a.repo}#${a.issueNumber}），把下面每一条解决了再派，不能硬派。\n${lines.join('\n')}${text}`,
      );
    }
    if (r.status < 200 || r.status >= 300) return refusal('派单', r);
    if (!isObj(r.json) || r.json.result !== 'dispatched') {
      return fail(
        `派单没确认：法国回 ${r.status}，但回包不是 dispatched，不知道派成没有。\n回包：${show(r.json ?? r.raw)}`,
      );
    }
    const text = typeof r.json.text === 'string' && r.json.text !== '' ? `\n${r.json.text}` : '';
    return ok(`已交给法国做：${a.repo}#${a.issueNumber}${text}`);
  });
}

export async function claim(deps: FleetMcpDeps, a: z.infer<typeof ClaimArgs>): Promise<ToolResult> {
  return guard('领单', async () => {
    const run = await deps.claim(a.issueNumber);
    const lines = [...run.out, ...run.err].join('\n');
    if (run.code !== 0) return fail(`领单没成（退出码 ${run.code}）：\n${lines || '（没有输出）'}`);
    return ok(lines || `已领 #${a.issueNumber}`);
  });
}

export async function events(deps: FleetMcpDeps, a: z.infer<typeof EventsArgs>): Promise<ToolResult> {
  return guard('读账本', async () => {
    const q = new URLSearchParams();
    if (a.after !== undefined) q.set('after', String(a.after));
    q.set('limit', String(a.limit));
    const r = await call(deps, 'GET', `/api/nodes/events?${q.toString()}`);
    if (r.status < 200 || r.status >= 300) return refusal('读账本', r);
    if (!isObj(r.json) || !Array.isArray(r.json.events)) {
      return fail(
        `读账本没确认：法国回 ${r.status}，但回包里没有 events 数组。\n回包：${show(r.json ?? r.raw)}`,
      );
    }
    const list = r.json.events as unknown[];
    const next = r.json.next ?? null;
    const head = `共 ${list.length} 条${next === null ? '，读到头了' : `，接着读用 after=${String(next)}`}`;
    return ok(`${head}\n${JSON.stringify({ events: list, next }, null, 2)}`);
  });
}

/** 装 4 个工具的 MCP 服务（还没连传输）。 */
export function createFleetMcpServer(deps: FleetMcpDeps): McpServer {
  const server = new McpServer({ name: 'fleet', version: '0.0.0' });
  server.registerTool(
    'fleet_issue_open',
    {
      description:
        '给法国开一张单。只用于要合 PR、要跨会话接力、或要创始人验收的事。' +
        '不要为拆出来的小步骤、一次会话内自己做完的小事、聊天里的想法开单（那些记在会话里或子代理里就行）。' +
        '开之前先想清楚类别、域、性质、里程碑，正文四节写全。法国说撞了已有的单（409）会回候选，别硬开：同一件事用 mergeInto，确认是新事才 force。',
      inputSchema: issueOpenInput,
    },
    (a) => issueOpen(deps, IssueOpenArgs.parse(a)),
  );
  server.registerTool(
    'fleet_dispatch',
    {
      description:
        '把一张已经开好的单交给法国引擎去做（写码、开 PR、合并）。用于「这件事让法国做」。' +
        '不要用于自己在本机做的单（那用 fleet_claim）；单还没开先用 fleet_issue_open。' +
        '法国会先过准入，不过就回原因（409），照原因处理，没有硬派的口子。回 503 是没查成，不知道派没派，先用 fleet_events 看账本再决定。',
      inputSchema: dispatchInput,
    },
    (a) => dispatch(deps, DispatchArgs.parse(a)),
  );
  server.registerTool(
    'fleet_claim',
    {
      description:
        '在本机领一张本仓（fleet-dao）的单，自己动手做：法国登记一行并给两小时租约，法国引擎就不会去接它。' +
        '做之前先领，别不领就开 PR。不要用于交给法国做的单（那用 fleet_dispatch）。引擎正在跑或排着的单领不了，会回原因。',
      inputSchema: claimInput,
    },
    (a) => claim(deps, ClaimArgs.parse(a)),
  );
  server.registerTool(
    'fleet_events',
    {
      description:
        '读法国的操作账本（谁在什么时候对什么做了什么、成没成）。用于确认开单、派单有没有落下，或看最近发生了什么。' +
        '只读，不改任何东西。翻页用上次回包里的 next 当 after。',
      inputSchema: eventsInput,
    },
    (a) => events(deps, EventsArgs.parse(a)),
  );
  return server;
}
