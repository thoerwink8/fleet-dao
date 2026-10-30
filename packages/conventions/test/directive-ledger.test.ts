// 创始人引导记进账本（#3764，决定 0123）：只经 POST /api/nodes/notes，不调 git、不调 gh pr create、不写 docs/directives/。
// 【故意造出的失败】：没给意思、挂的单已关、gh 读不到单、没法开单、账本写不成都明确拒绝或报没查成，写不成时不退回写文件。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ledgerPending, recordDirectiveToLedger } from '../src/directive-ledger.ts';
import { DirectiveRefused, DirectiveUnchecked } from '../src/directives.ts';
import type { Gh, GhResult } from '../src/issue-new.ts';
import type { LedgerNoteBody, LedgerNotePost } from '../src/ledger-note.ts';
import { LEDGER_PAGE, type LedgerEventsGet } from '../src/ledger-read.ts';
import { ProgressUnchecked } from '../src/progress.ts';

const QUOTE = '以后所有会话都先读规矩再动手，这是我的原话 xyz-secret-quote';
const rec = {
  text: QUOTE,
  at: '2026-10-30 10:00 +0800',
  atDate: new Date('2026-10-30T02:00:00Z'),
  owner: 'dir-a',
  source: 'prompt-log',
};
const meta = { meaning: '会话先读规矩再动手', category: 'ai' as const };
const okR = (stdout = ''): GhResult => ({ code: 0, stdout, stderr: '' });

function wiring(
  over: { open?: number[]; ghFails?: string; post?: (b: LedgerNoteBody) => ReturnType<LedgerNotePost> } = {},
) {
  const ghCalls: string[][] = [];
  const posts: LedgerNoteBody[] = [];
  const gh: Gh = async (args) => {
    ghCalls.push(args);
    if (over.ghFails) return { code: 1, stdout: '', stderr: over.ghFails };
    if (args[0] === 'issue' && args[1] === 'view')
      return okR((over.open ?? []).includes(Number(args[2])) ? 'OPEN\n' : 'CLOSED\n');
    return okR();
  };
  const post: LedgerNotePost = async (b) => {
    posts.push(b);
    return over.post ? over.post(b) : { status: 200, text: JSON.stringify({ id: 41, created: true }) };
  };
  return { ghCalls, posts, deps: { gh, post, repo: 'o/r', ref: 'sess-1' } };
}

/** 假法国账本：按 after/limit 切片，记下每次请求 */
function fakeLedger(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ after: number; limit: number }> = [];
  const get: LedgerEventsGet = async ({ after, limit }) => {
    calls.push({ after, limit });
    const events = rows
      .filter((r) => (r.id as number) > after)
      .slice(0, limit)
      .map((r) => ({ actorKind: 'agent', actorId: 'node:x', ok: true, ...r }));
    const last = rows
      .filter((r) => (r.id as number) > after)
      .slice(0, limit)
      .at(-1);
    return { status: 200, text: JSON.stringify({ events, next: (last?.id as number | undefined) ?? after }) };
  };
  return { get, calls };
}
const dirRow = (id: number, issue: number, meaning = `意思${id}`) => ({
  id,
  at: '2026-10-30T02:00:00Z',
  action: 'directive',
  target: `issue:o/r#${issue}`,
  after: { text: `原话${id}`, meaning, category: 'ai', owner: 'dir-a', spokenAt: '2026-10-30 10:00 +0800' },
});

describe('ledgerPending（progress read --pending 的账本那一半）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'directive-pending-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const openGh =
    (open: number[]): Gh =>
    async (args) =>
      args[1] === 'list' ? okR(JSON.stringify(open.map((number) => ({ number })))) : okR();

  it('账本里 directive 行挂的单还开着的才算没办完；关了的不列；增量读只请求 cursor 之后', async () => {
    const rows = [dirRow(1, 10), dirRow(2, 11)];
    const w = fakeLedger(rows);
    const stateFile = join(dir, 'a.json');
    const inbox = { get: w.get, stateFile, warn: () => {} };
    const first = await ledgerPending('o/r', { inbox, gh: openGh([10]) });
    expect(first.directives.map((d) => [d.id, d.issue, d.text])).toEqual([[1, 10, '原话1']]);
    expect(w.calls.map((c) => c.after)).toEqual([0]);

    rows.push(dirRow(3, 12));
    w.calls.length = 0;
    const second = await ledgerPending('o/r', { inbox, gh: openGh([10, 12]) });
    expect(second.directives.map((d) => d.id)).toEqual([1, 3]);
    expect(w.calls).toEqual([{ after: 2, limit: LEDGER_PAGE }]);
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))['o/r'] as {
      cursor: number;
      directives: unknown[];
    };
    expect(saved.cursor).toBe(3);
    expect(saved.directives).toHaveLength(3);
  });

  it('没有引导行时不去问 GitHub 开着的单', async () => {
    const w = fakeLedger([]);
    const gh: Gh = async () => {
      throw new Error('不该调 gh');
    };
    const got = await ledgerPending('o/r', { inbox: { get: w.get, warn: () => {} }, gh });
    expect(got).toEqual({ handoffs: [], directives: [] });
  });

  it('【故意造出的失败】账本读不到、开着的单读不到：都抛，不当成没有待办', async () => {
    const down: LedgerEventsGet = async () => ({ status: 503, text: 'down' });
    await expect(
      ledgerPending('o/r', { inbox: { get: down, warn: () => {} }, gh: openGh([]) }),
    ).rejects.toBeInstanceOf(ProgressUnchecked);
    const w = fakeLedger([dirRow(1, 10)]);
    const ghDown: Gh = async () => ({ code: 1, stdout: '', stderr: 'HTTP 502' });
    await expect(
      ledgerPending('o/r', { inbox: { get: w.get, warn: () => {} }, gh: ghDown }),
    ).rejects.toBeInstanceOf(DirectiveUnchecked);
  });

  it('老状态文件（还没有 directives 字段）照读，不重建', async () => {
    const stateFile = join(dir, 'old.json');
    writeFileSync(stateFile, JSON.stringify({ 'o/r': { cursor: 5, pending: [], cleared: [] } }));
    const w = fakeLedger([dirRow(6, 10)]);
    const warns: string[] = [];
    const got = await ledgerPending('o/r', {
      inbox: { get: w.get, stateFile, warn: (l) => warns.push(l) },
      gh: openGh([10]),
    });
    expect(got.directives.map((d) => d.id)).toEqual([6]);
    expect(w.calls[0]?.after).toBe(5);
    expect(warns).toEqual([]);
  });
});

describe('recordDirectiveToLedger', () => {
  it('写一条 kind=directive：原话在 text，意思、类别、主人、说话时刻、挂的单各一个字段；不调 gh pr create', async () => {
    const w = wiring({ open: [3764] });
    const made = await recordDirectiveToLedger(rec, meta, w.deps, 3764);
    expect(made).toEqual({ id: 41, issue: 3764, created: true });
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0]).toMatchObject({
      kind: 'directive',
      repo: 'o/r',
      issue: 3764,
      text: QUOTE,
      meaning: meta.meaning,
      category: 'ai',
      owner: 'dir-a',
      spokenAt: '2026-10-30 10:00 +0800',
      source: { kind: 'local-session', ref: 'sess-1' },
    });
    expect(w.posts[0]?.idempotencyKey).toMatch(/^directive:\d{12}-[0-9a-f]{16}$/);
    // 只查了挂的单开着没有；没有任何 pr 命令，也没有 git 依赖可调（deps 里压根没有 git）
    expect(w.ghCalls.map((a) => a.slice(0, 2).join(' '))).toEqual(['issue view']);
    expect(w.ghCalls.some((a) => a[0] === 'pr')).toBe(false);
    expect('git' in w.deps).toBe(false);
  });

  it('没给 --issue：顺手开一张单，标题和正文只用意思、不含原话', async () => {
    const w = wiring();
    const drafts: Array<{ title: string; body: string }> = [];
    const made = await recordDirectiveToLedger(rec, meta, {
      ...w.deps,
      newIssue: async (d) => {
        drafts.push(d);
        return 4242;
      },
    });
    expect(made.issue).toBe(4242);
    expect(w.posts[0]?.issue).toBe(4242);
    expect(JSON.stringify(drafts)).not.toContain('xyz-secret-quote');
    expect(drafts[0]?.title).toBe('创始人引导：会话先读规矩再动手');
    for (const h of ['## 场景', '## 原话', '## 已知的模块', '## 怎么算做完'])
      expect(drafts[0]?.body).toContain(h);
  });

  it('同一句同一分钟重跑：幂等键相同，回包 created:false 照实带回', async () => {
    const w = wiring({
      open: [1],
      post: async () => ({ status: 200, text: JSON.stringify({ id: 41, created: false }) }),
    });
    const a = await recordDirectiveToLedger(rec, meta, w.deps, 1);
    const b = await recordDirectiveToLedger(rec, meta, w.deps, 1);
    expect(a.created).toBe(false);
    expect(w.posts[0]?.idempotencyKey).toBe(w.posts[1]?.idempotencyKey);
    expect(b.id).toBe(41);
  });

  it('【故意造出的失败】没给意思：拒绝，不查单、不写账本', async () => {
    const w = wiring({ open: [1] });
    await expect(recordDirectiveToLedger(rec, { ...meta, meaning: '  ' }, w.deps, 1)).rejects.toThrow(
      DirectiveRefused,
    );
    expect(w.ghCalls).toEqual([]);
    expect(w.posts).toEqual([]);
  });

  it('【故意造出的失败】挂的单已关、gh 读不到、没法开单：都不写账本', async () => {
    const closed = wiring({ open: [] });
    await expect(recordDirectiveToLedger(rec, meta, closed.deps, 1)).rejects.toThrow(DirectiveRefused);
    const down = wiring({ ghFails: 'HTTP 502' });
    await expect(recordDirectiveToLedger(rec, meta, down.deps, 1)).rejects.toThrow(DirectiveUnchecked);
    const none = wiring();
    await expect(recordDirectiveToLedger(rec, meta, none.deps)).rejects.toThrow(/没法开单/);
    for (const w of [closed, down, none]) expect(w.posts).toEqual([]);
  });

  it('【故意造出的失败】账本写不成（HTTP 503、断连、回包认不出）：抛没记成，不退回写文件；顺手开过单的说明单号', async () => {
    for (const post of [
      async () => ({ status: 503, text: 'down' }),
      async () => {
        throw new Error('ECONNREFUSED');
      },
      async () => ({ status: 200, text: 'not json' }),
    ] as LedgerNotePost[]) {
      const w = wiring({ open: [1], post });
      await expect(recordDirectiveToLedger(rec, meta, w.deps, 1)).rejects.toThrow(
        /往法国账本记引导没成.*引导没记/,
      );
    }
    const w = wiring({ post: async () => ({ status: 503, text: 'down' }) });
    await expect(
      recordDirectiveToLedger(rec, meta, { ...w.deps, newIssue: async () => 4242 }),
    ).rejects.toThrow(/已顺手开了单 #4242，重跑时带 --issue 4242/);
  });
});
