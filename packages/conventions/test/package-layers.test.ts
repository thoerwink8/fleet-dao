// 包的分层钉子（#865）：api 是驾驶舱后端（Hono）、在最上面，别的包一律不许依赖它，也不许 import 它；
// store 是后端和引擎共用的、不碰 HTTP 的那一层，不许反过来依赖 api、engine。
// 起因：引擎的 package.json 里曾经有 @fleet-dao/api，Store 放在 HTTP 包里再被引擎倒着引用。
// #901 ⑤ 又加两条：github 是纯 GitHub API 包，只许依赖 conventions（PR 正文挂单的解析）、hygiene（推分支、开 PR 前扫密钥）、shared，
// 不许碰数据库（db）和 store——读写库的幂等账、PR 镜像、锁在 store 的 github-pg.ts；db 是表结构和查询，不许反过来依赖 github。
// 起因：github 包里夹着 ledger.ts、idempotency.ts 两个读写库的文件，GitHub 客户端因此拖着 db、drizzle-orm，改 db 就要重测 github。
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCOPE = '@fleet-dao/';

/** 包名（不带 @fleet-dao/）→ 它不许依赖的包。api 不在这里：任何别的包都不许碰 api，下面单独判。 */
const MUST_NOT_USE: Record<string, readonly string[]> = {
  store: ['engine'],
  db: ['github'],
};
/** 白名单：这个包只许依赖这几个（别的一律不行，今后有人想往里塞 db、store 就红）。 */
const ONLY_MAY_USE: Record<string, readonly string[]> = {
  github: ['conventions', 'hygiene', 'shared'],
};
const TOP = 'api';

export interface PackageFacts {
  name: string;
  /** package.json 里 dependencies、devDependencies、peerDependencies 写的包名。 */
  deps: readonly string[];
}
export interface ImportFact {
  pkg: string;
  file: string;
  /** import 的包名（可带子路径）。 */
  specifier: string;
}

/** 返回每一处违例的说法；空数组 = 分层没破。 */
export function layerViolations(facts: {
  packages: readonly PackageFacts[];
  imports: readonly ImportFact[];
}): string[] {
  const out: string[] = [];
  const bare = (s: string) => (s.startsWith(SCOPE) ? (s.slice(SCOPE.length).split('/')[0] ?? '') : '');
  const forbidden = (from: string, to: string): string | null => {
    if (from === to) return null;
    if (to === TOP) return `${from} 依赖了 ${TOP}：${TOP} 是最上面的驾驶舱后端，别的包不许依赖它`;
    if (MUST_NOT_USE[from]?.includes(to)) return `${from} 依赖了 ${to}：${from} 不许反过来依赖 ${to}`;
    const only = ONLY_MAY_USE[from];
    if (only && !only.includes(to)) {
      return `${from} 依赖了 ${to}：${from} 是纯 GitHub API 包，只许依赖 ${only.join('、')}；读写库的账放 store（github-pg.ts）`;
    }
    return null;
  };
  for (const p of facts.packages) {
    for (const d of p.deps) {
      const to = bare(d);
      const why = to ? forbidden(p.name, to) : null;
      if (why) out.push(`packages/${p.name}/package.json：${why}`);
    }
  }
  for (const i of facts.imports) {
    const to = bare(i.specifier);
    const why = to ? forbidden(i.pkg, to) : null;
    if (why) out.push(`${i.file}：import '${i.specifier}'，${why}`);
  }
  return out;
}

function walk(dir: string, into: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, into);
    else if (/\.(ts|tsx|mjs)$/.test(name)) into.push(abs);
  }
}

/** 真实仓里的事实。读不到某个 package.json 或认不出就抛，不当成「没有依赖」。 */
export function repoFacts(root: string): { packages: PackageFacts[]; imports: ImportFact[] } {
  const packages: PackageFacts[] = [];
  const imports: ImportFact[] = [];
  const pkgsDir = join(root, 'packages');
  for (const dirName of readdirSync(pkgsDir)) {
    const dir = join(pkgsDir, dirName);
    if (!statSync(dir).isDirectory()) continue;
    const manifest = join(dir, 'package.json');
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error(`${manifest} 不是对象`);
    const rec = parsed as Record<string, unknown>;
    const deps: string[] = [];
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const block = rec[key];
      if (block === undefined) continue;
      if (typeof block !== 'object' || block === null) throw new Error(`${manifest} 的 ${key} 不是对象`);
      deps.push(...Object.keys(block));
    }
    packages.push({ name: dirName, deps });
    const files: string[] = [];
    for (const sub of ['src', 'test']) {
      try {
        walk(join(dir, sub), files);
      } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') throw err;
      }
    }
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:from|import\()\s*['"](@fleet-dao\/[^'"]+)['"]/g)) {
        imports.push({
          pkg: dirName,
          file: relative(root, file).split('\\').join('/'),
          specifier: m[1] ?? '',
        });
      }
    }
  }
  return { packages, imports };
}

describe('包的分层', () => {
  it('仓里没有包反着依赖 api，store 不依赖 engine，github 只依赖 conventions、hygiene、shared，db 不依赖 github', () => {
    expect(layerViolations(repoFacts(ROOT))).toEqual([]);
  });

  it('故意造的违例都认得出：引擎依赖 api、引擎源码 import api 的子路径、store 依赖 engine', () => {
    const got = layerViolations({
      packages: [
        { name: 'engine', deps: ['@fleet-dao/api', '@fleet-dao/store'] },
        { name: 'store', deps: ['@fleet-dao/engine', '@fleet-dao/db'] },
        { name: 'api', deps: ['@fleet-dao/store'] },
      ],
      imports: [
        { pkg: 'engine', file: 'packages/engine/src/real/x.ts', specifier: '@fleet-dao/api/whitelist' },
        { pkg: 'api', file: 'packages/api/src/a.ts', specifier: '@fleet-dao/api' },
        { pkg: 'engine', file: 'packages/engine/src/y.ts', specifier: '@fleet-dao/store' },
      ],
    });
    expect(got).toHaveLength(3);
    expect(got[0]).toContain('packages/engine/package.json');
    expect(got.some((s) => s.includes('packages/store/package.json') && s.includes('engine'))).toBe(true);
    expect(got.some((s) => s.includes('packages/engine/src/real/x.ts'))).toBe(true);
  });

  it('【故意造出的失败】github 依赖 db、import store 的子路径、db 依赖 github 都认得出；github 依赖白名单里的放行', () => {
    const got = layerViolations({
      packages: [
        {
          name: 'github',
          deps: ['@fleet-dao/db', '@fleet-dao/conventions', '@fleet-dao/hygiene', '@fleet-dao/shared'],
        },
        { name: 'db', deps: ['@fleet-dao/github', '@fleet-dao/shared'] },
        { name: 'store', deps: ['@fleet-dao/github', '@fleet-dao/db'] },
      ],
      imports: [
        { pkg: 'github', file: 'packages/github/src/x.ts', specifier: '@fleet-dao/store/testing' },
        { pkg: 'github', file: 'packages/github/src/y.ts', specifier: '@fleet-dao/hygiene' },
        { pkg: 'github', file: 'packages/github/test/z.ts', specifier: '@fleet-dao/db/testing' },
      ],
    });
    expect(got).toHaveLength(4);
    expect(got.some((s) => s.includes('packages/github/package.json') && s.includes('依赖了 db'))).toBe(true);
    expect(
      got.some((s) => s.includes('packages/db/package.json') && s.includes('不许反过来依赖 github')),
    ).toBe(true);
    expect(got.some((s) => s.includes('packages/github/src/x.ts') && s.includes('store'))).toBe(true);
    expect(got.some((s) => s.includes('packages/github/test/z.ts') && s.includes('db'))).toBe(true);
    // 白名单里的依赖和 store 依赖 github、db 都不算违例
    expect(
      got.some(
        (s) =>
          s.includes('依赖了 conventions') ||
          s.includes('依赖了 hygiene') ||
          s.includes('依赖了 shared') ||
          s.includes('y.ts') ||
          s.includes('packages/store'),
      ),
    ).toBe(false);
  });

  it('package.json 读不到或认不出时抛错，不当成没有依赖', () => {
    expect(() => repoFacts(join(ROOT, '没有这个目录'))).toThrow();
    const tmp = mkdtempSync(join(tmpdir(), 'layers-'));
    try {
      mkdirSync(join(tmp, 'packages', 'x'), { recursive: true });
      expect(() => repoFacts(tmp)).toThrow();
      writeFileSync(join(tmp, 'packages', 'x', 'package.json'), '{"dependencies": 3}');
      expect(() => repoFacts(tmp)).toThrow('dependencies');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
