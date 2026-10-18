import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  LINUX_TESTS,
  parseLinuxRunner,
  runLocalVitest,
  snapshotSource,
  sourceDigest,
  splitLocalTests,
  verifyLinuxReceipt,
} from '../src/local-vitest.ts';
import { runChild } from './child.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('缺报告、旧摘要、root、少跑、多跑、跳过和退出码冲突都不算通过', () => {
  const make = () => ({
    digest: 'current',
    platform: 'linux',
    uid: 1000,
    root: '/snapshot',
    status: 0,
    report: {
      success: true,
      numPendingTests: 0,
      numTotalTests: 1,
      numFailedTests: 0,
      testResults: [{ name: `/snapshot/${LINUX_TESTS[0]}`, assertionResults: [{ status: 'passed' }] }],
    },
  });
  const good = make();
  expect(verifyLinuxReceipt(JSON.stringify(good), [LINUX_TESTS[0]], 'current', 0).uid).toBe(1000);
  const cases = [
    { ...good, digest: 'old' },
    { ...good, uid: 0 },
    { ...good, uid: undefined },
    { ...good, report: undefined },
    { ...good, status: 1 },
    { ...good, report: { ...good.report, testResults: [] } },
    {
      ...good,
      report: {
        ...good.report,
        testResults: [...good.report.testResults, { name: '/snapshot/extra.test.ts' }],
      },
    },
    { ...good, report: { ...good.report, numPendingTests: 1 } },
    { ...good, report: { ...good.report, numTotalTests: 0 } },
    { ...good, report: { ...good.report, success: false } },
    {
      ...good,
      report: {
        ...good.report,
        testResults: [{ name: `/snapshot/${LINUX_TESTS[0]}`, assertionResults: [{ status: 'failed' }] }],
      },
    },
  ];
  for (const bad of cases)
    expect(() => verifyLinuxReceipt(JSON.stringify(bad), [LINUX_TESTS[0]], 'current', 0)).toThrow();
});

it('目录/子串过滤选择同一全集，Linux 专属与原生清单无遗漏或重复', () => {
  const universe = [...LINUX_TESTS, 'packages/engine/test/native.test.ts', 'agents/test/skills.test.ts'];
  const split = splitLocalTests(universe, ['packages/engine/']);
  expect(split.linux).toEqual([...LINUX_TESTS]);
  expect(split.native).toEqual(['packages/engine/test/native.test.ts']);
  expect(splitLocalTests(universe, []).native).toContain('agents/test/skills.test.ts');
});

it('runner 必须显式提供 Linux Node 启动参数和绝对依赖根', () => {
  for (const value of [
    '{}',
    '{"command":"x","args":[],"dependencyRoot":"relative"}',
    '{"command":"x","args":[1],"dependencyRoot":"/deps"}',
  ])
    expect(() => parseLinuxRunner(value)).toThrow();
  expect(
    parseLinuxRunner('{"command":"wsl.exe","args":["--exec","node"],"dependencyRoot":"/deps"}')
      .dependencyRoot,
  ).toBe('/deps');
});

it('快照读取当前 tracked 脏改、新文件和删除，不用 HEAD 或暂存副本', { timeout: 0 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-snapshot-'));
  roots.push(root);
  const git = (...args: string[]) => {
    const r = runChild('git', args, { cwd: root });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  git('init');
  writeFileSync(join(root, 'tracked.ts'), 'staged');
  writeFileSync(join(root, 'deleted.ts'), 'deleted');
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
  git('add', '.');
  writeFileSync(join(root, 'tracked.ts'), 'current dirty bytes');
  writeFileSync(join(root, 'new.ts'), 'new source');
  writeFileSync(join(root, 'ignored.txt'), 'private');
  unlinkSync(join(root, 'deleted.ts'));
  const files = snapshotSource(root);
  expect(files.map((f) => f.path)).toEqual(['.gitignore', 'new.ts', 'tracked.ts']);
  expect(Buffer.from(files.find((f) => f.path === 'tracked.ts')?.data ?? '', 'base64').toString()).toBe(
    'current dirty bytes',
  );
  const before = sourceDigest(files);
  writeFileSync(join(root, 'tracked.ts'), 'another change');
  expect(sourceDigest(snapshotSource(root))).not.toBe(before);
});

it('Windows 命中 Linux 测试且没有配置时明确报错，不能返回成功', () => {
  // 用本仓实际测试全集核路由；此分支在启动任何测试前失败。
  const root = new URL('../../../', import.meta.url);
  const result = runLocalVitest(
    decodeURIComponent(root.pathname).replace(/^\/([A-Za-z]:)/, '$1'),
    ['run', LINUX_TESTS[0]],
    {},
    'win32',
  );
  expect(result.error?.message).toContain('FLEET_TEST_LINUX_RUNNER');
  expect(result.status).toBeNull();
});

it('tracked 父目录被换成链接时拒绝快照，不读取链接另一端的源码', { timeout: 0 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-snapshot-link-'));
  roots.push(root);
  const git = (...args: string[]) => {
    const result = runChild('git', args, { cwd: root });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git('init');
  mkdirSync(join(root, 'tracked'));
  writeFileSync(join(root, 'tracked', 'source.ts'), 'original');
  git('add', '.');
  const outside = mkdtempSync(join(tmpdir(), 'fleet-snapshot-outside-'));
  roots.push(outside);
  writeFileSync(join(outside, 'source.ts'), 'outside');
  rmSync(join(root, 'tracked'), { recursive: true });
  symlinkSync(outside, join(root, 'tracked'), 'junction');
  // Linux 会把新链接本身列为 untracked；忽略这一项，cached tracked/source.ts 仍须走父目录护栏。
  writeFileSync(join(root, '.gitignore'), '/tracked\n');
  expect(() => snapshotSource(root)).toThrow('符号链接父目录');
});
