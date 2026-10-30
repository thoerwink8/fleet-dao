// pnpm issue:new 开单先走法国的开单服务（决定 0122，#3739 第 2 片）：POST <法国地址>/api/nodes/issues，
// 机器通行证放请求头 X-Fleet-Node-Token，地址和通行证读法同 pnpm work claim（work.ts 的 readClaimsEndpoint）。
// 本文件只管「发一次、把回包认成四种结果」，不碰 gh、不碰本机校验：
// - created：开了（或并进了别的单）；
// - fallback：法国没接上（读不到配置、连不上、超时、401、404、503），调用方退回 gh 直连开单并打 why；
// - refused：法国明确拒了（409 同题强命中、422 正文问题），调用方原样报出、退出码 1，不退回；
// - 其余没说准的（200 但认不出、别的状态码）：抛错，开没开说不准，不退回（退回会开重复的单）。
// 零安装区引不了包：请求、回包形状按第 1 片的约定手写，字段名对不上以第 1 片 shared schema 为准。
import { createHash } from 'node:crypto';
import { type ClaimsEndpoint, readClaimsEndpoint } from './work.ts';

export const INTAKE_URL_PATH = '/api/nodes/issues';
/** 和 work.ts 的 TOKEN_HEADER、shared 的 NODE_REPORT_HEADER 同一个头。 */
export const INTAKE_TOKEN_HEADER = 'X-Fleet-Node-Token';
const POST_TIMEOUT_MS = 30_000;

/** 发给法国的那一条（第 1 片约定）。 */
export interface IntakeBody {
  repo: string;
  kind: string;
  domain: string;
  nature: string;
  milestone: '当前' | '未排期';
  title: string;
  body: string;
  local: boolean;
  source: { kind: 'local-session'; ref: string };
  idempotencyKey: string;
  force?: true;
  mergeInto?: number;
}

export type IntakePost = (body: IntakeBody) => Promise<{ status: number; text: string }>;

/** 入口传进 issueNew 的法国开单通道。 */
export interface FranceIntake {
  /** owner/name：开给哪个仓。 */
  repo: string;
  /** 本机会话号；拿不到时机器名加时间。 */
  ref: string;
  post: IntakePost;
}

export type IntakeOutcome =
  | { kind: 'created'; number: number; url: string; created: boolean; merged: boolean }
  | { kind: 'fallback'; why: string }
  | { kind: 'refused'; lines: string[] };

/** 同一次重试不会开两张：标题加正文的摘要。 */
export function idempotencyKeyOf(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`).digest('hex');
}

/** 真发：地址、通行证读不到时抛错（调用方当「没接上」退回）；超时、断连抛带原因的错，通行证不进错误信息。 */
export function liveIntakePost(
  endpoint: () => ClaimsEndpoint = readClaimsEndpoint,
  fetchImpl: typeof fetch = fetch,
): IntakePost {
  return async (body) => {
    const { url, token } = endpoint();
    try {
      const res = await fetchImpl(`${url.replace(/\/+$/, '')}${INTAKE_URL_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [INTAKE_TOKEN_HEADER]: token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      const name = (e as { name?: unknown } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Error(`${POST_TIMEOUT_MS / 1000} 秒内没回（超时）`);
      }
      throw new Error(msg(e).replaceAll(token, '***'));
    }
  };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const oneLine = (s: string, max = 300) => s.trim().replace(/\s+/g, ' ').slice(0, max);

function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** 找一个数组：法国（api 的 errorBody）放在 error.details 下；顶层、error 下也看一眼，认不出回 undefined。 */
function listOf(body: Record<string, unknown> | undefined, keys: string[]): unknown[] | undefined {
  const error = asObject(body?.error);
  for (const holder of [asObject(error?.details), error, body]) {
    for (const k of keys) {
      const v = holder?.[k];
      if (Array.isArray(v) && v.length > 0) return v;
    }
  }
  return undefined;
}

function errorMessage(body: Record<string, unknown> | undefined): string {
  const m = asObject(body?.error)?.message;
  return typeof m === 'string' ? oneLine(m) : '';
}

function describeCandidate(c: unknown): string {
  const o = asObject(c);
  if (!o) return `  - ${oneLine(String(c), 200)}`;
  const num = o.number ?? o.issueNumber;
  const title = typeof o.title === 'string' ? o.title : '';
  const score = typeof o.score === 'number' ? `，分数 ${o.score}` : '';
  const whyRaw = o.why ?? o.reason ?? o.reasons;
  const why = Array.isArray(whyRaw)
    ? whyRaw.map(String).join('；')
    : typeof whyRaw === 'string'
      ? whyRaw
      : '';
  return `  - #${String(num ?? '?')} ${oneLine(title, 120)}${score}${why ? `，为什么像：${oneLine(why, 200)}` : ''}`;
}

function describeProblem(p: unknown): string {
  const o = asObject(p);
  if (!o) return `  - ${oneLine(String(p), 300)}`;
  const m = o.message ?? o.why ?? o.problem ?? o.reason;
  return `  - ${typeof m === 'string' ? oneLine(m, 300) : oneLine(JSON.stringify(o), 300)}`;
}

/** 发一次开单请求并把回包认成结果；从不因为「没接上」抛错（那是 fallback），认不出的回包才抛。 */
export async function intakeViaFrance(post: IntakePost, body: IntakeBody): Promise<IntakeOutcome> {
  let res: { status: number; text: string };
  try {
    res = await post(body);
  } catch (e) {
    return { kind: 'fallback', why: `连不上法国开单接口（${oneLine(msg(e), 200)}）` };
  }
  const json = parseJson(res.text);
  if (res.status === 200) {
    const n = json?.number;
    const url = json?.url;
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0 || typeof url !== 'string' || url === '') {
      throw new Error(
        `法国开单接口回 200，可回包认不出单号和网址：${oneLine(res.text) || '（空）'}。单可能已经开了，去 GitHub 按标题「${body.title}」找一下，不要重跑。`,
      );
    }
    return {
      kind: 'created',
      number: n,
      url,
      created: json?.created !== false,
      merged: json?.merged === true,
    };
  }
  if (res.status === 409) {
    const cands = listOf(json, ['candidates', 'similar', 'matches']);
    const lines = [
      `法国查到同题强命中的单，没开（HTTP 409）${errorMessage(json) ? `：${errorMessage(json)}` : ''}`,
      ...(cands ? cands.map(describeCandidate) : [`  （候选列表没认出：${oneLine(res.text) || '空'}）`]),
      '下一步：确实是新的就加 --force 照开；其实是同一件事就加 --merge-into <号> 并进那张单。',
    ];
    return { kind: 'refused', lines };
  }
  if (res.status === 422) {
    const problems = listOf(json, ['problems', 'issues', 'errors', 'details']);
    const lines = [
      `法国查正文有问题，没开（HTTP 422）${errorMessage(json) ? `：${errorMessage(json)}` : ''}`,
      ...(problems ? problems.map(describeProblem) : [`  （问题列表没认出：${oneLine(res.text) || '空'}）`]),
    ];
    return { kind: 'refused', lines };
  }
  if (res.status === 401) {
    return {
      kind: 'fallback',
      // 法国没这个路由时也落到登录那一层回 401（开单服务还没发上去），所以两种可能都写上
      why: '法国回 HTTP 401：要么开单接口还没发到法国（看法国在用的版本），要么本机机器通行证不对（pnpm local-sessions install --url <法国地址>）',
    };
  }
  if (res.status === 404) return { kind: 'fallback', why: '法国回 HTTP 404，开单接口可能还没上线' };
  if (res.status === 503) {
    return {
      kind: 'fallback',
      why: `法国没接上 GitHub（HTTP 503）${errorMessage(json) ? `：${errorMessage(json)}` : ''}`,
    };
  }
  throw new Error(
    `法国开单接口回了没料到的 HTTP ${res.status}：${errorMessage(json) || oneLine(res.text) || '（空）'}。开没开说不准，去 GitHub 按标题「${body.title}」找一下再决定，不自动退回 gh（会开重复的单）。`,
  );
}
