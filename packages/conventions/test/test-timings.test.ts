// 刷新耗时表（src/test-timings.ts、bin/ci-timings.ts）：从 `gh run view --log` 认出每个测试文件的耗时、和旧表合并、写回仓里。
// 带【故意造出的失败】的：日志里认不出东西时必须退出 2、不写半张表。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTimings, TIMINGS_FILE } from '../src/test-split.ts';
import { mergeTimings, parseRunLog, renderTimings } from '../src/test-timings.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 2026-10-03 主线 run 37119718244 日志里原样抠出来的几行（GitHub 存的日志里颜色码是字面的「^[」）。 */
const REAL_LINES = [
  'test (engine 3/3)\tUNKNOWN STEP\t2026-10-03T11:28:50.1494879Z  ^[[32m✓^[[39m packages/engine/test/real/sessions.test.ts ^[[2m(^[[22m^[[2m28 tests^[[22m^[[2m)^[[22m^[[33m 27285^[[2mms^[[22m^[[39m',
  'test (engine 1/3)\tUNKNOWN STEP\t2026-10-03T11:28:35.0194389Z  ^[[32m✓^[[39m packages/engine/test/real/org-switch-sessions.test.ts ^[[2m(^[[22m^[[2m1 test^[[22m^[[2m)^[[22m^[[33m 3980^[[2mms^[[22m^[[39m',
];

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

describe('合并、写回', () => {
  it('新量的盖住旧的；这一轮没跑的沿用旧值；仓里已没有的删掉；新加的记上', () => {
    const r = mergeTimings(
      { source: 'old', files: { 'a.test.ts': 1, 'b.test.ts': 2, 'gone.test.ts': 3 } },
      new Map([
        ['a.test.ts', 10],
        ['new.test.ts', 20],
        ['not-in-repo.test.ts', 30],
      ]),
      ['a.test.ts', 'b.test.ts', 'new.test.ts'],
      'run 9',
    );
    expect(r.timings).toEqual({
      source: 'run 9',
      files: { 'a.test.ts': 10, 'b.test.ts': 2, 'new.test.ts': 20 },
    });
    expect(r).toMatchObject({ updated: 1, kept: 1, added: 1, dropped: ['gone.test.ts'] });
  });

  it('仓里那份耗时表就是 renderTimings 写出来的样子（排好序、说明一致），每个文件都还在仓里', () => {
    const text = readFileSync(join(ROOT, TIMINGS_FILE), 'utf8');
    const t = parseTimings(text);
    if (typeof t === 'string') throw new Error(t);
    expect(renderTimings(t)).toBe(text);
    expect(Object.keys(t.files).length).toBeGreaterThan(300);
  });
});

describe('入口 bin/ci-timings.ts（只用 --log-file，不连 GitHub）', () => {
  const bin = fileURLToPath(new URL('../src/bin/ci-timings.ts', import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), 'ci-timings-'));
  const run = (args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

  it('认得出：写到 --out，格式就是仓里那份的样子', () => {
    const log = join(tmp, 'ok.log');
    writeFileSync(log, `${REAL_LINES.join('\n')}\n`);
    const out = join(tmp, 'timings.json');
    const r = run(['--log-file', log, '--out', out]);
    expect(r.status, r.stderr).toBe(0);
    const t = parseTimings(readFileSync(out, 'utf8'));
    if (typeof t === 'string') throw new Error(t);
    expect(t.files['packages/engine/test/real/sessions.test.ts']).toBe(27285);
    expect(t.source).toBe('日志文件 ok.log');
  });

  it('【故意造出的失败】日志里一个文件都认不出、日志读不到、参数不对：退出 2，不写半张表', () => {
    const empty = join(tmp, 'empty.log');
    writeFileSync(empty, 'changes\tx\tT  nothing here\n');
    const out = join(tmp, 'never.json');
    const r = run(['--log-file', empty, '--out', out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('一个测试文件的耗时都没认出来');
    expect(existsSync(out)).toBe(false);
    expect(run(['--log-file', join(tmp, '没有这个.log'), '--out', out]).status).toBe(2);
    expect(run(['--weird']).status).toBe(2);
    expect(existsSync(out)).toBe(false);
  });
});
