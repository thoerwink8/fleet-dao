// 共享同步 Stop：Claude 在订阅项目登记，Codex 在用户 hooks.json 登记并信任。
// 先续本会话未完成工作并注入工人终态，后台任务条数不作为通知送达证明；未开无人值守才做原有队列对账。
// 起子代理、后台活不自动开；成功完成的新工作才重置无进展计数，三次无进展明确故障暂停。
// 引擎的无头会话（FLEET_HEADLESS=1）、机器派的会话（工人、反方）直接放行。
// 退出码恒为 0：Stop 上 exit 2 也是「不许停」。
// 规矩本身由 agents/test/rules/stop.rules.test.ts 钉住：不在 fleet-dao 检出里、又没开无人值守时，输出里出现 decision 或 hookSpecificOutput 会红。

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fingerprint, noteReceipt, receiptContext } from './continuation-receipts.mjs';
import { completedRuns } from './continuation-results.mjs';
import { isMainModule } from './is-main.mjs';
import { decideQueueStop } from './queue-stop.mjs';
import {
  decideStop,
  explicitlyOff,
  pendingOf,
  readState,
  selectSessionId,
  stateDir,
  unattendedAuthority,
} from './unattended.mjs';

/** stdout 回调只证明写出请求，不证明宿主已接收或模型已消费。
 * @param {ReturnType<typeof receiptContext>} context
 * @param {object} payload @param {string[]} results @param {'block'|'queue'} decision
 */
async function emitContinuation(context, payload, results, decision) {
  const continuation = fingerprint(randomUUID());
  noteReceipt(context, { phase: 'prepared', decision, continuation, results });
  const wrote = await new Promise((resolve) => {
    process.stdout.once('error', () => resolve(false));
    process.stdout.write(`${JSON.stringify(payload)}\n`, (error) => resolve(!error));
  });
  noteReceipt(context, {
    phase: wrote ? 'emitted' : 'fault',
    decision: wrote ? decision : 'write_failed',
    continuation,
  });
}

/** @param {'codex'|undefined} [expectedCli] */
export async function runStop(expectedCli) {
  /** @type {Record<string, unknown>} */
  let input = {};
  let validInput = true;
  try {
    const parsed = JSON.parse(readFileSync(0, 'utf8') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
    else validInput = false;
  } catch {
    validInput = false;
    // 读不懂输入就当没有能提醒的信息，不出声（读不懂不该炸）
  }
  const dir = stateDir();
  const session = selectSessionId(process.env, input?.session_id);
  const authority = unattendedAuthority({
    env: process.env,
    cwd: input.cwd,
    hookId: input.session_id,
    agentId: input.agent_id,
    expectedCli,
  });
  const initial = session.ok && authority.kind === 'allowed' ? readState(dir, session.id) : null;
  // 开始时捕获身份和generation；旧事件晚到也不能挂到后来重新on的窗口。
  const context = receiptContext(
    dir,
    input,
    initial?.ok ? initial.state : null,
    'Stop',
    process.env,
    authority.kind,
    expectedCli,
  );
  noteReceipt(context, { phase: 'entered', decision: 'none' });
  if (process.env.FLEET_HEADLESS === '1') {
    noteReceipt(context, { phase: 'bypass', decision: 'headless' });
    process.exit(0);
  }
  if (authority.kind === 'machine') {
    noteReceipt(context, { phase: 'bypass', decision: input.agent_id ? 'subagent' : 'machine' });
  } else if (!session.ok || context.session === null || authority.kind === 'unknown') {
    noteReceipt(context, { phase: 'fault', decision: validInput ? 'identity_unknown' : 'invalid_input' });
  } else if (!initial?.ok) {
    noteReceipt(context, { phase: 'fault', decision: 'state_unknown' });
  }
  // 无人值守：只有这个会话自己跑过 `unattended.mjs on` 才挡；先判，它自己防空转，不看 stop_hook_active
  // （我们自己挡回去之后那个标志就一直是真的）。机器派的会话（工人、反方）不挡。
  const notes = [];
  try {
    if (authority.kind === 'unknown')
      notes.push(`无人值守身份没查成（${authority.code}），未读取父会话状态，这一轮不拦。`);
    if (!session.ok && !session.missing) notes.push(`无人值守状态没查成：${session.why}，这一轮不拦。`);
    if (session.ok && authority.kind === 'allowed') {
      const sessionId = session.id;
      // 先接续本会话任务；不能被队列的另一个三次计数遮住，也不能凭后台任务存在而放行。
      /** @type {{ key: string, text: string }[]} */
      let completions = [];
      try {
        const state = readState(dir, sessionId);
        if (state.ok && state.state?.state === 'on') completions = completedRuns(sessionId);
      } catch (err) {
        noteReceipt(context, { phase: 'fault', decision: 'results_unknown' });
        notes.push(`后台完成结果没查成：${String(err)}`);
      }
      const un = decideStop({ dir, sessionId, pending: pendingOf(input), completions });
      if (un.block) {
        const results = completions
          .filter((c) => !(initial?.ok ? (initial.state?.deliveredResults ?? []) : []).includes(c.key))
          .map((c) => c.key);
        await emitContinuation(
          context,
          { decision: 'block', reason: [un.reason, ...notes].join('\n') },
          results,
          'block',
        );
        process.exit(0);
      }
      if (un.notice) notes.push(un.notice);
      // 未开无人值守时仍做原有收轮前对账。
      const q = await decideQueueStop({ input, dir, sessionId });
      if (q.block) {
        await emitContinuation(context, { decision: 'block', reason: q.reason }, [], 'queue');
        process.exit(0);
      }
      if (q.notice) notes.push(q.notice);
      const state = initial?.ok ? initial.state : null;
      noteReceipt(context, {
        phase: 'allow',
        decision: !initial?.ok
          ? 'state_unknown'
          : explicitlyOff(dir, sessionId)
            ? 'off'
            : state?.state === 'paused'
              ? 'paused'
              : state?.state === 'done'
                ? 'done'
                : state && Date.now() > Date.parse(state.expiresAt)
                  ? 'expired'
                  : un.notice
                    ? 'paused'
                    : 'not_on',
      });
    }
  } catch (err) {
    noteReceipt(context, { phase: 'fault', decision: 'read_failed' });
    notes.push(`收尾接续判断失败：${String(err)}；未证明工作完成，这一轮不拦以免困住会话。`);
  }
  if (notes.length > 0) process.stdout.write(`${JSON.stringify({ systemMessage: notes.join('；') })}\n`);
  process.exit(0);
}
if (isMainModule(import.meta)) await runStop();
