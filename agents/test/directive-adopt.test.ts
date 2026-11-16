// 开会话钩子对没办完引导（带「创始人引导」标签、开着的 GitHub 单，#4054）的两件事：挂了超过 24 小时、
// 本会话接不了的写成指挥官自己接着办（决定 0097，不进「要你拍的」）；办没办完就是单开着没有，没有认领。
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
const hook = (await import(pathToFileURL(join(HOOKS, 'session-start.mjs')).href)) as {
  directiveLines(
    r: { status: number | null; stdout: string; stderr: string },
    lineage: unknown,
    o?: { now?: number },
  ): string[];
};

const NOW = Date.parse('2026-10-14T12:00:00Z');
const iso = (hAgo: number) => new Date(NOW - hAgo * 3_600_000).toISOString();
/** 一条引导单：主人标记写在正文〔主：…〕里，没写就是无主 */
const issue = (number: number, title: string, hAgo: number, owner?: string) => ({
  number,
  title,
  body: owner === undefined ? '' : `〔主：${owner}〕`,
  createdAt: iso(hAgo),
});
const run = (issues: object[]) => ({ status: 0, stdout: `${JSON.stringify(issues)}\n`, stderr: '' });
const A = { status: 'found', dir: 'dir-a', sessionIds: ['dir-a'] };

describe('挂久了的引导交给指挥官自己办', () => {
  it('挂了超过 24 小时、本会话接不了的写成指挥官自己接着办（不用认领），不出现「要你拍」；自己的、不满 24 小时的不进', () => {
    const lines = hook
      .directiveLines(
        run([
          issue(1, '老的无主', 30),
          issue(2, '老的别人的', 25, 'dir-b'),
          issue(3, '老的自己的', 40, 'dir-a'),
          issue(4, '新的别人的', 3, 'dir-b'),
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
    expect(ask).toContain('把单关掉');
    expect(ask).toContain('2 条挂了超过 24 小时');
    expect(ask).toContain('老的无主');
    expect(ask).toContain('老的别人的');
    expect(ask).not.toContain('老的自己的');
    expect(ask).not.toContain('新的别人的');
  });

  it('开场注入不重复：挂久了的无主引导不在无主那行再列；每条只带前 40 字，全文指到 gh issue view', () => {
    const long = `${'长'.repeat(40)}后面的全文不该注入`;
    const lines = hook.directiveLines(
      run([issue(1, long, 30), issue(2, '新的无主', 1)]),
      A,
      { now: NOW },
    );
    const text = lines.join('\n');
    expect(text.split('长'.repeat(40)).length - 1).toBe(1);
    expect(text).not.toContain('后面的全文不该注入');
    expect(text).toContain('gh issue view');
    const unowned = lines.find((l) => l.startsWith('无主的创始人引导')) ?? '';
    expect(unowned).toContain('无主的创始人引导 1 条');
    expect(unowned).toContain('新的无主');
    expect(unowned).not.toContain('长长');
  });
});

describe('单号就是引导本身（#4054）', () => {
  it('每条带 #单号；办完＝把单关掉（PR 写 Closes），没有另记', () => {
    const lines = hook
      .directiveLines(
        run([issue(2727, '有单的', 2, 'dir-a'), issue(2728, '另一条', 2, 'dir-a')]),
        A,
        { now: NOW },
      )
      .join('\n');
    expect(lines).toContain('#2727');
    expect(lines).toContain('#2728');
    expect(lines).toContain('把单关掉');
    expect(lines).toContain('Closes');
  });
});
