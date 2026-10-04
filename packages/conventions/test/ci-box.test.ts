// CI 一台测试（src/ci-box.ts）：认矩阵里那一份、跑完核对「实际跑的 == 分到的」。
// vitest 的位置参数是子串过滤，交给它清单也不等于它正好跑这些——这一步是最后一道。
// 带【故意造出的失败】的每一条都是造一份对不上的结果，核对必须红并点名：平时绿着看不出它还在不在拦。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseBox, verifyRun } from '../src/ci-box.ts';
import { CACHE_SCHEMA } from '../src/ci-cache.ts';

const A = 'packages/api/test/a.test.ts';
const B = 'packages/api/test/b.test.ts';
const C = 'packages/api/test/c.test.ts';
const box = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ label: '2/5', files: [B, A], estMs: 12_000, pg: false, temporal: false, ...over });
const state = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: CACHE_SCHEMA,
    key: 'a'.repeat(64),
    box: [A, B],
    collected: { [A]: '1'.repeat(64), [B]: '2'.repeat(64) },
    mode: 'files',
    covered: [A],
    run: [B],
    ...over,
  });

describe('认矩阵里那一台', () => {
  it('名字、文件清单（排好序）、估计耗时、两个开关', () => {
    expect(parseBox(box())).toEqual({
      label: '2/5',
      files: [A, B],
      estMs: 12_000,
      pg: false,
      temporal: false,
    });
  });

  it('【故意造出的失败】认不出就说为什么：不是 JSON、没名字、没文件、不是测试文件、重复、带空白、开关不是真假值', () => {
    const bad: [string, string][] = [
      ['不是 JSON', '{'],
      ['数组', '[]'],
      ['没名字', box({ label: '' })],
      ['没文件', box({ files: [] })],
      ['不是测试文件', box({ files: ['packages/api/src/a.ts'] })],
      ['像参数', box({ files: ['--shard=1/2'] })],
      ['重复', box({ files: [A, A] })],
      ['带空白', box({ files: ['packages/api/test/a b.test.ts'] })],
      ['开关不是真假值', box({ pg: 'true' })],
      ['没有估计耗时', box({ estMs: undefined })],
    ];
    for (const [what, text] of bad) expect(typeof parseBox(text), what).toBe('string');
  });
});

describe('跑完核对：实际跑的 == 该跑的', () => {
  it('没走缓存（主线、缓存没开）、all：报告里正好是分到的那几个，过', () => {
    for (const mode of ['', 'all'] as const) {
      const r = verifyRun({ assigned: [A, B], mode, reported: new Set([A, B]), stateText: undefined });
      expect(r.ok, mode).toBe(true);
      expect(r.lines.join()).toContain('正好对上');
    }
  });

  it('【故意造出的失败】少跑了（分到了、报告里没有）：红，点名哪些', () => {
    const r = verifyRun({ assigned: [A, B], mode: '', reported: new Set([A]), stateText: undefined });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toContain('少跑了 1 个');
    expect(r.problems.join()).toContain(B);
  });

  it('【故意造出的失败】多跑了（vitest 的子串过滤拉上了别的台的文件）：红，点名哪些', () => {
    const r = verifyRun({
      assigned: [A, B],
      mode: 'all',
      reported: new Set([A, B, C]),
      stateText: undefined,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toContain('多跑了 1 个');
    expect(r.problems.join()).toContain(C);
  });

  it('【故意造出的失败】没有报告（vitest 没跑成、没吐报告）：红，不当成跑过了', () => {
    const r = verifyRun({ assigned: [A], mode: '', reported: undefined, stateText: undefined });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toContain('没有 vitest 的报告');
  });

  it('files：缓存盖住的 + 这一轮跑的 == 分到的，跑的正好是交接文件里要跑的，过', () => {
    const r = verifyRun({ assigned: [A, B], mode: 'files', reported: new Set([B]), stateText: state() });
    expect(r.ok).toBe(true);
    expect(r.lines.join()).toContain('缓存盖住 1 个');
  });

  it('【故意造出的失败】files：盖住的加要跑的没盖满分到的（交接文件被改过）、或多出别的台的：红', () => {
    const lost = verifyRun({
      assigned: [A, B, C],
      mode: 'files',
      reported: new Set([B]),
      stateText: state(),
    });
    expect(lost.ok).toBe(false);
    expect(lost.problems.join()).toContain('既没跑也没被缓存盖住');
    const foreign = verifyRun({
      assigned: [B],
      mode: 'files',
      reported: new Set([B]),
      stateText: state(),
    });
    expect(foreign.ok).toBe(false);
    expect(foreign.problems.join()).toContain('不是分到这一台的');
    // 交接文件里既算盖住又算要跑
    const both = verifyRun({
      assigned: [A, B],
      mode: 'files',
      reported: new Set([A, B]),
      stateText: state({ covered: [A, B], run: [A, B] }),
    });
    expect(both.ok).toBe(false);
  });

  it('【故意造出的失败】files：交接文件读不出 / 模式对不上：红（不知道哪些是盖住的，不能当跑全了）', () => {
    for (const text of [undefined, '{', state({ schema: 999 })]) {
      expect(verifyRun({ assigned: [A, B], mode: 'files', reported: new Set([B]), stateText: text }).ok).toBe(
        false,
      );
    }
    const r = verifyRun({
      assigned: [A, B],
      mode: 'files',
      reported: new Set([B]),
      stateText: state({ mode: 'none' }),
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toContain('模式');
  });

  it('none：缓存盖住了整台、没跑 vitest，没有报告才对；报告里有东西反而红', () => {
    const st = state({ mode: 'none', covered: [A, B], run: [] });
    expect(verifyRun({ assigned: [A, B], mode: 'none', reported: undefined, stateText: st }).ok).toBe(true);
    const ran = verifyRun({ assigned: [A, B], mode: 'none', reported: new Set([A]), stateText: st });
    expect(ran.ok).toBe(false);
  });
});

describe('入口 bin/ci-box.ts', () => {
  const bin = fileURLToPath(new URL('../src/bin/ci-box.ts', import.meta.url));
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  const tmp = mkdtempSync(join(tmpdir(), 'ci-box-'));
  const run = (args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
  const report = (files: string[]) => {
    const p = join(tmp, `report-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(
      p,
      JSON.stringify({
        success: true,
        numFailedTests: 0,
        numFailedTestSuites: 0,
        testResults: files.map((f) => ({
          name: `${ROOT}/${f}`,
          status: 'passed',
          assertionResults: [{ status: 'passed' }],
        })),
      }),
    );
    return p;
  };

  it('files：清单一行一个写出来，日志里打出几个文件、估几秒', () => {
    const out = join(tmp, 'files.txt');
    const r = run(['files', '--box', box(), '--out', out]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('分到 2 个测试文件');
    expect(r.stdout).toContain('估 12 秒');
  });

  it('verify：对得上退出 0；对不上退出 1 并点名', () => {
    expect(run(['verify', '--box', box(), '--mode', '', '--report', report([A, B])]).status).toBe(0);
    const bad = run(['verify', '--box', box(), '--mode', '', '--report', report([A])]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain(B);
  });

  it('【故意造出的失败】参数不对、矩阵认不出、报告读不出、模式认不出：退出 2，不当通过', () => {
    expect(run([]).status).toBe(2);
    expect(run(['nope', '--box', box()]).status).toBe(2);
    expect(run(['verify', '--box', '{']).status).toBe(2);
    expect(run(['files', '--box', box()]).status).toBe(2);
    const garbage = join(tmp, 'garbage.json');
    writeFileSync(garbage, '{');
    expect(run(['verify', '--box', box(), '--mode', '', '--report', garbage]).status).toBe(2);
    expect(run(['verify', '--box', box(), '--mode', 'weird', '--report', report([A, B])]).status).toBe(2);
    // 报告文件根本不在：verify 判红（没报告 = 不知道跑了什么）
    expect(run(['verify', '--box', box(), '--mode', '', '--report', join(tmp, 'none.json')]).status).toBe(1);
  });
});
