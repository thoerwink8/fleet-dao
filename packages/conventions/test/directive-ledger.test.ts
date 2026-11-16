// 创始人引导一条一张 GitHub 单（#4054）：贴「创始人引导」标签，正文只用意思，原话进本机私有目录。
// 不调 git、不调 gh pr create、不写 docs/directives/、不 POST 账本。
// 【故意造出的失败】：没给意思、意思里抄着原话、挂的单已关、gh 读不到、没法开单、标签没贴上都明确拒绝或报没查成。
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DIRECTIVE_LABEL,
  type DirectiveLedgerDeps,
  directiveIssueToDigest,
  ledgerPending,
  migrateOpenDirectives,
  type OpenDirectiveIssue,
  recordDirectiveToLedger,
} from '../src/directive-ledger.ts';
import { DirectiveRefused, DirectiveUnchecked } from '../src/directives.ts';
import type { Gh, GhResult } from '../src/issue-new.ts';
import { LEDGER_PAGE, type LedgerDirective, type LedgerEventsGet } from '../src/ledger-read.ts';
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
  over: { open?: number[]; ghFails?: string; labelFails?: boolean; listed?: OpenDirectiveIssue[] } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'directive-home-'));
  const ghCalls: string[][] = [];
  const gh: Gh = async (args) => {
    ghCalls.push(args);
    if (over.ghFails) return { code: 1, stdout: '', stderr: over.ghFails };
    if (over.labelFails && args.includes('--add-label'))
      return { code: 1, stdout: '', stderr: 'label refused' };
    if (args[0] === 'issue' && args[1] === 'list') return okR(JSON.stringify(over.listed ?? []));
    if (args[0] === 'issue' && args[1] === 'view' && args.includes('.state'))
      return okR((over.open ?? []).includes(Number(args[2])) ? 'OPEN\n' : 'CLOSED\n');
    if (args[0] === 'issue' && args[1] === 'view') return okR('既有正文\n');
    return okR();
  };
  const deps: DirectiveLedgerDeps = { gh, repo: 'o/r', ref: 'sess-1', home };
  return { ghCalls, home, deps };
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

describe('ledgerPending（只给 directive-export 的账本读口）', () => {
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
  const homes: string[] = [];
  afterAll(() => {
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  });
  const keep = <T extends { home: string }>(w: T): T => {
    homes.push(w.home);
    return w;
  };
  const quoteFile = (home: string) => {
    const dir = join(home, '.fleet-dao', 'private', 'directive-quotes');
    const name = readdirSync(dir).find((n) => n.endsWith('.json') && n !== 'index.json');
    if (!name) throw new Error('没有原话文件');
    return join(dir, name);
  };

  it('贴上「创始人引导」标签：正文只有意思和主人，原话在本机文件里，不进 gh', async () => {
    const w = keep(wiring({ open: [3764] }));
    const made = await recordDirectiveToLedger(rec, meta, w.deps, 3764);
    expect(made).toEqual({ id: 3764, issue: 3764, created: true });
    expect(w.ghCalls.some((a) => a.includes('--add-label') && a.includes(DIRECTIVE_LABEL))).toBe(true);
    expect(w.ghCalls.some((a) => a[0] === 'pr')).toBe(false);
    expect(JSON.stringify(w.ghCalls)).not.toContain('xyz-secret-quote');
    expect('git' in w.deps).toBe(false);
    const saved = readFileSync(quoteFile(w.home), 'utf8');
    expect(saved).toContain(QUOTE);
    if (process.platform !== 'win32') expect(statSync(quoteFile(w.home)).mode & 0o777).toBe(0o600);
  });

  it('没给 --issue：顺手开一张单，标题和正文只用意思、含主人标记、不含原话', async () => {
    const w = keep(wiring());
    const drafts: Array<{ title: string; body: string }> = [];
    const made = await recordDirectiveToLedger(rec, meta, {
      ...w.deps,
      newIssue: async (d) => {
        drafts.push(d);
        return 4242;
      },
    });
    expect(made).toEqual({ id: 4242, issue: 4242, created: true });
    expect(JSON.stringify(drafts)).not.toContain('xyz-secret-quote');
    expect(drafts[0]?.title).toBe('创始人引导：会话先读规矩再动手');
    expect(drafts[0]?.body).toContain('〔主：dir-a〕');
    expect(drafts[0]?.body).toContain('本机私有处');
    for (const h of ['## 场景', '## 原话', '## 已知的模块', '## 怎么算做完'])
      expect(drafts[0]?.body).toContain(h);
  });

  it('同一句同一分钟重跑：不再开第二张，created:false', async () => {
    const w = keep(wiring());
    let opened = 0;
    const deps = {
      ...w.deps,
      newIssue: async () => {
        opened += 1;
        return 4242;
      },
    };
    const a = await recordDirectiveToLedger(rec, meta, deps);
    const b = await recordDirectiveToLedger(rec, meta, deps);
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: 4242, issue: 4242, created: false });
    expect(opened).toBe(1);
  });

  it('【故意造出的失败】没给意思、意思里抄着原话：拒绝，不查单', async () => {
    const w = keep(wiring({ open: [1] }));
    await expect(recordDirectiveToLedger(rec, { ...meta, meaning: '  ' }, w.deps, 1)).rejects.toThrow(
      DirectiveRefused,
    );
    await expect(
      recordDirectiveToLedger(rec, { ...meta, meaning: `转述 ${QUOTE}` }, w.deps, 1),
    ).rejects.toThrow(/抄着原话/);
    expect(w.ghCalls).toEqual([]);
  });

  it('【故意造出的失败】挂的单已关、gh 读不到、没法开单：都不把原话交出去', async () => {
    const closed = keep(wiring({ open: [] }));
    await expect(recordDirectiveToLedger(rec, meta, closed.deps, 1)).rejects.toThrow(DirectiveRefused);
    const down = keep(wiring({ ghFails: 'HTTP 502' }));
    await expect(recordDirectiveToLedger(rec, meta, down.deps, 1)).rejects.toThrow(DirectiveUnchecked);
    const none = keep(wiring());
    await expect(recordDirectiveToLedger(rec, meta, none.deps)).rejects.toThrow(/没法开单/);
    for (const w of [closed, down, none]) expect(JSON.stringify(w.ghCalls)).not.toContain('xyz-secret-quote');
  });

  it('【故意造出的失败】标签没贴上：抛没记完，并写明已经开出的单号；重跑补标签、不再开一张', async () => {
    const home = mkdtempSync(join(tmpdir(), 'directive-home-'));
    homes.push(home);
    let labelFails = true;
    let opened = 0;
    const gh: Gh = async (args) => {
      if (labelFails && args.includes('--add-label')) return { code: 1, stdout: '', stderr: 'label refused' };
      if (args[1] === 'list') return okR('[]');
      if (args.includes('.state')) return okR('OPEN\n');
      return okR('');
    };
    const deps: DirectiveLedgerDeps = {
      gh,
      repo: 'o/r',
      home,
      newIssue: async () => {
        opened += 1;
        return 4242;
      },
    };
    await expect(recordDirectiveToLedger(rec, meta, deps)).rejects.toThrow(/已顺手开了单 #4242/);
    labelFails = false;
    const again = await recordDirectiveToLedger(rec, meta, deps);
    expect(again).toEqual({ id: 4242, issue: 4242, created: false });
    expect(opened).toBe(1);
  });

  it('挂已有单时正文没补上：重跑补主人标记，不再开第二张', async () => {
    const home = mkdtempSync(join(tmpdir(), 'directive-home-'));
    homes.push(home);
    let editFails = true;
    const calls: string[][] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      if (editFails && args.includes('--body-file')) return { code: 1, stdout: '', stderr: 'edit refused' };
      if (args[1] === 'list') return okR('[]');
      if (args.includes('.state')) return okR('OPEN\n');
      if (args.includes('--jq')) return okR('既有正文\n');
      return okR('');
    };
    const deps: DirectiveLedgerDeps = { gh, repo: 'o/r', home };
    await expect(recordDirectiveToLedger(rec, meta, deps, 7)).rejects.toThrow(/没补上主人标记/);
    editFails = false;
    calls.length = 0;
    const again = await recordDirectiveToLedger(rec, meta, deps, 7);
    expect(again).toEqual({ id: 7, issue: 7, created: false });
    expect(calls.some((a) => a.includes('--body-file'))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('xyz-secret-quote');
  });
});

describe('migrateOpenDirectives', () => {
  const row = (over: Partial<LedgerDirective> = {}): LedgerDirective => ({
    id: 9,
    at: '2026-10-30T02:00:00Z',
    issue: 10,
    text: QUOTE,
    meaning: '会话先读规矩再动手',
    category: 'ai',
    owner: 'dir-a',
    spokenAt: '2026-10-30 10:00 +0800',
    ...over,
  });

  it('未办完的逐条开单，正文写原单号，不写原话；再跑不重复开', async () => {
    const w = wiring();
    const drafts: Array<{ title: string; body: string }> = [];
    let opened = 0;
    const deps = {
      ...w.deps,
      newIssue: async (d: { title: string; body: string }) => {
        drafts.push(d);
        opened += 1;
        return 5000 + opened;
      },
    };
    const first = await migrateOpenDirectives(
      [row(), row({ id: 8, issue: 11, text: '另一句原话-secret' })],
      deps,
    );
    expect(first.opened.map((o) => [o.ledgerId, o.from, o.issue])).toEqual([
      [9, 10, 5001],
      [8, 11, 5002],
    ]);
    expect(drafts[0]?.body).toContain('原单：#10');
    expect(JSON.stringify(drafts)).not.toContain('xyz-secret-quote');
    expect(JSON.stringify(drafts)).not.toContain('另一句原话-secret');
    expect(JSON.stringify(w.ghCalls)).not.toContain('xyz-secret-quote');
    const second = await migrateOpenDirectives([row()], deps);
    expect(second.opened).toEqual([]);
    expect(second.already).toEqual([10]);
    expect(opened).toBe(2);
  });

  it('意思和原话是同一句：公开单用占位，原话只留本机', async () => {
    const w = wiring();
    const drafts: Array<{ body: string }> = [];
    await migrateOpenDirectives([row({ meaning: QUOTE })], {
      ...w.deps,
      newIssue: async (d) => {
        drafts.push(d);
        return 60;
      },
    });
    expect(drafts[0]?.body).toContain('没有可公开的意思');
    expect(drafts[0]?.body).not.toContain('xyz-secret-quote');
    expect(drafts[0]?.body).toContain('原单：#10');
  });

  it('开着的单上已经写了原单号：不再开', async () => {
    const w = wiring({
      listed: [
        {
          number: 70,
          title: '创始人引导：已迁',
          body: '原单：#10\n',
          createdAt: '2026-10-30T02:00:00Z',
        },
      ],
    });
    let opened = 0;
    const got = await migrateOpenDirectives([row()], {
      ...w.deps,
      newIssue: async () => {
        opened += 1;
        return 1;
      },
    });
    expect(got).toEqual({ opened: [], already: [10] });
    expect(opened).toBe(0);
    const saved = readdirSync(join(w.home, '.fleet-dao', 'private', 'directive-quotes'))
      .filter((n) => n.endsWith('.json') && n !== 'index.json')
      .map((n) => readFileSync(join(w.home, '.fleet-dao', 'private', 'directive-quotes', n), 'utf8'))
      .join('\n');
    expect(saved).toContain(QUOTE);
    expect(JSON.stringify(w.ghCalls)).not.toContain('xyz-secret-quote');
  });
});

describe('directiveIssueToDigest', () => {
  it('周汇总用正文里的说话时刻，不带原话', () => {
    const body = [
      '## 场景',
      '',
      '创始人 2026-10-30 10:00 +0800 的引导（来源：prompt-log）。意思：会话先读规矩再动手',
      '',
      '〔主：dir-a〕',
      '',
    ].join('\n');
    const d = directiveIssueToDigest({
      number: 41,
      title: '创始人引导：会话先读规矩再动手',
      body,
      createdAt: '2026-11-17T00:00:00.000Z',
    });
    expect(d.spokenAt).toBe('2026-10-30 10:00 +0800');
    expect(d.meaning).toBe('会话先读规矩再动手');
    expect(d.text).toBe('');
    expect(d.owner).toBe('dir-a');
    expect(d.issue).toBe(41);
  });
});
