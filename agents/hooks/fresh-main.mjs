// 取远端，取不成换一条路再取一次：开会话钩子（session-start.mjs）和起子代理前的钩子（pretool.mjs）共用。
//
// 为什么有它（创始人 2026-10-05：「其他分支做任务前，没有让 main 追平 origin/main，导致做的内容会落后」）：
// 子代理的工作树是从**本地记着的** origin/main 切出来的，建树那一刻不会去取远端；本机取不到远端时
// origin/main 就停在隔夜的提交上，子代理在旧代码上干活、开出来的 PR 一堆冲突。
//
// 改这里之前必须知道：
// - 这台机器上 Claude Code、reclaude、Mirasim 经 `HTTP(S)_PROXY=http://127.0.0.1:59822`（reclaude 自己的本地口）出网，
//   那是它们**正经的路**：先按进程环境原样取，**不改、不删环境里的代理**。只有这一次没取成才换直连再取一次。
// - 59822 在会话刚起来的那一刻可能还没在听（`over proxy 127.0.0.1 after 0 ms: Could not connect`，连接被拒，
//   不是代理坏了）：被拒当场就失败，所以第二次直连不会多花多少时间。代理挂着不回话的慢失败，靠每次各自的超时兜住。
// - 两次都没成，把两次各自为什么写在一起返回；绝不把「没取成」说成成功（调用方据此明说「没查成」或拦下）。
// - 只管 fetch，不动工作区、不动本地分支（钩子里改检出太冒险；追平本地 main 另有开会话钩子里的快进）。

import { spawnSync } from 'node:child_process';

/** @typedef {{ status: number | null, stdout: string, stderr: string, error?: (Error & { code?: string }) | undefined, timeoutMs?: number }} GitResult 一次 git 命令的结果 */

/** 直连时要从环境里拿掉的变量（大小写、ALL_PROXY 都算） */
export const PROXY_VARS = [
  'https_proxy',
  'http_proxy',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'all_proxy',
  'ALL_PROXY',
];

/** 环境里有没有设代理（任一个非空） */
export function hasProxy(env = process.env) {
  return PROXY_VARS.some((k) => typeof env[k] === 'string' && env[k] !== '');
}

/** 去掉代理变量的环境副本（NO_PROXY 不动：它只说哪些地址不走代理，留着无害） */
export function withoutProxy(env = process.env) {
  const out = { ...env };
  for (const k of PROXY_VARS) delete out[k];
  return out;
}

/**
 * 取远端：先照环境原样，没成且环境里设着代理，再去掉代理取一次。
 * `git(cwd, args, opts)` 是各钩子注入的 git 跑法；`opts.direct` 为 true 时它要用去掉代理的环境跑。
 * `okOf(r)` 判一次成没成，`whyOf(r)` 说一次为什么没成（各钩子自己的那一份，口径和它们别处一致）。
 * 返回 { ok, via, why }：via 是最后成了（或最后试的）那条路 'env' | 'direct'；ok 为 false 时 why 带两次各自的原因。
 * @param {(cwd: string, args: string[], opts?: { direct?: boolean }) => GitResult} git
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ okOf: (r: GitResult) => boolean, whyOf: (r: GitResult) => string, env?: Record<string, string | undefined> }} h
 * @returns {{ ok: boolean, via: 'env' | 'direct', why: string }}
 */
export function fetchWithFallback(git, cwd, args, h) {
  const first = git(cwd, args);
  if (h.okOf(first)) return { ok: true, via: 'env', why: '' };
  const proxied = hasProxy(h.env ?? process.env);
  if (!proxied) return { ok: false, via: 'env', why: h.whyOf(first) };
  const second = git(cwd, args, { direct: true });
  if (h.okOf(second)) return { ok: true, via: 'direct', why: '' };
  return {
    ok: false,
    via: 'direct',
    why: `经环境里的代理没成（${h.whyOf(first)}）；去掉代理直连也没成（${h.whyOf(second)}）`,
  };
}

/**
 * 起子代理前取远端的时间预算：调工具前钩子总共只有 10 秒（targets.ts），两次加起来要留出余量。
 * 首选路（环境里的代理，reclaude 的口）给 6 秒——2026-10-05 同时起了十来个子代理，代理瞬时慢过 4 秒，三个带工作树的子代理被误拦；
 * 直连只是兜底给 3 秒（这台机器上直连经常直接超时，实测 21 秒才报错）。
 */
export const SUBAGENT_FETCH_MS = 6_000;
export const SUBAGENT_DIRECT_MS = 3_000;

/**
 * 起子代理（Agent / Task）之前，把 origin/main 取到最新：子代理的工作树从它切（见文件头）。
 * 取成了、不是 Agent/Task、不在 git 仓里、没有 origin：什么都不说（返回 null）。
 * 取不成：要建工作树的（isolation 是 worktree）拦下，说清 origin/main 停在多久以前；不建工作树的不拦（它不从 origin/main 切）。
 * `git(cwd, args, opts)` 同 fetchWithFallback；不抛。
 * @param {{ tool: unknown, toolInput: unknown, cwd: string, git: (cwd: string, args: string[], opts?: { direct?: boolean }) => GitResult, okOf: (r: GitResult) => boolean, whyOf: (r: GitResult) => string, env?: Record<string, string | undefined> }} o
 * @returns {{ block: true, message: string } | null}
 */
export function freshBeforeSubagent(o) {
  if (o.tool !== 'Agent' && o.tool !== 'Task') return null;
  const inside = o.git(o.cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!o.okOf(inside) || String(inside.stdout ?? '').trim() !== 'true') return null;
  if (!o.okOf(o.git(o.cwd, ['remote', 'get-url', 'origin']))) return null;
  const got = fetchWithFallback(o.git, o.cwd, ['fetch', '-q', 'origin', 'main'], {
    okOf: o.okOf,
    whyOf: o.whyOf,
    ...(o.env ? { env: o.env } : {}),
  });
  if (got.ok) return null;
  const isolation =
    typeof o.toolInput === 'object' && o.toolInput !== null && 'isolation' in o.toolInput
      ? o.toolInput.isolation
      : undefined;
  if (isolation !== 'worktree') return null;
  const age = o.git(o.cwd, ['log', '-1', '--format=%h（%cr）', 'refs/remotes/origin/main']);
  const at = o.okOf(age) ? String(age.stdout ?? '').trim() : '认不出';
  return {
    block: true,
    message:
      `fleet-guard：要给子代理建工作树，但本机取不到远端（${got.why}）。本机记着的 origin/main 停在 ${at}，` +
      '子代理会在旧代码上干活、开出来的 PR 满是冲突。先让网络通了再起（自己跑一遍 git fetch origin 看报什么），' +
      '或者这次不用 isolation: "worktree"、在交代里写明开工第一步先 git fetch origin main 再 git rebase origin/main。',
  };
}

/** 钩子里跑 git 的一份：opts.direct 为 true 时去掉代理；返回 { status, stdout, stderr, error, timeoutMs } */
export function gitCall(/** @type {number} */ timeoutMs, /** @type {number} */ directTimeoutMs = timeoutMs) {
  return (
    /** @type {string} */ cwd,
    /** @type {string[]} */ args,
    /** @type {{ direct?: boolean }} */ opts = {},
  ) => {
    const r = spawnSync('git', args, {
      cwd,
      ...(opts.direct ? { env: withoutProxy() } : {}),
      encoding: 'utf8',
      timeout: opts.direct ? directTimeoutMs : timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error, timeoutMs };
  };
}

/** 一次 git 成没成 */
export const gitOk = (/** @type {GitResult} */ r) => r.status === 0 && !r.error;

/** 一次 git 为什么没成：超时、起不来，或输出的第一行 */
export function gitWhy(/** @type {GitResult} */ r) {
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') return `超过 ${Math.round((r.timeoutMs ?? 0) / 1000)} 秒没完`;
    return `起不来：${r.error.message}`;
  }
  const first = `${r.stderr ?? ''}\n${r.stdout ?? ''}`
    .split(/\r?\n/)
    .map((/** @type {string} */ l) => l.trim())
    .find(Boolean);
  return first ?? `退出码 ${r.status}`;
}
