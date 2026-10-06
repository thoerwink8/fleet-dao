// Stop 钩子（agents-sync 装进 ~/.fleet-dao/hooks/，登记在 ~/.claude/settings.json 的 Stop 事件；Grok、Devin 借道读这份，
// 支不支持 Stop 事件看各家自己，不支持就是从来不触发，不影响别的钩子）。
// 会话收尾时扫一眼仓根，是不是有没跟踪、看着像临时文件的（截图、导出的数据、日志）：通用段那条规矩、截图工具的默认目录
// 都可能被绕过（别的工具、别家 AI 手滑把这类文件直接写进仓根），这里是兜底提醒，不是强制点。
// 仓根临时文件那一条只提醒、不拦、不删——只用 systemMessage。
// 无人值守（决定 0028，创始人 2026-10-07 约 02:27 推翻 0026 的「收尾不拦」）：只有这个会话自己跑过 `unattended.mjs on`
// 才输出 decision:block（理由里说清继续盯工人、有进展记进度），起子代理、后台活不自动开；放行条件和防死循环的上限见 unattended.mjs。
// 决定 0026：起后台活不再自动开。决定 0027：不再读、不再清欠账文件。
// 退出码恒为 0：Stop 上 exit 2 也是「不许停」。
// 规矩本身由 agents/test/rules/stop.rules.test.ts 钉住：没开无人值守时输出里出现 decision 或 hookSpecificOutput 会红。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRunner, gitOk as ok } from './git-run.mjs';
import { cleanId, decideStop, isMachineSession, runningWorkers, stateDir } from './unattended.mjs';

/** 仓根里一眼像临时文件的：截图、导出的数据、日志（AGENTS.md 通用段「放 _tmp/」那条列的几类） */
const TEMP_LIKE = /\.(png|jpe?g|gif|json|log|txt)$/i;

/** 收尾钩子跑 git 的超时：只读本地两条，多等无益 */
export const STOP_GIT_MS = 5_000;

/** git 跑一条命令：钩子共用的那一份（git-run.mjs），测试从这里拿 */
export { gitRunner };

/** 这个 cwd 所在仓的根目录；不是 git 仓、查不到都是 null（不当错误，静悄悄不提醒） */
export function repoRoot(cwd, git) {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!ok(r)) return null;
  const root = r.stdout.trim();
  return root || null;
}

/**
 * 仓根这一层（不进子目录）里没跟踪、没被 .gitignore 忽略、看着像临时文件的文件名。
 * 用 git status 判「没跟踪、没忽略」：忽略的本来就不会出现在这里，不用另外过滤。
 * 查不成（git 不在、超时……）返回 null，和「查了、没有」（空数组）分开，调用方不把没查成当没有。
 */
export function tempFilesAtRoot(root, git) {
  const r = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  if (!ok(r)) return null;
  const names = [];
  for (const entry of r.stdout.split('\0')) {
    if (!entry.startsWith('?? ')) continue;
    const path = entry.slice(3);
    // 未跟踪目录会被 git 收成一整条「dirname/」：带斜杠的都不是仓根这一层的文件，跳过
    if (path.includes('/') || path.includes('\\')) continue;
    if (TEMP_LIKE.test(path)) names.push(path);
  }
  return names;
}

/** 给一份 Stop 钩子的输入，算出要不要提醒；不提醒返回 null（不是仓、查不成、仓根干净都不提醒） */
export function stopCheck({ cwd, git }) {
  const root = repoRoot(cwd, git);
  if (root === null) return null;
  const names = tempFilesAtRoot(root, git);
  if (names === null || names.length === 0) return null;
  return { systemMessage: `挪进 _tmp/：${names.join('、')}` };
}

/** 各家给的会话目录字段：Stop 输入按文档都给 cwd；没有就退回钩子自己的工作目录 */
export function pickCwd(input) {
  const cwd = input && typeof input === 'object' ? input.cwd : undefined;
  return typeof cwd === 'string' && cwd ? cwd : process.cwd();
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    // 读不懂输入就当没有能提醒的信息，不出声（这只是个提醒，不是拦截，读不懂不该炸）
  }
  // 无人值守：只有这个会话自己跑过 `unattended.mjs on` 才挡（决定 0028）；先判，它自己防空转，不看 stop_hook_active
  // （我们自己挡回去之后那个标志就一直是真的）。机器派的会话（工人、反方）不挡。
  const notes = [];
  try {
    const sessionId = cleanId(input?.session_id) ?? cleanId(process.env.CLAUDE_CODE_SESSION_ID);
    if (sessionId && !isMachineSession({ env: process.env })) {
      const dir = stateDir();
      const un = decideStop({ dir, sessionId, running: runningWorkers() });
      if (un.block) {
        process.stdout.write(`${JSON.stringify({ decision: 'block', reason: un.reason })}\n`);
        process.exit(0);
      }
      if (un.notice) notes.push(un.notice);
    }
  } catch {
    // 无人值守这一步自己出错：放行，不把「判不出」搞成「拦下」
  }
  // stop_hook_active：这一轮是别的 Stop 钩子把对话带下去才有的，不重复提醒仓根的临时文件
  if (input?.stop_hook_active !== true) {
    try {
      const out = stopCheck({ cwd: pickCwd(input), git: gitRunner(STOP_GIT_MS) });
      if (out) notes.push(out.systemMessage);
    } catch {
      // 钩子自己出错不影响会话收尾：安安静静退出，别把「查不成」搞成「拦下」
    }
  }
  if (notes.length > 0) process.stdout.write(`${JSON.stringify({ systemMessage: notes.join('；') })}\n`);
  process.exit(0);
}
