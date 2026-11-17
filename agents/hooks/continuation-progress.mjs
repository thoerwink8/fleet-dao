// 成功工具完成后登记实质进展；只消费本会话已开的无人值守，不自动开。
// 平时不输出提示。主会话派出的 Agent/Task 顺手记一行归属；本会话若有待执行的子代理停止，才写一句给模型。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { noteReceipt, observeContinuation, receiptContext } from './continuation-receipts.mjs';
import { isMainModule } from './is-main.mjs';
import { readState, recordProgress, selectSessionId, stateDir, unattendedAuthority } from './unattended.mjs';

const require = createRequire(import.meta.url);
/** 归属模块不进类型工程的 files 名单，说明符不写成字面量，避免 tsc 把它算进这个工程。 */
const ownerLib = () => require(['.', 'subagent-owner.mjs'].join('/'));

/** @param {'codex'|undefined} [expectedCli] */
export function runProgress(expectedCli) {
  /** @type {ReturnType<typeof receiptContext>|null} */
  let receipt = null;
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    // 记不上、停止通知读不了，都不挡下面的进展登记。
    try {
      const owner = ownerLib();
      owner.recordDispatch(input, { pid: process.ppid });
      const stopText = input.agent_id ? null : owner.takeStopNotice(input.session_id);
      if (typeof stopText === 'string') {
        process.stdout.write(
          `${JSON.stringify({
            systemMessage: stopText,
            hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: stopText },
          })}\n`,
        );
      }
    } catch {
      // 归属是旁路
    }
    const session = selectSessionId(process.env, input.session_id);
    const authority = unattendedAuthority({
      env: process.env,
      cwd: input.cwd,
      hookId: input.session_id,
      agentId: input.agent_id,
      expectedCli,
    });
    const dir = stateDir();
    const state = session.ok && authority.kind === 'allowed' ? readState(dir, session.id) : null;
    const context = receiptContext(
      dir,
      input,
      state?.ok ? state.state : null,
      'PostToolUse',
      process.env,
      authority.kind,
      expectedCli,
      session.ok ? () => readState(dir, session.id) : undefined,
    );
    receipt = context;
    noteReceipt(context, { phase: 'entered', decision: 'none' });
    const bypass =
      process.env.FLEET_HEADLESS === '1'
        ? 'headless'
        : input.agent_id
          ? 'subagent'
          : authority.kind === 'machine'
            ? 'machine'
            : null;
    if (bypass) noteReceipt(context, { phase: 'bypass', decision: bypass });
    else if (!session.ok || context.session === null || authority.kind === 'unknown')
      noteReceipt(context, { phase: 'fault', decision: 'identity_unknown' });
    else if (!state?.ok) noteReceipt(context, { phase: 'fault', decision: 'state_unknown' });
    else if (state.state?.state === 'on') observeContinuation(context);
    if (session.ok && process.env.FLEET_HEADLESS !== '1' && !input.agent_id && authority.kind === 'allowed')
      recordProgress({ dir, sessionId: session.id, input });
    if (authority.kind === 'unknown')
      process.stderr.write(`无人值守进展身份没查成（${authority.code}），未修改父会话状态。\n`);
  } catch (err) {
    noteReceipt(receipt ?? receiptContext(stateDir(), {}, null, 'PostToolUse'), {
      phase: 'fault',
      decision: receipt ? 'read_failed' : 'invalid_input',
    });
    process.stderr.write(`无人值守进展登记失败：${err instanceof Error ? err.message : String(err)}\n`);
  }
}
if (isMainModule(import.meta)) runProgress();
