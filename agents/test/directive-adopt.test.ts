// 开会话钩子对没办完引导的两件事：挂了超过 24 小时、本会话接不了的写成指挥官自己接着办（决定 0097，不进「要你拍的」）；
// 办没办完看挂的单，没有认领（#2727，认领和自动认领都删了）。
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
const hook = (await import(pathToFileURL(join(HOOKS, 'session-start.mjs')).href)) as {
  progressLines(
    r: { status: number | null; stdout: string; stderr: string },
    lineage: unknown,
    o?: { now?: number },
  ): string[];
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
