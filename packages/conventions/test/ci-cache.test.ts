// PR 的测试结果缓存（src/ci-cache.ts）：键盖没盖住输入、清单怎么核对、什么情况一律回来真跑。
// 带【故意造出的失败】的几条，每一条都是「造一份坏的输入，判定器必须拒」：平时都绿，看不出判定器还在不在拦，所以得造一次坏的看它红。
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  boxUnits,
  CACHE_SCHEMA,
  CACHE_SUBDIR,
  CacheError,
  checkedFiles,
  computeKey,
  type EnvIdentity,
  EXTERNAL_INPUT_DIRS,
  EXTERNAL_INPUT_FILES,
  fsHashFs,
  type HashFs,
  isWholeRepoInput,
  keyCovers,
  keyFromParts,
  keyRoots,
  MANIFEST_FILE,
  type Manifest,
  makeHasher,
  parseManifest,
  passedFiles,
  relativeToRoot,
  selectToRun,
  sourceClosure,
  stepKey,
  stepPlan,
  stepRecord,
  UNIVERSAL_PACKAGES,
} from '../src/ci-cache.ts';
import {
  assignTests,
  FIXTURE_PATH,
  PATH_RULES,
  type PackageGraph,
  planCi,
  ROOT_CONFIG_FILES,
  readGraph,
} from '../src/ci-plan.ts';
import { fsRepo } from '../src/repo.ts';
import { listTestFiles, parseTimings, TIMINGS_FILE } from '../src/test-split.ts';
import { runChild } from './child.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// ---- 假的仓：键是路径，值是内容；列目录从路径里推

function memFs(files: Record<string, string>): HashFs & { set(path: string, text: string): void } {
  const m = new Map(Object.entries(files));
  return {
    set: (path, text) => void m.set(path, text),
    bytes: (rel) => (m.has(rel) ? Buffer.from(m.get(rel) as string) : undefined),
    list(rel) {
      const prefix = rel === '' ? '' : `${rel}/`;
      const names = new Set<string>();
      for (const p of m.keys())
        if (p.startsWith(prefix) && p !== rel) names.add(p.slice(prefix.length).split('/')[0] as string);
      return names.size === 0 ? undefined : [...names];
    },
  };
}

const GRAPH: PackageGraph = {
  deps: {
    shared: [],
    core: ['shared'],
    web: ['shared'],
    db: ['shared'],
    api: ['db', 'shared'],
    feishu: ['shared'],
    conventions: ['shared'],
    engine: ['api', 'conventions', 'db'],
    cli: ['shared'],
    other: ['shared'],
  },
};

const BASE_FILES: Record<string, string> = {
  ...Object.fromEntries(ROOT_CONFIG_FILES.map((f) => [f, `root ${f}`])),
  'AGENTS.md': 'agents-md',
  'docs/ops.md': 'ops',
  'docs/PROGRESS.md': 'progress',
  '.github/pull_request_template.md': 'tpl',
  '.github/workflows/ci.yml': 'ci',
  '.gitignore': 'ignore',
  '.githooks/pre-push': 'hook',
  'deploy/lib/common.sh': 'common',
  'agents/hooks/pretool.mjs': 'pretool',
  'agents/test/skills.test.ts': 'agents-test',
};
for (const p of Object.keys(GRAPH.deps)) {
  BASE_FILES[`packages/${p}/package.json`] = `{"name":"@fleet-dao/${p}"}`;
  BASE_FILES[`packages/${p}/src/index.ts`] = `src ${p}`;
  BASE_FILES[`packages/${p}/test/index.test.ts`] = `test ${p}`;
}
BASE_FILES['packages/web/test/fixtures/a.json'] = 'fixture-a';
BASE_FILES['node_modules/vitest/package.json'] = '{"version":"5.0.1"}';

const ENV: EnvIdentity = {
  node: 'v22.22.0',
  platform: 'linux-x64',
  image: '20261001.1',
  vitest: '5.0.1',
  pg: false,
  temporal: 'no-cli:none',
  day: '2026-10-03',
};

const testsOf = (unit: string) => [`packages/${unit}/test/index.test.ts`];
const keyOf = (opts: {
  files?: Record<string, string>;
  /** 这一台分到的文件（默认 api 的那一个）。 */
  box?: string[];
  env?: Partial<EnvIdentity>;
  after?: (fs: ReturnType<typeof memFs>) => void;
}) => {
  const fs = memFs({ ...BASE_FILES, ...opts.files });
  opts.after?.(fs);
  return computeKey({
    fs,
    graph: GRAPH,
    box: opts.box ?? testsOf('api'),
    env: { ...ENV, ...opts.env },
  });
};

describe('这一台的文件清单：只认测试文件，别的不猜', () => {
  it('单元从文件来：packages/<包>、agents', () => {
    expect(
      boxUnits(['packages/api/test/a.test.ts', 'agents/test/x.test.ts', 'packages/api/src/b.test.ts']),
    ).toEqual(['agents', 'api']);
  });

  it('【故意造出的失败】空清单、不是测试文件、重复、单元不在依赖图里：抛错（调用方全跑），不当成没有', () => {
    for (const bad of [
      [],
      ['packages/api/src/index.ts'],
      ['packages/api/'],
      ['--watch'],
      ['docs/a.test.ts'],
      ['packages/api/test/a.test.ts', 'packages/api/test/a.test.ts'],
    ]) {
      expect(() => boxUnits(bad), bad.join(' ')).toThrow(CacheError);
    }
    expect(() => checkedFiles(GRAPH, ['packages/nope/test/a.test.ts'])).toThrow(CacheError);
    expect(checkedFiles(GRAPH, ['packages/db/test/b.test.ts', 'packages/api/test/a.test.ts'])).toEqual([
      'packages/api/test/a.test.ts',
      'packages/db/test/b.test.ts',
    ]);
  });

  it('源码闭包：单元自己 + 向下依赖 + TEST_READS（api 读 web、db 读 core、agents 读 db），不往上、不顺依赖往下传 TEST_READS', () => {
    expect(sourceClosure(GRAPH, ['api'])).toEqual(['api', 'db', 'shared', 'web']);
    expect(sourceClosure(GRAPH, ['db'])).toEqual(['core', 'db', 'shared']);
    expect(sourceClosure(GRAPH, ['cli'])).toEqual(['cli', 'shared']);
    // engine 依赖 api，但 api 读 web 是 api 测试自己的事：engine 的闭包里不带 web
    expect(sourceClosure(GRAPH, ['engine'])).not.toContain('web');
    // agents 不在依赖图里，但 agents/test/france.test.ts 直接读 shared 的源码：shared 每一组都带（UNIVERSAL_PACKAGES）；
    // agents/test/worker.test.ts 读 db 的路由骨架（TEST_READS）。db 读 core 是 db 测试自己的事：agents 的闭包里不带 core
    expect(sourceClosure(GRAPH, ['agents'])).toEqual(['agents-sync', 'db', 'shared']);
  });

  it('UNIVERSAL_PACKAGES 对得上 ci-plan.ts：PATH_RULES 里这些包一改就是全跑', () => {
    const real = readGraph(fsRepo(ROOT));
    if (typeof real === 'string') throw new Error(real);
    for (const p of UNIVERSAL_PACKAGES) {
      const plan = planCi({ event: 'pull_request', changed: [`packages/${p}/src/x.ts`], graph: real });
      expect(plan.full, p).toBe(true);
      expect(plan.reasons.join(), p).toContain(`packages/${p}/src/x.ts`);
    }
    expect(UNIVERSAL_PACKAGES).toEqual(['shared']);
  });

  /** 仓里真有的每个文件：PATH_RULES 说「改它要测什么」（全跑、或指定了单元）的，键必须盖住（从规则反推，不是手写清单）。 */
  const ruleMisses = (cover: typeof keyCovers) => {
    const real = readGraph(fsRepo(ROOT));
    if (typeof real === 'string') throw new Error(real);
    const all = makeHasher(fsHashFs(ROOT)).filesUnder('') ?? [];
    expect(all.length, '真仓里一个文件都没列出来：这条查的东西不存在').toBeGreaterThan(500);
    const roots = keyRoots(['cli'], sourceClosure(real, ['cli']));
    return all.filter((f) => {
      if (f.startsWith('packages/') && !f.startsWith('packages/shared/') && !FIXTURE_PATH.test(f))
        return false;
      const rule = PATH_RULES.find((r) => r.match(f));
      return rule !== undefined && ('full' in rule || rule.units.length > 0) && !cover(roots, f);
    });
  };

  it('PATH_RULES 说会触发测试的包外文件（根配置、工作流、shared、夹具、deploy/、AGENTS.md、agents/、ops.md、模板……），键都盖住', () => {
    expect(ruleMisses(keyCovers)).toEqual([]);
  });

  it('【故意造出的失败】键少盖 AGENTS.md 和 .githooks/：从规则反推必须正好报出这两处，不多不少', () => {
    const cut: typeof keyCovers = (roots, path) =>
      keyCovers(
        {
          ...roots,
          files: roots.files.filter((f) => f !== 'AGENTS.md'),
          dirs: roots.dirs.filter((d) => d !== '.githooks'),
        },
        path,
      );
    const missed = ruleMisses(cut);
    expect(missed).toContain('AGENTS.md');
    expect(
      missed.every((f) => f === 'AGENTS.md' || f.startsWith('.githooks/')),
      missed.join(),
    ).toBe(true);
    expect(missed.some((f) => f.startsWith('.githooks/'))).toBe(true);
  });
});

describe('键：盖住测试的全部输入，不相干的不变', () => {
  const base = keyOf({}).key;

  it('同样的输入同一个键（确定）', () => {
    expect(keyOf({}).key).toBe(base);
  });

  it('被测单元、向下依赖、TEST_READS 读的包的源码变了：键变', () => {
    expect(keyOf({ files: { 'packages/api/src/index.ts': 'changed' } }).key).not.toBe(base);
    expect(keyOf({ files: { 'packages/db/src/index.ts': 'changed' } }).key).not.toBe(base);
    expect(keyOf({ files: { 'packages/shared/src/index.ts': 'changed' } }).key).not.toBe(base);
    expect(keyOf({ files: { 'packages/web/src/index.ts': 'changed' } }).key, 'api 读 web').not.toBe(base);
    // 闭包里的包新增文件（不只是改内容）也算
    expect(keyOf({ files: { 'packages/db/src/new.ts': 'x' } }).key).not.toBe(base);
  });

  it('不相干的包、不读的文档变了：键不变（命中率的来源）', () => {
    for (const f of ['packages/cli/src/index.ts', 'packages/engine/src/index.ts', 'docs/PROGRESS.md']) {
      expect(keyOf({ files: { [f]: 'changed' } }).key, f).toBe(base);
    }
  });

  it('根配置、AGENTS.md、docs/ops.md、PR 模板、.gitignore、工作流、deploy、agents、推前钩子、夹具变了：键变', () => {
    const touched = [
      ...EXTERNAL_INPUT_FILES,
      ...EXTERNAL_INPUT_DIRS.map((d) => `${d}/new-file`),
      'packages/web/test/fixtures/a.json',
      'packages/cli/test/sub/fixtures/b.json',
    ];
    for (const f of touched) expect(keyOf({ files: { [f]: 'changed!' } }).key, f).not.toBe(base);
  });

  it('环境身份的每一项变了：键变（node、系统、镜像、vitest、真 Postgres、Temporal 命令行、日期）', () => {
    const change: Partial<EnvIdentity>[] = [
      { node: 'v22.23.0' },
      { platform: 'linux-arm64' },
      { image: '20261002.1' },
      { vitest: '5.0.2' },
      { pg: true },
      { temporal: 'cli:1.2.3 abc' },
      { day: '2026-10-04' },
    ];
    for (const c of change) expect(keyOf({ env: c }).key, JSON.stringify(c)).not.toBe(base);
  });

  it('这一台分到的文件变了（多一个、少一个、换一个）、文件内容变了：键变', () => {
    const two = [...testsOf('api'), 'packages/db/test/index.test.ts'];
    expect(keyOf({ box: two }).key).not.toBe(base);
    expect(keyOf({ box: ['packages/db/test/index.test.ts'] }).key).not.toBe(base);
    expect(keyOf({ files: { 'packages/api/test/index.test.ts': 'changed' } }).key).not.toBe(base);
    // 同一份清单换个顺序：键一样（装箱给的是排好序的，这里再排一次也不怕）
    expect(keyOf({ box: [...two].reverse() }).key).toBe(keyOf({ box: two }).key);
  });

  it('键的每一块（含 schema）变一个字，键都变；算键的代码自己的 schema 版本在里面', () => {
    const { parts } = keyOf({});
    expect(parts.schema).toBe(String(CACHE_SCHEMA));
    const k = keyFromParts(parts);
    expect(k).toBe(base);
    for (const name of Object.keys(parts)) {
      expect(keyFromParts({ ...parts, [name]: `${parts[name]}x` }), name).not.toBe(k);
    }
    expect(keyFromParts({ ...parts, extra: 'x' })).not.toBe(k);
  });

  it('conventions 那一组：别的包的测试文件、package.json 变了键也变（ci-plan.test.ts 的扫描器通读全仓测试）；别的组不受影响', () => {
    const conv = (files: Record<string, string>) => keyOf({ box: testsOf('conventions'), files }).key;
    const baseConv = conv({});
    expect(conv({ 'packages/cli/test/index.test.ts': 'a test that reads outside' })).not.toBe(baseConv);
    expect(conv({ 'packages/cli/test/brand-new.test.ts': 'x' })).not.toBe(baseConv);
    expect(conv({ 'packages/cli/package.json': '{"name":"@fleet-dao/cli","x":1}' })).not.toBe(baseConv);
    expect(conv({ 'agents/test/skills.test.ts': 'changed' })).not.toBe(baseConv);
    // 只改别的包的非测试源码：不变
    expect(conv({ 'packages/cli/src/index.ts': 'changed' })).toBe(baseConv);
    // 非 conventions 的组不盖全仓测试
    expect(keyOf({ files: { 'packages/cli/test/index.test.ts': 'changed' } }).key).toBe(base);
    expect(isWholeRepoInput('packages/cli/test/x.test.ts')).toBe(true);
    expect(isWholeRepoInput('packages/cli/src/x.ts')).toBe(false);
  });

  it('keyCovers 和 computeKey 说的是一回事：覆盖的路径改了键变、没覆盖的不变', () => {
    const units = ['api'];
    const roots = keyRoots(units, sourceClosure(GRAPH, units));
    const probes = [
      'packages/api/src/index.ts',
      'packages/web/src/index.ts',
      'packages/cli/src/index.ts',
      'AGENTS.md',
      'docs/ops.md',
      'docs/PROGRESS.md',
      'deploy/lib/common.sh',
      'packages/web/test/fixtures/a.json',
    ];
    for (const p of probes) {
      const changed = keyOf({ files: { [p]: 'changed again' } }).key !== base;
      expect(changed, p).toBe(keyCovers(roots, p));
    }
  });

  it('【故意造出的失败】读不了的文件不当成没有：读盘抛错，整个算键抛出去（不缓存），不是悄悄少盖一块', () => {
    const fs = memFs(BASE_FILES);
    const bad: HashFs = {
      list: fs.list,
      bytes(rel) {
        if (rel === 'AGENTS.md') throw new Error('EACCES');
        return fs.bytes(rel);
      },
    };
    expect(() => computeKey({ fs: bad, graph: GRAPH, box: testsOf('api'), env: ENV })).toThrow('EACCES');
    // 这一台一个测试文件都没有：抛，不拿空集算出一个键
    expect(() => keyOf({ box: [] })).toThrow(CacheError);
    // 分到的文件读不到
    expect(() => keyOf({ box: ['packages/api/test/ghost.test.ts'] })).toThrow(CacheError);
  });

  it('真读盘：不存在是 undefined，目录当目录；全跑那一版装出来的每一台在真仓上都能算出键、各不相同', () => {
    const fs = fsHashFs(ROOT);
    expect(fs.bytes('没有这个文件.txt')).toBeUndefined();
    expect(fs.list('没有这个目录')).toBeUndefined();
    expect(fs.list('packages')).toContain('conventions');
    expect(fs.list('packages/conventions/package.json')).toBeUndefined();
    expect(Buffer.from(fs.bytes('package.json') as Uint8Array).toString('utf8')).toContain('fleet-dao');
    const real = readGraph(fsRepo(ROOT));
    if (typeof real === 'string') throw new Error(real);
    const repo = fsRepo(ROOT);
    const r = assignTests(planCi({ event: 'push', changed: [], graph: real }), {
      all: listTestFiles(repo),
      timings: parseTimings(repo.read(TIMINGS_FILE)),
      read: (rel) => repo.read(rel),
    });
    if (typeof r === 'string') throw new Error(r);
    const keys = r.plan.tests.map((t) => computeKey({ fs, graph: real, box: t.files, env: ENV }).key);
    expect(keys.length).toBeGreaterThan(1);
    expect(new Set(keys).size, '每一台的键不一样（分到的文件不同）').toBe(keys.length);
  });
});

// ---- 清单

const SHA = (c: string) => c.repeat(64);
const KEY = SHA('a');
const BOX = ['packages/api/test/a.test.ts', 'packages/api/test/b.test.ts'];
const collected = { 'packages/api/test/a.test.ts': SHA('1'), 'packages/api/test/b.test.ts': SHA('2') };
const manifest = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: CACHE_SCHEMA,
    complete: true,
    key: KEY,
    box: BOX,
    files: {
      'packages/api/test/a.test.ts': { sha: SHA('1'), status: 'passed' },
      'packages/api/test/b.test.ts': { sha: SHA('2'), status: 'passed' },
    },
    ...over,
  });
const select = (
  manifestText: string | undefined,
  c: Record<string, string> = collected,
  box: string[] = Object.keys(c).sort(),
) => selectToRun({ collected: c, key: KEY, box, manifestText });
const ALL = Object.keys(collected);

describe('清单：命中了也不信键，逐个文件核对', () => {
  it('每个文件都盖住：none（不跑 vitest）', () => {
    expect(select(manifest())).toMatchObject({ mode: 'none', run: [], covered: ALL });
  });

  it('【故意造出的失败】内容变了不许跳：清单里是旧哈希，这个文件必须跑，别的不受影响', () => {
    const changed = { ...collected, 'packages/api/test/b.test.ts': SHA('9') };
    const s = select(manifest(), changed);
    expect(s.mode).toBe('files');
    expect(s.run).toEqual(['packages/api/test/b.test.ts']);
    expect(s.covered).toEqual(['packages/api/test/a.test.ts']);
    expect(s.why).toContain('哈希对不上');
    // 全都变了：一个都盖不住，全跑
    const allChanged = { 'packages/api/test/a.test.ts': SHA('8'), 'packages/api/test/b.test.ts': SHA('9') };
    expect(select(manifest(), allChanged)).toMatchObject({ mode: 'all', covered: [] });
  });

  it('【故意造出的失败】清单坏了必须全跑：没有、空、不是 JSON、不是对象、schema 不对、字段缺、哈希不像哈希', () => {
    const broken: [string, string | undefined][] = [
      ['没有清单', undefined],
      ['空', ''],
      ['不是 JSON', '{'],
      ['数组', '[]'],
      ['null', 'null'],
      ['schema 不对', manifest({ schema: CACHE_SCHEMA + 1 })],
      ['没有 schema', manifest({ schema: undefined })],
      ['没有 key', manifest({ key: undefined })],
      ['key 不像哈希', manifest({ key: 'abc' })],
      ['没有文件清单', manifest({ box: undefined })],
      ['文件清单是空的', manifest({ box: [] })],
      ['文件清单里有非字符串', manifest({ box: [1] })],
      ['没有文件表', manifest({ files: undefined })],
      ['文件表是数组', manifest({ files: [] })],
      ['文件表是空的', manifest({ files: {} })],
      ['文件没哈希', manifest({ files: { 'packages/api/test/a.test.ts': { status: 'passed' } } })],
      [
        '哈希不像哈希',
        manifest({ files: { 'packages/api/test/a.test.ts': { sha: 'x', status: 'passed' } } }),
      ],
      ['文件是 null', manifest({ files: { 'packages/api/test/a.test.ts': null } })],
    ];
    for (const [what, text] of broken) {
      const s = select(text);
      expect(s.mode, what).toBe('all');
      expect(s.run, what).toEqual(ALL);
      expect(s.covered, what).toEqual([]);
    }
    expect(typeof parseManifest('{')).toBe('string');
    expect(typeof parseManifest(manifest())).toBe('object');
  });

  it('清单里的键、文件清单和这一台不一样：全跑（缓存是别的输入跑出来的）', () => {
    expect(select(manifest({ key: SHA('b') })).mode).toBe('all');
    expect(select(manifest({ box: ['packages/api/test/a.test.ts'] })).mode).toBe('all');
  });

  it('【故意造出的失败】清单不 complete、或文件不在清单里，必须跑：新增的测试文件一定跑', () => {
    for (const complete of [false, undefined, 'true', 1, null]) {
      expect(select(manifest({ complete })), String(complete)).toMatchObject({ mode: 'all', run: ALL });
    }
    // 这一台多分到一个新文件：文件清单和上一轮不同，整台全跑（新文件当然在里面）
    const withNew = { ...collected, 'packages/api/test/new.test.ts': SHA('3') };
    const s = select(manifest(), withNew);
    expect(s.mode).toBe('all');
    expect(s.run).toContain('packages/api/test/new.test.ts');
    // 清单和这一台对得上、可清单里漏了某个文件（被改过的清单）：漏的那个一定跑
    const partial = manifest({
      files: { 'packages/api/test/a.test.ts': { sha: SHA('1'), status: 'passed' } },
    });
    expect(select(partial)).toMatchObject({ mode: 'files', run: ['packages/api/test/b.test.ts'] });
    // 这一台一个文件都没有：全跑（空集不是「全盖住了」）
    expect(select(manifest(), {}, BOX)).toMatchObject({ mode: 'all', run: [] });
  });

  it('【故意造出的失败】假清单里塞一个从没跑成的，不许算覆盖：标 failed / skipped / 没标，整份清单不信、全跑', () => {
    for (const status of ['failed', 'skipped', 'pending', undefined, true]) {
      const fake = manifest({
        files: {
          'packages/api/test/a.test.ts': { sha: SHA('1'), status: 'passed' },
          'packages/api/test/b.test.ts': { sha: SHA('2'), status },
        },
      });
      const s = select(fake);
      expect(s.mode, String(status)).toBe('all');
      expect(s.covered, String(status)).not.toContain('packages/api/test/b.test.ts');
    }
  });
});

describe('一轮的三步：key → plan → record', () => {
  const key = (over: Partial<Parameters<typeof stepKey>[0]> = {}) =>
    stepKey({
      event: 'pull_request',
      box: testsOf('api'),
      label: '2/5 · pg',
      fs: memFs(BASE_FILES),
      graph: GRAPH,
      env: () => ENV,
      ...over,
    });

  it('正常：键、缓存键名（带台名）、交接文件里有这一台的文件和哈希', () => {
    const k = key();
    if (!k.enabled) throw new Error(k.why);
    expect(k.cacheKey).toBe(`ci-test-v${CACHE_SCHEMA}-2-5-pg-${k.key}`);
    expect(Object.keys(k.state.collected)).toEqual(testsOf('api'));
    expect(k.state.box).toEqual(testsOf('api'));
    expect(k.state.mode).toBe('all');
  });

  it('文件就是矩阵给的那份：几台各算各的键，不重不漏（不再自己模仿 vitest 的 --shard 去猜一台跑哪些）', () => {
    const names = Array.from({ length: 7 }, (_, i) => `packages/api/test/t${i}.test.ts`);
    const fs = memFs({ ...BASE_FILES, ...Object.fromEntries(names.map((n) => [n, `body ${n}`])) });
    const boxes = [names.slice(0, 3), names.slice(3, 5), names.slice(5)];
    const per = boxes.map((box) => {
      const k = key({ fs, box });
      if (!k.enabled) throw new Error(k.why);
      return k;
    });
    expect(per.flatMap((k) => Object.keys(k.state.collected)).sort()).toEqual([...names].sort());
    expect(new Set(per.map((k) => k.key)).size).toBe(3);
  });

  it('【故意造出的失败】主线推送（和别的非 PR 事件）：三步都不缓存、测试全跑、不写清单——哪怕手边有一份完美的清单', () => {
    for (const event of ['push', 'workflow_dispatch', 'merge_group', 'schedule', '']) {
      const k = key({ event });
      expect(k.enabled, event).toBe(false);
      // 清单、交接文件都是真的、完美的：照样全跑
      const real = key();
      if (!real.enabled) throw new Error(real.why);
      const perfect = JSON.stringify({
        schema: CACHE_SCHEMA,
        complete: true,
        key: real.key,
        box: real.state.box,
        files: Object.fromEntries(
          Object.entries(real.state.collected).map(([f, sha]) => [f, { sha, status: 'passed' }]),
        ),
      });
      const p = stepPlan({ event, stateText: JSON.stringify(real.state), manifestText: perfect });
      expect(p.mode, event).toBe('all');
      expect(p.state, event).toBeUndefined();
      const r = stepRecord({
        event,
        stateText: JSON.stringify(real.state),
        reportText: JSON.stringify(report(Object.keys(real.state.collected), 'passed')),
        root: '/r',
      });
      expect(r, event).toHaveProperty('why');
    }
  });

  it('算不出就不开：依赖图读不出、清单认不出、空清单、单元不在依赖图里、环境认不出：enabled=false，带原因', () => {
    expect(key({ graph: '读不到 packages/b/package.json' })).toMatchObject({ enabled: false });
    expect(key({ box: ['--watch'] })).toMatchObject({ enabled: false });
    expect(key({ box: [] })).toMatchObject({ enabled: false });
    expect(key({ box: ['packages/nope/test/a.test.ts'] })).toMatchObject({
      enabled: false,
      why: expect.stringContaining('依赖图里没有这个单元'),
    });
    expect(
      key({
        env: () => {
          throw new CacheError('读不到 vitest 版本');
        },
      }),
    ).toMatchObject({ enabled: false });
    // CacheError 以外的错（代码写错了）不吞：往上抛，入口会打 ::warning:: 再全跑
    expect(() =>
      key({
        env: () => {
          throw new TypeError('bug');
        },
      }),
    ).toThrow('bug');
  });

  /** 一次完整的「第一轮跑、第二轮命中」：用同一份假仓。 */
  function firstRound() {
    const k = key();
    if (!k.enabled) throw new Error(k.why);
    const plan1 = stepPlan({
      event: 'pull_request',
      stateText: JSON.stringify(k.state),
      manifestText: undefined,
    });
    expect(plan1.mode).toBe('all');
    const rec = stepRecord({
      event: 'pull_request',
      stateText: JSON.stringify(plan1.state),
      reportText: JSON.stringify(report(testsOf('api'), 'passed')),
      root: '/r',
    });
    if (!('manifest' in rec)) throw new Error(rec.why);
    return { k, manifest: rec.manifest };
  }

  it('第一轮没清单：全跑、全绿后写清单（complete）；第二轮同样输入：命中、不跑', () => {
    const { k, manifest: m } = firstRound();
    expect(m).toMatchObject({ schema: CACHE_SCHEMA, complete: true, key: k.key, box: testsOf('api') });
    const k2 = key();
    if (!k2.enabled) throw new Error(k2.why);
    expect(k2.key).toBe(k.key);
    const plan2 = stepPlan({
      event: 'pull_request',
      stateText: JSON.stringify(k2.state),
      manifestText: JSON.stringify(m),
    });
    expect(plan2.mode).toBe('none');
    // 命中的一轮没有跑测试：不写清单（也没有报告）
    expect(
      stepRecord({
        event: 'pull_request',
        stateText: JSON.stringify(plan2.state),
        reportText: undefined,
        root: '/r',
      }),
    ).toHaveProperty('why');
  });

  it('第二轮源码变了：键变，上一轮的清单对不上，全跑', () => {
    const { manifest: m } = firstRound();
    const fs = memFs({ ...BASE_FILES, 'packages/api/src/index.ts': 'changed' });
    const k2 = key({ fs });
    if (!k2.enabled) throw new Error(k2.why);
    const plan2 = stepPlan({
      event: 'pull_request',
      stateText: JSON.stringify(k2.state),
      manifestText: JSON.stringify(m),
    });
    expect(plan2.mode).toBe('all');
    expect(plan2.why).toContain('键');
  });

  it('files 模式：要跑的就是清单没盖住的那几个（这一台分到的文件本身），交接文件记下盖住的和要跑的', () => {
    const state = {
      schema: CACHE_SCHEMA,
      key: KEY,
      box: BOX,
      collected: { ...collected, 'packages/api/test/b.test.ts': SHA('9') },
      mode: 'all',
      covered: [],
      run: BOX,
    };
    const p = stepPlan({ event: 'pull_request', stateText: JSON.stringify(state), manifestText: manifest() });
    expect(p).toMatchObject({ mode: 'files', run: ['packages/api/test/b.test.ts'] });
    expect(p.state).toMatchObject({
      mode: 'files',
      covered: ['packages/api/test/a.test.ts'],
      run: ['packages/api/test/b.test.ts'],
    });
  });

  it('交接文件坏了（没有、不是 JSON、字段缺）：plan 全跑、record 不写', () => {
    for (const text of [undefined, '', '{', '[]', JSON.stringify({ schema: CACHE_SCHEMA })]) {
      expect(stepPlan({ event: 'pull_request', stateText: text, manifestText: manifest() }).mode).toBe('all');
      expect(
        stepRecord({ event: 'pull_request', stateText: text, reportText: '{}', root: '/r' }),
      ).toHaveProperty('why');
    }
  });
});

// ---- 写清单：只在整组全绿

const report = (files: string[], status: string, over: Record<string, unknown> = {}) => ({
  success: true,
  numFailedTests: 0,
  numFailedTestSuites: 0,
  testResults: files.map((f) => ({
    name: `/r/${f}`,
    status,
    assertionResults: [{ status }],
  })),
  ...over,
});

describe('写清单：整组全绿才写，每个文件都要有「跑成了」的记录', () => {
  const state = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema: CACHE_SCHEMA,
      key: KEY,
      box: BOX,
      collected,
      mode: 'all',
      covered: [],
      run: ALL,
      ...over,
    });
  const record = (rep: unknown, st = state()) =>
    stepRecord({ event: 'pull_request', stateText: st, reportText: JSON.stringify(rep), root: '/r' });

  it('全绿：每个文件都在报告里标了 passed → 写出 complete 的清单，哈希是收到时那一份', () => {
    const r = record(report(ALL, 'passed'));
    if (!('manifest' in r)) throw new Error(r.why);
    expect(r.manifest).toMatchObject({ complete: true, key: KEY, box: BOX });
    expect(r.manifest.files['packages/api/test/a.test.ts']).toEqual({ sha: SHA('1'), status: 'passed' });
    expect(parseManifest(JSON.stringify(r.manifest))).toEqual(r.manifest);
  });

  it('【故意造出的失败】报告里有一个没跑成（failed、skipped、没出现），不写清单：不标 complete，下一轮全跑', () => {
    const failed = report(ALL, 'passed', { success: false, numFailedTests: 1 });
    expect(record(failed)).toHaveProperty('why');
    for (const bad of ['failed', 'skipped']) {
      const rep = report(ALL, 'passed');
      rep.testResults[1] = { name: `/r/${ALL[1]}`, status: bad, assertionResults: [{ status: bad }] };
      expect(record(rep), bad).toHaveProperty('why');
    }
    // 一个文件根本不在报告里（vitest 没跑它）
    expect(record(report([ALL[0] as string], 'passed'))).toHaveProperty('why');
    // 文件状态是 passed、但没有一条用例真的跑过（全跳过的文件）
    const hollow = report(ALL, 'passed');
    hollow.testResults[0] = {
      name: `/r/${ALL[0]}`,
      status: 'passed',
      assertionResults: [{ status: 'skipped' }],
    };
    expect(record(hollow)).toHaveProperty('why');
  });

  it('【故意造出的失败】报告读不出（没有、不是 JSON、没有 testResults、有认不出的一条）：不写', () => {
    for (const text of [
      undefined,
      '',
      '{',
      '{}',
      JSON.stringify({ ...report(ALL, 'passed'), testResults: [{}] }),
    ]) {
      expect(
        stepRecord({ event: 'pull_request', stateText: state(), reportText: text, root: '/r' }),
        String(text),
      ).toHaveProperty('why');
    }
  });

  it('files 模式：核对过的（covered）加这一轮跑成的，合起来盖住全集才写；少一个不写', () => {
    const files = { ...collected, 'packages/api/test/new.test.ts': SHA('3') };
    const st = state({
      collected: files,
      mode: 'files',
      covered: ALL,
      run: ['packages/api/test/new.test.ts'],
    });
    const r = record(report(['packages/api/test/new.test.ts'], 'passed'), st);
    if (!('manifest' in r)) throw new Error(r.why);
    expect(Object.keys(r.manifest.files).sort()).toEqual(Object.keys(files).sort());
    // 要跑的那个没跑成：不写，covered 的也不会替它顶
    expect(record(report([], 'passed'), st)).toHaveProperty('why');
    // 不在 covered 也不在 run 的文件（交接文件被改过）：不写
    expect(record(report(ALL, 'passed'), state({ collected: files, run: ALL }))).toHaveProperty('why');
  });

  it('passedFiles / relativeToRoot：绝对路径转仓内相对（Windows 反斜杠也认），不在仓里的不算', () => {
    expect(relativeToRoot('D:\\x\\repo', 'D:\\x\\repo\\packages\\a.ts')).toBe('packages/a.ts');
    expect(relativeToRoot('/r/', '/r/packages/a.ts')).toBe('packages/a.ts');
    expect(relativeToRoot('/r', '/rr/a.ts')).toBeUndefined();
    const r = passedFiles(JSON.stringify(report([...ALL, 'x.test.ts'], 'passed')), '/r');
    if (typeof r === 'string') throw new Error(r);
    expect([...r.passed].sort()).toEqual([...ALL, 'x.test.ts'].sort());
    expect([...r.reported].sort()).toEqual([...ALL, 'x.test.ts'].sort());
    const outside = {
      ...report(ALL, 'passed'),
      testResults: [
        { name: '/elsewhere/a.test.ts', status: 'passed', assertionResults: [{ status: 'passed' }] },
      ],
    };
    const o = passedFiles(JSON.stringify(outside), '/r');
    if (typeof o === 'string') throw new Error(o);
    expect([...o.passed, ...o.reported]).toEqual([]);
    // 状态不是 passed 的出现在 reported 里、不在 passed 里
    const failedOne = report(ALL, 'passed');
    failedOne.testResults[1] = { name: `/r/${ALL[1]}`, status: 'skipped', assertionResults: [] };
    const f = passedFiles(JSON.stringify(failedOne), '/r');
    if (typeof f === 'string') throw new Error(f);
    expect([...f.passed]).toEqual([ALL[0]]);
    expect([...f.reported].sort()).toEqual(ALL);
  });

  it('【故意造出的失败】报告里实际跑的文件和预测的这一批对不上（多一个、少一个、换一个）：不写清单，不拿预测错的集合当「已覆盖」', () => {
    const extra = [...ALL, 'packages/api/test/other-shard.test.ts'];
    expect(record(report(extra, 'passed'))).toHaveProperty('why');
    expect(record(report([ALL[0] as string], 'passed'))).toHaveProperty('why');
    expect(
      record(report([ALL[0] as string, 'packages/api/test/other-shard.test.ts'], 'passed')),
    ).toHaveProperty('why');
    // 正好对上：写
    expect(record(report(ALL, 'passed'))).toHaveProperty('manifest');
  });
});

// ---- 入口（真起一个进程）

// 同步起子进程的用例：不靠 vitest 的 5 秒默认限时（本机满负荷时光起进程就超），子进程自带上限（child.ts）。
describe('入口 bin/ci-cache.ts', { timeout: 0 }, () => {
  const bin = fileURLToPath(new URL('../src/bin/ci-cache.ts', import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), 'ci-cache-'));
  const run = (args: string[]) => {
    const out = join(tmp, `out-${Math.random().toString(36).slice(2)}`);
    writeFileSync(out, '');
    const r = runChild(process.execPath, [bin, ...args], { env: { ...process.env, GITHUB_OUTPUT: out } });
    return { ...r, outputs: readFileSync(out, 'utf8') };
  };

  /** 写一份这一台的文件清单（一行一个），返回路径。 */
  const boxFile = (lines: string[]) => {
    const p = join(tmp, `box-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(p, lines.length > 0 ? `${lines.join('\n')}\n` : '');
    return p;
  };

  it('参数不对：退出 2（工作流写错了，要红）', () => {
    expect(run([]).status).toBe(2);
    expect(run(['key']).status).toBe(2);
    expect(run(['nope', '--event', 'pull_request', '--tmp', tmp]).status).toBe(2);
    expect(run(['key', '--event', 'pull_request', '--tmp', tmp, '--args', 'packages/cli/']).status).toBe(2);
  });

  it('【故意造出的失败】主线推送：key 不开、plan 全跑、record 不写，都退出 0、什么清单都不碰', () => {
    const box = boxFile(['packages/cli/test/cli.test.ts']);
    expect(run(['key', '--event', 'push', '--tmp', tmp, '--box-file', box, '--label', '1/1']).outputs).toBe(
      'enabled=false\n',
    );
    expect(run(['plan', '--event', 'push', '--tmp', tmp]).outputs).toMatch(/^mode=all\n/);
    const rec = run(['record', '--event', 'push', '--tmp', tmp, '--report', join(tmp, 'x.json')]);
    expect(rec.status).toBe(0);
    expect(rec.outputs).toBe('written=false\n');
  });

  it('【故意造出的失败】PR：文件清单认不出（不是测试文件、空的、读不到）不缓存（enabled=false、退出 0）；交接文件坏了 plan 全跑', () => {
    for (const box of [boxFile(['--weird']), boxFile([]), join(tmp, '没有这个清单.txt')]) {
      const k = run(['key', '--event', 'pull_request', '--tmp', tmp, '--box-file', box, '--label', 'x']);
      expect(k.status, box).toBe(0);
      expect(k.outputs, box).toBe('enabled=false\n');
    }
    writeFileSync(join(tmp, 'fleet-test-cache-state.json'), '{坏的');
    const p = run(['plan', '--event', 'pull_request', '--tmp', tmp]);
    expect(p.status).toBe(0);
    expect(p.outputs).toMatch(/^mode=all\n/);
  });

  it('PR：真仓里 key 能算出来，同样的输入键一样', () => {
    const real = readGraph(fsRepo(ROOT));
    if (typeof real === 'string') throw new Error(real);
    const all = listTestFiles(fsRepo(ROOT));
    if (typeof all === 'string') throw new Error(all);
    const box = boxFile(all.filter((f) => f.startsWith('packages/cli/')));
    const args = ['key', '--event', 'pull_request', '--tmp', tmp, '--box-file', box, '--label', '1/1'];
    const a = run(args);
    const b = run(args);
    expect(a.status).toBe(0);
    expect(a.outputs).toMatch(/^enabled=true\ncache_key=ci-test-v\d+-1-1-[0-9a-f]{64}\n/);
    expect(b.outputs).toBe(a.outputs);
  });
});

// ---- ci.yml：缓存只在 PR 的 test job，主线那条不碰

describe('ci.yml 的 test job', () => {
  const yml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  type Step = {
    name?: string;
    id?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string>;
  };
  const doc = parse(yml) as { jobs: Record<string, { env?: Record<string, string>; steps: Step[] }> };
  const GH = (e: string) => ['$', `{{ ${e} }}`].join('');
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`ci.yml 里找不到${what}`);
    return v;
  };
  const steps = doc.jobs.test?.steps ?? [];
  const cacheSteps = steps.filter(
    (s) => /ci-cache\.ts/.test(s.run ?? '') || /^actions\/cache\/(restore|save)@/.test(s.uses ?? ''),
  );

  it('有五个缓存步骤：算键、取、核对、写清单、存，每一步的 if 都先认 pull_request', () => {
    expect(cacheSteps.map((s) => s.name)).toEqual([
      '测试缓存：算键',
      '测试缓存：取清单',
      '测试缓存：核对，算这次跑哪些',
      '测试缓存：全绿，写清单',
      '测试缓存：存清单',
    ]);
    // 【故意造出的失败】哪一步丢了事件名的判断，主线推送那一轮就会碰缓存：这里逐步核对，不能只看有没有
    for (const s of cacheSteps) {
      expect(s.if, s.name).toMatch(/^(?:success\(\) && )?github\.event_name == 'pull_request'/);
    }
  });

  it('只用 GitHub 自带的缓存：取不带 restore-keys（键完全一样才命中），存要「写了清单」且「不是已命中」', () => {
    const restore = need(
      cacheSteps.find((s) => s.uses?.startsWith('actions/cache/restore@')),
      '取缓存那一步',
    );
    const save = need(
      cacheSteps.find((s) => s.uses?.startsWith('actions/cache/save@')),
      '存缓存那一步',
    );
    const cacheKey = GH('steps.cache-key.outputs.cache_key');
    expect(restore.with).toEqual({ path: `${GH('runner.temp')}/${CACHE_SUBDIR}`, key: cacheKey });
    expect(save.if).toContain("steps.cache-record.outputs.written == 'true'");
    expect(save.if).toContain("steps.cache-restore.outputs.cache-hit != 'true'");
    expect(save.if).toMatch(/^success\(\)/);
    expect(save.with?.key).toBe(cacheKey);
    // 注释里会提到 restore-keys（说明为什么不用），去掉整行注释再查
    expect(yml.replace(/^\s*#.*$/gm, '')).not.toContain('restore-keys');
    // 写清单只在 all / files 这两种有真跑的模式、且前面全绿
    const record = need(
      cacheSteps.find((s) => s.id === 'cache-record'),
      '写清单那一步',
    );
    expect(record.if).toMatch(/^success\(\)/);
    expect(record.if).toContain("mode == 'all'");
    expect(record.if).toContain("mode == 'files'");
    expect(record.if).not.toContain("mode == 'none'");
  });

  it('跑 vitest 那一步：交出去的是这一台分到的文件清单（不再有 --shard），每一轮都出 JSON 报告给后面核对', () => {
    const run = need(
      steps.find((s) => /vitest run/.test(s.run ?? '') && !/ci-cache/.test(s.run ?? '')),
      '跑 vitest 那一步',
    );
    const text = run.run ?? '';
    // 缓存模式为空（主线、缓存没开）：整台照跑，也出报告（核对那一步要它）
    expect(text).toMatch(/^\s+""\) pnpm exec vitest run "\$\{box\[@\]\}" "\$\{report\[@\]\}" ;;$/m);
    expect(text).toMatch(/^\s+all\) pnpm exec vitest run "\$\{box\[@\]\}" "\$\{report\[@\]\}" ;;$/m);
    expect(text).toContain('mapfile -t box <"$BOX_FILE"');
    expect(text).not.toContain('--shard');
    // 认不出的模式红，不是悄悄全跑或悄悄跳过
    expect(text).toMatch(/\*\)\n\s+echo "认不出的缓存模式[^\n]*>&2\n\s+exit 1/);
    // none 不跑 vitest
    expect(text).toMatch(/none\) echo "[^"]*不跑 vitest"/);
    // 同一份文件清单：键算的、vitest 跑的、跑完核对的是同一台（都从「这一台跑哪些文件」那步的输出来）
    const keyStep = need(
      cacheSteps.find((s) => s.id === 'cache-key'),
      '算键那一步',
    );
    const boxFile = GH('steps.box.outputs.box_file');
    expect(keyStep.env?.BOX_FILE).toBe(boxFile);
    expect(run.env?.BOX_FILE).toBe(boxFile);
  });

  it('【故意造出的失败】跑完核对「实际跑的 == 分到的」那一步在、排在写清单之前、读的是同一份报告和矩阵', () => {
    const at = (pred: (s: Step) => boolean) => steps.findIndex(pred);
    const verify = at((s) => /ci-box\.ts verify/.test(s.run ?? ''));
    const runAt = at((s) => /vitest run/.test(s.run ?? '') && !/ci-cache/.test(s.run ?? ''));
    const recordAt = at((s) => s.id === 'cache-record');
    expect(verify, '没有核对那一步').toBeGreaterThan(runAt);
    expect(verify).toBeLessThan(recordAt);
    const v = steps[verify] as Step;
    expect(v.env?.MATRIX).toBe(GH('toJSON(matrix)'));
    expect(v.env?.REPORT).toBe((steps[runAt] as Step).env?.REPORT);
    // 主线也核对：这一步不认事件名（不是只在 PR 上）
    expect(v.if ?? '').not.toContain('pull_request');
    expect(v.run).toContain(['--mode "$', '{CACHE_MODE:-}"'].join(''));
  });

  it('FLEET_TEST_PG_URL 放在 job 上（算键的那一步也看得到），只给 pg 台；vitest 那一步不再单设', () => {
    const env = doc.jobs.test?.env;
    expect(env?.FLEET_TEST_PG_URL).toContain('matrix.pg');
    for (const s of steps) {
      expect(JSON.stringify(s.env ?? {}), s.name).not.toContain('FLEET_TEST_PG_URL');
    }
  });

  it('postgres 容器在 job 一开始就后台起、装依赖之后才等 pg_isready（不和装依赖串着等）', () => {
    const start = steps.findIndex((s) => /docker run -d --name fleet-test-pg/.test(s.run ?? ''));
    const install = steps.findIndex((s) => /pnpm install --frozen-lockfile/.test(s.run ?? ''));
    const wait = steps.findIndex((s) => /pg_isready/.test(s.run ?? ''));
    expect(start, '起容器那一步').toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(install);
    expect(wait).toBeGreaterThan(install);
    expect((steps[start] as Step).if).toBe('matrix.pg');
    expect((steps[wait] as Step).if).toBe('matrix.pg');
    // 起容器那一步自己不等（拉镜像放后台），也不跑 pg_isready
    expect(steps[start]?.run).not.toContain('pg_isready');
  });

  it('清单文件名和缓存目录名两边一致（bin 写的、yml 存的是同一个目录）', () => {
    expect(MANIFEST_FILE).toBe('manifest.json');
    expect(yml).toContain(`/${CACHE_SUBDIR}`);
    expect(yml).toContain('fleet-test-out/report.json');
  });

  it('清单类型：Manifest 的 status 只有 passed（类型层面也不留别的）', () => {
    const m: Manifest['files'][string] = { sha: SHA('1'), status: 'passed' };
    expect(m.status).toBe('passed');
  });
});

describe('防「别的测试也通读全仓」悄悄多出一个', () => {
  it('只有 ci-plan.test.ts 通读全仓的包（readdirSync(packages) 那种）：别的测试出现了要把它所在的单元加进 WHOLE_REPO_READERS', () => {
    const readers: string[] = [];
    const walk = (rel: string) => {
      const fs = fsHashFs(ROOT);
      for (const name of fs.list(rel) ?? []) {
        if (name === 'node_modules' || name === 'dist' || name === 'dist-demo') continue;
        const child = `${rel}/${name}`;
        const sub = fs.list(child);
        if (sub !== undefined) walk(child);
        else if (/\.test\.tsx?$/.test(name)) {
          const text = Buffer.from(fs.bytes(child) as Uint8Array).toString('utf8');
          if (
            /(?:readdirSync|readdir)\(\s*join\(\s*(?:ROOT|REPO|root)\s*,\s*['"`]packages['"`]\s*\)/.test(text)
          )
            readers.push(child);
        }
      }
    };
    walk('packages');
    // 自己的这条正则会匹配到自己的源码：本文件不算
    expect(readers.filter((f) => !f.endsWith('ci-cache.test.ts')).sort()).toEqual([
      'packages/conventions/test/ci-plan.test.ts',
    ]);
  });
});
