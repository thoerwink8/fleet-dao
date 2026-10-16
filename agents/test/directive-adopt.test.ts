// 开会话钩子对没办完引导的两件事：挂了超过 24 小时、本会话接不了的写成指挥官自己接着办（决定 0097，不进「要你拍的」）；
// 办没办完看挂的单，没有认领（#2727，认领和自动认领都删了）。主人在不在由 founder-inbox.mjs 的 ownerPresence 按本机 Mirasim 记录判。
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
    o?: { now?: number },
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

describe('挂久了的引导交给指挥官自己办', () => {
  it('挂了超过 24 小时、本会话接不了的写成指挥官自己接着办（不用认领），不出现「要你拍」；自己的、不满 24 小时的不进', () => {
    const lines = hook
      .progressLines(
        run([
          `1\t${H}\t原话：老的无主\t无主\t${iso(30)}`,
          `2\t${H}\t原话：老的别人的\tdir-b\t${iso(25)}`,
          `3\t${H}\t原话：老的自己的\tdir-a\t${iso(40)}`,
          `4\t${H}\t原话：新的别人的\tdir-b\t${iso(3)}`,
        ]),
        A,
        { now: NOW },
      )
      .join('\n');
    expect(lines).not.toContain('要你拍');
    const ask = lines.split('\n').find((l) => l.includes('挂了超过 24 小时')) ?? '';
    expect(ask).toContain('指挥官自己的活，不用问创始人');
    expect(ask).not.toContain('progress claim');
    expect(ask).not.toContain('progress done');
    expect(ask).toContain('不用认领');
    expect(ask).toContain('把挂的单关掉');
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
      { now: NOW },
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

describe('挂的单（#2727）', () => {
  it('progress.ts 第 6 列是挂的单：开场里写「单 #N」；没有这一列的旧输出照常列', () => {
    const lines = hook
      .progressLines(
        run([`1\t${H}\t原话：有单的\tdir-a\t${iso(2)}\t#2727`, `2\t${H}\t原话：没单的\tdir-a\t${iso(2)}`]),
        A,
        { now: NOW },
      )
      .join('\n');
    expect(lines).toContain('1，单 #2727');
    expect(lines).toContain('2（2026-10-14 16:00 +0800）没单的');
    expect(lines).not.toContain('2，单');
  });
});
