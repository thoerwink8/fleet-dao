// 过程记录写口（决定 0122，母单 #3741 片 2a）：POST /api/nodes/notes 写一行账本，GET /api/nodes/events 读得到 progress: 行。
import { LEDGER_NOTE_KINDS, NODE_REPORT_HEADER } from '@fleet-dao/shared';
import { describe, expect, it, vi } from 'vitest';
import { nodeKeyHash } from '../src/node-report.ts';
import { harness } from './harness.ts';

const TOKEN = 'token-of-founder-pc-0123456789abcdefghijk';
const KEYS = { 'founder-pc': nodeKeyHash(TOKEN) };
const REPO = 'example/canary';

const note = (over: Record<string, unknown> = {}) => ({
  kind: 'progress.note',
  repo: REPO,
  text: '片 2a 写口做完了，等 CI',
  source: { kind: 'local-session', ref: 'sess-42' },
  idempotencyKey: 'note-0001-aaaa',
  ...over,
});

function post(
  h: ReturnType<typeof harness>,
  body: unknown,
  headers: Record<string, string> = { [NODE_REPORT_HEADER]: TOKEN },
) {
  return h.cockpit.request('/api/nodes/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
const get = (h: ReturnType<typeof harness>, query = '') =>
  h.cockpit.request(`/api/nodes/events${query}`, { headers: { [NODE_REPORT_HEADER]: TOKEN } });
/** 不带引导字段的四种 */
const PLAIN_KINDS = LEDGER_NOTE_KINDS.filter((k) => k !== 'directive');
const directive = (over: Record<string, unknown> = {}) =>
  note({
    kind: 'directive',
    issue: 3764,
    text: '（原话，只进私有库）',
    meaning: '创始人引导改记进驾驶舱库',
    category: 'ai',
    owner: 'dir-a',
    spokenAt: '2026-10-30 10:00 +0800',
    idempotencyKey: 'directive:202610301000-aaaa',
    ...over,
  });
const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const ledger = (h: ReturnType<typeof harness>) =>
  h.store.data.audit.filter((a) =>
    LEDGER_NOTE_KINDS.includes(a.action as (typeof LEDGER_NOTE_KINDS)[number]),
  );

describe('POST /api/nodes/notes', () => {
  it('【故意造出的失败】没带通行证、带错通行证都是 401，不记账', async () => {
    const h = harness({ config: { nodeKeys: KEYS } });
    expect((await post(h, note(), {})).status).toBe(401);
    expect((await post(h, note(), { [NODE_REPORT_HEADER]: 'not-the-token' })).status).toBe(401);
    expect(ledger(h)).toEqual([]);
  });

  it('请求体 strict：多一个字段、坏 kind、空 text、超长 text、坏 key、issue 非正整数都是 400', async () => {
    const h = harness({ config: { nodeKeys: KEYS } });
    for (const bad of [
      note({ extra: 1 }),
      note({ kind: 'issue.open' }),
      note({ text: '' }),
      note({ text: 'x'.repeat(20_001) }),
      note({ idempotencyKey: 'short' }),
      note({ issue: 0 }),
      note({ issue: 1.5 }),
      note({ source: { kind: 'local-session', ref: 'a', extra: 1 } }),
    ]) {
      expect((await post(h, bad)).status).toBe(400);
    }
    expect(ledger(h)).toEqual([]);
  });

  it('仓不归法国管 404 unknown_repo', async () => {
    const h = harness({ config: { nodeKeys: KEYS } });
    const res = await post(h, note({ repo: 'someone/else' }));
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe('unknown_repo');
    expect(ledger(h)).toEqual([]);
  });

  it('不挂单：target = progress:<repo>；四种 kind 都能写，after 里有 text / source / idempotencyKey，actor 是 agent node:<环境>', async () => {
    const h = harness({ config: { nodeKeys: KEYS } });
    for (const kind of PLAIN_KINDS) {
      const res = await post(h, note({ kind, idempotencyKey: `key-${kind}-0001` }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: expect.any(Number), created: true });
    }
    const rows = ledger(h);
    expect(rows.map((r) => r.action)).toEqual([...PLAIN_KINDS]);
    expect(rows.every((r) => r.target === `progress:${REPO}`)).toBe(true);
    expect(rows[0]).toMatchObject({
      actor: { kind: 'agent', id: 'node:founder-pc' },
      via: 'agent',
      ok: true,
      after: {
        repo: REPO,
        text: '片 2a 写口做完了，等 CI',
        source: { kind: 'local-session', ref: 'sess-42' },
        idempotencyKey: 'key-progress.note-0001',
      },
    });
  });

  it('挂单：target = issue:<repo>#<号>', async () => {
    const h = harness({ config: { nodeKeys: KEYS } });
    const res = await post(h, note({ kind: 'decision.handoff', issue: 3741 }));
    expect(res.status).toBe(200);
    expect(ledger(h)[0]).toMatchObject({
      action: 'decision.handoff',
      target: `issue:${REPO}#3741`,
      after: { number: 3741 },
    });
  });

  it('同一个仓同一个 idempotencyKey 重放：回原来那行、created:false，不多记；换 key 或换仓是新的一行', async () => {
    const h = harness({ config: { nodeKeys: KEYS } });
    const first = (await (await post(h, note())).json()) as { id: number; created: boolean };
    expect(first.created).toBe(true);
    const again = await post(h, note({ text: '换了字也是同一条' }));
    expect(await again.json()).toEqual({ id: first.id, created: false });
    expect(ledger(h)).toHaveLength(1);
    expect(ledger(h)[0]?.after).toMatchObject({ text: '片 2a 写口做完了，等 CI' });
    const other = (await (await post(h, note({ idempotencyKey: 'note-0002-bbbb' }))).json()) as {
      id: number;
      created: boolean;
    };
    expect(other.created).toBe(true);
    expect(other.id).not.toBe(first.id);
    expect(ledger(h)).toHaveLength(2);
  });

  it('directive：挂单、带意思和类别，原话在 text，target = issue:<repo>#<号>，读口读得到', async () => {
    const h = harness({ config: { nodeKeys: KEYS } });
    const res = await post(h, directive());
    expect(res.status).toBe(200);
    expect(ledger(h)[0]).toMatchObject({
      action: 'directive',
      target: `issue:${REPO}#3764`,
      after: {
        number: 3764,
        text: '（原话，只进私有库）',
        meaning: '创始人引导改记进驾驶舱库',
        category: 'ai',
        owner: 'dir-a',
        spokenAt: '2026-10-30 10:00 +0800',
      },
    });
    const body = (await (await get(h)).json()) as { events: { action: string }[] };
    expect(body.events.map((e) => e.action)).toEqual(['directive']);
    const again = await post(h, directive());
    expect(((await again.json()) as { created: boolean }).created).toBe(false);
    expect(ledger(h)).toHaveLength(1);
  });

  it('directive 缺单、缺意思、缺类别、类别认不出：400；别的 kind 带引导字段也 400', async () => {
    const h = harness({ config: { nodeKeys: KEYS } });
    for (const bad of [
      directive({ issue: undefined }),
      directive({ meaning: undefined }),
      directive({ category: undefined }),
      directive({ category: 'nope' }),
      note({ meaning: '不该带' }),
      note({ kind: 'decision.handoff', category: 'ai' }),
    ]) {
      expect((await post(h, bad)).status).toBe(400);
    }
    expect(ledger(h)).toEqual([]);
  });

  it('库写失败 503，不假装记了', async () => {
    const h = harness({ config: { nodeKeys: KEYS } });
    vi.spyOn(h.store, 'appendLedgerNote').mockRejectedValue(new Error('db down'));
    const res = await post(h, note());
    expect(res.status).toBe(503);
    expect(await errCode(res)).toBe('ledger_unwritable');
  });
});

describe('GET /api/nodes/events 读得到 progress: 行', () => {
  it('issue: 和 progress: 的行一起、按 id 升序，别的 target 不读', async () => {
    const h = harness({ config: { nodeKeys: KEYS } });
    await post(h, note({ idempotencyKey: 'note-0001-aaaa' }));
    await h.store.appendAudit({
      actor: { kind: 'ops', id: 'x' },
      action: 'task.pause',
      target: 'task:1',
      via: 'ops',
      ok: true,
    });
    await post(h, note({ kind: 'decision.handoff', issue: 7, idempotencyKey: 'note-0002-bbbb' }));
    await h.store.appendAudit({
      actor: { kind: 'ops', id: 'x' },
      action: 'login',
      target: 'progressive:1',
      via: 'ops',
      ok: true,
    });
    const body = (await (await get(h)).json()) as {
      events: { id: number; action: string; target: string; after: { text: string } }[];
      next: number;
    };
    expect(body.events.map((e) => [e.action, e.target])).toEqual([
      ['progress.note', `progress:${REPO}`],
      ['decision.handoff', `issue:${REPO}#7`],
    ]);
    expect(body.events[0]?.after.text).toBe('片 2a 写口做完了，等 CI');
    expect(body.next).toBe(body.events.at(-1)?.id);
    const page = (await (await get(h, `?after=${body.events[0]?.id}&limit=1`)).json()) as {
      events: { target: string }[];
    };
    expect(page.events.map((e) => e.target)).toEqual([`issue:${REPO}#7`]);
  });
});
