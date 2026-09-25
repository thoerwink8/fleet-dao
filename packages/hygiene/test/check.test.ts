// runCheck 的退出码和输出：扫完 0 条、查出了、一个没扫到、清单不对、名单没读到、白名单没用上或没写理由，各自分得开。
import { describe, expect, it } from 'vitest';
import type { Allow } from '../src/allowlist.ts';
import { runCheck } from '../src/check.ts';
import type { LoadedValues } from '../src/values.ts';

const LIST: LoadedValues = { ok: true, source: '测试名单', values: ['fake-org-778899'] };
const NO_LIST: LoadedValues = { ok: false, reason: '已知敏感值名单没读到（找过：/nope）', tried: ['/nope'] };

const clean = {
  'README.md': Buffer.from('没有问题\n'),
  'packages/hygiene/src/rules.ts': Buffer.from('// 规则\n'),
};
const run = (files: Record<string, Buffer>, allowlist: readonly Allow[] = [], values: LoadedValues = LIST) =>
  runCheck({
    root: '/repo',
    list: () => Object.keys(files),
    read: (path) => files[path] ?? Buffer.alloc(0),
    allowlist,
    mustInclude: 'packages/hygiene/src/rules.ts',
    values,
  });
const leakEmail = ['zhang.san', 'mail.co'].join('@');

describe('runCheck', () => {
  it('扫了、名单读到了、没查出东西：退出码 0，写明扫了几个、名单几条', () => {
    expect(run(clean)).toEqual({
      code: 0,
      lines: [
        '卫生检查：扫了 2 个文件，查出 0 条（二进制 0 个只按文件名判、工作树里已删的 0 个没扫；已知敏感值名单 1 条）',
      ],
    });
  });

  it('查出了：退出码 1，逐条列出路径、行号和规则名，不打命中的值', () => {
    const leaked = { ...clean, 'docs/a.md': Buffer.from(`\n\n见 ${leakEmail}\n用户 fake-org-778899\n`) };
    const result = run(leaked);
    expect(result.code).toBe(1);
    expect(result.lines.slice(0, 3)).toEqual([
      '卫生检查：扫了 3 个文件，查出 2 条（二进制 0 个只按文件名判、工作树里已删的 0 个没扫；已知敏感值名单 1 条）',
      'docs/a.md:3 邮箱',
      'docs/a.md:4 名单里的敏感值',
    ]);
    expect(result.lines.join('\n')).not.toContain(leakEmail);
    expect(result.lines.join('\n')).not.toContain('fake-org-778899');
  });

  it('名单没读到：退出码 2（和「查出问题」的 1 分开），查出的照样列出来', () => {
    const quiet = run(clean, [], NO_LIST);
    expect(quiet.code).toBe(2);
    expect(quiet.lines.at(-1)).toMatch(/^没扫全：已知敏感值名单没读到/);
    const leaked = run({ ...clean, 'docs/a.md': Buffer.from(`${leakEmail}\n`) }, [], NO_LIST);
    expect(leaked.code).toBe(2);
    expect(leaked.lines).toContain('docs/a.md:1 邮箱');
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
      values: LIST,
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
      { rule: 'email', path: /^nowhere\//, reason: '测试用：一处都用不上的条目。' },
    ]);
    expect(unused.code).toBe(0);
    expect(unused.lines).toContain('提示：白名单这条这次一处都没用上，确实不用了就删掉：email /^nowhere\\//');
    const unreasoned = run(clean, [{ rule: 'email', path: /^README\.md$/, reason: '' }]);
    expect(unreasoned.code).toBe(1);
    expect(unreasoned.lines).toContain('白名单这条没写清理由：email /^README\\.md$/');
  });
});
