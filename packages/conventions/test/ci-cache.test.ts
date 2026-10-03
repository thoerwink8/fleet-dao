// PR 的测试分片结果缓存（src/ci-cache.ts）：键盖没盖住输入、清单怎么核对、什么情况一律回来真跑。
// 带【故意造出的失败】的几条，每一条都是「造一份坏的输入，判定器必须拒」：平时都绿，看不出判定器还在不在拦，所以得造一次坏的看它红。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  CACHE_SCHEMA,
  CACHE_SUBDIR,
  CacheError,
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
  parseShardArgs,
  passedFiles,
  predictShard,
  relativeToRoot,
  selectToRun,
  shardUnits,
  sourceClosure,
  stepKey,
  stepPlan,
  stepRecord,
  UNIVERSAL_PACKAGES,
} from '../src/ci-cache.ts';
import {
  FIXTURE_PATH,
  PATH_RULES,
  type PackageGraph,
  planCi,
  ROOT_CONFIG_FILES,
  readGraph,
} from '../src/ci-plan.ts';
import { parseRiskPaths, RISK_PATHS_FILE } from '../src/merge-gates.ts';
import { fsRepo } from '../src/repo.ts';

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
  args?: string[];
  env?: Partial<EnvIdentity>;
  collected?: string[];
  after?: (fs: ReturnType<typeof memFs>) => void;
}) => {
  const fs = memFs({ ...BASE_FILES, ...opts.files });
  opts.after?.(fs);
  return computeKey({
    fs,
    graph: GRAPH,
    args: opts.args ?? ['packages/api/', '--shard=1/2'],
    env: { ...ENV, ...opts.env },
    collected: opts.collected ?? testsOf('api'),
  });
};

describe('分片参数：只认 ci-plan.ts 会给的三种，别的不猜', () => {
  it('包目录、--exclude packages/<包>/**、--shard=i/n', () => {
    expect(parseShardArgs(['packages/api/', 'agents/', '--shard=2/3'])).toEqual({
      paths: ['packages/api/', 'agents/'],
      excludes: [],
      shard: { index: 2, count: 3 },
    });
    expect(parseShardArgs(['--exclude', 'packages/engine/**', '--exclude', 'packages/db/**'])).toMatchObject({
      paths: [],
      excludes: ['packages/engine/**', 'packages/db/**'],
    });
  });

  it('【故意造出的失败】认不出的参数、怪的 --exclude、台号越界：抛错（调用方全跑），不当成没有', () => {
    for (const bad of [
      ['--watch'],
      ['packages/api'],
      ['packages/api/test/x.test.ts'],
      ['--exclude'],
      ['--exclude', 'docs/**'],
      ['--shard=0/3'],
      ['--shard=4/3'],
      ['--shard=1/3', '--shard=2/3'],
      ['--shard=a/b'],
    ]) {
      expect(() => parseShardArgs(bad), bad.join(' ')).toThrow(CacheError);
    }
  });

  it('没给包目录（rest 全跑）：依赖图里所有包加 agents，减去 --exclude 的；单元不在依赖图里抛', () => {
    const units = shardUnits(
      parseShardArgs(['--exclude', 'packages/engine/**', '--exclude', 'packages/db/**']),
      GRAPH,
    );
    expect(units).toContain('agents');
    expect(units).toContain('api');
    expect(units).not.toContain('engine');
    expect(units).not.toContain('db');
    expect(() => shardUnits(parseShardArgs(['packages/nope/']), GRAPH)).toThrow(CacheError);
    expect(() =>
      shardUnits(parseShardArgs(['packages/api/', '--exclude', 'packages/api/**']), GRAPH),
    ).toThrow(CacheError);
  });

  it('源码闭包：单元自己 + 向下依赖 + TEST_READS（api 读 web、db 读 core），不往上、不顺依赖往下传 TEST_READS', () => {
    expect(sourceClosure(GRAPH, ['api'])).toEqual(['api', 'db', 'shared', 'web']);
    expect(sourceClosure(GRAPH, ['db'])).toEqual(['core', 'db', 'shared']);
    expect(sourceClosure(GRAPH, ['cli'])).toEqual(['cli', 'shared']);
    // engine 依赖 api，但 api 读 web 是 api 测试自己的事：engine 的闭包里不带 web
    expect(sourceClosure(GRAPH, ['engine'])).not.toContain('web');
    // agents 不在依赖图里，但 agents/test/france.test.ts 直接读 shared 的源码：shared 每一组都带（UNIVERSAL_PACKAGES）
    expect(sourceClosure(GRAPH, ['agents'])).toEqual(['shared']);
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

  it('分片参数变了（换一台、换包）、vitest 收的测试文件变了（多一个、少一个、内容变）：键变', () => {
    expect(keyOf({ args: ['packages/api/', '--shard=2/2'] }).key).not.toBe(base);
    expect(keyOf({ args: ['packages/api/'] }).key).not.toBe(base);
    expect(keyOf({ collected: [...testsOf('api'), 'packages/db/test/index.test.ts'] }).key).not.toBe(base);
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
    const conv = (files: Record<string, string>) =>
      keyOf({ args: ['packages/conventions/'], collected: testsOf('conventions'), files }).key;
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
    expect(() =>
      computeKey({ fs: bad, graph: GRAPH, args: ['packages/api/'], env: ENV, collected: testsOf('api') }),
    ).toThrow('EACCES');
    // 一个测试文件都没收到（vitest list 空）：抛，不拿空集算出一个键
    expect(() => keyOf({ collected: [] })).toThrow(CacheError);
    // 收到的文件读不到
    expect(() => keyOf({ collected: ['packages/api/test/ghost.test.ts'] })).toThrow(CacheError);
  });

  it('真读盘：不存在是 undefined，目录当目录；全跑那一版的每一台（engine、db、rest）在真仓上都能算出键', () => {
    const fs = fsHashFs(ROOT);
    expect(fs.bytes('没有这个文件.txt')).toBeUndefined();
    expect(fs.list('没有这个目录')).toBeUndefined();
    expect(fs.list('packages')).toContain('conventions');
    expect(fs.list('packages/conventions/package.json')).toBeUndefined();
    expect(Buffer.from(fs.bytes('package.json') as Uint8Array).toString('utf8')).toContain('fleet-dao');
    const real = readGraph(fsRepo(ROOT));
    if (typeof real === 'string') throw new Error(real);
    const full = planCi({ event: 'push', changed: [], graph: real });
    const keys = full.tests.map(
      (t) =>
        computeKey({
          fs,
          graph: real,
          args: t.args,
          env: ENV,
          collected: ['packages/conventions/test/child.test.ts'],
        }).key,
    );
    expect(new Set(keys).size, '每一台的键不一样（分片参数不同）').toBe(keys.length);
  });
});

// ---- 清单

const SHA = (c: string) => c.repeat(64);
const KEY = SHA('a');
const ARGS = ['packages/api/', '--shard=1/2'];
const collected = { 'packages/api/test/a.test.ts': SHA('1'), 'packages/api/test/b.test.ts': SHA('2') };
const manifest = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: CACHE_SCHEMA,
    complete: true,
    key: KEY,
    args: ARGS,
    files: {
      'packages/api/test/a.test.ts': { sha: SHA('1'), status: 'passed' },
      'packages/api/test/b.test.ts': { sha: SHA('2'), status: 'passed' },
    },
    ...over,
  });
const select = (manifestText: string | undefined, c: Record<string, string> = collected) =>
  selectToRun({ collected: c, key: KEY, args: ARGS, manifestText });
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
      ['没有 args', manifest({ args: undefined })],
      ['args 里有非字符串', manifest({ args: [1] })],
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

  it('清单里的键、分片参数和这次不一样：全跑（缓存是别的输入跑出来的）', () => {
    expect(select(manifest({ key: SHA('b') })).mode).toBe('all');
    expect(select(manifest({ args: ['packages/api/', '--shard=2/2'] })).mode).toBe('all');
  });

  it('【故意造出的失败】清单不 complete、或文件不在清单里，必须跑：新增的测试文件一定跑', () => {
    for (const complete of [false, undefined, 'true', 1, null]) {
      expect(select(manifest({ complete })), String(complete)).toMatchObject({ mode: 'all', run: ALL });
    }
    const withNew = { ...collected, 'packages/api/test/new.test.ts': SHA('3') };
    const s = select(manifest(), withNew);
    expect(s.mode).toBe('files');
    expect(s.run).toEqual(['packages/api/test/new.test.ts']);
    // 全集是 vitest 收到的：清单多出来的文件（已经删了、或换了台）不影响，也不会被当成「收到了」
    const shrunk = { 'packages/api/test/a.test.ts': SHA('1') };
    expect(select(manifest(), shrunk)).toMatchObject({
      mode: 'none',
      covered: ['packages/api/test/a.test.ts'],
    });
    // vitest 一个文件都没收到：全跑（空集不是「全盖住了」）
    expect(select(manifest(), {})).toMatchObject({ mode: 'all', run: [] });
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
  const stubList = (files: string[]) => () => files;
  const key = (over: Partial<Parameters<typeof stepKey>[0]> = {}) =>
    stepKey({
      event: 'pull_request',
      args: ['packages/api/', '--shard=1/2'],
      label: 'rest 1/2',
      fs: memFs(BASE_FILES),
      graph: GRAPH,
      env: () => ENV,
      listTests: stubList(testsOf('api')),
      ...over,
    });

  it('正常：键、缓存键名（带组名）、交接文件里有收到的文件和哈希', () => {
    const k = key();
    if (!k.enabled) throw new Error(k.why);
    expect(k.cacheKey).toBe(`ci-test-v${CACHE_SCHEMA}-rest-1-2-${k.key}`);
    expect(Object.keys(k.state.collected)).toEqual(testsOf('api'));
    expect(k.state.mode).toBe('all');
  });

  it('vitest list 不认 --shard（列的是切之前的全集）：交给它的参数里去掉 --shard，这一台的文件自己按 vitest 的算法切；三台正好不重不漏', () => {
    const names = Array.from({ length: 7 }, (_, i) => `packages/api/test/t${i}.test.ts`);
    const fs = memFs({ ...BASE_FILES, ...Object.fromEntries(names.map((n) => [n, `body ${n}`])) });
    const seen: string[][] = [];
    const per = [1, 2, 3].map((index) => {
      const k = key({
        fs,
        args: ['packages/api/', `--shard=${index}/3`],
        listTests: (a) => {
          seen.push(a);
          return names;
        },
      });
      if (!k.enabled) throw new Error(k.why);
      return Object.keys(k.state.collected);
    });
    expect(seen.every((a) => a.join(' ') === 'packages/api/')).toBe(true);
    expect(per.map((p) => p.length).sort()).toEqual([2, 2, 3]);
    expect([...per.flat()].sort()).toEqual([...names].sort());
    // 一台一个都分不到（文件比台数少）：不缓存，不拿空集算键
    const few = key({ args: ['packages/api/', '--shard=2/3'], listTests: () => testsOf('api') });
    expect(few.enabled).toBe(false);
  });

  it('predictShard 和装着的 vitest 自己的分片逐个对：各种文件个数 × 台数，一个文件都不差', async () => {
    const { BaseSequencer } = await import('vitest/node');
    for (const n of [1, 2, 3, 5, 7, 10, 29, 88, 237]) {
      const files = Array.from({ length: n }, (_, i) => `packages/p${i % 9}/test/some-file-${i}.test.ts`);
      for (const count of [1, 2, 3, 4, 7]) {
        if (count > n) continue;
        for (let index = 1; index <= count; index++) {
          const seq = new BaseSequencer({ config: { root: '/r', shard: { index, count } } } as never);
          const actual = (await seq.shard(
            files.map((f) => ({ moduleId: `/r/${f}` })) as never,
          )) as unknown as {
            moduleId: string;
          }[];
          expect(predictShard(files, { index, count }), `${n} 个文件，${index}/${count}`).toEqual(
            actual.map((s) => s.moduleId.slice('/r/'.length)).sort(),
          );
        }
      }
    }
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
        args: real.state.args,
        files: Object.fromEntries(
          Object.entries(real.state.collected).map(([f, sha]) => [f, { sha, status: 'passed' }]),
        ),
      });
      const p = stepPlan({
        event,
        stateText: JSON.stringify(real.state),
        manifestText: perfect,
        listTests: stubList([]),
      });
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

  it('算不出就不开：依赖图读不出、vitest list 跑不成、认不出的参数、没收到文件：enabled=false，带原因', () => {
    expect(key({ graph: '读不到 packages/b/package.json' })).toMatchObject({ enabled: false });
    expect(
      key({
        listTests: () => {
          throw new CacheError('vitest list 退出 1');
        },
      }),
    ).toMatchObject({ enabled: false, why: expect.stringContaining('vitest list 退出 1') });
    expect(key({ args: ['--watch'] })).toMatchObject({ enabled: false });
    expect(key({ listTests: stubList([]) })).toMatchObject({ enabled: false });
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
        listTests: () => {
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
      listTests: stubList([]),
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
    expect(m).toMatchObject({ schema: CACHE_SCHEMA, complete: true, key: k.key });
    const k2 = key();
    if (!k2.enabled) throw new Error(k2.why);
    expect(k2.key).toBe(k.key);
    const plan2 = stepPlan({
      event: 'pull_request',
      stateText: JSON.stringify(k2.state),
      manifestText: JSON.stringify(m),
      listTests: stubList([]),
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
      listTests: stubList([]),
    });
    expect(plan2.mode).toBe('all');
    expect(plan2.why).toContain('键');
  });

  it('files 模式：按文件名过滤后 vitest 收到的和要跑的对不上（多一个、少一个、列不出），全跑', () => {
    const files = { ...collected, 'packages/api/test/new.test.ts': SHA('3') };
    const state = {
      schema: CACHE_SCHEMA,
      key: KEY,
      args: ARGS,
      collected: files,
      mode: 'all',
      covered: [],
      run: Object.keys(files),
    };
    const plan = (list: (a: string[]) => string[]) =>
      stepPlan({
        event: 'pull_request',
        stateText: JSON.stringify(state),
        manifestText: manifest(),
        listTests: list,
      });
    expect(plan((a) => a)).toMatchObject({ mode: 'files', run: ['packages/api/test/new.test.ts'] });
    expect(plan((a) => [...a, 'packages/api/test/b.test.ts']).mode).toBe('all');
    expect(plan(() => []).mode).toBe('all');
    expect(
      plan(() => {
        throw new CacheError('vitest list 退出 1');
      }).mode,
    ).toBe('all');
  });

  it('交接文件坏了（没有、不是 JSON、字段缺）：plan 全跑、record 不写', () => {
    for (const text of [undefined, '', '{', '[]', JSON.stringify({ schema: CACHE_SCHEMA })]) {
      expect(
        stepPlan({
          event: 'pull_request',
          stateText: text,
          manifestText: manifest(),
          listTests: stubList([]),
        }).mode,
      ).toBe('all');
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
      args: ARGS,
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
    expect(r.manifest).toMatchObject({ complete: true, key: KEY, args: ARGS });
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

describe('入口 bin/ci-cache.ts', () => {
  const bin = fileURLToPath(new URL('../src/bin/ci-cache.ts', import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), 'ci-cache-'));
  const run = (args: string[]) => {
    const out = join(tmp, `out-${Math.random().toString(36).slice(2)}`);
    writeFileSync(out, '');
    const r = spawnSync(process.execPath, [bin, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: out },
    });
    return { ...r, outputs: readFileSync(out, 'utf8') };
  };

  it('参数不对：退出 2（工作流写错了，要红）', () => {
    expect(run([]).status).toBe(2);
    expect(run(['key']).status).toBe(2);
    expect(run(['nope', '--event', 'pull_request', '--tmp', tmp]).status).toBe(2);
    expect(run(['key', '--event', 'pull_request', '--tmp', tmp, '--args', '--exclude x']).status).toBe(2);
  });

  it('【故意造出的失败】主线推送：key 不开、plan 全跑、record 不写，都退出 0、什么清单都不碰', () => {
    expect(
      run(['key', '--event', 'push', '--tmp', tmp, '--args=packages/cli/', '--label', 'rest']).outputs,
    ).toBe('enabled=false\n');
    expect(run(['plan', '--event', 'push', '--tmp', tmp]).outputs).toMatch(/^mode=all\n/);
    const rec = run(['record', '--event', 'push', '--tmp', tmp, '--report', join(tmp, 'x.json')]);
    expect(rec.status).toBe(0);
    expect(rec.outputs).toBe('written=false\n');
  });

  it('PR：认不出的分片参数不缓存（enabled=false、退出 0）；交接文件坏了 plan 全跑', () => {
    const k = run(['key', '--event', 'pull_request', '--tmp', tmp, '--args=--weird', '--label', 'x']);
    expect(k.status).toBe(0);
    expect(k.outputs).toBe('enabled=false\n');
    writeFileSync(join(tmp, 'fleet-test-cache-state.json'), '{坏的');
    const p = run(['plan', '--event', 'pull_request', '--tmp', tmp]);
    expect(p.status).toBe(0);
    expect(p.outputs).toMatch(/^mode=all\n/);
  });

  it('PR：真仓里 key 能算出来（vitest list 真跑），同样的输入键一样', () => {
    const args = [
      'key',
      '--event',
      'pull_request',
      '--tmp',
      tmp,
      '--args=packages/cli/ --shard=1/1',
      '--label',
      'rest',
    ];
    const a = run(args);
    const b = run(args);
    expect(a.status).toBe(0);
    expect(a.outputs).toMatch(/^enabled=true\ncache_key=ci-test-v\d+-rest-[0-9a-f]{64}\n/);
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

  it('跑 vitest 那一步：缓存模式为空时（主线、缓存没开）就是原来那条命令，不带报告、不改参数', () => {
    const run = need(
      steps.find((s) => /vitest run/.test(s.run ?? '') && !/ci-cache/.test(s.run ?? '')),
      '跑 vitest 那一步',
    );
    const text = run.run ?? '';
    expect(text).toMatch(/^\s+"?"\) pnpm exec vitest run "\$\{args\[@\]\}" ;;$/m);
    // 认不出的模式红，不是悄悄全跑或悄悄跳过
    expect(text).toMatch(/\*\)\n\s+echo "认不出的缓存模式[^\n]*>&2\n\s+exit 1/);
    // none 不跑 vitest
    expect(text).toMatch(/none\) echo "[^"]*不跑 vitest"/);
    // 同一个 ARGS 表达式：键算的、vitest 跑的是同一串参数
    const keyStep = need(
      cacheSteps.find((s) => s.id === 'cache-key'),
      '算键那一步',
    );
    const expr = GH("join(matrix.args, ' ')");
    expect(keyStep.env?.ARGS).toBe(expr);
    expect(run.env?.ARGS).toBe(expr);
  });

  it('FLEET_TEST_PG_URL 放在 job 上（算键的那一步也看得到），只给 db 分片；vitest 那一步不再单设', () => {
    const env = doc.jobs.test?.env;
    expect(env?.FLEET_TEST_PG_URL).toContain("matrix.name == 'db'");
    for (const s of steps) {
      expect(JSON.stringify(s.env ?? {}), s.name).not.toContain('FLEET_TEST_PG_URL');
    }
  });

  it('新文件在先审后合清单里（它们是「决定少跑」的一步，和 ci-plan.ts 同类）', () => {
    const parsed = parseRiskPaths(readFileSync(join(ROOT, RISK_PATHS_FILE), 'utf8'));
    if (typeof parsed === 'string') throw new Error(parsed);
    const listed = parsed.map((r) => r.path);
    expect(listed).toContain('packages/conventions/src/ci-cache.ts');
    expect(listed).toContain('packages/conventions/src/bin/ci-cache.ts');
  });

  it('清单文件名和缓存目录名两边一致（bin 写的、yml 存的是同一个目录）', () => {
    expect(MANIFEST_FILE).toBe('manifest.json');
    expect(yml).toContain(`/${CACHE_SUBDIR}`);
    expect(yml).toContain('fleet-test-report.json');
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
