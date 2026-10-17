import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { cleanSessionId } from '../hooks/session-id.mjs';
import { watchRuns } from '../hooks/work-watch.mjs';

it('会话号边界：只接受1到128个字母数字下划线和连字符', () => {
  for (const id of ['a', 'x'.repeat(128), 'A_Z-09']) expect(cleanSessionId(id)).toBe(id);
  for (const id of ['', 'x'.repeat(129), '../x', 'a/b', 'a\\b', 'a b', ' a', 33, null, undefined])
    expect(cleanSessionId(id)).toBeNull();
});
it('非法会话号不读写工人run/watch状态', async () => {
  const home = mkdtempSync(join(tmpdir(), 'invalid-work-sid-'));
  try {
    for (const session_id of ['../escape', 'x'.repeat(129), '']) {
      expect(
        await watchRuns({ session_id }, { home, env: { FLEET_WORK_RUNS_DIR: join(home, 'missing-runs') } }),
      ).toBe(0);
      expect(readdirSync(home)).toEqual([]);
      expect(existsSync(join(home, 'missing-runs'))).toBe(false);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
