// 收件箱读法国账本（#3741 片 2c）：假 fetch 分页读完、30 天截止、已迁/已处理认领、读不到抛 ProgressUnchecked、--from-inbox 新旧编号。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  HANDOFF_ACTION,
  LEDGER_PAGE,
  type LedgerEventsGet,
  ledgerInboxPending,
  liveLedgerEventsGet,
  NOTE_ACTION,
  parseInboxId,
  readAllLedgerEvents,
  readLedgerHandoff,
} from '../src/ledger-read.ts';
import { ProgressRefused, ProgressUnchecked } from '../src/progress.ts';

const REPO = 'o/r';
const NOW = new Date('2026-10-30T00:00:00Z');
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

interface Row {
  id: number;
  at: string;
  action: string;
  target: string;
  after: unknown;
  ok?: boolean;
}
const ev = (r: Row) => ({ actorKind: 'api', actorId: 'x', ok: true, ...r });
const handoff = (id: number, daysAgo: number, text = `创始人已选：A（通知 n${id}）`): Row => ({
  id,
  at: day(daysAgo),
  action: HANDOFF_ACTION,
  target: `progress:${REPO}`,
  after: { text },
});
const note = (id: number, text: string): Row => ({
  id,
  at: day(0),
  action: NOTE_ACTION,
  target: `progress:${REPO}`,
  after: { text },
});

/** 假法国：按 after/limit 切片，limit 超过 LEDGER_PAGE 按上限给，记下每次请求 */
function fakeLedger(rows: Row[]) {
  const calls: Array<{ after: number; limit: number }> = [];
  const get: LedgerEventsGet = async ({ after, limit }) => {
    calls.push({ after, limit });
    const events = rows
      .filter((r) => r.id > after)
      .slice(0, Math.min(limit, LEDGER_PAGE))
      .map(ev);
    return { status: 200, text: JSON.stringify({ events, next: events.at(-1)?.id ?? after }) };
  };
  return { get, calls };
}

describe('readAllLedgerEvents', () => {
  it('按 id 往后翻页读完，limit 用上限', async () => {
    const rows: Row[] = Array.from({ length: LEDGER_PAGE * 2 + 3 }, (_, i) => handoff(i + 1, 0));
    const w = fakeLedger(rows);
    const got = await readAllLedgerEvents(w.get);
    expect(got).toHaveLength(rows.length);
    expect(w.calls).toEqual([
      { after: 0, limit: LEDGER_PAGE },
      { after: LEDGER_PAGE, limit: LEDGER_PAGE },
      { after: LEDGER_PAGE * 2, limit: LEDGER_PAGE },
    ]);
  });

  it('刚好整页时再读一页确认读完', async () => {
    const w = fakeLedger(Array.from({ length: LEDGER_PAGE }, (_, i) => handoff(i + 1, 0)));
    expect(await readAllLedgerEvents(w.get)).toHaveLength(LEDGER_PAGE);
    expect(w.calls).toHaveLength(2);
  });

  it('【故意造出的失败】HTTP 非 200、断连、不是 JSON、没有 events、行不对、id 不递增都抛 ProgressUnchecked', async () => {
    const bad: LedgerEventsGet[] = [
      async () => ({ status: 503, text: '{"error":"issue_events_unreadable"}' }),
      async () => {
        throw new Error('ECONNREFUSED');
      },
      async () => ({ status: 200, text: '<html>' }),
      async () => ({ status: 200, text: '{"nope":1}' }),
      async () => ({ status: 200, text: JSON.stringify({ events: [{ id: 'x' }] }) }),
      async () => ({
        status: 200,
        text: JSON.stringify({ events: [ev(handoff(5, 0)), ev(handoff(5, 0))] }),
      }),
    ];
    for (const get of bad) await expect(readAllLedgerEvents(get)).rejects.toBeInstanceOf(ProgressUnchecked);
  });
});

describe('ledgerInboxPending', () => {
  it('只收本仓 decision.handoff、最近 30 天、没被认领的（旧到新）', async () => {
    const w = fakeLedger([
      handoff(1, 31), // 超过 30 天
      handoff(2, 29),
      handoff(3, 10),
      { ...handoff(4, 5), target: 'progress:o/other' }, // 别的仓
      { ...handoff(5, 5), ok: false }, // 没成的
      { ...handoff(6, 5), action: 'report.daily' }, // 不是引导
      note(7, '已迁 2：docs/directives/x.md'),
      handoff(8, 1),
      note(9, '已处理 8：记在设计文档'),
      handoff(10, 0),
      note(11, '合了 #12'), // 普通进度不认领
    ]);
    const got = await ledgerInboxPending(REPO, { get: w.get, now: () => NOW });
    expect(got.map((h) => h.id)).toEqual([3, 10]);
    expect(got[0]?.text).toContain('通知 n3');
  });

  it('30 天边界之内的留、之外的不要', async () => {
    const w = fakeLedger([handoff(1, 30.01), handoff(2, 29.99)]);
    expect((await ledgerInboxPending(REPO, { get: w.get, now: () => NOW })).map((h) => h.id)).toEqual([2]);
  });

  it('【故意造出的失败】账本读不到：抛 ProgressUnchecked，不当成收件箱是空的', async () => {
    const get: LedgerEventsGet = async () => ({ status: 401, text: 'no' });
    await expect(ledgerInboxPending(REPO, { get, now: () => NOW })).rejects.toBeInstanceOf(ProgressUnchecked);
  });

  it('【故意造出的失败】待处理行的时间认不出：抛 ProgressUnchecked', async () => {
    const w = fakeLedger([{ ...handoff(1, 1), at: 'yesterday' }]);
    await expect(ledgerInboxPending(REPO, { get: w.get, now: () => NOW })).rejects.toBeInstanceOf(
      ProgressUnchecked,
    );
  });
});

describe('--from-inbox 编号', () => {
  it('新编号（账本行 id）通过；旧的 10 位评论号、非数字、0 都拒绝，旧号的报错给新用法', () => {
    expect(parseInboxId('4137')).toBe(4137);
    expect(() => parseInboxId('4398046511')).toThrowError(ProgressRefused);
    expect(() => parseInboxId('4398046511')).toThrowError(/旧的 #1055 评论号.*progress read --pending/s);
    for (const s of ['0', 'abc', '-3', '1.5', ''])
      expect(() => parseInboxId(s)).toThrowError(ProgressRefused);
  });

  it('readLedgerHandoff：待处理的读出来；已迁、不存在的拒绝', async () => {
    const w = fakeLedger([handoff(3, 2), handoff(4, 2), note(5, '已迁 4：x')]);
    const deps = { get: w.get, now: () => NOW };
    expect((await readLedgerHandoff(3, REPO, deps)).id).toBe(3);
    await expect(readLedgerHandoff(4, REPO, deps)).rejects.toBeInstanceOf(ProgressRefused);
    await expect(readLedgerHandoff(99, REPO, deps)).rejects.toBeInstanceOf(ProgressRefused);
  });
});

describe('增量读（状态文件 cursor + pending）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-inbox-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const fresh = () => join(dir, `state-${n++}.json`);
  const stateOf = (f: string) =>
    JSON.parse(readFileSync(f, 'utf8'))[REPO] as {
      cursor: number;
      pending: Array<{ id: number }>;
      cleared: number[];
    };

  it('没有状态文件：从 0 读一次全量建起来；第二次只请求 cursor 之后，新行并入', async () => {
    const rows: Row[] = [handoff(1, 3), handoff(2, 2)];
    const w = fakeLedger(rows);
    const f = fresh();
    const deps = { get: w.get, now: () => NOW, stateFile: f, warn: () => {} };
    expect((await ledgerInboxPending(REPO, deps)).map((h) => h.id)).toEqual([1, 2]);
    expect(w.calls.map((c) => c.after)).toEqual([0]);
    expect(stateOf(f).cursor).toBe(2);

    rows.push(handoff(3, 0));
    w.calls.length = 0;
    expect((await ledgerInboxPending(REPO, deps)).map((h) => h.id)).toEqual([1, 2, 3]);
    expect(w.calls).toEqual([{ after: 2, limit: LEDGER_PAGE }]);
    expect(stateOf(f).cursor).toBe(3);

    // 没有新行：仍只请求 cursor 之后，结果不变
    w.calls.length = 0;
    expect((await ledgerInboxPending(REPO, deps)).map((h) => h.id)).toEqual([1, 2, 3]);
    expect(w.calls.map((c) => c.after)).toEqual([3]);
  });

  it('新来的「已迁/已处理 <id>」把对应行从 pending 移走', async () => {
    const rows: Row[] = [handoff(1, 3), handoff(2, 2), handoff(3, 1)];
    const w = fakeLedger(rows);
    const f = fresh();
    const deps = { get: w.get, now: () => NOW, stateFile: f, warn: () => {} };
    await ledgerInboxPending(REPO, deps);
    rows.push(note(4, '已迁 1：x'), note(5, '已处理 3：y'), note(6, '合了 #12'));
    const got = await ledgerInboxPending(REPO, deps);
    expect(got.map((h) => h.id)).toEqual([2]);
    expect(stateOf(f).pending.map((h) => h.id)).toEqual([2]);
    expect(stateOf(f).cleared).toEqual([1, 3]);
  });

  it('超过 30 天的从 pending 丢掉（时间往后走）', async () => {
    const rows: Row[] = [handoff(1, 20), handoff(2, 1)];
    const w = fakeLedger(rows);
    const f = fresh();
    let now = NOW;
    const deps = { get: w.get, now: () => now, stateFile: f, warn: () => {} };
    expect((await ledgerInboxPending(REPO, deps)).map((h) => h.id)).toEqual([1, 2]);
    now = new Date(NOW.getTime() + 15 * 86_400_000); // 第 1 条这时 35 天
    expect((await ledgerInboxPending(REPO, deps)).map((h) => h.id)).toEqual([2]);
    expect(stateOf(f).pending.map((h) => h.id)).toEqual([2]);
  });

  it('文件坏了（解析不了 / 形状不对）：当不存在，说一行，从 0 重建', async () => {
    const w = fakeLedger([handoff(1, 1)]);
    for (const bad of ['{not json', JSON.stringify({ [REPO]: { cursor: 'x' } })]) {
      const f = fresh();
      writeFileSync(f, bad);
      const lines: string[] = [];
      w.calls.length = 0;
      const got = await ledgerInboxPending(REPO, {
        get: w.get,
        now: () => NOW,
        stateFile: f,
        warn: (l) => lines.push(l),
      });
      expect(got.map((h) => h.id)).toEqual([1]);
      expect(w.calls[0]?.after).toBe(0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('重建');
      expect(stateOf(f).cursor).toBe(1);
    }
  });

  it('按仓分键：别的仓的状态保留不动', async () => {
    const w = fakeLedger([handoff(1, 1)]);
    const f = fresh();
    writeFileSync(f, JSON.stringify({ 'o/other': { cursor: 9, pending: [], cleared: [] } }));
    await ledgerInboxPending(REPO, { get: w.get, now: () => NOW, stateFile: f, warn: () => {} });
    const all = JSON.parse(readFileSync(f, 'utf8'));
    expect(all['o/other'].cursor).toBe(9);
    expect(all[REPO].cursor).toBe(1);
  });

  it('【故意造出的失败】读不到法国：抛 ProgressUnchecked，状态文件原样不动', async () => {
    const f = fresh();
    const seed = JSON.stringify({ [REPO]: { cursor: 5, pending: [], cleared: [] } });
    writeFileSync(f, seed);
    const get: LedgerEventsGet = async () => ({ status: 503, text: 'down' });
    await expect(
      ledgerInboxPending(REPO, { get, now: () => NOW, stateFile: f, warn: () => {} }),
    ).rejects.toBeInstanceOf(ProgressUnchecked);
    expect(readFileSync(f, 'utf8')).toBe(seed);
    // 没有状态文件时读不到也不凭空建一个
    const g = fresh();
    await expect(
      ledgerInboxPending(REPO, { get, now: () => NOW, stateFile: g, warn: () => {} }),
    ).rejects.toBeInstanceOf(ProgressUnchecked);
    expect(() => readFileSync(g, 'utf8')).toThrowError(/ENOENT/);
  });
});

describe('liveLedgerEventsGet', () => {
  it('GET /api/nodes/events?after=&limit=，通行证放头里；断连时错误信息不带通行证', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchOk = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      return new Response('{"events":[],"next":0}', { status: 200 });
    }) as unknown as typeof fetch;
    const endpoint = () => ({ url: 'http://fr.example/', token: 'SECRET-TOKEN' });
    const r = await liveLedgerEventsGet(endpoint, fetchOk)({ after: 7, limit: 500 });
    expect(r.status).toBe(200);
    expect(seen[0]?.url).toBe('http://fr.example/api/nodes/events?after=7&limit=500');
    expect(seen[0]?.headers['X-Fleet-Node-Token']).toBe('SECRET-TOKEN');
    const fetchBad = (async () => {
      throw new Error('connect failed SECRET-TOKEN');
    }) as unknown as typeof fetch;
    await expect(liveLedgerEventsGet(endpoint, fetchBad)({ after: 0, limit: 1 })).rejects.toThrowError(
      /^((?!SECRET-TOKEN).)*$/s,
    );
  });

  it('【故意造出的失败】读不到地址/通行证配置：抛出，由读方认成没查成', async () => {
    const get = liveLedgerEventsGet(() => {
      throw new Error('读不到 config.json');
    });
    await expect(readAllLedgerEvents(get)).rejects.toBeInstanceOf(ProgressUnchecked);
  });
});
