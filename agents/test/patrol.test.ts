// 法国只读巡查（patrol-lib.mjs，决定 0034，#1372）：监控的主体是脚本，读不成一律 BROKEN、不当 OK；基线只由脚本写。
// ssh 全是假的（fetchRaw 换掉）；基线文件换成内存里的一份。故意造的失败：空输出、截断、库查询报错、采集时间过旧、
// 认不出的行、ssh 名字没配，都必须判 BROKEN；坏样本必须判 ALERT。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPTS = fileURLToPath(new URL('../skills/commander/scripts/', import.meta.url));

type Raw = { ok: true; stdout: string } | { ok: false; kind: string; why: string };
interface Report {
  verdict: 'OK' | 'ALERT' | 'BROKEN';
  alerts: string[];
  delta: string[];
  broken: string | null;
  facts: { at: string; notes: { key: string }[] } | null;
}
interface SampleOpts {
  at: Date;
  disk?: number;
  mem?: number;
  engine?: string;
  master?: string;
  tasks?: string[];
  jobs?: string[];
  notes?: string[];
  noEnd?: boolean;
  err?: string;
}
interface PatrolLib {
  REMOTE_SCRIPT: string;
  STALE_MINUTES: number;
  sampleRaw(o: SampleOpts): string;
  parseRaw(text: string): { ok: true; facts: NonNullable<Report['facts']> } | { ok: false; why: string };
  judge(input: { raw: Raw; now: Date; base: unknown }): Report;
  render(r: Report): string[];
  selftest(now: Date): { ok: boolean; lines: string[] };
  runPatrol(io: {
    fetchRaw: () => Promise<Raw>;
    now: () => Date;
    loadBaseline: () => string | null;
    saveBaseline: (text: string) => void;
  }): Promise<{ code: number; lines: string[]; report: Report }>;
  fetchFrance(opts: {
    home: string;
    env: Record<string, string | undefined>;
    readText: (f: string) => string;
  }): Promise<Raw>;
}

const lib = (await import(pathToFileURL(join(SCRIPTS, 'patrol-lib.mjs')).href)) as PatrolLib;
const NOW = new Date('2026-10-09T01:00:00Z');
const ok = (stdout: string): Raw => ({ ok: true, stdout });
const good = () => lib.sampleRaw({ at: NOW });
const baseOf = (text: string) => {
  const p = lib.parseRaw(text);
  if (!p.ok) throw new Error(p.why);
  return p.facts;
};

/** 跑一次 runPatrol，基线是内存里的一份 */
async function patrol(raw: Raw, baseline: string | null) {
  const saved: string[] = [];
  const r = await lib.runPatrol({
    fetchRaw: async () => raw,
    now: () => NOW,
    loadBaseline: () => baseline,
    saveBaseline: (t) => saved.push(t),
  });
  return { ...r, saved };
}

describe('巡查脚本：判法', () => {
  it('一切正常：OK，最后一行 VERDICT: OK，每项一行带采集时间', () => {
    const r = lib.judge({ raw: ok(good()), now: NOW, base: null });
    expect(r.verdict).toBe('OK');
    const lines = lib.render(r);
    expect(lines.at(-1)).toBe('VERDICT: OK');
    expect(lines.filter((l) => l.includes(`@${NOW.toISOString()}`)).length).toBeGreaterThanOrEqual(5);
  });

  it('坏样本：每条不变量各记一行，VERDICT: ALERT <条数>', () => {
    const base = baseOf(good());
    const raw = lib.sampleRaw({
      at: NOW,
      engine: 'failed',
      disk: 91,
      mem: 512,
      master: 'false',
      tasks: ['task|12|fleet-dao|running|parked|45|等人'],
      jobs: ['job|probe|failed|7|探针连不上'],
      notes: ['note|deploy-lag|发布落后', 'note|task-stuck:12|单卡住了'],
    });
    const r = lib.judge({ raw: ok(raw), now: NOW, base });
    expect(r.verdict).toBe('ALERT');
    expect(r.alerts).toHaveLength(7);
    expect(lib.render(r).at(-1)).toBe('VERDICT: ALERT 7');
  });

  it('和基线比：只报变了的（新单、状态变了、新通知、消失的通知），分钟数每次变不算', () => {
    const base = baseOf(good());
    const raw = lib.sampleRaw({
      at: new Date(NOW.getTime() + 60_000),
      tasks: ['task|12|fleet-dao|merging||9|在合并', 'task|13|fleet-dao|running||1|刚起'],
      notes: ['note|other|别的'],
    });
    const r = lib.judge({ raw: ok(raw), now: NOW, base });
    expect(r.delta).toEqual([
      '~ 单 #12（fleet-dao）running → merging',
      '+ 单 #13（fleet-dao）running',
      '+ 通知 other：别的',
      '- 通知 deploy-lag',
    ]);
    const same = lib.judge({
      raw: ok(lib.sampleRaw({ at: NOW, tasks: ['task|12|fleet-dao|running||40|在写代码'] })),
      now: NOW,
      base,
    });
    expect(same.delta).toEqual([]);
  });

  it('单卡住没超过线（30 分钟）不报；卡住超过才报', () => {
    const short = lib.judge({
      raw: ok(lib.sampleRaw({ at: NOW, tasks: ['task|12|fleet-dao|stalled||10|等'] })),
      now: NOW,
      base: null,
    });
    expect(short.verdict).toBe('OK');
    const long = lib.judge({
      raw: ok(lib.sampleRaw({ at: NOW, tasks: ['task|12|fleet-dao|stalled||31|等'] })),
      now: NOW,
      base: null,
    });
    expect(long.alerts).toHaveLength(1);
  });

  it('【故意造出的失败】空输出：BROKEN，不当 OK', () => {
    for (const text of ['', '\n\n', '   ']) {
      const r = lib.judge({ raw: ok(text), now: NOW, base: null });
      expect(r.verdict, JSON.stringify(text)).toBe('BROKEN');
      expect(lib.render(r).at(-1)).toBe('VERDICT: BROKEN');
    }
  });

  it('【故意造出的失败】截断（没有 end）、库查询报错、少一块、认不出的行、ssh 没读成：都是 BROKEN', () => {
    const cases: Raw[] = [
      ok(lib.sampleRaw({ at: NOW, noEnd: true })),
      ok(lib.sampleRaw({ at: NOW, err: 'ERR|notes|permission denied' })),
      ok(good().replace('ok|jobs\n', '')),
      ok(good().replace('ok|master\n', 'ok|master\n乱七八糟\n')),
      { ok: false, kind: 'ssh-failed', why: '连不上' },
    ];
    for (const raw of cases) expect(lib.judge({ raw, now: NOW, base: null }).verdict).toBe('BROKEN');
  });

  it('【故意造出的失败】采集时间比本机早超过 15 分钟（或晚超过）：BROKEN', () => {
    const old = lib.sampleRaw({ at: new Date(NOW.getTime() - (lib.STALE_MINUTES + 1) * 60_000) });
    expect(lib.judge({ raw: ok(old), now: NOW, base: null }).verdict).toBe('BROKEN');
    const future = lib.sampleRaw({ at: new Date(NOW.getTime() + (lib.STALE_MINUTES + 1) * 60_000) });
    expect(lib.judge({ raw: ok(future), now: NOW, base: null }).verdict).toBe('BROKEN');
    const fresh = lib.sampleRaw({ at: new Date(NOW.getTime() - (lib.STALE_MINUTES - 1) * 60_000) });
    expect(lib.judge({ raw: ok(fresh), now: NOW, base: null }).verdict).toBe('OK');
  });

  it('--selftest 用的那几份已知样本全过', () => {
    const r = lib.selftest(NOW);
    expect(r.lines.at(-1)).toBe('SELFTEST: OK');
    expect(r.ok).toBe(true);
  });
});

describe('巡查脚本：基线只由脚本写', () => {
  it('OK、ALERT 都写新基线；退出码 0、1', async () => {
    const a = await patrol(ok(good()), null);
    expect(a.code).toBe(0);
    expect(a.saved).toHaveLength(1);
    const b = await patrol(ok(lib.sampleRaw({ at: NOW, disk: 99 })), a.saved[0] ?? null);
    expect(b.code).toBe(1);
    expect(b.saved).toHaveLength(1);
  });

  it('【故意造出的失败】BROKEN 不写基线（不拿坏读数盖掉好基线），退出码 2', async () => {
    const r = await patrol(ok(''), null);
    expect(r.code).toBe(2);
    expect(r.saved).toEqual([]);
    expect(r.lines.at(-1)).toBe('VERDICT: BROKEN');
  });

  it('基线认不出：照没有基线算，并打一行说明，不悄悄吞掉', async () => {
    const r = await patrol(ok(good()), '{坏的');
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => l.startsWith('基线 基线文件不是 JSON'))).toBe(true);
    expect(r.lines.at(-1)).toBe('VERDICT: OK');
  });
});

describe('巡查脚本：只读、读不到 ssh 名字明确失败', () => {
  let home = '';
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = '';
  });

  it('法国上跑的那段 sh 只读：库连接带只读事务，没有写库语句、没有往文件写', () => {
    const s = lib.REMOTE_SCRIPT;
    expect(s).toContain('default_transaction_read_only=on');
    expect(s).not.toMatch(/\b(?:insert|update|delete|drop|alter|truncate|create|grant)\b/i);
    expect(s.replace(/2>&1/g, '')).not.toMatch(/>\s*[/\w]/);
    expect(s.trimEnd().split('\n').at(-1)).toBe('echo end');
  });

  it('【故意造出的失败】这台没配登法国的 ssh 名字：fetchFrance 回失败，runPatrol 判 BROKEN', async () => {
    home = mkdtempSync(join(tmpdir(), 'patrol-'));
    const raw = await lib.fetchFrance({
      home,
      env: {},
      readText: () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
    });
    expect(raw.ok).toBe(false);
    const r = await patrol(raw, null);
    expect(r.code).toBe(2);
  });
});
