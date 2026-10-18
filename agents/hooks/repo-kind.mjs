// 仓是哪一种（决定 0107）：自用仓（只有创始人和 AI 读）还是对外仓（同事、领导、客户会读）。
// - 标记只打在自用仓里、跟着仓走：仓根 AGENTS.md 里去掉两头空白后一字不差的一行 SELF_MARK（旧的私人仓写法照认）。
//   任何机器克隆下来就知道，不用每台登记；对外仓什么都不打，同事看不到任何东西。
// - fleet-dao 本身认两份文件，不靠标记（老分支、老检出没有标记行也不会被当成对外仓）。
// - 其余一律对外仓：没 AGENTS.md、读不了、没那一行都算（严的一边）。
// - 唯一的提醒：没标记、但远端全在创始人自己的 GitHub 账号下的仓，开会话提醒一句「像是自用仓，要加标记吗」，
//   他说加才加；不说照对外仓办。每个仓每天最多一次。
// 用它的：ai-attribution.mjs（对外仓不带 AI 署名）、repo-contract.mjs（仓合同不管对外仓）、session-start.mjs（上面那句提醒）。
// 和别的钩子一样被 agents-sync 整份拷进 ~/.fleet-dao/hooks/，只用 node 自带模块和同目录脚本。
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { gitBroken, gitOk } from './git-run.mjs';

/** 自用仓的标记：仓根 AGENTS.md 里单独一行 */
export const SELF_MARK = '<!-- repo-kind: 自用仓 -->';
/** 以前的写法（决定 0106 的私人仓），照认 */
export const LEGACY_SELF_MARKS = ['<!-- repo-kind: 私人仓 -->'];
/** 创始人自己的 GitHub 账号：远端全在这些账号下、又没标记的仓才提醒 */
export const FOUNDER_GITHUB_OWNERS = ['thoerwink8'];

/**
 * 仓是哪一种。fleet-dao 和打了标记的是自用仓，其余都是对外仓。
 * @param {string} root 仓根
 * @param {(p: string) => string} [read]
 * @returns {'self' | 'external'}
 */
export function repoKind(root, read = (p) => readFileSync(p, 'utf8')) {
  return isFleetDao(root, read) || hasSelfMark(root, read) ? 'self' : 'external';
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
 * 远端是不是全在创始人自己的 GitHub 账号下（至少一个远端）
 * @param {string[]} urls
 * @param {string[]} [owners]
 */
export function allFounderRemotes(urls, owners = FOUNDER_GITHUB_OWNERS) {
  const want = new Set(owners.map((o) => o.toLowerCase()));
  return urls.length > 0 && urls.every((u) => want.has((githubOwnerOf(u) ?? '').toLowerCase()));
}

/** 按 git 公共目录分仓的记号名：和 repo-contract.mjs 的 stampKeyOf 同一种算法（那边引这里，不反过来引，免得互相引） @param {string} commonDir */
function stampKeyOf(commonDir) {
  const p = resolve(commonDir);
  const norm = process.platform === 'win32' ? p.toLowerCase() : p;
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/** @param {number} now */
function beijingDay(now) {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * 开会话那一句：没标记、远端全在创始人 GitHub 下的仓提醒问他要不要加标记。每个仓每天最多一次，记号在
 * ~/.fleet-dao/repo-kind/<仓的 git 公共目录的指纹>（和仓合同同一种分仓法）。自用仓、对外仓里远端不全是他的、
 * 不是 git 仓、git 跑不起来，都不出声；钩子自己出错说一句没查成。
 * @param {{ cwd: string, git: (cwd: string, args: string[]) => { status: number | null, stdout: string, stderr: string, error?: Error }, home: string, now?: number, read?: (p: string) => string }} o
 * @returns {string[]}
 */
export function kindReminderLines({ cwd, git, home, now = Date.now(), read = undefined }) {
  try {
    const top = git(cwd, ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir']);
    if (gitBroken(top) || !gitOk(top)) return [];
    const [root, common] = top.stdout.split(/\r?\n/).map((s) => s.trim());
    if (!root || repoKind(root, read) === 'self') return [];
    const remotes = git(root, ['remote', '-v']);
    if (gitBroken(remotes) || !gitOk(remotes)) return [];
    const urls = [
      ...new Set(
        remotes.stdout
          .split(/\r?\n/)
          .map((l) => l.split(/\s+/)[1] ?? '')
          .filter(Boolean),
      ),
    ];
    if (!allFounderRemotes(urls)) return [];
    const stamp =
      common && isAbsolute(common) ? join(home, '.fleet-dao', 'repo-kind', stampKeyOf(common)) : null;
    const today = beijingDay(now);
    if (stamp) {
      try {
        if (readFileSync(stamp, 'utf8').trim() === today) return [];
      } catch {
        // 今天还没说过
      }
      try {
        mkdirSync(dirname(stamp), { recursive: true });
        writeFileSync(stamp, `${today}\n`);
      } catch {
        // 记不下只是今天可能多说一次
      }
    }
    return [
      `这个仓（${root.replaceAll('\\', '/')}）仓根 AGENTS.md 没有自用仓标记，照对外仓办（通用段「对外仓和对外内容怎么写」）；` +
        `但远端都在创始人自己的 GitHub 下（${urls.join('、')}），像是自用仓。动手前问他一句「这像是你的自用仓，要加标记吗」：` +
        `他说加，就在仓根 AGENTS.md 加一行 ${SELF_MARK} 提交推送（没有 AGENTS.md 用 fleet-dao 的 pnpm repo:init <仓路径> --self）；没说就照对外仓办。这条每个仓每天只说一次。`,
    ];
  } catch (e) {
    return [`仓类型没查成：钩子自己出错了（${e instanceof Error ? e.message : String(e)}）。照对外仓办。`];
  }
}
