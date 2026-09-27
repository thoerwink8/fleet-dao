// SessionStart 钩子（agents-sync 装进 ~/.fleet-dao/hooks/，登记在 ~/.claude/settings.json；Grok、Devin、Cursor 默认借道读这份）。
// 开会话、续会话时跑；stdout 打一段 JSON，hookSpecificOutput.additionalContext 进会话上下文（Grok 不收开会话钩子的输出）。两件事：
// 1. 会话所在的仓：取一下远端；在 main 上、没有未提交的改动、落后了就快进；快进不了，或在别的分支上而 AGENTS.md 和主线不同，
//    提醒一句（#72 撞过：会话读到旧的 AGENTS.md）。不是 git 仓、没有 origin/main 的不出声。
// 2. 这台机器的 fleet-dao 检出（agents-sync 记在 ~/.fleet-dao/synced.json 的 repo）：取远端、快进 main，再跑一遍
//    agents-sync --apply，规矩、技能、钩子自己跟上主线；结论一句话。在别的仓里开会话也照做。
//    上次同步成功不到 QUIET_MS 就不再跑：Cursor 讨论一次并行起好几个会话，每个都会触发这个钩子。
// 没查成、没做成都明说原因和这台落后主线几个提交，不当成是最新的。一律退出 0：开会话钩子退出码非 0 也挡不住会话，
// 只会把输出丢掉；钩子自己出了意外也要打一句「没查成」。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FETCH_MS = 15_000;
export const SYNC_MS = 30_000;
export const QUIET_MS = 3 * 60_000;
const ORIGIN_MAIN = 'refs/remotes/origin/main';
const READ_MAIN = '规矩以 origin/main 的 AGENTS.md 为准（git show origin/main:AGENTS.md）';

/** git 跑一条命令：{ status, stdout, stderr, error } */
export function gitRunner(timeoutMs = FETCH_MS) {
  return (cwd, args) => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error, timeoutMs };
  };
}

/** 用检出里的 agents-sync 同步这台机器 */
export function syncRunner(timeoutMs = SYNC_MS) {
  return (repo, home) => {
    const bin = join(repo, 'packages', 'agents-sync', 'bin', 'agents-sync');
    const r = spawnSync(process.execPath, [bin, '--apply', '--repo', repo, '--home', home], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error, timeoutMs };
  };
}

/** 一次命令为什么没成：超时、起不来，或者输出的第一行 */
export function why(r) {
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') return `超过 ${Math.round((r.timeoutMs ?? FETCH_MS) / 1000)} 秒没完`;
    return `起不来：${r.error.message}`;
  }
  const first = `${r.stderr ?? ''}\n${r.stdout ?? ''}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return first || `退出码 ${r.status}`;
}

const ok = (r) => r.status === 0 && !r.error;
const short = (sha) => String(sha).slice(0, 7);

function commonOf(g) {
  const r = g('rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!ok(r)) return null;
  const p = resolve(r.stdout.trim());
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * 第 1 件：会话所在的仓。返回要说的一句（没有就是 null）；取过远端的话，带上这个仓的 git 公共目录和取没取成
 * （会话就开在 fleet-dao 里时，第 2 件不用再取一遍）
 */
export function checkHere(cwd, git) {
  const g = (...a) => git(cwd, a);
  const inside = g('rev-parse', '--is-inside-work-tree');
  if (!ok(inside) || inside.stdout.trim() !== 'true') return { line: null, fetch: null };
  const common = commonOf(g);
  const fetched = g('fetch', '-q', 'origin');
  if (!ok(fetched))
    return {
      line: `开场核规矩没查成：git fetch 失败（${why(fetched)}）。规矩以 origin/main 为准，动手前用 git show origin/main:AGENTS.md 读一遍。`,
      fetch: { common, ok: false, why: why(fetched) },
    };
  const fetch = { common, ok: true, why: '' };
  if (!ok(g('rev-parse', '-q', '--verify', ORIGIN_MAIN))) return { line: null, fetch };
  const branch = g('branch', '--show-current').stdout.trim();
  const behind = Number(g('rev-list', '--count', `HEAD..${ORIGIN_MAIN}`).stdout.trim() || '0');
  if (branch === 'main') {
    if (behind === 0) return { line: null, fetch };
    const dirty = g('status', '--porcelain', '--untracked-files=no').stdout.trim() !== '';
    if (!dirty && ok(g('merge', '--ff-only', '-q', ORIGIN_MAIN)))
      return { line: `已把 main 快进到最新（原来落后 ${behind} 个提交），AGENTS.md 等规矩是最新的。`, fetch };
    return {
      line: `注意：main 落后 origin/main ${behind} 个提交，${dirty ? '有没提交的改动' : '快进失败'}没法自动更新；规矩以 origin/main 为准。`,
      fetch,
    };
  }
  const differs = g('diff', '--quiet', ORIGIN_MAIN, '--', 'AGENTS.md');
  if (differs.status === 1)
    return {
      line: `注意：当前分支 ${branch || '（分离头）'} 的 AGENTS.md 和 origin/main 不一样，${READ_MAIN}。`,
      fetch,
    };
  return { line: null, fetch };
}

/** 这台同步到哪个提交、落后主线几个（按本机的 origin/main 算） */
function lag(g, synced, stale) {
  if (!synced) return `这台还没记过同步到哪个提交，${READ_MAIN}`;
  const c = g('rev-list', '--count', `${synced}..${ORIGIN_MAIN}`);
  const n = Number(c.stdout.trim());
  if (!ok(c) || c.stdout.trim() === '' || !Number.isInteger(n))
    return `这台同步到 ${short(synced)}，和主线比不了（${why(c)}），${READ_MAIN}`;
  const basis = stale ? '（按本机上次取到的主线算）' : '';
  if (n === 0) return `这台同步到 ${short(synced)}，没落后主线${basis}`;
  return `这台同步到 ${short(synced)}，落后主线 ${n} 个提交${basis}，${READ_MAIN}`;
}

/** agents-sync 的输出 → 一句话 */
export function describeSync(r, repo, origin, lagText) {
  const check = `node ${join(repo, 'packages', 'agents-sync', 'bin', 'agents-sync').replaceAll('\\', '/')} --check`;
  if (r.error) {
    const what =
      r.error.code === 'ETIMEDOUT'
        ? `${Math.round((r.timeoutMs ?? SYNC_MS) / 1000)} 秒没跑完`
        : `起不来（${r.error.message}）`;
    return `规矩同步没查成：agents-sync ${what}；${lagText}。`;
  }
  const lines = String(r.stdout ?? '').split(/\r?\n/);
  const pick = (glyph) => lines.filter((l) => l.startsWith(`  ${glyph} `)).map((l) => l.slice(4));
  const bad = pick('✗');
  const unknown = pick('…');
  // 只记同步位置的那一行不算装了什么
  const changed = pick('↻').filter((l) => !l.startsWith('~/.fleet-dao/synced.json'));
  const summary = lines.some((l) => l.startsWith('结论：'));
  if (r.status === 0 && summary) {
    if (changed.length === 0)
      return `规矩同步：这台已同步到主线最新（${short(origin)}），规矩、技能、钩子都和仓里一致。`;
    const keys = changed.map((l) => l.split('：')[0]);
    const listed = keys.slice(0, 3).join('、') + (keys.length > 3 ? ' 等' : '');
    return `规矩同步：这台刚同步到主线最新（${short(origin)}），改了 ${changed.length} 处（${listed}）；本会话开场已经读进来的全局说明和技能还是旧的，下次开会话才生效，拿不准以 origin/main 的 AGENTS.md 为准。`;
  }
  if (r.status === 1 && bad.length > 0) {
    const shown = bad.slice(0, 2).join('；') + (bad.length > 2 ? '……' : '');
    return `规矩同步有没做成的（${bad.length} 处）：${shown}。全部看 ${check}；${lagText}。`;
  }
  // 退出码 2：逐项里有没查成的，或者原件读不到、根本没往下走（那时原因只在 stderr）
  if (r.status === 2)
    return `规矩同步没查成：${(unknown[0] ?? why(r)).replace(/^没查成：/, '')}；${lagText}。`;
  return `规矩同步没查成：agents-sync 退出码 ${r.status}，没给出逐项结论（${why(r)}）；${lagText}。`;
}

function readRecord(home) {
  const file = join(home, '.fleet-dao', 'synced.json');
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, missing: err?.code === 'ENOENT', why: err?.code ?? err?.message ?? String(err) };
  }
}

function quietFor(stamp, now) {
  try {
    // 文件时间和 Date.now() 不是同一个钟，刚写的文件可能比 now 晚零点几毫秒：几秒以内的「将来」也算刚写的
    const age = now - statSync(stamp).mtimeMs;
    return age > -5_000 && age < QUIET_MS ? Math.max(0, age) : null;
  } catch {
    return null;
  }
}

function touch(stamp, now) {
  try {
    mkdirSync(dirname(stamp), { recursive: true });
    writeFileSync(stamp, `${new Date(now).toISOString()}\n`);
  } catch {
    // 记不下只是下次多同步一遍，不影响这次的结论
  }
}

const RERUN = '在 fleet-dao 的检出里跑一遍 node packages/agents-sync/bin/agents-sync --apply';

/** 第 2 件：同步这台机器。fetch 是第 1 件在同一个仓里取远端的结果（没取过是 null）。返回一句话 */
export function syncFleet({ home, git, sync, fetch = null, now = Date.now() }) {
  const rec = readRecord(home);
  if (!rec.ok) {
    if (rec.missing)
      return `规矩同步没查成：这台没记 fleet-dao 检出在哪（没有 ~/.fleet-dao/synced.json）；${RERUN}，${READ_MAIN}。`;
    return `规矩同步没查成：~/.fleet-dao/synced.json 读不懂（${rec.why}）；${RERUN}，${READ_MAIN}。`;
  }
  const repo = typeof rec.value?.repo === 'string' ? rec.value.repo : '';
  if (!repo) return `规矩同步没查成：~/.fleet-dao/synced.json 里没有 repo；${RERUN}，${READ_MAIN}。`;
  const synced = typeof rec.value?.synced?.commit === 'string' ? rec.value.synced.commit : null;
  const stamp = join(home, '.fleet-dao', 'session-sync.ok');
  const quiet = synced ? quietFor(stamp, now) : null;
  if (quiet !== null)
    return `规矩同步：${Math.max(1, Math.round(quiet / 60_000))} 分钟内刚同步成功过（这台同步到 ${short(synced)}），这次没再取远端。`;
  if (!existsSync(repo))
    return `规矩同步没查成：记下的 fleet-dao 检出 ${repo} 不在了；在现在的检出里跑一遍 node packages/agents-sync/bin/agents-sync --apply，${READ_MAIN}。`;
  const g = (...a) => git(repo, a);
  const inside = g('rev-parse', '--is-inside-work-tree');
  if (!ok(inside) || inside.stdout.trim() !== 'true')
    return `规矩同步没查成：记下的检出 ${repo} 不是 git 仓（${why(inside)}）；${READ_MAIN}。`;
  const common = commonOf(g);
  // 会话就开在这个仓（或它的工作树）里时，第 1 件已经取过远端，不再取第二遍
  let fetchWhy = null;
  if (fetch !== null && common !== null && fetch.common === common) fetchWhy = fetch.ok ? null : fetch.why;
  else {
    const f = g('fetch', '-q', 'origin');
    if (!ok(f)) fetchWhy = why(f);
  }
  if (fetchWhy !== null)
    return `规矩同步没查成：在 ${repo} 取远端失败（${fetchWhy}）；${lag(g, synced, true)}。`;
  const originRead = g('rev-parse', '-q', '--verify', `${ORIGIN_MAIN}^{commit}`);
  if (!ok(originRead)) return `规矩同步没查成：${repo} 里没有 origin/main；${READ_MAIN}。`;
  const origin = originRead.stdout.trim();
  const lagText = lag(g, synced, false);
  const branch = g('branch', '--show-current').stdout.trim();
  if (branch !== 'main')
    return `规矩同步没跑：检出 ${repo} 不在 main 上（在 ${branch || '分离头'}），不拿别的分支同步；${lagText}。`;
  let head = g('rev-parse', 'HEAD').stdout.trim();
  if (head !== origin) {
    if (g('status', '--porcelain', '--untracked-files=no').stdout.trim() !== '')
      return `规矩同步没跑：检出 ${repo} 的 main 有没提交的改动，快进不了；${lagText}。`;
    const ff = g('merge', '--ff-only', '-q', ORIGIN_MAIN);
    if (!ok(ff)) return `规矩同步没跑：检出 ${repo} 的 main 快进不了（${why(ff)}）；${lagText}。`;
    head = g('rev-parse', 'HEAD').stdout.trim();
    if (head !== origin)
      return `规矩同步没跑：检出 ${repo} 的 main（${short(head)}）和 origin/main（${short(origin)}）分叉了，不拿它同步；${lagText}。`;
  }
  if (g('status', '--porcelain', '--', 'AGENTS.md', 'agents').stdout.trim() !== '')
    return `规矩同步没跑：检出 ${repo} 里 AGENTS.md 或 agents/ 有没提交的改动，不拿它们同步；${lagText}。`;
  const r = sync(repo, home);
  if (r.status === 0 && !r.error) touch(stamp, now);
  return describeSync(r, repo, origin, lagText);
}

export function sessionStart({ cwd, home, git, sync, now = Date.now() }) {
  const here = checkHere(cwd, git);
  return [...(here.line ? [here.line] : []), syncFleet({ home, git, sync, fetch: here.fetch, now })];
}

/** Claude Code、Codex、Devin 都认的开会话输出 */
export function render(lines) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') },
  });
}

/** 各家给的会话目录字段不一样：Claude Code、Grok 给 cwd，Grok 另给 workspaceRoot，Cursor 给 workspace_roots；Devin 不给 */
export function pickCwd(input) {
  const i = input && typeof input === 'object' ? input : {};
  const roots = Array.isArray(i.workspace_roots) ? i.workspace_roots : [];
  for (const c of [i.cwd, i.workspaceRoot, roots[0]]) if (typeof c === 'string' && c) return c;
  return process.cwd();
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  let lines;
  try {
    let input = {};
    try {
      input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    } catch {
      // 输入读不懂不要紧：会话目录退回到钩子自己的工作目录
    }
    lines = sessionStart({ cwd: pickCwd(input), home: homedir(), git: gitRunner(), sync: syncRunner() });
  } catch (err) {
    lines = [`开场核规矩没查成：开会话钩子自己出错了（${err?.message ?? err}）；${READ_MAIN}。`];
  }
  process.stdout.write(`${render(lines)}\n`);
}
