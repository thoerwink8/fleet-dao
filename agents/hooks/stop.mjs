// 共享同步 Stop：Claude 在订阅项目登记，Codex 在用户 hooks.json 登记并信任。
// 先续本会话未完成工作并注入工人终态，后台任务条数不作为通知送达证明；未开无人值守才做原有队列对账。
// 起子代理、后台活不自动开；成功完成的新工作才重置无进展计数，三次无进展明确故障暂停。
// 引擎的无头会话（FLEET_HEADLESS=1）、机器派的会话（工人、反方）直接放行。
// 退出码恒为 0：Stop 上 exit 2 也是「不许停」。
// 规矩本身由 agents/test/rules/stop.rules.test.ts 钉住：不在 fleet-dao 检出里、又没开无人值守时，输出里出现 decision 或 hookSpecificOutput 会红。
import { readFileSync } from 'node:fs';
import { completedRuns } from './continuation-results.mjs';
import { isMainModule } from './is-main.mjs';
import { decideQueueStop } from './queue-stop.mjs';
import {
  decideStop,
  isMachineSession,
  pendingOf,
  readState,
  selectSessionId,
  stateDir,
} from './unattended.mjs';

if (isMainModule(import.meta)) {
  if (process.env.FLEET_HEADLESS === '1') process.exit(0);
  /** @type {Record<string, unknown>} */
  let input = {};
  try {
    const parsed = JSON.parse(readFileSync(0, 'utf8') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
  } catch {
    // 读不懂输入就当没有能提醒的信息，不出声（读不懂不该炸）
  }
  // 无人值守：只有这个会话自己跑过 `unattended.mjs on` 才挡；先判，它自己防空转，不看 stop_hook_active
  // （我们自己挡回去之后那个标志就一直是真的）。机器派的会话（工人、反方）不挡。
  const notes = [];
  try {
    const session = selectSessionId(process.env, input?.session_id);
    if (!session.ok && !session.missing) notes.push(`无人值守状态没查成：${session.why}，这一轮不拦。`);
    if (session.ok && !input.agent_id && !isMachineSession({ env: process.env, cwd: input.cwd })) {
      const sessionId = session.id;
      const dir = stateDir();
      // 先接续本会话任务；不能被队列的另一个三次计数遮住，也不能凭后台任务存在而放行。
      /** @type {{ key: string, text: string }[]} */
      let completions = [];
      try {
        const state = readState(dir, sessionId);
        if (state.ok && state.state?.state === 'on') completions = completedRuns(sessionId);
      } catch (err) {
        notes.push(`后台完成结果没查成：${String(err)}`);
      }
      const un = decideStop({ dir, sessionId, pending: pendingOf(input), completions });
      if (un.block) {
        process.stdout.write(
          `${JSON.stringify({ decision: 'block', reason: [un.reason, ...notes].join('\n') })}\n`,
        );
        process.exit(0);
      }
      if (un.notice) notes.push(un.notice);
      // 未开无人值守时仍做原有收轮前对账。
      const q = await decideQueueStop({ input, dir, sessionId });
      if (q.block) {
        process.stdout.write(`${JSON.stringify({ decision: 'block', reason: q.reason })}\n`);
        process.exit(0);
      }
      if (q.notice) notes.push(q.notice);
    }
  } catch (err) {
    notes.push(`收尾接续判断失败：${String(err)}；未证明工作完成，这一轮不拦以免困住会话。`);
  }
  if (notes.length > 0) process.stdout.write(`${JSON.stringify({ systemMessage: notes.join('；') })}\n`);
  process.exit(0);
}
