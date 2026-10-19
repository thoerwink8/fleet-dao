// 包的面（../src/package-surface.ts）：exports、bin 顺着包内相对引用走得到的文件；认不出就整个包都算面。
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { crossPackageTargets, packageOffSurface, packageSurface } from '../src/package-surface.ts';
import { fsRepo } from '../src/repo.ts';
import { memRepo } from './helpers.ts';

const PKG = { name: '@x/a', exports: { '.': './src/index.ts' } };

describe('包的面', () => {
  it('从 exports 顺着 import、export from、new URL 走；走不到的入口脚本、测试不在面上', () => {
    const repo = memRepo({
      'packages/a/package.json': JSON.stringify(PKG),
      'packages/a/src/index.ts': "export * from './b.ts';\nimport { c } from './c.ts';\n",
      'packages/a/src/b.ts': "const f = new URL('../data/x.json', import.meta.url);\n",
      'packages/a/src/c.ts': "export const c = await import('./d.ts');\n",
      'packages/a/src/d.ts': '',
      'packages/a/data/x.json': '{}',
      'packages/a/src/bin/run.ts': "import { c } from '../c.ts';\n",
      'packages/a/test/a.test.ts': "import '../src/index.ts';\n",
    });
    expect(packageSurface(repo, 'a', PKG)).toEqual([
      'packages/a/data/x.json',
      'packages/a/src/b.ts',
      'packages/a/src/c.ts',
      'packages/a/src/d.ts',
      'packages/a/src/index.ts',
    ]);
    expect(packageOffSurface(repo, 'a', PKG, new Set())).toEqual([
      'packages/a/src/bin/run.ts',
      'packages/a/test/a.test.ts',
    ]);
  });

  it('注释里写的 import(...) 不算拿变量拼的引用', () => {
    const repo = memRepo({
      'packages/a/package.json': JSON.stringify(PKG),
      'packages/a/src/index.ts':
        '// 有拿变量拼的 import(...) 就认不出\n/**\n * import(x)\n */\nexport const a = 1;\n',
    });
    expect(packageSurface(repo, 'a', PKG)).toEqual(['packages/a/src/index.ts']);
  });

  it('【故意造出的失败】认不出就整个包都算面：没 exports、拿变量拼的 import、入口不在、相对路径落不到文件', () => {
    const base = { 'packages/a/package.json': JSON.stringify(PKG), 'packages/a/src/bin/x.ts': '' };
    const surfaceOf = (files: Record<string, string>, pkg: Record<string, unknown> = PKG) =>
      packageSurface(memRepo({ ...base, ...files }), 'a', pkg);
    expect(surfaceOf({ 'packages/a/src/index.ts': '' }, { name: '@x/a' })).toBeNull();
    expect(surfaceOf({ 'packages/a/src/index.ts': 'const m = await import(name);\n' })).toBeNull();
    expect(
      surfaceOf({ 'packages/a/src/index.ts': 'const u = new URL(`./` + name, import.meta.url);\n' }),
    ).toBeNull();
    expect(surfaceOf({})).toBeNull();
    expect(surfaceOf({ 'packages/a/src/index.ts': "import './gone.ts';\n" })).toBeNull();
    expect(surfaceOf({ 'packages/a/src/index.ts': '' }, { name: '@x/a', exports: './src/*.ts' })).toBeNull();
    // 认不出时面以外的清单是空的：没有哪个文件被当成「依赖它的包用不到」
    expect(
      packageOffSurface(
        memRepo({ ...base, 'packages/a/src/index.ts': '' }),
        'a',
        { name: '@x/a' },
        new Set(),
      ),
    ).toEqual([]);
  });

  it('package.json、tsconfig.json 和别处直接引用到的文件都算在面上', () => {
    const repo = memRepo({
      'packages/a/package.json': JSON.stringify(PKG),
      'packages/a/tsconfig.json': '{}',
      'packages/a/src/index.ts': '',
      'packages/a/src/wire.ts': '',
      'packages/a/src/bin/x.ts': '',
      'packages/a/fixtures/one.json': '',
      'packages/b/package.json': JSON.stringify({ name: '@x/b', exports: { '.': './src/index.ts' } }),
      'packages/b/src/index.ts':
        "import { w } from '../../a/src/wire.ts';\nconst d = new URL('../../a/fixtures', import.meta.url);\n",
      // 别的包的测试读它不算在这里（由 ci-plan 的 TEST_READS 和扫描器管）
      'packages/b/test/b.test.ts': "import '../../a/src/bin/x.ts';\n",
    });
    const cross = crossPackageTargets(repo, ['a', 'b']);
    expect([...cross].sort()).toEqual(['packages/a/fixtures', 'packages/a/src/wire.ts']);
    expect(packageOffSurface(repo, 'a', PKG, cross)).toEqual(['packages/a/src/bin/x.ts']);
  });

  it('真仓：conventions 的入口脚本、check.ts 不在面上；index.ts、ci-plan.ts、standard-paths.json 在', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const repo = fsRepo(root);
    const pkg = JSON.parse(repo.read('packages/conventions/package.json') ?? '{}') as Record<string, unknown>;
    const surface = packageSurface(repo, 'conventions', pkg);
    expect(surface).not.toBeNull();
    for (const f of ['src/index.ts', 'src/ci-plan.ts', 'src/e2e-flaky.ts', 'standard-paths.json']) {
      expect(surface, f).toContain(`packages/conventions/${f}`);
    }
    for (const f of [
      'src/check.ts',
      'src/bin/check.ts',
      'src/bin/test-changed.ts',
      'src/bin/e2e-flaky.ts',
      'src/e2e-flaky-settled.ts',
    ]) {
      expect(surface, f).not.toContain(`packages/conventions/${f}`);
    }
  });
});
