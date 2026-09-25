// 真跑验收：会话里敲 fleet 命令能不能到后端。经 reclaude 起一个极小的会话，PATH 里放 fleet，后端是本机假后端；
// 会话结束后核对后端收到的请求（路径、通行证、内容）。
// 在法国 VPS 上以登录好的会话用户跑（不进 scope）：FLEET_ENV=development node packages/adapters/test/e2e/fleet-e2e.ts <reclaude 绝对路径> <fleet 所在目录> [模型]
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeClaudeRun, runClaudeCode } from '../../src/claude-code/run.ts';

const [reclaude, fleetBin, model = 'claude-haiku-4-5'] = process.argv.slice(2);
if (!reclaude || !fleetBin) {
  console.error('用法：node fleet-e2e.ts <reclaude 绝对路径> <fleet 所在目录> [模型]');
  process.exit(2);
}

const token = `e2e-${randomUUID()}`;
const seen: { method: string; path: string; auth: string; body: unknown }[] = [];
const server = createServer((req, res) => {
  let text = '';
  req.on('data', (c: Buffer) => {
    text += c.toString('utf8');
  });
  req.on('end', () => {
    seen.push({
      method: req.method ?? '',
      path: req.url ?? '',
      auth: req.headers.authorization ?? '',
      body: text ? JSON.parse(text) : undefined,
    });
    if (req.url === '/agent/v1/task') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          taskId: 'E2E-1',
          repo: 'example/e2e',
          branch: 'e2e',
          request: '验收 fleet 命令能从会话里打到后端',
          acceptance: ['后端收到 task、plan、say 三个请求'],
          touches: [],
          plan: [],
        }),
      );
      return;
    }
    res.writeHead(204);
    res.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const cwd = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
const report = await runClaudeCode(
  {
    runId: 'e2e-fleet',
    cwd,
    prompt:
      '按顺序运行这三条命令，每条都要真的运行：\n' +
      '1. fleet task\n' +
      '2. fleet plan "[x] 看任务" "[>] 报进度"\n' +
      '3. fleet say "e2e 进度正常"\n' +
      '全部运行完只回复「好了」。',
    model,
    session: { mode: 'new', id: randomUUID() },
    permissionMode: 'bypassPermissions',
    env: { base: process.env, fleetApi: api, fleetToken: token, pathPrepend: [fleetBin] },
    limits: { wallClockMs: 10 * 60_000 },
  },
  { command: [reclaude] },
);
server.close();
rmSync(cwd, { recursive: true, force: true });

const find = (path: string) => seen.find((s) => s.path === path);
const checks: [string, boolean][] = [
  ['会话正常结束', judgeClaudeRun(report).outcome === 'ok'],
  ['后端收到 fleet task', find('/agent/v1/task')?.method === 'GET'],
  [
    '后端收到 fleet plan，两步、第二步进行中',
    JSON.stringify(find('/agent/v1/plan')?.body) ===
      JSON.stringify({
        steps: [
          { title: '看任务', state: 'done' },
          { title: '报进度', state: 'in_progress' },
        ],
      }),
  ],
  [
    '后端收到 fleet say',
    JSON.stringify(find('/agent/v1/say')?.body) === JSON.stringify({ text: 'e2e 进度正常' }),
  ],
  ['每个请求都带着这次会话的通行证', seen.length > 0 && seen.every((s) => s.auth === `Bearer ${token}`)],
];
console.log(
  JSON.stringify(
    {
      seen: seen.map((s) => ({ ...s, auth: s.auth === `Bearer ${token}` ? '本会话通行证' : s.auth })),
      verdict: judgeClaudeRun(report),
      checks: Object.fromEntries(checks),
    },
    null,
    2,
  ),
);
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
console.log(failed.length ? `FAIL：${failed.join('、')}` : 'PASS');
process.exitCode = failed.length ? 1 : 0;
