// Codex SessionStart 只回填本会话接续状态，不启动/修改别的 CLI 配置。
import { readFileSync } from 'node:fs';
import { isMachineSession, selectSessionId, sessionLines, stateDir } from './unattended.mjs';

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const session = selectSessionId(process.env, input.session_id);
  if (
    session.ok &&
    process.env.FLEET_HEADLESS !== '1' &&
    !input.agent_id &&
    !isMachineSession({ env: process.env, cwd: input.cwd })
  ) {
    const lines = sessionLines({ dir: stateDir(), sessionId: session.id });
    if (lines.length)
      process.stdout.write(
        `${JSON.stringify({
          systemMessage: lines.join('\n'),
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') },
        })}\n`,
      );
  }
} catch (err) {
  process.stderr.write(`无人值守开场读回失败：${err instanceof Error ? err.message : String(err)}\n`);
}
