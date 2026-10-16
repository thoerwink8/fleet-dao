// 开会话钩子对待处理引导的两件事（决定 0093）：主人会话确定已不在的自动认领（只在认得出本会话血缘的指挥官会话）；
// 挂了超过 24 小时、本会话接不了的进「要你拍的」。主人在不在由 founder-inbox.mjs 的 ownerPresence 按本机 Mirasim 记录判，判不了的不认。
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

type Presence = { state: 'gone' | 'here' | 'unknown'; why: string };
const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
const hook = (await import(pathToFileURL(join(HOOKS, 'session-start.mjs')).href)) as {
  progressLines(
    r: { status: number | null; stdout: string; stderr: string },
    lineage: unknown,
    o?: {
      presence?: (owner: string) => Presence;
      adopt?: (id: string, owner: string) => { ok: boolean };
      now?: number;
    },
  ): string[];
};
const inbox = (await import(pathToFileURL(join(HOOKS, 'founder-inbox.mjs')).href)) as {
  ownerPresence(o: {
    home: string;
    owner: string;
    now?: number;
    env?: Record<string, string | undefined>;
  }): Presence;
};

const NOW = Date.parse('2026-10-14T12:00:00Z');
const H = '【创始人引导·待处理】2026-10-14 16:00 +0800';
const iso = (hAgo: number) => new Date(NOW - hAgo * 3_600_000).toISOString();
const run = (rows: string[]) => ({ status: 0, stdout: `${rows.join('\n')}\n`, stderr: '' });
const A = { status: 'found', dir: 'dir-a', sessionIds: ['dir-a'] };

describe('自动认领和交给创始人拍', () => {
  it('主人确定已不在的：起后台认领，按归本会话列；在的、判不了的不认', () => {
    const adopted: string[] = [];
    const lines = hook
      .progressLines(
        run([
          `1\t${H}\t原话：走了的会话的\tdir-gone\t${iso(2)}`,
          `2\t${H}\t原话：还在的\tdir-here\t${iso(2)}`,
          `3\t${H}\t原话：判不了的\tdir-x\t${iso(2)}`,
        ]),
        A,
        {
          now: NOW,
          presence: (o) => ({
            state: o === 'dir-gone' ? 'gone' : o === 'dir-here' ? 'here' : 'unknown',
            why: `${o} 的说法`,
          }),
          adopt: (id, owner) => {
            adopted.push(`${id}:${owner}`);
            return { ok: true };
          },
        },
      )
      .join('\n');
    expect(adopted).toEqual(['1:dir-gone']);
    expect(lines).toMatch(/后台正在替本会话认领.*1（dir-gone 的说法）/);
    expect(lines).toContain('走了的会话的');
    expect(lines).not.toContain('还在的');
    expect(lines).toContain('别的会话还有 2 条');
  });

  it('【故意造出失败】认不出本会话血缘（不是指挥官会话）：一条也不认', () => {
    let called = 0;
    hook.progressLines(run([`1\t${H}\t原话：x\tdir-gone\t${iso(2)}`]), null, {
      now: NOW,
      presence: () => ({ state: 'gone', why: '' }),
      adopt: () => {
        called++;
        return { ok: true };
      },
    });
    expect(called).toBe(0);
  });

  it('挂了超过 24 小时、本会话接不了的写成指挥官自己认领，不出现「要你拍」；自己的、不满 24 小时的不进', () => {
    const lines = hook
      .progressLines(
        run([
          `1\t${H}\t原话：老的无主\t无主\t${iso(30)}`,
          `2\t${H}\t原话：老的别人的\tdir-b\t${iso(25)}`,
          `3\t${H}\t原话：老的自己的\tdir-a\t${iso(40)}`,
          `4\t${H}\t原话：新的别人的\tdir-b\t${iso(3)}`,
        ]),
        A,
        { now: NOW, presence: () => ({ state: 'here', why: '' }), adopt: () => ({ ok: true }) },
      )
      .join('\n');
    expect(lines).not.toContain('要你拍');
    const ask = lines.split('\n').find((l) => l.includes('挂了超过 24 小时')) ?? '';
    expect(ask).toContain('指挥官自己的活，不用问创始人');
    expect(ask).toContain('pnpm progress claim');
    expect(ask).toContain('2 条挂了超过 24 小时');
    expect(ask).toContain('老的无主');
    expect(ask).toContain('老的别人的');
    expect(ask).not.toContain('老的自己的');
    expect(ask).not.toContain('新的别人的');
  });

  it('开场注入不重复：挂久了的无主引导不在无主那行再列；每条只带前 40 字，全文指到 pnpm progress read --pending', () => {
    const long = `${'长'.repeat(40)}后面的全文不该注入`;
    const lines = hook.progressLines(
      run([`1\t${H}\t原话：${long}\t无主\t${iso(30)}`, `2\t${H}\t原话：新的无主\t无主\t${iso(1)}`]),
      A,
      { now: NOW, presence: () => ({ state: 'here', why: '' }), adopt: () => ({ ok: true }) },
    );
    const text = lines.join('\n');
    expect(text.split('长'.repeat(40)).length - 1).toBe(1);
    expect(text).not.toContain('后面的全文不该注入');
    expect(text).toContain('pnpm progress read --pending');
    const unowned = lines.find((l) => l.startsWith('无主的创始人引导')) ?? '';
    expect(unowned).toContain('无主的创始人引导 1 条');
    expect(unowned).toContain('新的无主');
    expect(unowned).not.toContain('长长');
  });
});

describe('ownerPresence：主人会话在不在', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const home = () => {
    const h = mkdtempSync(join(tmpdir(), 'presence-'));
    made.push(h);
    return h;
  };
  const session = (h: string, dir: string, rec: Record<string, unknown>, turnsHAgo?: number) => {
    const d = join(h, '.mirasim', 'sessions', 'claude', dir);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'record.json'), JSON.stringify(rec));
    if (turnsHAgo !== undefined) {
      writeFileSync(join(d, 'turns.jsonl'), '{}\n');
      const t = new Date(NOW - turnsHAgo * 3_600_000);
      utimesSync(join(d, 'turns.jsonl'), t, t);
    }
  };
  const env = {};

  it('没在跑、闲置超过 12 小时：不在；最近动过、在跑：在', () => {
    const h = home();
    session(h, 'old', { runPid: null, updatedAt: iso(20) }, 20);
    session(h, 'fresh', { runPid: null, updatedAt: iso(20) }, 1);
    session(h, 'busy', { runPid: 123, updatedAt: iso(50) });
    expect(inbox.ownerPresence({ home: h, owner: 'old', now: NOW, env }).state).toBe('gone');
    expect(inbox.ownerPresence({ home: h, owner: 'fresh', now: NOW, env }).state).toBe('here');
    expect(inbox.ownerPresence({ home: h, owner: 'busy', now: NOW, env }).state).toBe('here');
  });

  it('交接给了别的会话、自己没在跑：不在', () => {
    const h = home();
    session(h, 'src', { runPid: null, updatedAt: iso(1) });
    session(h, 'next', { runPid: 9, handoverFrom: 'src', updatedAt: iso(0) });
    expect(inbox.ownerPresence({ home: h, owner: 'src', now: NOW, env })).toMatchObject({ state: 'gone' });
  });

  it('【故意造出失败】判不了的（本机没有这个会话、记录认不出、无主）一律 unknown', () => {
    const h = home();
    session(h, 'x', { runPid: null, updatedAt: iso(30) });
    writeFileSync(join(h, '.mirasim', 'sessions', 'claude', 'x', 'record.json'), '{坏');
    expect(inbox.ownerPresence({ home: h, owner: 'x', now: NOW, env }).state).toBe('unknown');
    expect(inbox.ownerPresence({ home: h, owner: 'nobody', now: NOW, env }).state).toBe('unknown');
    expect(inbox.ownerPresence({ home: h, owner: '无主', now: NOW, env }).state).toBe('unknown');
  });
});
