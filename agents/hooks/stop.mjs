// Stop 钩子。登记在 fleet-dao 仓的 .claude/settings.json（项目级），不装进用户级设置。
// Grok、Devin 借道读的是用户级那份，这份它们碰不到。
// 只有无人值守才 decision:block：这个会话自己跑过 `unattended.mjs on` 才输出（理由里说清有进展记进度）；
// 起子代理、后台活不自动开；放行条件和防死循环的上限见 unattended.mjs。人在场时这一轮收不收，由规矩说，不由这个钩子拦。
// 引擎的无头会话（FLEET_HEADLESS=1）直接退出。
// 退出码恒为 0：Stop 上 exit 2 也是「不许停」。
// 规矩本身由 agents/test/rules/stop.rules.test.ts 钉住：没开无人值守时输出里出现 decision 或 hookSpecificOutput 会红。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanId, decideStop, isMachineSession, stateDir } from './unattended.mjs';

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  if (process.env.FLEET_HEADLESS === '1') process.exit(0);
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    // 读不懂输入就当没有能提醒的信息，不出声（读不懂不该炸）
  }
  // 无人值守：只有这个会话自己跑过 `unattended.mjs on` 才挡；先判，它自己防空转，不看 stop_hook_active
  // （我们自己挡回去之后那个标志就一直是真的）。机器派的会话（工人、反方）不挡。
  const notes = [];
  try {
    const sessionId = cleanId(input?.session_id) ?? cleanId(process.env.CLAUDE_CODE_SESSION_ID);
    if (sessionId && !isMachineSession({ env: process.env })) {
      const dir = stateDir();
      const un = decideStop({ dir, sessionId });
      if (un.block) {
        process.stdout.write(`${JSON.stringify({ decision: 'block', reason: un.reason })}\n`);
        process.exit(0);
      }
      if (un.notice) notes.push(un.notice);
    }
  } catch {
    // 无人值守这一步自己出错：放行，不把「判不出」搞成「拦下」
  }
  if (notes.length > 0) process.stdout.write(`${JSON.stringify({ systemMessage: notes.join('；') })}\n`);
  process.exit(0);
}
