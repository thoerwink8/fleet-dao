// 对外仓不带 AI 署名（通用段「对外仓和对外内容怎么写」）：调工具前钩子 pretool.mjs 的 decide 调这里，各家 CLI 经 vendor-pretool.mjs 共用。
// 各家 CLI 默认往提交和 PR 里加署名（Claude Code 的 Co-Authored-By、Generated with），全局说明压得住大多数，这里是兜底：
// - git push：查这次要推、还不在任何远端上的提交，最终说明里有署名就拦。编辑器、-F 文件、amend 怎么写进去的都盖得住。
// - git commit：命令文本（-m、--trailer、heredoc 正文）和 -F/--file 指的文件里有署名就拦，免得写完再改。
// - gh pr create|edit、glab mr create|update：命令文本和 --body-file/-F 指的文件里有就拦。
// 只管对外仓（repo-kind.mjs 判）：自用仓（fleet-dao 靠提交里的 Co-Authored-By: Claude Haiku 统计降档子代理开的 PR）一律放行。
// 只有命令像上面几种时才跑 git、读文件；git 跑不起来、超时就放行并说一句没查成，不拦。
// 和别的钩子一样被 agents-sync 整份拷进 ~/.fleet-dao/hooks/，只用 node 自带模块和同目录脚本。
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { gitBroken, gitOk, gitRunner, gitWhy } from './git-run.mjs';
import { repoKind } from './repo-kind.mjs';

export const ATTRIBUTION_GIT_MS = 5_000;

const AI_NAMES = 'claude|anthropic|gpt|openai|codex|gemini|cursor|copilot|kimi|grok|devin|deepseek|glm';
const ATTRIBUTION_RES = [
  new RegExp(String.raw`co-authored-by:[^\n]*?(?:${AI_NAMES})`, 'i'),
  new RegExp(String.raw`generated (?:with|by) \[?(?:${AI_NAMES})`, 'i'),
  /🤖[^\n]*generated/i,
];

/**
 * 一段文字里有没有 AI 署名
 * @param {string} text
 */
export function hasAiAttribution(text) {
  return ATTRIBUTION_RES.some((re) => re.test(text));
}

const GIT_HEAD = String.raw`(?:^|[;&|(\n'"]|\$\()\s*(?:sudo\s+)?git(?:\.exe)?((?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*)\s+`;
const GIT_PUSH = new RegExp(`${GIT_HEAD}push(?![\\w-])`);
const GIT_COMMIT = new RegExp(`${GIT_HEAD}commit(?![\\w-])`);
const PR_CMD = /(?:^|[;&|(\n]|\$\()\s*(?:gh\s+pr\s+(?:create|edit)|glab\s+mr\s+(?:create|update))(?![\w-])/;

/**
 * git 全局选项里的 -C 路径（最后一个算数），没有就是 null
 * @param {string} globals
 */
function gitDirOption(globals) {
  /** @type {string | null} */
  let dir = null;
  for (const m of globals.matchAll(/-C\s+(['"]?)([^\s'"]+)\1/g)) dir = m[2] ?? dir;
  return dir;
}

/**
 * 命令里 -F/--file/--body-file 指的文件（相对 cwd），读不到就跳过
 * @param {string} command
 * @param {string} cwd
 * @param {string} flags 正则里的几个选项名，用 | 隔开
 */
function referencedFiles(command, cwd, flags) {
  /** @type {string[]} */
  const out = [];
  const re = new RegExp(String.raw`(?:^|\s)(?:${flags})(?:=|\s+)(['"]?)([^\s'"]+)\1`, 'g');
  for (const m of command.matchAll(re)) {
    const name = m[2] ?? '-';
    if (name === '-') continue;
    const p = isAbsolute(name) ? name : resolve(cwd, name);
    try {
      out.push(readFileSync(p, 'utf8'));
    } catch {
      // 读不到就只看命令文本
    }
  }
  return out;
}

const RULE = '对外仓的提交和 PR/MR 不加 AI 署名行（通用段「对外仓和对外内容怎么写」）';

/**
 * @param {string} command 整条命令（含 heredoc 正文）
 * @param {string} outer 去掉 heredoc 正文的命令行（认命令用它）
 * @param {string} cwd 会话目录
 * @param {{ git?: ReturnType<typeof gitRunner>, read?: (p: string) => string }} [deps]
 * @returns {{ code: 2, message: string } | { code: 0, context: string } | null} null = 不归这里管
 */
export function attributionVerdict(command, outer, cwd, deps = {}) {
  const push = GIT_PUSH.exec(outer);
  const commit = GIT_COMMIT.exec(outer);
  const pr = PR_CMD.test(outer);
  if (!push && !commit && !pr) return null;
  const git = deps.git ?? gitRunner(ATTRIBUTION_GIT_MS);
  const globals = (push ?? commit)?.[1] ?? '';
  const dirOpt = gitDirOption(globals);
  const dir = dirOpt ? (isAbsolute(dirOpt) ? dirOpt : resolve(cwd, dirOpt)) : cwd;
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (gitBroken(top))
    return {
      code: 0,
      context: `fleet-guard：没查成这个仓是不是对外仓（${gitWhy(top)}），AI 署名没查。${RULE}。`,
    };
  const root = top.stdout.trim();
  if (!gitOk(top) || !root) return null;
  if (repoKind(root, { git, ...(deps.read ? { read: deps.read } : {}) }) !== 'external') return null;

  const texts = [command];
  if (commit) texts.push(...referencedFiles(outer, dir, '-F|--file'));
  if (pr) texts.push(...referencedFiles(outer, cwd, '-F|--body-file'));
  if ((commit || pr) && texts.some(hasAiAttribution))
    return {
      code: 2,
      message: `${RULE}：这条${commit ? '提交' : ' PR/MR'}的说明里有 AI 署名（Co-Authored-By 后面是 AI、Generated with …、🤖 Generated），去掉那几行再来。`,
    };
  if (!push) return null;
  const log = git(root, ['log', 'HEAD', '--not', '--remotes', '--format=%h%x00%s%x00%B%x1e']);
  if (gitBroken(log) || !gitOk(log))
    return { code: 0, context: `fleet-guard：没查成要推的提交里有没有 AI 署名（${gitWhy(log)}）。${RULE}。` };
  const bad = log.stdout
    .split('\x1e')
    .map((r) => r.replace(/^\n/, '').split('\0'))
    .filter((f) => f.length === 3 && hasAiAttribution(f[2] ?? ''))
    .map(([h, s]) => `${h} ${s}`);
  if (bad.length === 0) return null;
  return {
    code: 2,
    message: `${RULE}：要推的提交里有 ${bad.length} 个带 AI 署名：${bad.slice(0, 5).join('；')}${bad.length > 5 ? ' 等' : ''}。用 git rebase 改这几个提交的说明、去掉署名行再推。`,
  };
}
