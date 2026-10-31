// 本机交单给法国（#3739）：POST /api/nodes/dispatch，只认机器通行证；准入没过列原因（409）、没查成 503、每次写操作记录。不连真 GitHub、Temporal。
import { NODE_DISPATCH_AUDIT_ACTION, NODE_DISPATCH_FULL_PATH, NODE_REPORT_HEADER } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { type NodeDispatchFn, parseRefusalReasons } from '../src/node-dispatch.ts';
import { nodeKeyHash } from '../src/node-report.ts';
import { harness } from './harness.ts';

const TOKEN = 'token-of-founder-pc-0123456789abcdefghijk';
const KEYS = { 'founder-pc': nodeKeyHash(TOKEN) };
const BODY = { repo: 'acme/app', issueNumber: 42, source: { kind: 'local-session', ref: '42' } };

function fake(reply: Awaited<ReturnType<NodeDispatchFn>> | Error) {
  const seen: Parameters<NodeDispatchFn>[] = [];
  const fn: NodeDispatchFn = async (...args) => {
    seen.push(args);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { fn, seen };
}

function post(
  h: ReturnType<typeof harness>,
  body: unknown,
  headers: Record<string, string> = { [NODE_REPORT_HEADER]: TOKEN },
) {
  return h.cockpit.request(NODE_DISPATCH_FULL_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const audits = async (h: ReturnType<typeof harness>) =>
  (await h.store.listAudit({ limit: 50 })).items.filter((a) => a.action === NODE_DISPATCH_AUDIT_ACTION);

const REFUSED_TEXT = [
  '没派：acme/app#42',
  '  not_current_version：不是当前版本（硬闸？就绪度闸）（就绪度闸，确认没问题可以加 --force --note "<为什么>"）',
  '  author_not_whitelisted：作者不在白名单（硬闸，force 也不放行）',
].join('\n');

describe('POST /api/nodes/dispatch', () => {
  it('【故意造出的失败】没带通行证 401、带错 401，都不派也不写记录', async () => {
    const { fn, seen } = fake({ ok: true, text: '已派' });
    const h = harness({ config: { nodeKeys: KEYS }, nodeDispatch: fn });
    const none = await post(h, BODY, {});
    expect(none.status).toBe(401);
    expect(await codeOf(none)).toBe('node_token_missing');
    const wrong = await post(h, BODY, { [NODE_REPORT_HEADER]: 'not-the-token' });
    expect(wrong.status).toBe(401);
    expect(await codeOf(wrong)).toBe('node_token_invalid');
    expect(seen).toEqual([]);
    expect(await audits(h)).toEqual([]);
  });

  it('派了：200 dispatched；按钥匙认出的环境编号写进执行者，不信载荷；写一条操作记录', async () => {
    const { fn, seen } = fake({ ok: true, text: '已派：acme/app#42 的任务工作流已经起了' });
    const h = harness({ config: { nodeKeys: KEYS }, nodeDispatch: fn });
    const res = await post(h, BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: 'dispatched',
      text: '已派：acme/app#42 的任务工作流已经起了',
    });
    expect(seen).toEqual([[{ owner: 'acme', name: 'app' }, 42, 'node:founder-pc local-session:42']]);
    const [entry, ...rest] = await audits(h);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      action: 'issue.dispatch_request',
      target: 'issue:acme/app#42',
      actor: { kind: 'agent', id: 'founder-pc' },
      ok: true,
      after: { result: 'dispatched', nodeId: 'founder-pc', source: BODY.source },
    });
  });

  it('准入没过：409 refused，列出每一道原因；操作记录写明没派', async () => {
    const h = harness({
      config: { nodeKeys: KEYS },
      nodeDispatch: fake({ ok: false, text: REFUSED_TEXT }).fn,
    });
    const res = await post(h, BODY);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { result: string; reasons: { reason: string; why: string }[] };
    expect(body.result).toBe('refused');
    expect(body.reasons.map((r) => r.reason)).toEqual(['not_current_version', 'author_not_whitelisted']);
    expect(body.reasons[1]?.why).toContain('作者不在白名单');
    const [entry] = await audits(h);
    expect(entry).toMatchObject({
      ok: true,
      after: { result: 'refused', reasons: ['not_current_version', 'author_not_whitelisted'] },
    });
  });

  it('【故意造出的失败】没查成：派单抛错 503，不当成没派也不当成派了；记录 ok=false 带原因', async () => {
    const h = harness({
      config: { nodeKeys: KEYS },
      nodeDispatch: fake(new Error('派工结果未知（退出码 1）：没查成：Temporal 连不上')).fn,
    });
    const res = await post(h, BODY);
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('dispatch_unavailable');
    const [entry] = await audits(h);
    expect(entry).toMatchObject({
      ok: false,
      after: { result: 'unavailable' },
      error: expect.stringContaining('Temporal 连不上'),
    });
  });

  it('【故意造出的失败】没派、但输出里一道原因也认不出：503，不编一个 refused', async () => {
    const h = harness({
      config: { nodeKeys: KEYS },
      nodeDispatch: fake({ ok: false, text: '没派：???' }).fn,
    });
    const res = await post(h, BODY);
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('dispatch_unavailable');
  });

  it('没接派单（开发、内存版）503；多带字段（比如 force）400，都不派', async () => {
    const bare = harness({ config: { nodeKeys: KEYS } });
    const r1 = await post(bare, BODY);
    expect(r1.status).toBe(503);
    expect(await codeOf(r1)).toBe('node_dispatch_not_wired');
    const { fn, seen } = fake({ ok: true, text: '已派' });
    const h = harness({ config: { nodeKeys: KEYS }, nodeDispatch: fn });
    const r2 = await post(h, { ...BODY, force: true });
    expect(r2.status).toBe(400);
    const r3 = await post(h, { ...BODY, source: { kind: 'somebody', ref: '1' } });
    expect(r3.status).toBe(400);
    const r4 = await post(h, { ...BODY, source: { kind: 'mirasim', ref: 'x'.repeat(101) } });
    expect(r4.status).toBe(400);
    const r5 = await post(h, { ...BODY, repo: 'a b/c' });
    expect(r5.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('派了但操作记录写不进：502 明说，不吞', async () => {
    const h = harness({ config: { nodeKeys: KEYS }, nodeDispatch: fake({ ok: true, text: '已派' }).fn });
    h.store.appendAudit = async () => {
      throw new Error('库写不进');
    };
    const res = await post(h, BODY);
    expect(res.status).toBe(502);
    expect(await codeOf(res)).toBe('dispatched_audit_failed');
  });
});

describe('parseRefusalReasons', () => {
  it('每行一道原因；第一行和空行不算', () => {
    expect(parseRefusalReasons(REFUSED_TEXT).map((r) => r.reason)).toEqual([
      'not_current_version',
      'author_not_whitelisted',
    ]);
    expect(parseRefusalReasons('没派：acme/app#42\n')).toEqual([]);
  });
});
