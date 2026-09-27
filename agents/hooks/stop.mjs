// Stop 钩子（agents-sync 装进 ~/.fleet-dao/hooks/，登记在 ~/.claude/settings.json 的 Stop 事件；Grok、Devin 借道读这份，
// 支不支持 Stop 事件看各家自己，不支持就是从来不触发，不影响别的钩子）。
// 会话收尾时扫一眼仓根，是不是有没跟踪、看着像临时文件的（截图、导出的数据、日志）：通用段那条规矩、截图工具的默认目录
// 都可能被绕过（别的工具、别家 AI 手滑把这类文件直接写进仓根），这里是兜底提醒，不是强制点。
// 只提醒、不拦、不删：只用 systemMessage，不设 decision、不设 hookSpecificOutput.additionalContext，退出码一律 0——
// Stop 上 exit 2 是「不许停，接着聊」，additionalContext 也会让对话接着走，都不是这里要的
// （code.claude.com/docs/en/hooks.md「Stop」「Stop decision control」两节，2026-09-27 查）。
// 规矩本身由 agents/test/rules/stop.rules.test.ts 钉住：改这里改出「拦下」或「接着聊」的效果，那边会红。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓根里一眼像临时文件的：截图、导出的数据、日志（AGENTS.md 通用段「放 _tmp/」那条列的几类） */
const TEMP_LIKE = /\.(png|jpe?g|gif|json|log|txt)$/i;

/** git 跑一条命令：{ status, stdout, stderr, error }（和 session-start.mjs 的 gitRunner 同一个形状） */
export function gitRunner(timeoutMs = 5_000) {
  return (cwd, args) => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  };
}

const ok = (r) => r.status === 0 && !r.error;

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
  // stop_hook_active：这一轮是别的 Stop 钩子把对话带下去才有的。本钩子从不 block、不加 context，
  // 正常走不到这一步；留着这条只是防别的 Stop 钩子把它捎带触发出重复提醒。
  if (input?.stop_hook_active !== true) {
    try {
      const out = stopCheck({ cwd: pickCwd(input), git: gitRunner() });
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    } catch {
      // 钩子自己出错不影响会话收尾：安安静静退出，别把「查不成」搞成「拦下」
    }
  }
  process.exit(0);
}
