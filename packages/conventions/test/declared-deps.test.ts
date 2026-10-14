import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  extractImports,
  findUndeclared,
  type Manifest,
  packageOf,
  parseManifest,
} from '../src/declared-deps.ts';
import { walkRelease } from '../src/release-smoke.ts';

const m = (dir: string, name: string, deps: string[]): Manifest => ({ dir, name, deps: new Set(deps) });

describe('packageOf', () => {
  it('取包名：带 scope 取两段、子路径去掉；相对、内置、#子路径不算包', () => {
    expect(packageOf('zod')).toBe('zod');
    expect(packageOf('hono/body-limit')).toBe('hono');
    expect(packageOf('@temporalio/worker')).toBe('@temporalio/worker');
    expect(packageOf('@fleet-dao/engine/failure')).toBe('@fleet-dao/engine');
    expect(packageOf('./x.ts')).toBeNull();
    expect(packageOf('node:fs')).toBeNull();
    expect(packageOf('fs')).toBeNull();
    expect(packageOf('#internal')).toBeNull();
  });
});

describe('parseManifest', () => {
  it('四栏依赖都算；不是 JSON、栏不是对象报一句为什么，不当成没依赖', () => {
    const r = parseManifest(
      'packages/a',
      '{"name":"a","dependencies":{"x":"1"},"devDependencies":{"y":"1"},"peerDependencies":{"z":"1"}}',
    );
    expect(typeof r).toBe('object');
    expect([...(r as Manifest).deps].sort()).toEqual(['x', 'y', 'z']);
    expect(typeof parseManifest('packages/a', '{')).toBe('string');
    expect(parseManifest('', '{"dependencies":"x"}')).toMatch(/dependencies 不是对象/);
  });
});

describe('extractImports + findUndeclared', () => {
  const manifests = [
    m('', 'root', ['vitest', 'esbuild']),
    m('packages/api', '@fleet-dao/api', ['zod', '@fleet-dao/shared']),
    m('packages/hygiene', '@fleet-dao/hygiene', []),
  ];

  it('【故意造出的失败】没声明的包查得出、指名该写进哪份 package.json（065445a4 那类）', async () => {
    const { imports, errors } = await extractImports([
      { path: 'packages/hygiene/src/a.ts', contents: "import { z } from 'zod';\nexport const q = z;\n" },
    ]);
    expect(errors).toEqual([]);
    expect(findUndeclared(imports, manifests)).toEqual([
      {
        file: 'packages/hygiene/src/a.ts',
        spec: 'zod',
        pkg: 'zod',
        manifest: 'packages/hygiene/package.json',
      },
    ]);
  });

  it('import type 被擦掉不算；没用到的值导入、副作用导入、字面量 import()、require 都算', async () => {
    const { imports } = await extractImports([
      {
        path: 'packages/hygiene/src/b.ts',
        contents: [
          "import type { A } from 'only-types';",
          "import { type B } from 'mixed-type';",
          "import { unused } from 'unused-value';",
          "import 'side-effect';",
          "const d = await import('dyn');",
          "const r = require('req');",
          'export const x: A | B | undefined = undefined; void d; void r;',
          '',
        ].join('\n'),
      },
    ]);
    const specs = imports.map((i) => i.spec).sort();
    expect(specs).toEqual(['dyn', 'mixed-type', 'req', 'side-effect', 'unused-value']);
  });

  it('自己包、仓根、自己的包名、node 内置、相对路径都不报', async () => {
    const { imports } = await extractImports([
      {
        path: 'packages/api/src/c.ts',
        contents:
          "import { z } from 'zod';\nimport { s } from '@fleet-dao/shared';\nimport { t } from 'vitest';\nimport { u } from '@fleet-dao/api/x';\nimport fs from 'node:fs';\nimport p from 'path';\nimport { v } from './v.ts';\nexport default [z, s, t, u, fs, p, v];\n",
      },
      { path: 'deploy/web/x.mjs', contents: "import { build } from 'esbuild';\nexport default build;\n" },
    ]);
    expect(findUndeclared(imports, manifests)).toEqual([]);
  });

  it('【故意造出的失败】解析不了的文件记成错，不当成没有 import', async () => {
    const { errors } = await extractImports([{ path: 'packages/api/src/bad.ts', contents: 'import {' }]);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('walkRelease（发版目录冒烟）', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-smoke-')));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const rel = join(root, 'rel');
  const outside = join(root, 'home-store');
  mkdirSync(join(rel, 'packages/api/src'), { recursive: true });
  mkdirSync(join(rel, 'packages/api/node_modules/inpkg'), { recursive: true });
  mkdirSync(join(outside, 'outpkg'), { recursive: true });
  writeFileSync(
    join(rel, 'packages/api/node_modules/inpkg/package.json'),
    '{"name":"inpkg","main":"index.js"}',
  );
  writeFileSync(join(rel, 'packages/api/node_modules/inpkg/index.js'), 'module.exports = 1;');
  writeFileSync(join(outside, 'outpkg/package.json'), '{"name":"outpkg","main":"index.js"}');
  writeFileSync(join(outside, 'outpkg/index.js'), 'module.exports = 1;');
  // 指到目录外：和法国开着全局虚拟仓时一样（node_modules 链到家目录里的 pnpm 仓库）
  symlinkSync(join(outside, 'outpkg'), join(rel, 'packages/api/node_modules/outpkg'), 'junction');
  writeFileSync(join(rel, 'packages/api/src/lib.ts'), "import 'inpkg';\nexport const a = 1;\n");

  // 测试里不开 --experimental-import-meta-resolve：用一个按 node_modules 往上找的简化解析器代替，只为喂进 walkRelease
  const resolve = (spec: string, parent: string): string => {
    const from = new URL(parent);
    if (spec.startsWith('.')) return new URL(spec, from).href;
    let dir = new URL('.', from);
    for (;;) {
      const cand = new URL(`node_modules/${spec}/index.js`, dir);
      try {
        realpathSync(cand);
        return cand.href;
      } catch {}
      const up = new URL('..', dir);
      if (up.href === dir.href) break;
      dir = up;
    }
    throw Object.assign(new Error(`not found ${spec}`), { code: 'ERR_MODULE_NOT_FOUND' });
  };

  it('都在目录里、都找得到：没有问题，顺着相对 import 走到下一层', async () => {
    writeFileSync(
      join(rel, 'packages/api/src/main.ts'),
      "import { a } from './lib.ts';\nimport fs from 'node:fs';\nexport default [a, fs];\n",
    );
    const r = await walkRelease(rel, ['packages/api/src/main.ts'], resolve);
    expect(r.problems).toEqual([]);
    expect(r.files).toBe(2);
  });

  it('【故意造出的失败】找不到的包、解析到目录外的包都报红', async () => {
    writeFileSync(join(rel, 'packages/api/src/main.ts'), "import 'missing';\nimport 'outpkg';\n");
    const r = await walkRelease(rel, ['packages/api/src/main.ts'], resolve);
    expect(r.problems).toHaveLength(2);
    expect(r.problems[0]).toMatch(/import 'missing' 找不到（ERR_MODULE_NOT_FOUND）/);
    expect(r.problems[1]).toMatch(/import 'outpkg' 解析到这一版目录外面/);
  });

  it('【故意造出的失败】入口不在：报出来，不当成走完了', async () => {
    const r = await walkRelease(rel, ['packages/nope/main.ts'], resolve);
    expect(r.problems[0]).toMatch(/入口 packages\/nope\/main.ts 不在/);
  });
});
