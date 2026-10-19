import { expect, it } from 'vitest';
import { runChildOk } from './child.ts';

const moduleUrl = new URL('../hooks/unattended.mjs', import.meta.url).href;

it.each([
  ['Asia/Shanghai', '2026-10-18T19:45:20.398Z', '2026-10-19 03:45 UTC+08:00'],
  ['America/Los_Angeles', '2026-01-01T03:45:20.398Z', '2025-12-31 19:45 UTC-08:00'],
  ['America/Los_Angeles', '2026-07-01T03:45:20.398Z', '2026-06-30 20:45 UTC-07:00'],
  ['Asia/Kathmandu', '2026-10-18T19:45:20.398Z', '2026-10-19 01:30 UTC+05:45'],
  ['UTC', '2026-10-18T19:45:20.398Z', '2026-10-18 19:45 UTC+00:00'],
])('截止显示使用 %s 的本地日期和明确偏移', { timeout: 0 }, (tz, expiresAt, expected) => {
  const source = `
    import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { main, sessionLines, decideStop } from ${JSON.stringify(moduleUrl)};
    const dir = mkdtempSync(join(tmpdir(), 'unattended-timezone-'));
    try {
      const expiresAt = ${JSON.stringify(expiresAt)};
      const now = Date.parse(expiresAt) - 12 * 3600000;
      const sessionId = 'timezone-test';
      const env = { FLEET_UNATTENDED_DIR: dir, CLAUDE_CODE_SESSION_ID: sessionId };
      const lines = [];
      const io = { env, now, out: s => lines.push(s), err: s => { throw Error(s); } };
      if (main(['on'], io) !== 0 || main(['status'], io) !== 0) throw Error('CLI failed');
      lines.push(...sessionLines({ dir, sessionId, now }));
      const stored = JSON.parse(readFileSync(join(dir, sessionId + '.json'), 'utf8'));
      const stopped = decideStop({ dir, sessionId, now: Date.parse(expiresAt) + 1 });
      console.log(JSON.stringify({ lines, stored, stopped }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  `;
  const result = JSON.parse(
    runChildOk(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, TZ: tz },
    }),
  );
  expect(result.lines).toHaveLength(3);
  for (const line of result.lines) expect(line).toContain(expected);
  expect(result.stored.expiresAt).toBe(expiresAt);
  expect(result.stored.state).toBe('on');
  expect(result.stopped.block).toBe(false);
  expect(result.stopped.notice).toContain(expected);
});
