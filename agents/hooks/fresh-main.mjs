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
// - 同一个仓三分钟内刚取成过就不再取（记在 ~/.fleet-dao/fetch-ok/）。开会话钩子取成功也会记一笔，
//   接着起的子代理不再各付一次 6 秒。取失败不记：要建工作树的子代理仍拦，下一轮还会再试。

import { createHash } from 'node:crypto';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { hasProxy } from './git-run.mjs';

/** @typedef {import('./git-run.mjs').GitResult} GitResult 一次 git 命令的结果 */

/**
 * 这次失败是不是「几个进程同时在取同一个远端、别人刚把引用更新了」的竞争：
 * 2026-10-05 同时起十来个子代理时撞到 `cannot lock ref 'refs/remotes/origin/main': is at A but expected B`，
 * 被误当成取不到远端、拦了子代理——其实 origin/main 刚被别人更新到最新。这种失败原路再取一次就好，不是网络问题。
 * @param {GitResult} r
 */
export function isRefRace(r) {
  return /cannot lock ref|unable to update local ref/i.test(`${r.stderr ?? ''}${r.stdout ?? ''}`);
}

/**
 * 取远端：先照环境原样，没成且环境里设着代理，再去掉代理取一次。
 * `git(cwd, args, opts)` 是各钩子注入的 git 跑法；`opts.direct` 为 true 时它要用去掉代理的环境跑。
 * `okOf(r)` 判一次成没成，`whyOf(r)` 说一次为什么没成（一般就是 git-run.mjs 的 gitOk、gitWhy）。
 * 返回 { ok, via, why }：via 是最后成了（或最后试的）那条路 'env' | 'direct'；ok 为 false 时 why 带两次各自的原因。
 * @param {(cwd: string, args: string[], opts?: { direct?: boolean }) => GitResult} git
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ okOf: (r: GitResult) => boolean, whyOf: (r: GitResult) => string, env?: Record<string, string | undefined> }} h
 * @returns {{ ok: boolean, via: 'env' | 'direct', why: string }}
 */
export function fetchWithFallback(git, cwd, args, h) {
  /** 同一条路上跑一次；撞上「别的进程刚更新了这个引用」的竞争就原路再来（最多 2 次），不当成网络不通 */
  const attempt = (/** @type {{ direct?: boolean } | undefined} */ opts) => {
    let r = opts ? git(cwd, args, opts) : git(cwd, args);
    for (let i = 0; i < 2 && !h.okOf(r) && isRefRace(r); i += 1)
      r = opts ? git(cwd, args, opts) : git(cwd, args);
    return r;
  };
  const first = attempt(undefined);
  if (h.okOf(first)) return { ok: true, via: 'env', why: '' };
  const proxied = hasProxy(h.env ?? process.env);
  if (!proxied) return { ok: false, via: 'env', why: h.whyOf(first) };
  const second = attempt({ direct: true });
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
/** 这个仓刚取成 origin 的有效期。和开会话钩子的 QUIET_MS 一样是 3 分钟。 */
export const FETCH_QUIET_MS = 3 * 60_000;

/**
 * 这个仓在记号里用的键。git 公共目录的绝对路径，工作树和主检出是同一扇门。
 * 假 git 回的不是绝对路径时返回 null：不记记号，每次都照取（测试不会往真家里写）。
 * @param {string} cwd
 * @param {(cwd: string, args: string[], opts?: { direct?: boolean }) => GitResult} git
 * @param {(r: GitResult) => boolean} okOf
 * @returns {string | null}
 */
export function repoStampKey(cwd, git, okOf) {
  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!okOf(inside) || String(inside.stdout ?? '').trim() !== 'true') return null;
  const r = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!okOf(r)) return null;
  const raw = String(r.stdout ?? '').trim();
  if (!isAbsolute(raw)) return null;
  const p = resolve(raw);
  const norm = process.platform === 'win32' ? p.toLowerCase() : p;
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/** @param {string} home @param {string} key */
export function fetchOkFile(home, key) {
  return join(home, '.fleet-dao', 'fetch-ok', key);
}

/**
 * 文件时间比 now 早一点点也算刚写的（两个钟对不齐）。读不到就是没记过。
 * @param {string} file
 * @param {number} now
 * @param {number} windowMs
 */
export function stampIsFresh(file, now, windowMs) {
  try {
    const age = now - statSync(file).mtimeMs;
    return age > -5_000 && age < windowMs;
  } catch {
    return false;
  }
}

/** @param {string} file @param {number} now */
export function touchStamp(file, now) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${new Date(now).toISOString()}\n`);
  } catch {
    // 记不下只是下次再取一次，不影响这次的结论
  }
}

/**
 * @param {{ home: string, cwd: string, git: (cwd: string, args: string[]) => GitResult, okOf: (r: GitResult) => boolean, now?: number }} o
 */
export function fetchIsFresh(o) {
  const key = repoStampKey(o.cwd, o.git, o.okOf);
  if (!key) return false;
  return stampIsFresh(fetchOkFile(o.home, key), o.now ?? Date.now(), FETCH_QUIET_MS);
}

/** @param {{ home: string, cwd: string, git: (cwd: string, args: string[]) => GitResult, okOf: (r: GitResult) => boolean, now?: number }} o */
export function markFetchOk(o) {
  const key = repoStampKey(o.cwd, o.git, o.okOf);
  if (!key) return;
  touchStamp(fetchOkFile(o.home, key), o.now ?? Date.now());
}

/**
 * 起子代理（Agent / Task）之前，把 origin/main 取到最新：子代理的工作树从它切（见文件头）。
 * 取成了、不是 Agent/Task、不在 git 仓里、没有 origin：什么都不说（返回 null）。
 * 取不成：要建工作树的（isolation 是 worktree）拦下，说清 origin/main 停在多久以前；不建工作树的不拦（它不从 origin/main 切）。
 * `git(cwd, args, opts)` 同 fetchWithFallback；不抛。
 * 这个仓三分钟内刚取成过：不再取，直接放行。取失败不记成功。
 * @param {{ tool: unknown, toolInput: unknown, cwd: string, git: (cwd: string, args: string[], opts?: { direct?: boolean }) => GitResult, okOf: (r: GitResult) => boolean, whyOf: (r: GitResult) => string, env?: Record<string, string | undefined>, home?: string, now?: number }} o
 * @returns {{ block: true, message: string } | null}
 */
export function freshBeforeSubagent(o) {
  if (o.tool !== 'Agent' && o.tool !== 'Task') return null;
  const inside = o.git(o.cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!o.okOf(inside) || String(inside.stdout ?? '').trim() !== 'true') return null;
  if (!o.okOf(o.git(o.cwd, ['remote', 'get-url', 'origin']))) return null;
  const home = o.home ?? homedir();
  const now = o.now ?? Date.now();
  if (fetchIsFresh({ home, cwd: o.cwd, git: o.git, okOf: o.okOf, now })) return null;
  const got = fetchWithFallback(o.git, o.cwd, ['fetch', '-q', 'origin', 'main'], {
    okOf: o.okOf,
    whyOf: o.whyOf,
    ...(o.env ? { env: o.env } : {}),
  });
  if (got.ok) {
    markFetchOk({ home, cwd: o.cwd, git: o.git, okOf: o.okOf, now });
    return null;
  }
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
