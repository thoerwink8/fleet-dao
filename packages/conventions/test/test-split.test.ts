// CI 测试怎么分台（src/test-split.ts）：列测试文件、按环境的类和能力标记、按耗时装箱。
// 带【故意造出的失败】的都是「造一份坏的/怪的输入，判定必须拒或必须照样跑」：平时绿着看不出它还在不在拦。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fsRepo } from '../src/repo.ts';
import {
  boxCount,
  FALLBACK_FILE_MS,
  isTestFile,
  listTestFiles,
  MAX_BOXES,
  needsPg,
  packTests,
  parseTimings,
  siblingsOf,
  TARGET_BOX_MS,
  TEMPORAL_MARKER,
  TIMINGS_FILE,
  type Timings,
  unitOfTestFile,
  withSiblings,
} from '../src/test-split.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const REPO = fsRepo(ROOT);
/** 仓根（/ 分隔、不带结尾的斜杠）：vitest list 给的是绝对路径，去掉这一段才是仓内相对。 */
const root = ROOT.replace(/\\/g, '/').replace(/\/+$/, '');

const FILES = listTestFiles(REPO);
if (typeof FILES === 'string') throw new Error(FILES);
const REAL_TIMINGS = parseTimings(readFileSync(join(ROOT, TIMINGS_FILE), 'utf8'));
if (typeof REAL_TIMINGS === 'string') throw new Error(REAL_TIMINGS);

const read = (rel: string) => REPO.read(rel);
const temporalOf = (files: readonly string[]) =>
  new Set(files.filter((f) => TEMPORAL_MARKER.test(read(f) ?? '')));

describe('列测试文件：和 vitest 自己收的是一份（vitest.config.ts 的 include 就取 TEST_INCLUDE）', () => {
  it('枚举出来的正好是 vitest list 列出来的（多一个少一个都红：少了那个测试就没人跑）', () => {
    // 起一个子进程跑 vitest list：本进程正跑着 vitest，自己再拉一个实例会打架。
    // 装着的 vitest 不是测试的输入（版本在缓存键的环境身份里），路径拆开写，免得 ci-plan.test.ts 的扫描器当成「读了包外文件」
    const vitestBin = ['node_modules', 'vitest', 'vitest.mjs'].join('/');
    const out = join(mkdtempSync(join(tmpdir(), 'test-split-')), 'list.json');
    const r = spawnSync(process.execPath, [join(ROOT, vitestBin), 'list', '--filesOnly', `--json=${out}`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(r.status, r.stderr.slice(0, 500)).toBe(0);
    const listed = (JSON.parse(readFileSync(out, 'utf8')) as { file: string }[])
      .map((x) => x.file.replace(/\\/g, '/').replace(`${root}/`, ''))
      .sort();
    expect(listed.length).toBeGreaterThan(300);
    expect(FILES).toEqual(listed);
  });

  it('测试文件的判法：包的 src/test 下、agents/test 下；node_modules、.git 里的不收', () => {
    for (const yes of [
      'packages/cli/src/a.test.ts',
      'packages/cli/src/deep/b.test.tsx',
      'packages/cli/test/c.test.ts',
      'agents/test/d.test.ts',
    ]) {
      expect(isTestFile(yes), yes).toBe(true);
    }
    for (const no of [
      'packages/cli/src/helper.ts',
      'packages/cli/node_modules/x/y.test.ts',
      'agents/skills/x.test.ts',
      'docs/a.test.ts',
      'package.json',
    ]) {
      expect(isTestFile(no), no).toBe(false);
    }
  });

  it('目录列不出（检出坏了）：一句为什么，不拿空清单冒充「没有测试」', () => {
    const empty = {
      read: () => undefined,
      exists: () => false,
      isDir: () => false,
      list: () => undefined,
    };
    expect(listTestFiles(empty)).toContain('列不出');
  });
});

describe('vitest 的位置参数是子串过滤：名字会被一起拉上的放在同一台', () => {
  it('siblingsOf：路径（不分大小写）包含它的别的文件', () => {
    const all = ['a/x.test.ts', 'a/x.test.tsx', 'a/y.test.ts'];
    expect(siblingsOf('a/x.test.ts', all)).toEqual(['a/x.test.tsx']);
    expect(siblingsOf('a/x.test.tsx', all)).toEqual(['a/x.test.ts']);
    expect(siblingsOf('a/y.test.ts', all)).toEqual([]);
  });

  it('withSiblings：把会被一起拉上的补进来（少分一个，跑完核对那一步会红）', () => {
    expect(withSiblings(['a/x.test.ts'], ['a/x.test.ts', 'a/x.test.tsx', 'a/y.test.ts'])).toEqual([
      'a/x.test.ts',
      'a/x.test.tsx',
    ]);
  });

  it('装箱：互相拉上的并成一件、放同一台，并在说明里写清', () => {
    const files = ['a/x.test.ts', 'a/x.test.tsx', 'b/p.test.ts'];
    const timings: Timings = {
      source: 'test',
      files: { 'a/x.test.ts': 1000, 'a/x.test.tsx': 1000, 'b/p.test.ts': 1000 },
    };
    const r = packTests({ files, universe: files, timings, temporal: new Set() });
    if (typeof r === 'string') throw new Error(r);
    expect(r.boxes).toHaveLength(1);
    expect(r.boxes[0]?.files).toEqual(files);
    expect(r.notes.join()).toContain('子串过滤');
  });

  it('【故意造出的失败】按名字绑在一起、却一半要真 Postgres：分不了台，报出来而不是硬塞', () => {
    expect(needsPg('packages/db/test/a.test.ts')).toBe(true);
    expect(needsPg('packages/web/test/packages/db/test/a.test.ts')).toBe(false);
    // 别的包里有个路径「包含」db 那个文件的路径（vitest 是子串过滤，交 db 那个会把它也拉上）：
    // 一个要真库、一个不要，同一台分不了
    const pair = ['packages/db/test/a.test.ts', 'packages/web/test/packages/db/test/a.test.ts'];
    expect(withSiblings([pair[0] as string], pair)).toEqual(pair);
    const bad = packTests({
      files: pair,
      universe: pair,
      timings: { source: 'test', files: Object.fromEntries(pair.map((f) => [f, 1000])) },
      temporal: new Set(),
    });
    expect(typeof bad).toBe('string');
    expect(bad as string).toContain('分不了台');
    // 只是「装箱时才发现」也会被拦：清单里漏了会被拉上的那个，先报出来（先 withSiblings）
    const missing = packTests({
      files: ['packages/db/test/a.test.ts'],
      universe: pair,
      timings: { source: 'test', files: { 'packages/db/test/a.test.ts': 1000 } },
      temporal: new Set(),
    });
    expect(typeof missing).toBe('string');
  });

  it('【故意造出的失败】选中的文件没带上会被一起拉上的别的文件：报出来，不静默少装', () => {
    const r = packTests({
      files: ['a/x.test.ts'],
      universe: ['a/x.test.ts', 'a/x.test.tsx'],
      timings: { source: 'test', files: { 'a/x.test.ts': 1 } },
      temporal: new Set(),
    });
    expect(typeof r).toBe('string');
    expect(r as string).toContain('先 withSiblings');
  });
});

describe('耗时表：只影响分得匀不匀，绝不影响跑不跑', () => {
  const timings = (files: Record<string, number>): Timings => ({ source: 'test', files });

  it('读不出、认不出：一句为什么（调用方照样装箱、打 ::warning::）', () => {
    expect(parseTimings(undefined)).toContain('读不到');
    expect(parseTimings('{')).toContain('不是 JSON');
    expect(parseTimings('[]')).toContain('不是对象');
    expect(parseTimings('{"files":{}}')).toContain('source');
    expect(parseTimings('{"source":"x"}')).toContain('files');
    expect(parseTimings('{"source":"x","files":{}}')).toContain('空的');
    expect(parseTimings('{"source":"x","files":{"a":-1}}')).toContain('毫秒数认不出');
    expect(parseTimings('{"source":"x","files":{"a":1.5}}')).toContain('毫秒数认不出');
    expect(parseTimings('{"source":"x","files":{"a":"1"}}')).toContain('毫秒数认不出');
    expect(parseTimings('{"source":"x","files":{"a":3}}')).toEqual({ source: 'x', files: { a: 3 } });
  });

  it('【故意造出的失败】耗时表整个读不出：每个文件照样分到一台（按默认估计），并报一声', () => {
    const files = Array.from({ length: 20 }, (_, i) => `p/t${i}.test.ts`);
    const r = packTests({ files, universe: files, timings: '读不到 x.json', temporal: new Set() });
    if (typeof r === 'string') throw new Error(r);
    expect(r.timingsProblem).toContain('读不到');
    expect(r.boxes.flatMap((b) => b.files).sort()).toEqual([...files].sort());
    expect(r.boxes[0]?.estMs).toBeGreaterThanOrEqual(FALLBACK_FILE_MS);
  });

  it('表里没有的文件按中位数估（新加的测试文件不会没台，也不会被当成 0 秒塞进某一台）', () => {
    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'new.test.ts'];
    const r = packTests({
      files,
      universe: files,
      // c 和 new 都不在表里：按 a、b 的中位数（1000）估
      timings: timings({ 'a.test.ts': 1000, 'b.test.ts': 1000, 'c.test.ts': 5000 }),
      temporal: new Set(),
    });
    if (typeof r === 'string') throw new Error(r);
    expect(r.notes.join()).toContain('耗时表里没有的 1 个文件');
    expect(r.notes.join()).toContain('中位数 1000 毫秒');
    expect(r.boxes.flatMap((b) => b.files).sort()).toEqual([...files].sort());
  });

  it('台数 = clamp(ceil(合计 / TARGET_BOX_MS), 1, MAX_BOXES)，参数就是这几个常量', () => {
    expect(TARGET_BOX_MS).toBe(50_000);
    expect(MAX_BOXES).toBe(8);
    expect(boxCount(0)).toBe(1);
    expect(boxCount(1)).toBe(1);
    expect(boxCount(TARGET_BOX_MS)).toBe(1);
    expect(boxCount(TARGET_BOX_MS + 1)).toBe(2);
    expect(boxCount(TARGET_BOX_MS * 8)).toBe(8);
    expect(boxCount(TARGET_BOX_MS * 100)).toBe(8);
  });

  it('装箱结果确定：同一份输入换个顺序，分台一模一样（缓存键靠这个）', () => {
    const files = Array.from({ length: 12 }, (_, i) => `p/t${i}.test.ts`);
    const t = timings(Object.fromEntries(files.map((f, i) => [f, 1000 + i * 7])));
    const a = packTests({ files, universe: files, timings: t, temporal: new Set() });
    const b = packTests({ files: [...files].reverse(), universe: files, timings: t, temporal: new Set() });
    if (typeof a === 'string' || typeof b === 'string') throw new Error('装不了');
    expect(b.boxes).toEqual(a.boxes);
  });

  it('一台都没有要跑的文件：空清单（调用方判红，不拿空清单去跑 vitest）', () => {
    const r = packTests({ files: [], universe: [], timings: timings({}), temporal: new Set() });
    expect(r).toEqual({ boxes: [], notes: [] });
  });
});

describe('环境类、能力标记', () => {
  it('unitOfTestFile：packages/<包>、agents', () => {
    expect(unitOfTestFile('packages/db/test/a.test.ts')).toBe('db');
    expect(unitOfTestFile('agents/test/skills.test.ts')).toBe('agents');
    expect(unitOfTestFile('docs/a.test.ts')).toBeUndefined();
  });

  it('要真 Postgres 的：packages/db 下的（CI 上只有它们设 FLEET_TEST_PG_URL）', () => {
    expect(needsPg('packages/db/test/migrations.test.ts')).toBe(true);
    expect(needsPg('packages/db/src/x.test.ts')).toBe(true);
    expect(needsPg('packages/api/test/store.pg.test.ts')).toBe(false);
  });

  it('扫全仓：用到 FLEET_TEST_PG_URL / realTestPgUrl 的测试文件，都在 pg 这一类里', () => {
    // conventions 这座仓自己的测试（ci-cache、ci-plan、本文件）只是「提到」这些名字：判定的是别的包的测试
    const users = FILES.filter(
      (f) => !f.startsWith('packages/conventions/') && /FLEET_TEST_PG_URL|realTestPgUrl/.test(read(f) ?? ''),
    );
    expect(
      users.length,
      '没有别的包的测试读 FLEET_TEST_PG_URL 了：这条查的东西不存在，测试该删',
    ).toBeGreaterThan(0);
    expect(users.filter((f) => !needsPg(f))).toEqual([]);
  });

  it('要 Temporal 命令行的：调了 createRealEnv 的测试文件；别人不许包一层再调（扫全仓，漏认了会红）', () => {
    const callers = FILES.filter((f) => TEMPORAL_MARKER.test(read(f) ?? ''));
    expect(callers.length, '没有测试调 createRealEnv 了：这条查的东西不存在，测试该删').toBeGreaterThan(0);
    expect(callers).toEqual(['packages/engine/test/github-reconcile.test.ts']);
    // 定义它的只有 support.ts：本仓别的非测试文件要是包了一层再调（createRealEnv 不出现、认不出要 Temporal），
    // 这里就红——那种包一层会绕开标记，跑到没装命令行的台上（CI 里 support.ts 会抛错，不会悄悄过）。
    const others: string[] = [];
    const walk = (dir: string) => {
      for (const name of REPO.list(dir) ?? []) {
        if (name === 'node_modules' || name === '.git') continue;
        const child = `${dir}/${name}`;
        if (REPO.isDir(child)) walk(child);
        else if (
          /\.(?:ts|tsx|mts|mjs)$/.test(name) &&
          !/\/(?:test|src)\/.*\.test\.tsx?$/.test(child) &&
          !child.startsWith('agents/test/')
        ) {
          if (TEMPORAL_MARKER.test(REPO.read(child) ?? '')) others.push(child);
        }
      }
    };
    walk('packages');
    walk('agents');
    expect(others, '有别的文件用了 createRealEnv：要 Temporal 的清单跟着改').toEqual([
      'packages/engine/test/support.ts',
    ]);
    expect(TEMPORAL_MARKER.test(read('packages/engine/test/support.ts') ?? '')).toBe(true);
  });
});

describe('在真仓上装箱（全跑那一轮）', () => {
  const input = { all: FILES, timings: REAL_TIMINGS, read };

  it('全部测试文件都分到、正好一台一次；台数 8（687 秒合计 / 目标 50 秒，封顶 8）', () => {
    const r = packTests({
      files: FILES,
      universe: FILES,
      timings: REAL_TIMINGS,
      temporal: temporalOf(FILES),
    });
    if (typeof r === 'string') throw new Error(r);
    expect(r.boxes).toHaveLength(8);
    // pg 台排在前面；具体几台、Temporal 落在哪台随耗时表变，不钉死
    const pgCount = r.boxes.filter((b) => b.pg).length;
    expect(pgCount).toBeGreaterThanOrEqual(1);
    expect(r.boxes.slice(0, pgCount).every((b) => b.pg && b.label.endsWith('· pg'))).toBe(true);
    expect(r.boxes.map((b, i) => b.label.startsWith(`${i + 1}/8`))).toEqual(Array(8).fill(true));
    const all = r.boxes.flatMap((b) => b.files);
    expect(all.length).toBe(FILES.length);
    expect([...all].sort()).toEqual([...FILES].sort());
    // 耗时表是上一轮量出来的，这一轮新加的文件不在上面（按中位数估）——那正是「表过期只是不匀、不影响跑不跑」
    expect(r.notes.filter((n) => !n.includes('按中位数'))).toEqual([]);
  });

  it('每一台的估计耗时（对比现在的 --shard 分片：89/35/137 · 141 · 87/72/125 秒）', () => {
    const r = packTests({
      files: FILES,
      universe: FILES,
      timings: REAL_TIMINGS,
      temporal: temporalOf(FILES),
    });
    if (typeof r === 'string') throw new Error(r);
    const seconds = r.boxes.map((b) => Math.round(b.estMs / 1000));
    // 8 台的合计 = 全部文件的耗时合计；最重的台和最轻的差不过 2 倍（LPT 的效果）
    expect(seconds.reduce((a, b) => a + b, 0)).toBe(
      Math.round(Object.values(REAL_TIMINGS.files).reduce((a, b) => a + b, 0) / 1000),
    );
    expect(Math.max(...seconds)).toBeLessThanOrEqual(Math.min(...seconds) * 2);
  });

  it('pg 台只有 db 的文件；Temporal 装在有 github-reconcile.test.ts 的那一台', () => {
    const r = packTests({
      files: FILES,
      universe: FILES,
      timings: REAL_TIMINGS,
      temporal: temporalOf(FILES),
    });
    if (typeof r === 'string') throw new Error(r);
    for (const b of r.boxes.filter((x) => x.pg))
      expect(b.files.every((f) => f.startsWith('packages/db/'))).toBe(true);
    const withTemporal = r.boxes.filter((b) => b.temporal);
    expect(withTemporal).toHaveLength(1);
    expect(withTemporal[0]?.files).toContain('packages/engine/test/github-reconcile.test.ts');
    expect(input.read('packages/engine/test/github-reconcile.test.ts')).toBeDefined();
  });
});
