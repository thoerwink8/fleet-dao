// Codex SessionStart 只回填本会话接续状态，不启动/修改别的 CLI 配置。
import { readFileSync } from 'node:fs';
import { noteReceipt, receiptContext } from './continuation-receipts.mjs';
import { readState, selectSessionId, sessionLines, stateDir, unattendedAuthority } from './unattended.mjs';

/** @type {ReturnType<typeof receiptContext>|null} */
let receipt = null;
try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const session = selectSessionId(process.env, input.session_id);
  const authority = unattendedAuthority({
    env: process.env,
    cwd: input.cwd,
    hookId: input.session_id,
    agentId: input.agent_id,
    expectedCli: 'codex',
  });
  const dir = stateDir();
  const state = session.ok && authority.kind === 'allowed' ? readState(dir, session.id) : null;
  const context = receiptContext(
    dir,
    input,
    state?.ok ? state.state : null,
    'SessionStart',
    process.env,
    authority.kind,
    'codex',
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
  if (session.ok && process.env.FLEET_HEADLESS !== '1' && !input.agent_id && authority.kind === 'allowed') {
    const lines = sessionLines({ dir: stateDir(), sessionId: session.id });
    if (lines.length)
      process.stdout.write(
        `${JSON.stringify({
          systemMessage: lines.join('\n'),
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') },
        })}\n`,
      );
  }
  if (authority.kind === 'unknown')
    process.stderr.write(`无人值守开场身份没查成（${authority.code}），未读取父会话状态。\n`);
} catch (err) {
  noteReceipt(receipt ?? receiptContext(stateDir(), {}, null, 'SessionStart'), {
    phase: 'fault',
    decision: receipt ? 'read_failed' : 'invalid_input',
  });
  process.stderr.write(`无人值守开场读回失败：${err instanceof Error ? err.message : String(err)}\n`);
}
