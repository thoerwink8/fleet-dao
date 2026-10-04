// 包边界钉子（#901 重构方案第 1、4 节）：两件事一份名单。
// ① 零安装区：这些地方在没有 node_modules 的环境里跑（CI 的 changes/check job 在 pnpm install 之前就 node packages/conventions/src/bin/*.ts、
//    hygiene 零依赖、agents-sync 和 mirasim-reclaude 跑在不装依赖的专用检出、adapters 的 bridge.ts 被另一个系统用户的 node 当单文件脚本跑），
//    里面写 `import '@fleet-dao/…'` 会直接找不到包。bridge.ts 更严：只许 node: 内置。
// ② 跨包相对路径：src 里每一处指向别的包目录的相对 import / new URL，都要在名单里登记（写明理由），并且这个包在 package.json 里声明了对那个包的依赖
//    ——CI 选测靠 package.json 的依赖算「改了谁、要重测谁」（packages/conventions/src/ci-plan.ts 的 readGraph），声明丢了就漏测。
// 名单里登记了、文件里已经没有的，也算违规（免得名单越攒越多）；登记的目标文件不存在也算（目录挪了不会悄悄过）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCOPE = '@fleet-dao/';

/** 零安装区：这些包的 src 里不许有包名 import。 */
const ZONE_PACKAGES = ['conventions', 'hygiene', 'agents-sync', 'mirasim-reclaude'] as const;
/** 单文件脚本：只许 import node: 内置。 */
const SINGLE_FILE_SCRIPTS = ['packages/adapters/src/mirasim/bridge.ts'] as const;

export interface Allowed {
  /** 出现的文件（仓根起的相对路径，正斜杠）。 */
  file: string;
  /** 文件里的写法原文（import 说明符，或 new URL 的第一个参数）。 */
  spec: string;
  why: string;
}

/** 包名 @fleet-dao/shared 这类引用的登记（零安装区里例外放行的）。 */
export const ALLOWED_BARE: readonly Allowed[] = [
  ...['release-notes.ts', 'publish-release-logic.ts', 'publish-actions.ts'].map((f) => ({
    file: `packages/conventions/src/${f}`,
    spec: '@fleet-dao/shared',
    why: '发布流程用（release.yml 在 pnpm install 之后才跑它），不在 CI 的 install 之前那几个入口的引用链上',
  })),
  {
    file: 'packages/conventions/src/intents.ts',
    spec: '@fleet-dao/shared',
    why: 'pnpm intents 在指挥官本机跑（装过依赖），不在 CI 的 install 之前那几个入口的引用链上',
  },
];

/** 跨包相对路径的登记。 */
export const ALLOWED_CROSS: readonly Allowed[] = [
  {
    file: 'packages/mirasim-reclaude/src/migrate.ts',
    spec: '../../adapters/src/mirasim/wire.ts',
    why: '专用同步检出不装 node_modules（docs/reclaude-in-mirasim.md 第 56 行），借 adapters 的零依赖 wire.ts；package.json 声明保留，它是 CI 选测的变更边',
  },
  {
    file: 'packages/agents-sync/src/main.ts',
    spec: '../../mirasim-reclaude/bin/migrate',
    why: '同上，不装依赖；用路径起 mirasim-reclaude 的 bin 当子进程，没有 import；package.json 声明保留作变更边',
  },
  {
    file: 'packages/engine/src/real/index.ts',
    spec: '../../../adapters/src/mirasim/bridge.ts',
    why: '过渡：#901 ⑥-2 改成 import.meta.resolve(adapters 的 exports 子路径)后删这一条',
  },
];

export interface SrcFile {
  /** 仓根起的相对路径，正斜杠，如 packages/x/src/a.ts。 */
  rel: string;
  text: string;
}
export interface BoundaryFacts {
  files: readonly SrcFile[];
  /** 仓根起的相对路径是否存在（文件或目录）。 */
  exists: (rel: string) => boolean;
  /** 包目录名 → package.json 里 dependencies、devDependencies、peerDependencies 写的包目录名（只含 @fleet-dao/*）。 */
  deps: Readonly<Record<string, readonly string[]>>;
  allowedBare: readonly Allowed[];
  allowedCross: readonly Allowed[];
}

const pkgOf = (rel: string): string | null => {
  const m = /^packages\/([^/]+)\//.exec(rel);
  return m ? (m[1] ?? null) : null;
};

/** 去掉整行注释和块注释（注释里常提到 @fleet-dao/xxx，不算引用）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

interface Ref {
  kind: 'import' | 'url';
  spec: string;
}

/** import / export … from / import() 的说明符，和 new URL('相对路径', import.meta.url) 的第一个参数。 */
export function refsIn(text: string): Ref[] {
  const code = stripComments(text);
  const out: Ref[] = [];
  for (const m of code.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"\n]+)['"]/g)) {
    out.push({ kind: 'import', spec: m[1] ?? '' });
  }
  for (const m of code.matchAll(/new URL\(\s*['"](\.[^'"\n]*)['"]\s*,\s*import\.meta\.url/g)) {
    out.push({ kind: 'url', spec: m[1] ?? '' });
  }
  return out;
}

const inZone = (rel: string) => {
  const pkg = pkgOf(rel);
  return (
    pkg !== null &&
    (ZONE_PACKAGES as readonly string[]).includes(pkg) &&
    rel.startsWith(`packages/${pkg}/src/`)
  );
};

/** 返回每一处违规的说法；空数组 = 边界没破。 */
export function boundaryProblems(facts: BoundaryFacts): string[] {
  const out: string[] = [];
  const seenBare = new Set<string>();
  const seenCross = new Set<string>();
  const key = (file: string, spec: string) => `${file}\u0000${spec}`;
  const allowedBare = new Set(facts.allowedBare.map((a) => key(a.file, a.spec)));
  const allowedCross = new Set(facts.allowedCross.map((a) => key(a.file, a.spec)));

  for (const f of facts.files) {
    const pkg = pkgOf(f.rel);
    if (pkg === null) continue;
    const single = (SINGLE_FILE_SCRIPTS as readonly string[]).includes(f.rel);
    for (const ref of refsIn(f.text)) {
      const bare = ref.kind === 'import' && ref.spec.startsWith(SCOPE);
      if (single && ref.kind === 'import' && !ref.spec.startsWith('node:')) {
        out.push(
          `${f.rel}：引了 '${ref.spec}'——这个文件被另一个系统用户的 node 当单文件脚本跑，只许 import node: 内置`,
        );
        continue;
      }
      if (bare) {
        const k = key(f.rel, ref.spec.split('/').slice(0, 2).join('/'));
        if (inZone(f.rel)) {
          if (allowedBare.has(k)) seenBare.add(k);
          else
            out.push(
              `${f.rel}：import '${ref.spec}'——零安装区（没有 node_modules 的环境）不许引包名；真要引，先在 package-boundaries.test.ts 的 ALLOWED_BARE 里登记理由`,
            );
        }
        continue;
      }
      if (!ref.spec.startsWith('.')) continue;
      const target = posix.normalize(posix.join(posix.dirname(f.rel), ref.spec));
      const targetPkg = pkgOf(`${target}/`);
      if (targetPkg === null || targetPkg === pkg) continue; // 包内、或出了 packages/（agents/、仓根文件）：不算跨包
      const k = key(f.rel, ref.spec);
      if (!allowedCross.has(k)) {
        out.push(
          `${f.rel}：跨包相对路径 '${ref.spec}' → ${target}，没在 ALLOWED_CROSS 里登记；能走包的 exports 就走 exports，走不了（零安装）就登记理由`,
        );
        continue;
      }
      seenCross.add(k);
      if (!facts.exists(target))
        out.push(`${f.rel}：登记的跨包路径 '${ref.spec}' 指向的 ${target} 不存在（目录挪了？）`);
      if (!(facts.deps[pkg] ?? []).includes(targetPkg)) {
        out.push(
          `packages/${pkg}/package.json：src 里用了 ${targetPkg} 的路径，却没声明依赖 @fleet-dao/${targetPkg}——CI 选测会漏掉它`,
        );
      }
    }
  }
  for (const a of facts.allowedBare) {
    if (!seenBare.has(key(a.file, a.spec)))
      out.push(`ALLOWED_BARE 登记的 ${a.file} 的 '${a.spec}' 已经不在文件里了：删掉这一条`);
  }
  for (const a of facts.allowedCross) {
    if (!seenCross.has(key(a.file, a.spec)))
      out.push(`ALLOWED_CROSS 登记的 ${a.file} 的 '${a.spec}' 已经不在文件里了：删掉这一条`);
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
export function repoBoundaryFacts(root: string): Pick<BoundaryFacts, 'files' | 'exists' | 'deps'> {
  const files: SrcFile[] = [];
  const deps: Record<string, string[]> = {};
  const nameToDir = new Map<string, string>();
  const pkgsDir = join(root, 'packages');
  const dirs = readdirSync(pkgsDir).filter((d) => statSync(join(pkgsDir, d)).isDirectory());
  const manifests = new Map<string, Record<string, unknown>>();
  for (const d of dirs) {
    const manifest = join(pkgsDir, d, 'package.json');
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error(`${manifest} 不是对象`);
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.name === 'string') nameToDir.set(rec.name, d);
    manifests.set(d, rec);
  }
  for (const d of dirs) {
    const rec = manifests.get(d) as Record<string, unknown>;
    const list: string[] = [];
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const block = rec[field];
      if (block === undefined) continue;
      if (typeof block !== 'object' || block === null)
        throw new Error(`packages/${d}/package.json 的 ${field} 不是对象`);
      for (const name of Object.keys(block)) {
        const dir = nameToDir.get(name);
        if (dir !== undefined) list.push(dir);
      }
    }
    deps[d] = list;
    const abs: string[] = [];
    try {
      walk(join(pkgsDir, d, 'src'), abs);
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
    }
    for (const file of abs) {
      files.push({ rel: relative(root, file).split('\\').join('/'), text: readFileSync(file, 'utf8') });
    }
  }
  return { files, deps, exists: (rel) => existsSync(join(root, rel)) };
}

describe('包边界：零安装区不引包名，跨包相对路径有名有姓', () => {
  it('真实仓里没有违规', () => {
    const real = repoBoundaryFacts(ROOT);
    expect(real.files.length).toBeGreaterThan(300); // 不是空扫一遍就算过
    expect(boundaryProblems({ ...real, allowedBare: ALLOWED_BARE, allowedCross: ALLOWED_CROSS })).toEqual([]);
  });

  const facts = (over: Partial<BoundaryFacts>): BoundaryFacts => ({
    files: [],
    exists: () => true,
    deps: {},
    allowedBare: [],
    allowedCross: [],
    ...over,
  });

  it('【故意造出的失败】零安装区里的三种引入形式都认得出：包名、import()、export … from', () => {
    for (const text of [
      "import { x } from '@fleet-dao/shared/util';",
      "const m = await import('@fleet-dao/shared');",
      "export { y } from '@fleet-dao/db';",
    ]) {
      const got = boundaryProblems(facts({ files: [{ rel: 'packages/hygiene/src/a.ts', text }] }));
      expect(got, text).toHaveLength(1);
      expect(got[0]).toContain('零安装区');
    }
  });

  it('非零安装区的包引包名没事；零安装区登记过的放行', () => {
    expect(
      boundaryProblems(
        facts({
          files: [{ rel: 'packages/engine/src/a.ts', text: "import { x } from '@fleet-dao/shared/util';" }],
        }),
      ),
    ).toEqual([]);
    expect(
      boundaryProblems(
        facts({
          files: [{ rel: 'packages/conventions/src/a.ts', text: "import { x } from '@fleet-dao/shared';" }],
          allowedBare: [{ file: 'packages/conventions/src/a.ts', spec: '@fleet-dao/shared', why: 't' }],
        }),
      ),
    ).toEqual([]);
  });

  it('【故意造出的失败】单文件脚本（bridge.ts）只许 node: 内置：相对 import 也红', () => {
    const rel = 'packages/adapters/src/mirasim/bridge.ts';
    const got = boundaryProblems(
      facts({
        files: [
          { rel, text: "import { readFile } from 'node:fs/promises';\nimport { x } from './wire.ts';" },
        ],
      }),
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toContain('单文件脚本');
  });

  it('【故意造出的失败】跨包相对路径：没登记红、登记了但没声明依赖红、目标不存在红、登记了文件里已经没有也红', () => {
    const rel = 'packages/a/src/x.ts';
    const text =
      "import { w } from '../../b/src/w.ts';\nconst u = new URL('../../c/bin/run', import.meta.url);";
    const unlisted = boundaryProblems(facts({ files: [{ rel, text }], deps: { a: ['b', 'c'] } }));
    expect(unlisted).toHaveLength(2);
    for (const s of unlisted) expect(s).toContain('没在 ALLOWED_CROSS 里登记');

    const allowed: Allowed[] = [
      { file: rel, spec: '../../b/src/w.ts', why: 't' },
      { file: rel, spec: '../../c/bin/run', why: 't' },
    ];
    expect(
      boundaryProblems(facts({ files: [{ rel, text }], deps: { a: ['b', 'c'] }, allowedCross: allowed })),
    ).toEqual([]);

    const noDep = boundaryProblems(
      facts({ files: [{ rel, text }], deps: { a: ['b'] }, allowedCross: allowed }),
    );
    expect(noDep).toHaveLength(1);
    expect(noDep[0]).toContain('没声明依赖 @fleet-dao/c');

    const gone = boundaryProblems(
      facts({
        files: [{ rel, text }],
        deps: { a: ['b', 'c'] },
        allowedCross: allowed,
        exists: (p) => !p.startsWith('packages/c/'),
      }),
    );
    expect(gone).toHaveLength(1);
    expect(gone[0]).toContain('不存在');

    const stale = boundaryProblems(
      facts({
        files: [{ rel, text: "import { w } from '../../b/src/w.ts';" }],
        deps: { a: ['b', 'c'] },
        allowedCross: allowed,
      }),
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain('已经不在文件里了');
  });

  it('包内相对路径、指向 agents/ 或仓根文件的不算跨包；注释里提到包名、路径不算引用', () => {
    const rel = 'packages/a/src/x.ts';
    const text = [
      "import { l } from './local.ts';",
      "import { s } from '../sibling/s.ts';",
      "const hook = new URL('../../../agents/hooks/pretool.mjs', import.meta.url);",
      "const log = new URL('../../../CHANGELOG.md', import.meta.url);",
      "// import { x } from '@fleet-dao/shared'; 以及 '../../b/src/w.ts'",
      "/* from '@fleet-dao/db' */",
    ].join('\n');
    expect(boundaryProblems(facts({ files: [{ rel: 'packages/hygiene/src/x.ts', text }] }))).toEqual([]);
    expect(boundaryProblems(facts({ files: [{ rel, text }] }))).toEqual([]);
  });

  it('package.json 读不到或认不出时抛错，不当成没有依赖', () => {
    expect(() => repoBoundaryFacts(join(ROOT, '没有这个目录'))).toThrow();
  });
});
