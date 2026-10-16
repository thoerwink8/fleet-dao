// Stop 钩子。登记在 fleet-dao 仓的 .claude/settings.json（项目级），不装进用户级设置。
// Grok、Devin 借道读的是用户级那份，这份它们碰不到。
// 先做收轮前对账（queue-stop.mjs，单 #2731，人在不在场都判）：本机队列有可接的活、容量够、没有子代理在跑（只有后台命令、监视器在跑也算没有）
// 就 decision:block，连着挡 3 次放行一次；会话目录不在 fleet-dao 检出里不管，队列、容量没查成不挡、明说。
// 再看无人值守：decision:block：这个会话自己跑过 `unattended.mjs on`、而且输入的 background_tasks、session_crons 里
// 什么都没在跑才输出（还有子代理、后台命令、监视、定时唤醒在跑就放行：它们收口时会把会话叫回来）；
// 起子代理、后台活不自动开；放行条件和防死循环的上限见 unattended.mjs。
// 引擎的无头会话（FLEET_HEADLESS=1）、机器派的会话（工人、反方）直接放行。
// 退出码恒为 0：Stop 上 exit 2 也是「不许停」。
// 规矩本身由 agents/test/rules/stop.rules.test.ts 钉住：不在 fleet-dao 检出里、又没开无人值守时，输出里出现 decision 或 hookSpecificOutput 会红。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideQueueStop } from './queue-stop.mjs';
import { cleanId, decideStop, isMachineSession, pendingOf, stateDir } from './unattended.mjs';

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
      // 收轮前对账（单 #2731，人在不在场都判）：有可接的活、容量够、没有子代理在跑就挡回（queue-stop.mjs）
      const q = await decideQueueStop({ input, dir, sessionId });
      if (q.block) {
        process.stdout.write(`${JSON.stringify({ decision: 'block', reason: q.reason })}\n`);
        process.exit(0);
      }
      if (q.notice) notes.push(q.notice);
      const un = decideStop({ dir, sessionId, pending: pendingOf(input) });
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
