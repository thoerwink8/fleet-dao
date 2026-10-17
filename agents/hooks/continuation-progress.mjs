// 成功工具完成后登记实质进展；只消费本会话已开的无人值守，不自动开、不输出提示。
import { readFileSync } from 'node:fs';
import { isMachineSession, recordProgress, selectSessionId, stateDir } from './unattended.mjs';

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const session = selectSessionId(process.env, input.session_id);
  if (
    session.ok &&
    process.env.FLEET_HEADLESS !== '1' &&
    !input.agent_id &&
    !isMachineSession({ env: process.env, cwd: input.cwd })
  )
    recordProgress({ dir: stateDir(), sessionId: session.id, input });
} catch (err) {
  process.stderr.write(`无人值守进展登记失败：${err instanceof Error ? err.message : String(err)}\n`);
}
