// 成功工具完成后登记实质进展；只消费本会话已开的无人值守，不自动开、不输出提示。
import { readFileSync } from 'node:fs';
import { noteReceipt, observeContinuation, receiptContext } from './continuation-receipts.mjs';
import { isMachineSession, readState, recordProgress, selectSessionId, stateDir } from './unattended.mjs';

/** @type {ReturnType<typeof receiptContext>|null} */
let receipt = null;
try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const session = selectSessionId(process.env, input.session_id);
  const dir = stateDir();
  const state = session.ok ? readState(dir, session.id) : null;
  const context = receiptContext(dir, input, state?.ok ? state.state : null, 'PostToolUse');
  receipt = context;
  noteReceipt(context, { phase: 'entered', decision: 'none' });
  const bypass =
    process.env.FLEET_HEADLESS === '1'
      ? 'headless'
      : input.agent_id
        ? 'subagent'
        : isMachineSession({ env: process.env, cwd: input.cwd })
          ? 'machine'
          : null;
  if (bypass) noteReceipt(context, { phase: 'bypass', decision: bypass });
  else if (!session.ok || context.session === null)
    noteReceipt(context, { phase: 'fault', decision: 'identity_unknown' });
  else if (!state?.ok) noteReceipt(context, { phase: 'fault', decision: 'state_unknown' });
  else if (state.state?.state === 'on') observeContinuation(context);
  if (
    session.ok &&
    process.env.FLEET_HEADLESS !== '1' &&
    !input.agent_id &&
    !isMachineSession({ env: process.env, cwd: input.cwd })
  )
    recordProgress({ dir, sessionId: session.id, input });
} catch (err) {
  noteReceipt(receipt ?? receiptContext(stateDir(), {}, null, 'PostToolUse'), {
    phase: 'fault',
    decision: receipt ? 'read_failed' : 'invalid_input',
  });
  process.stderr.write(`无人值守进展登记失败：${err instanceof Error ? err.message : String(err)}\n`);
}
