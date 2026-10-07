// 刷新耗时表（src/test-timings.ts、bin/ci-timings.ts）：从 `gh run view --log` 认出每个测试文件的耗时、和旧表合并、写回仓里。
// 带【故意造出失败的】的：日志里认不出东西时必须退出 2、不写半张表。
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTimings, TIMINGS_FILE } from '../src/test-split.ts';
import { medianOfRuns, mergeTimings, parseRunLog, renderTimings } from '../src/test-timings.ts';
import { runChild } from './child.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 2026-10-03 主线 run 37119718244 日志里原样抠出来的几行（GitHub 存的日志里颜色码是字面的「^[」）。
 *  里面的路径是**那天**真跑过的文件，不保证今天还在仓里——只给纯判法（parseRunLog）用，不喂给会读仓的入口。 */
const REAL_LINES = [
  'test (engine 3/3)\tUNKNOWN STEP\t2026-10-03T11:28:50.1494879Z  ^[[32m✓^[[39m packages/engine/test/real/sessions.test.ts ^[[2m(^[[22m^[[2m28 tests^[[22m^[[2m)^[[22m^[[33m 27285^[[2mms^[[22m^[[39m',
  'test (engine 1/3)\tUNKNOWN STEP\t2026-10-03T11:28:35.0194389Z  ^[[32m✓^[[39m packages/engine/test/real/org-switch-sessions.test.ts ^[[2m(^[[22m^[[2m1 test^[[22m^[[2m)^[[22m^[[33m 3980^[[2mms^[[22m^[[39m',
];

/**
 * 喂给**入口**（真起子进程、会读仓里的测试文件清单）的样例路径：入口把「仓里没有的」文件当删掉的丢掉（test-timings.ts
 * 的 mergeTimings），所以这些路径必须此刻真在仓里。用一个必然在的：这个测试文件自己——它被删掉的时候这条测试也没了。
 * 2026-10-05 出过一次事：这里原先写的是 `packages/engine/test/real/sessions.test.ts`，#987 把它删了之后入口写出空表、
 * 还退出 0，主线红了半天——下面是这条不变量自己的钉子。
 */
const SELF = 'packages/conventions/test/test-timings.test.ts';

describe('从日志认耗时', () => {
  it('真日志的写法（字面的 ^[ 颜色码）、终端里的 ESC 颜色码、带跳过的、秒为单位的都认', () => {
    const esc = String.fromCharCode(27);
    const m = parseRunLog(
      [
        ...REAL_LINES,
        `test (2/8)\tx\t2026-10-03T00:00:00Z  ${esc}[32m✓${esc}[39m packages/api/test/a.test.ts (3 tests | 1 skipped) 1.5s`,
        'test (3/8)\tx\t2026-10-03T00:00:00Z  ✓ agents/test/skills.test.ts (12 tests) 88ms',
      ].join('\n'),
    );
    expect(Object.fromEntries(m)).toEqual({
      'packages/engine/test/real/sessions.test.ts': 27285,
      'packages/engine/test/real/org-switch-sessions.test.ts': 3980,
      'packages/api/test/a.test.ts': 1500,
      'agents/test/skills.test.ts': 88,
    });
  });

  it('只认 test (…) 那几台：lint 里 docs 那步跑的 agents/test 不混进来；不是测试文件的、同一个文件出现两次取大的', () => {
    const m = parseRunLog(
      [
        'lint\tdocs\t2026-10-03T00:00:00Z  ✓ agents/test/skills.test.ts (12 tests) 999ms',
        'test (1/2)\tx\tT  ✓ packages/api/src/helper.ts (1 test) 5ms',
        'test (1/2)\tx\tT  ✓ packages/api/test/b.test.ts (1 test) 10ms',
        'test (2/2)\tx\tT  ✓ packages/api/test/b.test.ts (1 test) 30ms',
      ].join('\n'),
    );
    expect(Object.fromEntries(m)).toEqual({ 'packages/api/test/b.test.ts': 30 });
  });

  it('日志里没有能认的：空表（入口据此退出 2，不写）', () => {
    expect(parseRunLog('changes\tx\tT  hello\n').size).toBe(0);
  });
});

describe('几轮取中位数', () => {
  it('每个文件取各轮的中位数（偶数轮取偏高的）；只在部分轮里出现的按出现的几轮取；一轮的抖动盖不住稳定值', () => {
    const m = medianOfRuns([
      new Map([
        ['a.test.ts', 5000],
        ['only-first.test.ts', 7],
      ]),
      new Map([['a.test.ts', 11000]]),
      new Map([['a.test.ts', 5200]]),
    ]);
    expect(Object.fromEntries(m ?? [])).toEqual({ 'a.test.ts': 5200, 'only-first.test.ts': 7 });
    expect(
      Object.fromEntries(medianOfRuns([new Map([['b.test.ts', 10]]), new Map([['b.test.ts', 30]])]) ?? []),
    ).toEqual({ 'b.test.ts': 30 });
    expect(medianOfRuns([])).toBeUndefined();
  });
});

describe('和旧表合并', () => {
  it('新量的盖住旧的；这轮没跑的沿用旧值；仓里已经没有的删掉；仓里没有的新文件不进表', () => {
    const r = mergeTimings(
      { source: 'old', files: { 'a.test.ts': 1, 'b.test.ts': 2, 'gone.test.ts': 3 } },
      new Map([
        ['a.test.ts', 10],
        ['new.test.ts', 20],
      ]),
      ['a.test.ts', 'b.test.ts', 'new.test.ts'],
      'new',
    );
    expect(r).toEqual({
      timings: { source: 'new', files: { 'a.test.ts': 10, 'b.test.ts': 2, 'new.test.ts': 20 } },
      updated: 1,
      kept: 1,
      dropped: ['gone.test.ts'],
      added: 1,
    });
  });

  it('写回的样子：说明、来源、按路径排好序、两格缩进、末尾换行', () => {
    const text = renderTimings({ source: 's', files: { 'b.test.ts': 2, 'a.test.ts': 1 } });
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text).files).toEqual({ 'a.test.ts': 1, 'b.test.ts': 2 });
    expect(text.indexOf('"a.test.ts"')).toBeLessThan(text.indexOf('"b.test.ts"'));
  });
});

describe('仓里那份表', () => {
  it('读得出来、有文件、每个都是正经毫秒数（表坏了装箱会全按估算，不会红，所以这里钉住）', () => {
    const t = parseTimings(readFileSync(join(ROOT, TIMINGS_FILE), 'utf8'));
    if (typeof t === 'string') throw new Error(t);
    expect(Object.keys(t.files).length).toBeGreaterThan(100);
  });
});

describe('入口 bin/ci-timings.ts（只用 --log-file，不连 GitHub）', { timeout: 0 }, () => {
  const bin = fileURLToPath(new URL('../src/bin/ci-timings.ts', import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), 'ci-timings-'));
  const run = (args: string[]) => runChild(process.execPath, [bin, ...args]);

  it('故意造出失败的哨兵：喂给入口的样例路径（SELF）必须真在仓里——不在就是这个样例烂了，不是代码坏了', () => {
    // 上面那条注释说的 2026-10-05 事故：样例路径被删，入口于是把量到的文件全当「仓里已没有」丢掉、写空表还退出 0。
    // 这条先炸，报的是「样例过时了」，不是让人去猜「files 是空的」是什么意思。
    expect(existsSync(join(ROOT, SELF)), `${SELF} 不在了：把本文件里 SELF 换成另一个真在仓里的测试文件`).toBe(
      true,
    );
  });

  it('认得出：写到 --out，格式就是仓里那份的样子', () => {
    const log = join(tmp, 'ok.log');
    writeFileSync(log, `test (1/2)\tx\t2026-10-04T00:00:00Z  ✓ ${SELF} (10 tests) 27285ms\n`);
    const out = join(tmp, 'timings.json');
    const r = run(['--log-file', log, '--out', out]);
    expect(r.status, r.stderr).toBe(0);
    const t = parseTimings(readFileSync(out, 'utf8'));
    if (typeof t === 'string') throw new Error(t);
    expect(t.files[SELF]).toBe(27285);
    expect(t.source).toContain('日志文件 ok.log');
    expect(t.source).toContain('共 1 轮取中位数');
  });

  it('重复给 --log-file：取各轮的中位数；其中一轮认不出一个文件就整个退出 2、不写（不悄悄少算一轮）', () => {
    const line = (ms: number) => `test (1/2)\tx\t2026-10-04T00:00:00Z  ✓ ${SELF} (10 tests) ${ms}ms`;
    const logs = [4000, 9000, 4400].map((ms, i) => {
      const f = join(tmp, `multi-${i}.log`);
      writeFileSync(f, `${line(ms)}\n`);
      return f;
    });
    const out = join(tmp, 'multi.json');
    const r = run([...logs.flatMap((f) => ['--log-file', f]), '--out', out]);
    expect(r.status, r.stderr).toBe(0);
    const t = parseTimings(readFileSync(out, 'utf8'));
    if (typeof t === 'string') throw new Error(t);
    expect(t.files[SELF]).toBe(4400);
    expect(t.source).toContain('共 3 轮取中位数');

    const empty = join(tmp, 'multi-empty.log');
    writeFileSync(empty, 'changes\tx\tT  nothing here\n');
    const out2 = join(tmp, 'multi-never.json');
    const bad = run(['--log-file', logs[0] as string, '--log-file', empty, '--out', out2]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('multi-empty.log');
    expect(existsSync(out2)).toBe(false);
  });

  it('【故意造出失败的】量到的文件一个都不在仓里（样例烂了、或仓被删空）：退出 2、一个字都不写，绝不写空表', () => {
    const log = join(tmp, 'stale.log');
    writeFileSync(
      log,
      'test (1/2)\tx\t2026-10-04T00:00:00Z  ✓ packages/engine/test/real/sessions.test.ts (28 tests) 27285ms\n',
    );
    const out = join(tmp, 'stale.json');
    const r = run(['--log-file', log, '--out', out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('一个都不在仓里');
    expect(existsSync(out)).toBe(false);
  });

  it('【故意造出失败的】日志里一个文件都认不出、日志读不到、参数不对：退出 2，不写半张表', () => {
    const empty = join(tmp, 'empty.log');
    writeFileSync(empty, 'changes\tx\tT  nothing here\n');
    const out = join(tmp, 'never.json');
    const r = run(['--log-file', empty, '--out', out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('一个测试文件的耗时都没认出来');
    expect(existsSync(out)).toBe(false);
    expect(run(['--log-file', join(tmp, '没有这个.log'), '--out', out]).status).toBe(2);
    expect(run(['--weird']).status).toBe(2);
    expect(run(['--run', 'abc', '--out', out]).status).toBe(2);
    expect(existsSync(out)).toBe(false);
  });
});

/** 假的 gh：记下参数，运行列表按给的回，测试台数和日志固定。不连 GitHub。 */
function fakeGh(dir: string, runs: { databaseId: number; event?: string }[]): NodeJS.ProcessEnv {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const calls = join(dir, 'calls.log');
  const gh = join(bin, 'gh');
  const logLine = `test (1/4)\tx\t2026-10-04T00:00:00Z  ✓ ${SELF} (10 tests) 100ms\n`;
  writeFileSync(
    gh,
    [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(calls)}, \`\${JSON.stringify(args)}\\n\`);`,
      `const runs = ${JSON.stringify(runs)};`,
      "if (args[0] === 'run' && args[1] === 'list') {",
      '  process.stdout.write(JSON.stringify(runs));',
      '  process.exit(0);',
      '}',
      "if (args.includes('--jq')) {",
      "  process.stdout.write('4\\n');",
      '  process.exit(0);',
      '}',
      "if (args.includes('--log')) {",
      `  process.stdout.write(${JSON.stringify(logLine)});`,
      '  process.exit(0);',
      '}',
      "process.stderr.write('没想到的 gh：' + args.join(' '));",
      'process.exit(1);',
      '',
    ].join('\n'),
  );
  chmodSync(gh, 0o755);
  return { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, GH_CALLS: calls };
}

describe('入口不给 --run：只取 PR 触发的运行（假 gh，不连 GitHub）', { timeout: 0 }, () => {
  const bin = fileURLToPath(new URL('../src/bin/ci-timings.ts', import.meta.url));

  function go(runs: { databaseId: number; event?: string }[]) {
    const dir = mkdtempSync(join(tmpdir(), 'ci-timings-gh-'));
    const env = fakeGh(dir, runs);
    const out = join(dir, 'timings.json');
    const r = runChild(process.execPath, [bin, '--out', out], { env });
    const calls = readFileSync(env.GH_CALLS ?? '', 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as string[]);
    return { r, out, calls };
  }

  it('【故意造出失败的】运行列表混进 push：退出 2、报没查成，不拿这批运行刷表', () => {
    // 名单里有能刷的 PR 运行。混进 push 仍要整批停下：滤掉 push、只用旁边的 PR 刷，这条就绿不了。
    const { r, out } = go([
      { databaseId: 11, event: 'pull_request' },
      { databaseId: 13, event: 'push' },
    ]);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/没查成.*13.*不是 PR/);
    expect(existsSync(out)).toBe(false);
  });

  it('只有 PR 运行：取运行列表带 event=pull_request，照常刷表', () => {
    const { r, out, calls } = go([
      { databaseId: 11, event: 'pull_request' },
      { databaseId: 12, event: 'pull_request' },
    ]);
    expect(r.status, r.stderr).toBe(0);
    const list = calls.find((a) => a[0] === 'run' && a[1] === 'list');
    if (list === undefined) throw new Error(`没有 gh run list：${JSON.stringify(calls)}`);
    expect(list[list.indexOf('--event') + 1]).toBe('pull_request');
    const t = parseTimings(readFileSync(out, 'utf8'));
    if (typeof t === 'string') throw new Error(t);
    expect(t.files[SELF]).toBe(100);
    expect(t.source).toContain('ci.yml run 11');
    expect(t.source).toContain('ci.yml run 12');
    expect(t.source).toContain('共 2 轮取中位数');
  });
});
