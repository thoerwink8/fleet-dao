import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 测试只用临时CODEX_HOME；真实结构已脱敏，不读取运行测试的会话或对话。 */
export function codexSourceFixture(root: string, id: string, source: unknown = 'vscode', parent?: string) {
  const home = join(root, 'codex-home');
  const date = join(home, 'sessions', '2026', '10', '19');
  mkdirSync(date, { recursive: true });
  const file = join(date, `rollout-2026-10-19T00-00-00-${id}.jsonl`);
  const metadata = {
    type: 'session_meta',
    payload: { id, source, ...(parent ? { parent_thread_id: parent } : {}) },
  };
  writeFileSync(file, `${JSON.stringify(metadata)}\n`);
  return { home, date, file, metadata };
}
