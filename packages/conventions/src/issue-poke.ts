// 开单顺手戳法国接单（决定 0096 A6，决定 0122 改走接口）：开给法国的单开完，调一次法国的 POST /api/nodes/dispatch，
// 让引擎立刻接，不等 5 分钟一轮的拉单。法国那头复用 fleet-api dispatch-issue（不带 --force）的准入，这里也不带 force。
// 只是加速：戳不成（连不上、通行证不对、准入没过、没查成）不影响开单，拉单照旧兜底；但每种没戳成都要照实说，不能静默当成已经派了。
// 法国地址和机器通行证读 pnpm local-sessions install 写的那份配置（work.ts 的 readClaimsEndpoint，和 pnpm work 领单同一份）。
// 零安装区引不了包：请求、回包形状按 shared 的 node-dispatch.ts 手写，test/issue-poke.test.ts 钉着路径、请求头一致。
import { type ClaimsEndpoint, readClaimsEndpoint } from './work.ts';

/** 发给法国的那一条：形状和 shared 的 NodeDispatchRequestSchema 一致（法国按它 strict 收，多一个字段 400）。 */
export interface DispatchBody {
  repo: string;
  issueNumber: number;
  source: { kind: 'local-session'; ref: string };
}

export interface PokeDeps {
  /** 发一次 POST /api/nodes/dispatch；读不到配置、连不上、超时抛错（message 写原因），收到响应就返回状态和正文。 */
  post: (body: DispatchBody) => Promise<{ status: number; text: string }>;
}

/** 和 shared 的 NODE_DISPATCH_FULL_PATH、NODE_REPORT_HEADER 同一个值。 */
export const DISPATCH_URL_PATH = '/api/nodes/dispatch';
export const DISPATCH_TOKEN_HEADER = 'X-Fleet-Node-Token';
/** 法国那头起 dispatch-issue 本体最多等 60 秒，这里多留几秒，让它自己的失败原因能回得来。 */
const POST_TIMEOUT_MS = 65_000;

const SINGLE = /^[\w.-]+\/[\w.-]+$/;

/** 从单的网址认出 owner/仓名 和单号；认不出回 undefined。 */
export function parseIssueUrl(url: string): { repo: string; number: number } | undefined {
  const m = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url.trim());
  if (!m?.[1] || !m[2] || !SINGLE.test(m[1])) return undefined;
  return { repo: m[1], number: Number(m[2]) };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const oneLine = (s: string, max = 300) => s.trim().replace(/\s+/g, ' ').slice(0, max);

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** 出错 body 里的 {"error":{"code","message"}}，认不出是空串。 */
function errorOf(body: Record<string, unknown> | undefined): { code: string; message: string } {
  const e = body?.error;
  if (typeof e !== 'object' || e === null) return { code: '', message: '' };
  const { code, message } = e as { code?: unknown; message?: unknown };
  return {
    code: typeof code === 'string' && /^[\w.-]{1,64}$/.test(code) ? code : '',
    message: typeof message === 'string' ? oneLine(message) : '',
  };
}

export async function pokeFrance(url: string, deps: PokeDeps = realDeps()): Promise<string> {
  const head = '没戳法国接单（单已开，5 分钟一轮的拉单照旧会接）：';
  const issue = parseIssueUrl(url);
  if (!issue) return `${head}认不出单的网址「${url}」。`;
  let res: { status: number; text: string };
  try {
    res = await deps.post({
      repo: issue.repo,
      issueNumber: issue.number,
      source: { kind: 'local-session', ref: String(issue.number) },
    });
  } catch (e) {
    return `${head}连不上法国派单接口（${oneLine(msg(e), 200)}）。`;
  }
  const body = parseJson(res.text);
  if (res.status === 200 && body?.result === 'dispatched') {
    return `已戳法国接单（dispatch #${issue.number}）：${typeof body.text === 'string' && body.text ? oneLine(body.text) : '派了'}`;
  }
  if (res.status === 409 && body?.result === 'refused' && Array.isArray(body.reasons)) {
    const reasons = body.reasons
      .map((r: unknown) => {
        const { reason, why } = (r ?? {}) as { reason?: unknown; why?: unknown };
        return typeof reason === 'string'
          ? `${reason}${typeof why === 'string' ? `（${oneLine(why, 120)}）` : ''}`
          : '';
      })
      .filter((s: string) => s !== '');
    if (reasons.length > 0) return `${head}法国的准入没过：${reasons.join('；')}。`;
  }
  const { code, message } = errorOf(body);
  const tag = code ? `（${code}）` : '';
  if (res.status === 401)
    return `${head}法国不认本机通行证（HTTP 401${tag}）：${message || '重装 pnpm local-sessions install 换新的'}。`;
  if (res.status === 404) return `${head}法国回 HTTP 404${tag}，派单接口可能还没上线。`;
  if (res.status === 503)
    return `${head}法国没查成，不知道派没派（HTTP 503${tag}）：${message || oneLine(res.text) || '没有说明'}。`;
  return `${head}法国回 HTTP ${res.status}${tag}：${message || oneLine(res.text) || '没有输出'}。`;
}

function realDeps(): PokeDeps {
  return {
    post: async (body) => {
      const { url, token }: ClaimsEndpoint = readClaimsEndpoint();
      try {
        const res = await fetch(`${url.replace(/\/+$/, '')}${DISPATCH_URL_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [DISPATCH_TOKEN_HEADER]: token },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });
        return { status: res.status, text: await res.text() };
      } catch (e) {
        // 通行证只放请求头，错误信息里万一带了也抹掉
        const name = (e as { name?: unknown } | null)?.name;
        if (name === 'TimeoutError' || name === 'AbortError')
          throw new Error(`${POST_TIMEOUT_MS / 1000} 秒内没回（超时）`);
        throw new Error(msg(e).replaceAll(token, '***'));
      }
    },
  };
}
