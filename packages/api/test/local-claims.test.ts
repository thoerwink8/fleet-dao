// 本机领单（决定 0096）：POST /api/nodes/claims，本机会话心跳同一个通行证；不成的回 409 / 404 带原因，没接库回 503。
import { NODE_REPORT_HEADER } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { engineTakeOver, type LocalClaimsPort, pgLocalClaims } from '../src/local-claims.ts';
import { nodeKeyHash } from '../src/node-report.ts';
import { type WorkflowControl, WorkflowGoneError, WorkflowUnavailableError } from '../src/ports.ts';
import { harness } from './harness.ts';

const TOKEN = 'token-of-founder-pc-0123456789abcdefghijk';
const KEYS = { 'founder-pc': nodeKeyHash(TOKEN) };

function port(reply: Awaited<ReturnType<LocalClaimsPort['apply']>>) {
  const seen: Parameters<LocalClaimsPort['apply']>[0][] = [];
  const p: LocalClaimsPort = {
    async apply(input) {
      seen.push(input);
      return reply;
    },
    async list() {
      return [];
    },
  };
  return { p, seen };
}

function post(
  h: ReturnType<typeof harness>,
  body: unknown,
  headers: Record<string, string> = { [NODE_REPORT_HEADER]: TOKEN },
) {
  return h.cockpit.request('/api/nodes/claims', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const CLAIM = { action: 'claim', repo: 'acme/app', issue: 42, title: '加验证码' };

describe('POST /api/nodes/claims', () => {
  it('对上通行证的收下：环境编号取钥匙的，不信载荷；回租约', async () => {
    const { p, seen } = port({
      ok: true,
      taskId: 't1',
      state: 'running',
      executor: 'local',
      leaseUntil: '2026-10-14T14:00:00.000Z',
    });
    const h = harness({ config: { nodeKeys: KEYS }, localClaims: p });
    const res = await post(h, CLAIM);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      executor: 'local',
      leaseUntil: '2026-10-14T14:00:00.000Z',
    });
    expect(seen[0]).toMatchObject({ nodeId: 'founder-pc', request: CLAIM });
  });

  it('【故意造出的失败】引擎在做：409 带原因；仓不归法国管：404', async () => {
    const busy = harness({
      config: { nodeKeys: KEYS },
      localClaims: port({ ok: false, code: 'engine_has_it', why: '法国引擎手上有这张单' }).p,
    });
    const r1 = await post(busy, CLAIM);
    expect(r1.status).toBe(409);
    expect(await codeOf(r1)).toBe('engine_has_it');
    const unknown = harness({
      config: { nodeKeys: KEYS },
      localClaims: port({ ok: false, code: 'unknown_repo', why: '不是法国管的仓' }).p,
    });
    expect((await post(unknown, CLAIM)).status).toBe(404);
  });

  it('【故意造出的失败】没带通行证 401；多带字段 400；没接库 503，都不调登记', async () => {
    const { p, seen } = port({
      ok: true,
      taskId: 't1',
      state: 'running',
      executor: 'local',
      leaseUntil: null,
    });
    const h = harness({ config: { nodeKeys: KEYS }, localClaims: p });
    expect((await post(h, CLAIM, {})).status).toBe(401);
    expect((await post(h, { ...CLAIM, token: 'x' })).status).toBe(400);
    expect(seen).toEqual([]);
    const bare = harness({ config: { nodeKeys: KEYS } });
    const res = await post(bare, CLAIM);
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('local_claims_not_wired');
  });
});

describe('engineTakeOver / pgLocalClaims：接手停下的单要叫停引擎任务', () => {
  const task = { taskId: 't1', issueNumber: 42, state: 'stalled', doing: '停着' } as const;
  const control = (signal: WorkflowControl['signal'], running?: WorkflowControl['runningTaskWorkflow']) =>
    ({ signal, ...(running ? { runningTaskWorkflow: running } : {}) }) as WorkflowControl;

  it('发 taskAbandon，by 是 node:<环境>，note 是「本机接手」，发给在跑的那一代', async () => {
    const sent: unknown[] = [];
    const wf = control(
      async (id, s) => {
        sent.push([id, s]);
      },
      async () => 'task-acme-app-42-g2',
    );
    expect(await engineTakeOver(wf, 'acme/app', 'founder-pc')(task)).toEqual({ ok: true });
    expect(sent).toEqual([
      ['task-acme-app-42-g2', { name: 'taskAbandon', by: 'node:founder-pc', reason: '本机接手' }],
    ]);
  });

  it('工作流已经没了（Gone）当已叫停；连不上、别的错带原因拒', async () => {
    const gone = control(async () => {
      throw new WorkflowGoneError('w');
    });
    expect(await engineTakeOver(gone, 'acme/app', 'n')(task)).toEqual({ ok: true });
    const down = control(async () => {
      throw new WorkflowUnavailableError('连不上');
    });
    expect(await engineTakeOver(down, 'acme/app', 'n')(task)).toMatchObject({ ok: false });
    const bad = control(async () => {
      throw new Error('炸了');
    });
    const r = await engineTakeOver(bad, 'acme/app', 'n')(task);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? '' : r.why).toContain('炸了');
  });

  it('pgLocalClaims 的 claim 带上 takeOver；没给 workflows 就不带（停下的单照旧拒）', async () => {
    const seen: unknown[] = [];
    const ops = {
      claim: async (i: { takeOver?: unknown }) => {
        seen.push(i.takeOver);
        return {
          ok: true as const,
          taskId: 't',
          state: 'running',
          executor: 'local' as const,
          leaseUntil: null,
        };
      },
      list: async () => [],
      renew: async () => {
        throw new Error('不该调');
      },
      finish: async () => {
        throw new Error('不该调');
      },
    };
    const req = { action: 'claim', repo: 'acme/app', issue: 1, title: 'x' } as const;
    await pgLocalClaims({ ...ops, workflows: control(async () => {}) }).apply({
      nodeId: 'n',
      request: req,
      now: new Date(),
    });
    await pgLocalClaims(ops).apply({ nodeId: 'n', request: req, now: new Date() });
    expect(typeof seen[0]).toBe('function');
    expect(seen[1]).toBeUndefined();
  });
});
