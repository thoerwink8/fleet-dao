// @vitest-environment happy-dom
// 法国页刷新说明和实际间隔一致；发版卡「最多 N 分钟」读同一份等待上限（#2017）。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import France from '../routes/france';
import { renderApp } from './harness';

afterEach(cleanup);

const webSrc = path.join(process.cwd(), 'packages/web/src');
const repoRoot = process.cwd();

/** 从一个 export function 切到下一个，避免后面的钩子把前面的断言带过。 */
function fnBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = source.indexOf('\nexport function ', start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

test('法国页说明同时写出快的和慢的刷新间隔，和钩子用的是同一对数', async () => {
  const client = readFileSync(path.join(webSrc, 'api/client.tsx'), 'utf8');
  expect(client).toContain('export const POLL_FAST_MS = 30_000');
  expect(client).toContain('export const POLL_SLOW_MS = 60_000');
  for (const name of ['useJobs', 'useFranceReleaseState', 'useNodes', 'useNodeSnapshots']) {
    const body = fnBody(client, name);
    expect(body, name).toContain('refetchInterval: POLL_FAST_MS');
    expect(body, name).not.toContain('refetchInterval: POLL_SLOW_MS');
    expect(body, name).not.toMatch(/refetchInterval:\s*30_000/);
  }
  for (const name of ['useFranceReleaseCard', 'useCliTools', 'useEnv']) {
    const body = fnBody(client, name);
    expect(body, name).toContain('refetchInterval: POLL_SLOW_MS');
    expect(body, name).not.toContain('refetchInterval: POLL_FAST_MS');
    expect(body, name).not.toMatch(/refetchInterval:\s*60_000/);
  }
  const schedules = readFileSync(path.join(webSrc, 'routes/schedules.tsx'), 'utf8');
  const scheduleRow = readFileSync(path.join(webSrc, 'components/schedule-row.tsx'), 'utf8');
  expect(schedules).toContain('POLL_FAST_MS');
  expect(scheduleRow).toContain('POLL_FAST_MS');
  expect(schedules).not.toMatch(/每\s*30\s*秒自己刷新/);
  expect(scheduleRow).not.toMatch(/每\s*30\s*秒自己刷新/);
  renderApp(<France />);
  fireEvent.click(await screen.findByRole('button', { name: '这页是做什么的' }));
  const hint = await screen.findByText(/每 30 秒/);
  expect(hint.textContent).toContain('每 60 秒');
  expect(hint.textContent).not.toContain('每 30 秒自己刷新');
});

test('发版卡的「最多 N 分钟」和发版上限读同一份 session-wait', async () => {
  const card = readFileSync(path.join(webSrc, 'components/release-card.tsx'), 'utf8');
  expect(card).toContain('SESSION_WAIT_MS');
  expect(card).toContain('SESSION_WAIT_MS / 60_000');
  expect(card).not.toMatch(/最多\s*\n\s*13\s*\n\s*分钟/);
  expect(card).not.toMatch(/最多\s*13\s*分钟/);

  const waitSrc = readFileSync(path.join(repoRoot, 'deploy/france/release-request/session-wait.mjs'), 'utf8');
  expect(waitSrc).toContain('export const SESSION_WAIT_MS = 13 * 60_000');
  const lib = readFileSync(path.join(repoRoot, 'deploy/france/release-request/lib.mjs'), 'utf8');
  expect(lib).toContain("from './session-wait.mjs'");
  expect(lib).toContain('sessionsMs: SESSION_WAIT_MS');
  expect(lib).not.toMatch(/sessionsMs:\s*13\s*\*\s*60_000/);

  const sh = readFileSync(path.join(repoRoot, 'deploy/france.sh'), 'utf8');
  expect(sh).toMatch(/RELEASE_REQUEST_FILES=\([^)]*session-wait\.mjs/);
  const auto = readFileSync(path.join(repoRoot, 'deploy/france/auto-release/lib.mjs'), 'utf8');
  // 接活脚本归自动档（#2728）：自动发布每轮比副本哈希的清单（INSTALLED_COPIES）里有它，测试核对清单和 france.sh 一样
  expect(auto).toMatch(/src: 'deploy\/france\/release-request',\s*files: \[[^\]]*'session-wait\.mjs'/);
  const listed = readFileSync(path.join(repoRoot, 'deploy/test/release-request.test.mjs'), 'utf8');
  expect(listed).toContain("'session-wait.mjs'");

  // lib.mjs 会拉 auto-release；vitest 改写 import.meta.url 后 fileURLToPath 会炸，所以用 Node 自己对。
  const printed = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        "import { SESSION_WAIT_MS } from './deploy/france/release-request/session-wait.mjs';",
        "import { LIMITS } from './deploy/france/release-request/lib.mjs';",
        'if (LIMITS.sessionsMs !== SESSION_WAIT_MS) process.exit(2);',
        'if (SESSION_WAIT_MS / 60_000 !== 13) process.exit(3);',
        'process.stdout.write(String(SESSION_WAIT_MS));',
      ].join('\n'),
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  expect(Number(printed)).toBe(13 * 60_000);
});
