// runCheck 的退出码和输出：扫完 0 条、查出了、一个没扫到、清单不对、白名单没用上或没写理由，各自分得开。
import { describe, expect, it } from 'vitest';
import type { Allow } from '../src/allowlist.ts';
import { runCheck } from '../src/check.ts';
import { pseudoRandom, pseudoUuid } from './helpers.ts';

const R = (n: number, seed: number) => pseudoRandom(n, seed);

const clean = {
  'README.md': Buffer.from('没有问题\n'),
  'packages/hygiene/src/rules.ts': Buffer.from('// 规则\n'),
};
const run = (files: Record<string, Buffer>, allowlist: readonly Allow[] = []) =>
  runCheck({
    root: '/repo',
    list: () => Object.keys(files),
    read: (path) => files[path] ?? Buffer.alloc(0),
    allowlist,
    mustInclude: 'packages/hygiene/src/rules.ts',
  });
const leakToken = ['ghp', R(36, 701)].join('_');
const leakWebhook = ['https://open.feishu.cn/open-apis/bot/v2/hook', pseudoUuid(702)].join('/');

describe('runCheck', () => {
  it('扫了，没查出东西：退出码 0，写明扫了几个', () => {
    expect(run(clean)).toEqual({
      code: 0,
      lines: ['卫生检查：扫了 2 个文件，查出 0 条（二进制 0 个只按文件名判、工作树里已删的 0 个没扫）'],
    });
  });

  it('查出了：退出码 1，逐条列出路径、行号和规则名，不打命中的值', () => {
    // findHits 按 RULES 数组的顺序分组（token 排在 webhook 前面），不是按文本里的行号排：这里的顺序照它来。
    const leaked = { ...clean, 'docs/a.md': Buffer.from(`\n\n令牌 ${leakToken}\n${leakWebhook}\n`) };
    const result = run(leaked);
    expect(result.code).toBe(1);
    expect(result.lines.slice(0, 3)).toEqual([
      '卫生检查：扫了 3 个文件，查出 2 条（二进制 0 个只按文件名判、工作树里已删的 0 个没扫）',
      'docs/a.md:3 令牌',
      'docs/a.md:4 webhook 地址',
    ]);
    expect(result.lines.join('\n')).not.toContain(leakToken);
    expect(result.lines.join('\n')).not.toContain(leakWebhook);
  });

  it('一个文件都没扫到：退出码 2，不算干净', () => {
    const result = run({});
    expect(result.code).toBe(2);
    expect(result.lines[1]).toContain('一个文件都没扫到');
  });

  it('列文件出错（不在 git 仓库里之类）：退出码 2，写明没扫成', () => {
    const result = runCheck({
      root: '/repo',
      list: () => {
        throw new Error('not a git repository');
      },
    });
    expect(result).toEqual({ code: 2, lines: ['卫生检查没扫成：列文件出错（not a git repository）'] });
  });

  it('清单里没有必有的文件（仓库根不对）：退出码 2', () => {
    const result = run({ 'README.md': Buffer.from('没有问题\n') });
    expect(result.code).toBe(2);
    expect(result.lines[1]).toContain('扫描清单里没有 packages/hygiene/src/rules.ts');
  });

  it('白名单没用上的只提示、不判红；没写理由的判红', () => {
    const unused = run(clean, [
      { rule: 'request-id', path: /^nowhere\//, reason: '测试用：一处都用不上的条目。' },
    ]);
    expect(unused.code).toBe(0);
    expect(unused.lines).toContain(
      '提示：白名单这条这次一处都没用上，确实不用了就删掉：request-id /^nowhere\\//',
    );
    const unreasoned = run(clean, [{ rule: 'request-id', path: /^README\.md$/, reason: '' }]);
    expect(unreasoned.code).toBe(1);
    expect(unreasoned.lines).toContain('白名单这条没写清理由：request-id /^README\\.md$/');
  });
});
