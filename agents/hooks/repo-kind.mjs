// 仓是哪一种（决定 0108，替代 0107 第 3 条）：自用仓（只有创始人和 AI 读）还是对外仓（同事、领导、客户会读）。
// 按顺序判，先认到的算数：
// 1. 本机说过的：仓的 .git/config 里 fleet.repoKind = self | external。创始人随口一句「这个仓是自用仓／对外仓」，
//    AI 就跑 `pnpm repo:kind self|external` 记在这里。不进仓、同事看不到；换机器要再说一次（那台照远端重判，偏严）。
// 2. fleet-dao 本身（认两份文件）、仓根 AGENTS.md 有自用仓标记（SELF_MARK，旧的私人仓写法照认）：自用仓。标记跟着仓走，
//    只给自用仓用（比如没有远端的私人仓），对外仓里什么都不加。
// 3. 看远端：有任何一个不在创始人自己的 GitHub 账号下（公司 GitLab、内网地址、别人的 GitHub）就是对外仓；全在他账号下就是自用仓。
// 4. 没有远端（不在 GitHub 上）：照对外仓办，不问、不提醒；要当自用仓的，创始人说一句用第 1 条记下。
// git 跑不起来、读不了：照对外仓办（严的一边）。
// 用它的：ai-attribution.mjs（对外仓不带 AI 署名）、repo-contract.mjs（仓合同不管对外仓）。
// 命令行：node repo-kind.mjs [show|self|external] [仓路径]（fleet-dao 里是 pnpm repo:kind）。
// 和别的钩子一样被 agents-sync 整份拷进 ~/.fleet-dao/hooks/，只用 node 自带模块和同目录脚本。
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBroken, gitOk, gitRunner, gitWhy } from './git-run.mjs';

/** 自用仓的标记：仓根 AGENTS.md 里单独一行 */
export const SELF_MARK = '<!-- repo-kind: 自用仓 -->';
/** 以前的写法（决定 0106 的私人仓），照认 */
export const LEGACY_SELF_MARKS = ['<!-- repo-kind: 私人仓 -->'];
/** 创始人自己的 GitHub 账号：远端全在这些账号下的仓是自用仓 */
export const FOUNDER_GITHUB_OWNERS = ['thoerwink8'];
/** 本机记类型的 git 配置键（仓的 .git/config，工作树共用） */
export const CONFIG_KEY = 'fleet.repoKind';
export const REPO_KIND_GIT_MS = 5_000;

/** @typedef {(cwd: string, args: string[]) => import('./git-run.mjs').GitResult} Git */
/**
 * @typedef {{ kind: 'self' | 'external', source: 'config' | 'fleet-dao' | 'mark' | 'remote' | 'no-remote' | 'unchecked',
 *   why: string, remotes: string[] }} KindInfo
 * source 是凭什么判的：no-remote（没远端）和 unchecked（git 没跑成）都是判不出来、照对外仓办。
 */

/**
 * 仓是哪一种，带上凭什么判的
 * @param {string} root 仓根
 * @param {{ read?: (p: string) => string, git?: Git }} [deps]
 * @returns {KindInfo}
 */
export function repoKindInfo(root, deps = {}) {
  const read = deps.read ?? ((p) => readFileSync(p, 'utf8'));
  const git = deps.git ?? gitRunner(REPO_KIND_GIT_MS);
  const conf = git(root, ['config', '--get', CONFIG_KEY]);
  const said = gitOk(conf) ? conf.stdout.trim() : '';
  if (said === 'self' || said === 'external')
    return { kind: said, source: 'config', why: `本机 .git/config 记着 ${CONFIG_KEY}=${said}`, remotes: [] };
  if (isFleetDao(root, read))
    return { kind: 'self', source: 'fleet-dao', why: 'fleet-dao 本身', remotes: [] };
  if (hasSelfMark(root, read))
    return { kind: 'self', source: 'mark', why: `仓根 AGENTS.md 有自用仓标记 ${SELF_MARK}`, remotes: [] };
  const r = git(root, ['remote', '-v']);
  if (gitBroken(r) || !gitOk(r))
    return {
      kind: 'external',
      source: 'unchecked',
      why: `没读成远端（${gitWhy(r)}），照对外仓办`,
      remotes: [],
    };
  const remotes = remotesOf(r.stdout);
  if (remotes.length === 0)
    return { kind: 'external', source: 'no-remote', why: '没有远端，判不出来，照对外仓办', remotes };
  const others = remotes.filter((u) => !isFounderRemote(u));
  if (others.length > 0)
    return {
      kind: 'external',
      source: 'remote',
      why: `有不在创始人 GitHub 下的远端（${others.join('、')}）`,
      remotes,
    };
  return { kind: 'self', source: 'remote', why: '远端全在创始人自己的 GitHub 下', remotes };
}

/**
 * 仓是哪一种；判不出来的一律对外仓
 * @param {string} root
 * @param {{ read?: (p: string) => string, git?: Git }} [deps]
 * @returns {'self' | 'external'}
 */
export function repoKind(root, deps = {}) {
  return repoKindInfo(root, deps).kind;
}

/**
 * fleet-dao 认两份文件
 * @param {string} root
 * @param {(p: string) => string} read
 */
function isFleetDao(root, read) {
  return ['agents/shared-rules.md', 'packages/conventions/standard-paths.json'].every((rel) => {
    try {
      read(join(root, rel));
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * 仓根 AGENTS.md 有没有自用仓标记（新写法或旧写法）
 * @param {string} root
 * @param {(p: string) => string} [read]
 */
export function hasSelfMark(root, read = (p) => readFileSync(p, 'utf8')) {
  const marks = new Set([SELF_MARK, ...LEGACY_SELF_MARKS]);
  try {
    return read(join(root, 'AGENTS.md'))
      .split(/\r?\n/)
      .some((l) => marks.has(l.trim()));
  } catch {
    return false;
  }
}

/** `git remote -v` 的输出 → 去重的地址 @param {string} text */
function remotesOf(text) {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((l) => l.split(/\s+/)[1] ?? '')
        .filter(Boolean),
    ),
  ];
}

/**
 * 远端地址里的 GitHub 账号；不是 GitHub 的回 null。认 git@github.com:o/r、https://github.com/o/r、ssh://git@github.com/o/r，
 * 和 ~/.ssh/config 里起的 github 开头的别名（github-xxx:o/r）。
 * @param {string} url
 */
export function githubOwnerOf(url) {
  const u = url.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):([^/\s]+)\/[^/\s]+$/.exec(u);
  const full = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/([^/\s]+)\/[^/\s]+$/.exec(u);
  const m = full ?? scp;
  if (!m) return null;
  const host = (m[1] ?? '').toLowerCase();
  if (host !== 'github.com' && !/^github(?:[.-]|$)/.test(host)) return null;
  return m[2] ?? null;
}

/**
 * 这个远端在不在创始人自己的 GitHub 账号下
 * @param {string} url
 * @param {string[]} [owners]
 */
export function isFounderRemote(url, owners = FOUNDER_GITHUB_OWNERS) {
  const o = (githubOwnerOf(url) ?? '').toLowerCase();
  return o !== '' && owners.some((w) => w.toLowerCase() === o);
}

/**
 * repo:kind self|external：记进本机 .git/config。有不在创始人 GitHub 下的远端、却要记成自用仓的，提醒一句后果（照记）。
 * @param {string} root
 * @param {'self' | 'external'} kind
 * @param {Git} git
 * @returns {{ ok: true, lines: string[] } | { ok: false, why: string }}
 */
export function setRepoKind(root, kind, git) {
  const before = repoKindInfo(root, { git });
  const w = git(root, ['config', CONFIG_KEY, kind]);
  if (gitBroken(w) || !gitOk(w)) return { ok: false, why: `没写进 .git/config（${gitWhy(w)}）` };
  const lines = [
    `记下了：${root} 是${kind === 'self' ? '自用仓' : '对外仓'}（本机 .git/config ${CONFIG_KEY}=${kind}，不进仓）。`,
  ];
  const others = before.remotes.filter((u) => !isFounderRemote(u));
  if (kind === 'self' && others.length > 0)
    lines.push(
      `注意：它有不在你 GitHub 下的远端（${others.join('、')}），能拉代码的人都看得到往后的提交说明和文档；` +
        '记成自用仓后 AI 会照 fleet-dao 的写法记（可能带原话、AI 的事）。不对就 pnpm repo:kind external 改回来。',
    );
  return { ok: true, lines };
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (/** @type {string} */ p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const args = process.argv.slice(2);
  const cmd = ['show', 'self', 'external'].includes(args[0] ?? '') ? args[0] : 'show';
  const arg = args.find((a, i) => !(i === 0 && a === cmd) && !a.startsWith('--'));
  const base = process.env.INIT_CWD || process.cwd();
  const dir = arg ? (isAbsolute(arg) ? arg : resolve(base, arg)) : base;
  const git = gitRunner(REPO_KIND_GIT_MS);
  try {
    if (!statSync(dir).isDirectory()) throw new Error('不是目录');
  } catch (e) {
    console.error(`仓路径 ${dir} 读不了（${e instanceof Error ? e.message : String(e)}）。`);
    process.exit(2);
  }
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (gitBroken(top) || !gitOk(top) || !top.stdout.trim()) {
    console.error(
      `${dir} 不是 git 仓，或 git 没跑成（${gitWhy(top)}）。用法：repo:kind [show|self|external] [仓路径]`,
    );
    process.exit(2);
  }
  const root = top.stdout.trim();
  if (cmd === 'show') {
    const info = repoKindInfo(root, { git });
    console.log(`${root}：${info.kind === 'self' ? '自用仓' : '对外仓'}（${info.why}）`);
    process.exit(0);
  }
  const r = setRepoKind(root, /** @type {'self' | 'external'} */ (cmd), git);
  if (!r.ok) {
    console.error(r.why);
    process.exit(2);
  }
  console.log(r.lines.join('\n'));
}
