// 本机领单（决定 0096）：pnpm work claim|renew|done <单号>。本机会话要做一张单，先在法国的 tasks 登记（executor = local、带 2 小时租约），
// 法国拉单看见就不接；本机会话死了，租约到期法国收回、退回法国队列。判法和租约在 shared 的 local-claims.ts。
//
// claim：先查这张单有没有开着的 PR（「需求」栏挂着、或分支是 fleet/<单号>-、local/<单号>-）→ 有就停下不领；再经 /api/nodes/claims 登记
//        （引擎手上有它就回 409，停下不领）→ 贴「本机做」→ 打出要用的分支名 local/<单号>-<短名>。
// renew：续租（会话在 local/<单号>- 分支上动着、或开着 PR 挂着这张单，法国自己会顺延，不用手动续；跑超过 2 小时的长测试前续一下）。
// done：做完（PR 合了）记 done；--failed "原因" 记没做成（还是本机的账，法国不自动接）；--release "原因" 放手，退回法国队列。
//
// 改这里之前必须知道：
// - 写法国只用本机会话心跳同一个通行证（~/.fleet-dao/local-sessions/config.json 的 url、token，pnpm local-sessions install 写的），
//   本机不放机器人凭据。读不到配置、法国不回，照实报「没登记上」、退出码 1，不当成领到了。
// - 通行证只放进请求头，不打印。
// 退出码：0 成了；1 没成（原因打在 stderr）。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  LOCAL_CLAIMS_PATH,
  type LocalClaimRequest,
  LocalClaimResponseSchema,
  localBranchPrefix,
} from '@fleet-dao/shared';
import type { Gh } from './issue-new.ts';
import { LOCAL_LABEL } from './labels.ts';
import { type OpenPullRef, otherPrOnIssue } from './pr-claims.ts';

/** 和 agents/local-sessions/lib.mjs 的 TOKEN_HEADER 同一个头。 */
const TOKEN_HEADER = 'X-Fleet-Node-Token';
const POST_TIMEOUT_MS = 20_000;

export const WORK_USAGE =
  '用法：pnpm work claim <单号> | pnpm work renew <单号> | pnpm work done <单号> [--failed "原因" | --release "原因"]';

export interface ClaimsEndpoint {
  url: string;
  token: string;
}

/** 本机会话心跳的配置（pnpm local-sessions install 写的）里的法国地址和通行证。读不到、认不出抛错，写明怎么补。 */
export function readClaimsEndpoint(home = homedir()): ClaimsEndpoint {
  const path = join(home, '.fleet-dao', 'local-sessions', 'config.json');
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(
      `读不到 ${path}（${e instanceof Error ? e.message : String(e)}）：先装本机会话上报 pnpm local-sessions install --url <法国地址>`,
    );
  }
  const c = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  if (typeof c.url !== 'string' || !/^https?:\/\//.test(c.url)) throw new Error(`${path} 里 url 不对`);
  if (typeof c.token !== 'string' || c.token === '') throw new Error(`${path} 里没有 token`);
  return { url: c.url, token: c.token };
}

export type ClaimsPost = (body: LocalClaimRequest) => Promise<{ status: number; text: string }>;

/** 真发：POST <法国地址>/api/nodes/claims，通行证放请求头。 */
export function liveClaimsPost(endpoint: () => ClaimsEndpoint, fetchImpl: typeof fetch = fetch): ClaimsPost {
  return async (body) => {
    const { url, token } = endpoint();
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/api${LOCAL_CLAIMS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return { status: res.status, text: await res.text() };
  };
}

export interface WorkDeps {
  gh: Gh;
  post: ClaimsPost;
  out: (line: string) => void;
  err: (line: string) => void;
}

interface Parsed {
  action: 'claim' | 'renew' | 'done';
  issue: number;
  failed?: string;
  release?: string;
}

function parse(argv: readonly string[]): Parsed {
  const [action, n, ...rest] = argv;
  if (action !== 'claim' && action !== 'renew' && action !== 'done') throw new Error(WORK_USAGE);
  const issue = Number(n);
  if (!Number.isSafeInteger(issue) || issue <= 0)
    throw new Error(`单号要是正整数：${n ?? '（没给）'}。${WORK_USAGE}`);
  const out: Parsed = { action, issue };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (
      (flag === '--failed' || flag === '--release') &&
      action === 'done' &&
      value &&
      !value.startsWith('--')
    ) {
      if (flag === '--failed') out.failed = value;
      else out.release = value;
      i += 1;
      continue;
    }
    throw new Error(`认不出的参数：${flag}。${WORK_USAGE}`);
  }
  if (out.failed !== undefined && out.release !== undefined)
    throw new Error('--failed 和 --release 只能给一个');
  return out;
}

async function ghJson(gh: Gh, args: string[], what: string): Promise<unknown> {
  const r = await gh(args);
  if (r.code !== 0) throw new Error(`${what}没读成（gh 退出码 ${r.code}）：${(r.stderr || r.stdout).trim()}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`${what}：gh 回的不是 JSON`);
  }
}

/** 这个仓的 owner/name（gh 认的当前仓）。 */
async function repoSlug(gh: Gh): Promise<string> {
  const v = (await ghJson(gh, ['repo', 'view', '--json', 'nameWithOwner'], '当前仓')) as {
    nameWithOwner?: unknown;
  };
  if (typeof v.nameWithOwner !== 'string') throw new Error('当前仓认不出（gh repo view 没给 nameWithOwner）');
  return v.nameWithOwner;
}

/** 这个仓开着的 PR（号、正文、分支）。翻不全就抛：不当成没有。 */
export async function openPulls(gh: Gh): Promise<OpenPullRef[]> {
  const v = await ghJson(
    gh,
    ['pr', 'list', '--state', 'open', '--limit', '500', '--json', 'number,body,headRefName'],
    '开着的 PR',
  );
  if (!Array.isArray(v)) throw new Error('开着的 PR：gh 回的不是列表');
  if (v.length >= 500) throw new Error('开着的 PR 有 500 个以上，没翻全，不判');
  return v.map((p: { number?: unknown; body?: unknown; headRefName?: unknown }) => {
    if (typeof p.number !== 'number' || typeof p.headRefName !== 'string')
      throw new Error('开着的 PR 认不出');
    return { number: p.number, body: typeof p.body === 'string' ? p.body : '', headRef: p.headRefName };
  });
}

/** 分支名里的短名：标题里的字母数字，最多 30 个字符；一个都没有就用 work。 */
export function branchSlug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
  return s || 'work';
}

async function send(
  deps: WorkDeps,
  body: LocalClaimRequest,
): Promise<{ ok: true; leaseUntil: string | null }> {
  let res: { status: number; text: string };
  try {
    res = await deps.post(body);
  } catch (e) {
    throw new Error(`没登记上：法国没回（${e instanceof Error ? e.message : String(e)}）`);
  }
  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new Error(`没登记上：法国回 ${res.status}，内容认不出：${res.text.slice(0, 200)}`);
  }
  if (res.status >= 200 && res.status < 300) {
    const parsed = LocalClaimResponseSchema.safeParse(json);
    if (!parsed.success || !parsed.data.ok) throw new Error(`没登记上：法国回 ${res.status}，内容认不出`);
    return { ok: true, leaseUntil: parsed.data.leaseUntil };
  }
  const why = (json as { error?: { message?: unknown } })?.error?.message;
  throw new Error(
    `没登记上：法国回 ${res.status}：${typeof why === 'string' ? why : res.text.slice(0, 200)}`,
  );
}

export async function work(argv: readonly string[], deps: WorkDeps): Promise<number> {
  try {
    const p = parse(argv);
    const repo = await repoSlug(deps.gh);
    if (p.action === 'claim') {
      const issue = (await ghJson(
        deps.gh,
        ['issue', 'view', String(p.issue), '--json', 'title,state'],
        `#${p.issue}`,
      )) as {
        title?: unknown;
        state?: unknown;
      };
      if (issue.state !== 'OPEN') throw new Error(`#${p.issue} 不是开着的单（${String(issue.state)}），不领`);
      const title =
        typeof issue.title === 'string' && issue.title.trim() ? issue.title.trim() : `#${p.issue}`;
      const other = otherPrOnIssue(await openPulls(deps.gh), p.issue, null);
      if (other !== null) {
        throw new Error(`#${p.issue} 已经有开着的 PR #${other} 在做，不再领、不重复做：先看 #${other}`);
      }
      const got = await send(deps, { action: 'claim', repo, issue: p.issue, title: title.slice(0, 300) });
      const label = await deps.gh(['issue', 'edit', String(p.issue), '--add-label', LOCAL_LABEL]);
      if (label.code !== 0) {
        deps.err(
          `提示：登记上了，可「${LOCAL_LABEL}」没贴上（${(label.stderr || label.stdout).trim()}）；法国照样不接（看的是登记），手动补贴即可`,
        );
      }
      deps.out(
        `领了 #${p.issue}（租约到 ${got.leaseUntil ?? '？'}）。分支用：${localBranchPrefix(p.issue)}${branchSlug(title)}`,
      );
      deps.out(`做完 pnpm work done ${p.issue}；放手 pnpm work done ${p.issue} --release "原因"`);
      return 0;
    }
    if (p.action === 'renew') {
      const got = await send(deps, { action: 'renew', repo, issue: p.issue });
      deps.out(`续上了 #${p.issue}（租约到 ${got.leaseUntil ?? '？'}）`);
      return 0;
    }
    const outcome = p.failed !== undefined ? 'failed' : p.release !== undefined ? 'released' : 'done';
    const reason = p.failed ?? p.release;
    await send(deps, { action: 'finish', repo, issue: p.issue, outcome, ...(reason ? { reason } : {}) });
    if (outcome === 'released') {
      const label = await deps.gh(['issue', 'edit', String(p.issue), '--remove-label', LOCAL_LABEL]);
      if (label.code !== 0) {
        deps.err(
          `提示：放手登记上了，可「${LOCAL_LABEL}」没摘掉（${(label.stderr || label.stdout).trim()}）：不摘法国不接，手动摘`,
        );
        return 1;
      }
    }
    deps.out(
      outcome === 'done'
        ? `#${p.issue} 记做完`
        : outcome === 'failed'
          ? `#${p.issue} 记没做成：${reason}`
          : `#${p.issue} 放手，退回法国队列：${reason}`,
    );
    return 0;
  } catch (e) {
    deps.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
