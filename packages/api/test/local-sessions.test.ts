// 本机会话（#1991）的收（POST /api/nodes/sessions，专用通行证）和读（GET /api/nodes/sessions，登录门后面）。
// 故意造出的失败：没带头、假通行证 401；多带提示词 400；超大 413；20 秒内再推 429；没配钥匙 503 且读口写 notWired；
// 推不来了：读口写 stale / never（页面写「没上报」），不当成 0 个会话。
import {
  LOCAL_SESSION_IDLE_MS,
  LOCAL_SESSIONS_FRESH_MS,
  LOCAL_SESSIONS_MAX_BYTES,
  LocalSessionsResponseSchema,
  NODE_REPORT_HEADER,
} from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { nodeKeyHash } from '../src/node-report.ts';
import { type Harness, harness, T0 } from './harness.ts';

const TOKEN = 'token-of-founder-pc-0123456789abcdefghijk';
const KEYS = { 'founder-pc': nodeKeyHash(TOKEN) };
const MIN = 60_000;
const at = (ms: number) => new Date(T0.getTime() + ms).toISOString();

function report(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    reportedAt: at(0),
    machine: '创始人的电脑',
    sessions: [
      {
        id: 'run-1',
        repo: 'thoerwink8/fleet-dao',
        branch: 'feat/x',
        worktree: 'agent-1',
        subagent: false,
        startedAt: at(-60 * MIN),
        lastSeenAt: at(-MIN),
        last: 'tool',
        lastTool: 'Bash',
      },
      {
        id: 'idle-1',
        repo: 'thoerwink8/fleet-dao',
        branch: 'main',
        worktree: null,
        subagent: true,
        agentType: 'Explore',
        startedAt: at(-90 * MIN),
        lastSeenAt: at(-LOCAL_SESSION_IDLE_MS - MIN),
        last: 'tool',
        lastTool: 'Read',
      },
      {
        id: 'stop-1',
        repo: null,
        branch: null,
        worktree: null,
        subagent: false,
        startedAt: at(-30 * MIN),
        lastSeenAt: at(-5 * MIN),
        last: 'stop',
        lastTool: null,
      },
    ],
    problems: [],
    ...over,
  };
}

const setup = (keys: Record<string, string> = KEYS) => harness({ config: { nodeKeys: keys } });

function post(h: Harness, body: unknown, headers: Record<string, string> = { [NODE_REPORT_HEADER]: TOKEN }) {
  return h.cockpit.request('/api/nodes/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
async function read(h: Harness) {
  const { cookie } = await h.login();
  const res = await h.cockpit.request('/api/nodes/sessions', { headers: { cookie } });
  expect(res.status).toBe(200);
  return LocalSessionsResponseSchema.parse(await res.json());
}
const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('收本机会话', () => {
  it('对上的收下：记在钥匙的编号下；读回三个会话各是在跑、超过阈值没动、刚停', async () => {
    const h = setup();
    const res = await post(h, report());
    expect(res.status).toBe(200);
    const got = await read(h);
    expect(got.notWired).toBeUndefined();
    expect(got.nodes).toHaveLength(1);
    const node = got.nodes[0];
    expect(node).toMatchObject({ id: 'founder-pc', freshness: 'fresh', machine: '创始人的电脑' });
    const states = Object.fromEntries((node?.sessions ?? []).map((s) => [s.id, s.state]));
    expect(states).toEqual({ 'run-1': 'running', 'idle-1': 'idle', 'stop-1': 'stopped' });
  });

  it('【故意造出的失败】没带头、假通行证：401，什么都没写', async () => {
    const h = setup();
    expect((await post(h, report(), {})).status).toBe(401);
    expect((await post(h, report(), { [NODE_REPORT_HEADER]: 'fake-fake-fake-fake' })).status).toBe(401);
    expect(await h.store.listNodeSessions()).toEqual([]);
  });

  it('【故意造出的失败】多带了提示词、命令参数：400，整份不收', async () => {
    const h = setup();
    const r = report();
    (r.sessions[0] as Record<string, unknown>).prompt = '帮我改登录页';
    const res = await post(h, r);
    expect(res.status).toBe(400);
    const r2 = { ...report(), cwd: 'D:\\frank\\secret' };
    expect((await post(h, r2)).status).toBe(400);
    expect(await h.store.listNodeSessions()).toEqual([]);
  });

  it('【故意造出的失败】超过大小上限 413；20 秒内再推 429', async () => {
    const h = setup();
    const big = report({ problems: ['x'.repeat(LOCAL_SESSIONS_MAX_BYTES)] });
    expect((await post(h, big)).status).toBe(413);
    expect((await post(h, report())).status).toBe(200);
    const again = await post(h, report());
    expect(again.status).toBe(429);
    expect(await codeOf(again)).toBe('too_frequent');
  });

  it('【故意造出的失败】这台没配钥匙：收 503；读口写 notWired，不当成没有本机会话', async () => {
    const h = setup({});
    const res = await post(h, report());
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('node_keys_not_wired');
    const got = await read(h);
    expect(got.notWired).toMatch(/FLEET_NODE_KEYS/);
    expect(got.nodes).toEqual([]);
  });
});

describe('读本机会话：推不来了就是「没上报」', () => {
  it('【故意造出的失败】配了钥匙、一次都没推来：freshness=never，没有会话', async () => {
    const h = setup();
    const got = await read(h);
    expect(got.nodes).toEqual([{ id: 'founder-pc', freshness: 'never', sessions: [], problems: [] }]);
  });

  it('【故意造出的失败】上次收到超过 5 分钟：stale，会话照列（页面灰着写旧的），多久没动按收到后过了多久往上加', async () => {
    const h = setup();
    expect((await post(h, report())).status).toBe(200);
    h.clock.now = new Date(T0.getTime() + LOCAL_SESSIONS_FRESH_MS + MIN);
    const got = await read(h);
    const node = got.nodes[0];
    expect(node?.freshness).toBe('stale');
    const run = node?.sessions.find((s) => s.id === 'run-1');
    expect(run?.idleMs).toBe(MIN + LOCAL_SESSIONS_FRESH_MS + MIN);
  });

  it('推送方自己没读成的照带：problems 原样读回', async () => {
    const h = setup();
    await post(h, report({ problems: ['心跳文件 abc.json 认不出'] }));
    expect((await read(h)).nodes[0]?.problems).toEqual(['心跳文件 abc.json 认不出']);
  });
});
