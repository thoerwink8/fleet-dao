// fleet-api groom（母单 #1335 第 3 片，#1338）：参数、排上队、各种拒绝（说明原因、退出码 1）、没查成。
import { GROOM_ACTION, type GroomAuditRow } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { parseGroomArgs } from '../src/jobs/groom.ts';
import { type GroomCommandIo, runGroomCommand } from '../src/jobs/groom-command.ts';
import type { GroomRequestDeps } from '../src/jobs/groom-request.ts';

const NOW = new Date('2026-10-08T14:00:00.000Z');

function setup(
  over: {
    rows?: GroomAuditRow[];
    master?: { on: true } | { on: false; why: string };
    known?: boolean;
    openFails?: boolean;
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const recorded: { repo: string; source: string; reason: string }[] = [];
  let closed = 0;
  const deps: GroomRequestDeps = {
    rows: async () => over.rows ?? [],
    engineMaster: async () => over.master ?? { on: true },
    record: async (i) => {
      recorded.push({ repo: i.repo, source: i.source, reason: i.reason });
    },
    now: () => NOW,
    newId: () => 'rid-1',
  };
  const io: GroomCommandIo = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    async open() {
      if (over.openFails) throw new Error('DATABASE_URL 没设');
      return {
        deps,
        repoKnown: async () => over.known ?? true,
        operator: 'root',
        close: async () => {
          closed += 1;
        },
      };
    },
  };
  return { io, out, err, recorded, closed: () => closed };
}

describe('参数', () => {
  it('恰好一个仓；--note 可选；别的写法一律拒（退出码 2），不猜', async () => {
    expect(parseGroomArgs(['acme/demo'])).toEqual({ repo: 'acme/demo' });
    expect(parseGroomArgs(['acme/demo', '--note', '待办堆了'])).toEqual({
      repo: 'acme/demo',
      note: '待办堆了',
    });
    for (const argv of [
      [],
      ['demo'],
      ['a/b', 'c/d'],
      ['a/b', '--force'],
      ['a/b', '--note'],
      ['a/b', '--note', '--x'],
    ]) {
      const s = setup();
      expect(await runGroomCommand(argv, s.io), argv.join(' ')).toBe(2);
      expect(s.err.length).toBe(1);
      expect(s.recorded).toEqual([]);
    }
  });

  it('--help 打印用法，退出码 0，不连库', async () => {
    const s = setup({ openFails: true });
    expect(await runGroomCommand(['--help'], s.io)).toBe(0);
    expect(s.out[0]).toContain('fleet-api groom');
  });
});

describe('fleet-api groom', () => {
  it('排上队了：记一条点了（来源 cli，reason 写明谁跑的），打印编号和今天还剩几次，退出码 0，连接关掉', async () => {
    const s = setup();
    expect(await runGroomCommand(['acme/demo', '--note', '待办堆了'], s.io)).toBe(0);
    expect(s.recorded).toEqual([
      {
        repo: 'acme/demo',
        source: 'cli',
        reason: '待办堆了（服务器上 root 跑的 fleet-api groom acme/demo）',
      },
    ]);
    expect(s.out[0]).toContain('rid-1');
    expect(s.out[0]).toContain('今天还剩 2 次');
    expect(s.closed()).toBe(1);
  });

  it('【故意造出的失败】引擎总开关关着 → 拒，打印总开关，退出码 1，不记', async () => {
    const s = setup({ master: { on: false, why: '关着（默认）' } });
    expect(await runGroomCommand(['acme/demo'], s.io)).toBe(1);
    expect(s.err[0]).toContain('engine_off');
    expect(s.err[0]).toContain('总开关');
    expect(s.recorded).toEqual([]);
  });

  it('【故意造出的失败】锁被占 → 拒，说明已经有一次在做', async () => {
    const at = new Date(NOW.getTime() - 120_000);
    const s = setup({
      rows: [
        {
          at,
          action: GROOM_ACTION.request,
          actorId: 'x',
          after: { requestId: 'a', repo: 'o/r', source: 'cli' },
          ok: true,
          error: null,
        },
      ],
    });
    expect(await runGroomCommand(['acme/demo'], s.io)).toBe(1);
    expect(s.err[0]).toContain('busy');
    expect(s.err[0]).toContain('同一时刻只做一个');
  });

  it('【故意造出的失败】这个仓 24 小时内已用 3 次 → 拒，打印每天最多 3 次', async () => {
    const rows = [0, 1, 2].flatMap((i): GroomAuditRow[] => {
      const t = (m: number) => new Date(NOW.getTime() - m * 60_000);
      return [
        {
          at: t(300 - i),
          action: GROOM_ACTION.request,
          actorId: 'x',
          after: { requestId: `u${i}`, repo: 'acme/demo', source: 'cli' },
          ok: true,
          error: null,
        },
        {
          at: t(299 - i),
          action: GROOM_ACTION.start,
          actorId: 'x',
          after: { requestId: `u${i}`, repo: 'acme/demo' },
          ok: true,
          error: null,
        },
        {
          at: t(290 - i),
          action: GROOM_ACTION.done,
          actorId: 'x',
          after: { requestId: `u${i}` },
          ok: false,
          error: '没成',
        },
      ];
    });
    const s = setup({ rows });
    expect(await runGroomCommand(['acme/demo'], s.io)).toBe(1);
    expect(s.err[0]).toContain('daily_cap');
    expect(s.err[0]).toContain('每天最多 3 次');
  });

  it('【故意造出的失败】库里没有这个仓 → 退出码 1，不记', async () => {
    const s = setup({ known: false });
    expect(await runGroomCommand(['acme/nope'], s.io)).toBe(1);
    expect(s.err[0]).toContain('库里没有仓');
    expect(s.recorded).toEqual([]);
  });

  it('【故意造出的失败】连不上库 → 打印「没查成」，退出码 1', async () => {
    const s = setup({ openFails: true });
    expect(await runGroomCommand(['acme/demo'], s.io)).toBe(1);
    expect(s.err[0]).toContain('没查成');
  });
});
