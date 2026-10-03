// test-graph-audit.ts：流水对图的分级（会选漏 / 交回的 / 目录列举）、读不到认不出的流水抛错、真跑一轮 vitest 记得到东西。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { fsRepo } from '../src/repo.ts';
import { buildTestGraph, listRepoFiles, type TestGraph } from '../src/test-graph.ts';
import { compareTrace, readTrace, realMisses, runTrace, type TraceRecord } from '../src/test-graph-audit.ts';
import { memRepo } from './helpers.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
  .replace(/\\/g, '/')
  .replace(/\/$/, '');
const FAKE = '/work/repo';

const repo = memRepo({
  'package.json': '{}',
  'docs/ops.md': '端口表',
  'packages/a/package.json': JSON.stringify({ name: '@x/a' }),
  'packages/a/src/lib.ts': 'export const lib = 1;',
  'packages/a/src/other.ts': 'export const other = 1;',
  'packages/a/src/uses-other.ts': `import { other } from './other.ts';`,
  'packages/a/src/index.ts': `export * from './uses-other.ts';`,
  'packages/a/data/x.json': '{}',
  'packages/a/test/lib.test.ts': `import { lib } from '../src/lib.ts';\nconst d = new URL('../data/', import.meta.url);`,
  'packages/a/test/second.test.ts': `import { lib } from '../src/lib.ts';`,
});
let graph: TestGraph;
beforeAll(() => {
  graph = buildTestGraph(repo);
});

const rec = (test: string, read: string[], extra: Partial<TraceRecord> = {}): TraceRecord => ({
  testFile: `${FAKE}/${test}`,
  root: FAKE,
  loaded: [`${FAKE}/${test}`],
  read: read.map((r) => `${FAKE}/${r}`),
  listed: [],
  ...extra,
});

describe('compareTrace', () => {
  it('图里有的、目录边盖住的不算漏', () => {
    const r = compareTrace(
      [rec('packages/a/test/lib.test.ts', ['packages/a/src/lib.ts', 'packages/a/data/x.json'])],
      graph,
      FAKE,
      { scope: ['packages/a/test/lib.test.ts'] },
    );
    expect(realMisses(r)).toEqual([]);
    expect(r.missingTrace).toEqual([]);
  });

  it('运行时真读了、图里没有、改了会由图做主的文件：记成会选漏的漏边', () => {
    const r = compareTrace(
      [rec('packages/a/test/lib.test.ts', ['packages/a/src/uses-other.ts'])],
      graph,
      FAKE,
    );
    expect(realMisses(r).map((m) => [m.test, m.files])).toEqual([
      ['packages/a/test/lib.test.ts', ['packages/a/src/uses-other.ts']],
    ]);
  });

  it('读了改了本来就交回的文件（根 package.json、没人读的文档）、列了目录：只供参考，不算会选漏', () => {
    const r = compareTrace(
      [
        rec('packages/a/test/lib.test.ts', ['package.json', 'docs/ops.md'], {
          listed: [`${FAKE}/packages/a/src`],
        }),
      ],
      graph,
      FAKE,
    );
    expect(realMisses(r)).toEqual([]);
    const m = r.results.find((x) => x.test === 'packages/a/test/lib.test.ts');
    expect(m?.handedBack).toEqual(['docs/ops.md', 'package.json']);
    expect(m?.dirs).toEqual(['packages/a/src']);
  });

  it('探目录、探不存在的路径、node_modules 里的：不算读', () => {
    const r = compareTrace(
      [rec('packages/a/test/lib.test.ts', ['packages/a', 'packages/a/nope.ts', 'node_modules/x/index.js'])],
      graph,
      FAKE,
    );
    expect(r.results[0]).toMatchObject({ files: [], handedBack: [], dirs: [] });
  });

  it('测试把仓拷到别处跑（流水的根不同）：那批不参与比对', () => {
    const r = compareTrace(
      [rec('packages/a/test/lib.test.ts', ['packages/a/src/uses-other.ts'], { root: '/tmp/copy' })],
      graph,
      FAKE,
    );
    expect(r.results).toEqual([]);
  });

  it('该核却没记到流水的测试：没查成，单独列出（不当没漏）', () => {
    const r = compareTrace([rec('packages/a/test/lib.test.ts', [])], graph, FAKE, {
      scope: ['packages/a/test'],
    });
    expect(r.missingTrace).toEqual(['packages/a/test/second.test.ts']);
  });

  it('子进程的记录算到起它的测试头上', () => {
    const r = compareTrace(
      [
        rec('packages/a/test/second.test.ts', []),
        {
          ...rec('packages/a/test/second.test.ts', ['packages/a/src/uses-other.ts']),
          child: true,
          loaded: [],
        },
      ],
      graph,
      FAKE,
    );
    expect(realMisses(r).map((m) => m.files)).toEqual([['packages/a/src/uses-other.ts']]);
  });
});

describe('readTrace：读不到、认不出抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-test-'));
  it('文件不存在', () => {
    expect(() => readTrace([join(dir, 'nope.jsonl')])).toThrow(/读不到流水文件/);
  });
  it('有一行不是 JSON', () => {
    const f = join(dir, 'bad.jsonl');
    writeFileSync(f, '{"testFile":"a","loaded":[],"read":[],"listed":[]}\n{oops\n');
    expect(() => readTrace([f])).toThrow(/不是 JSON/);
  });
  it('记录的形状不对', () => {
    const f = join(dir, 'shape.jsonl');
    writeFileSync(f, '{"testFile":"a","loaded":"x"}\n');
    expect(() => readTrace([f])).toThrow(/认不出/);
  });
});

describe('真跑一轮（vitest + 追踪钩子）', () => {
  it('记得到测试读的仓内文件，也记得到洗过 env 的子进程', async () => {
    const tests = ['packages/conventions/test/pr-links.test.ts', 'packages/cli/test/bin.test.ts'];
    const run = await runTrace(ROOT, tests);
    const pr = run.records.filter((r) => r.testFile.endsWith('pr-links.test.ts'));
    expect(
      pr
        .flatMap((r) => r.read)
        .some((p) => p.replace(/\\/g, '/').endsWith('.github/pull_request_template.md')),
    ).toBe(true);
    // cli 的 bin 测试给子进程只留了 PATH：追踪照样接上，子进程加载了 bin/fleet
    const child = run.records.filter((r) => r.child === true && r.testFile.endsWith('bin.test.ts'));
    expect(child.length).toBeGreaterThan(0);
    expect(
      child.flatMap((r) => r.loaded).some((p) => p.replace(/\\/g, '/').endsWith('packages/cli/bin/fleet')),
    ).toBe(true);
    const realGraph = buildTestGraph(fsRepo(ROOT), { files: listRepoFiles(fsRepo(ROOT)) });
    const report = compareTrace(run.records, realGraph, ROOT, { scope: tests });
    expect(report.missingTrace).toEqual([]);
    expect(realMisses(report).map((m) => [m.test, m.files])).toEqual([]);
  }, 180_000);
});
