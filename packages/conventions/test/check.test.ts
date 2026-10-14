// pnpm check：参数解析、四样都跑完再统一判红、--all 走全量、算不出改到的测试时报失败。
import { describe, expect, it } from 'vitest';
import { check, failedFilesFromJson, judge, parseCheckArgs, type StepRun, withRetry } from '../src/check.ts';

function harness(results: Record<string, StepRun | Error>) {
  const ran: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let t = 0;
  const code = (argv: string[]) =>
    check({
      argv,
      steps: (all) =>
        ['biome', 'tsc', all ? 'vitest-all' : 'test-changed', 'hygiene'].map((name) => ({
          step: {
            name,
            run: () => {
              ran.push(name);
              const r = results[name] ?? { status: 0 };
              if (r instanceof Error) throw r;
              return r;
            },
          },
          notRunCodes: name === 'test-changed' ? [2, 3] : [],
        })),
      now: () => (t += 1000),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
  return { code, ran, out, err };
}

describe('parseCheckArgs', () => {
  it('无参数、--all、pnpm 传进来的 -- 都认；别的参数报错', () => {
    expect(parseCheckArgs([])).toEqual({ all: false });
    expect(parseCheckArgs(['--all'])).toEqual({ all: true });
    expect(parseCheckArgs(['--', '--all'])).toEqual({ all: true });
    expect(parseCheckArgs(['--bogus'])).toHaveProperty('error');
  });
});

describe('judge', () => {
  it('0 过；非 0 红；起不来、被信号杀掉、点名的退出码是没跑成', () => {
    expect(judge({ status: 0 }).verdict).toBe('pass');
    expect(judge({ status: 1 }).verdict).toBe('fail');
    expect(judge({ status: 2 }, [2]).verdict).toBe('not-run');
    expect(judge({ status: null, signal: 'SIGKILL' }).detail).toContain('SIGKILL');
    expect(judge({ status: null, error: new Error('boom') }).verdict).toBe('not-run');
  });
});

describe('check', () => {
  it('全过：退出 0，四样都跑、每样报耗时', () => {
    const h = harness({});
    expect(h.code([])).toBe(0);
    expect(h.ran).toEqual(['biome', 'tsc', 'test-changed', 'hygiene']);
    expect(h.out.filter((l) => l.includes('1.0s'))).toHaveLength(4);
  });

  it('第一样红也跑完后面三样，最后统一退出 1 并点名红的', () => {
    const h = harness({ biome: { status: 1 } });
    expect(h.code([])).toBe(1);
    expect(h.ran).toEqual(['biome', 'tsc', 'test-changed', 'hygiene']);
    expect(h.err.join('\n')).toContain('biome');
  });

  it('--all 跑全量测试、不跑改到的', () => {
    const h = harness({});
    expect(h.code(['--', '--all'])).toBe(0);
    expect(h.ran).toEqual(['biome', 'tsc', 'vitest-all', 'hygiene']);
  });

  it('算不出改到的测试（test:changed 退出 2）不当通过，后面照跑', () => {
    const h = harness({ 'test-changed': { status: 2 } });
    expect(h.code([])).toBe(1);
    expect(h.ran).toContain('hygiene');
    expect(h.err.join('\n')).toContain('没跑成');
  });

  it('某一步抛异常也算没跑成、不中断', () => {
    const h = harness({ tsc: new Error('起不来') });
    expect(h.code([])).toBe(1);
    expect(h.ran).toEqual(['biome', 'tsc', 'test-changed', 'hygiene']);
  });

  it('参数不对：退出 2，一样都不跑', () => {
    const h = harness({});
    expect(h.code(['--x'])).toBe(2);
    expect(h.ran).toEqual([]);
  });
});

describe('failedFilesFromJson', () => {
  it('只取 failed 的文件，换成相对仓根的 / 路径，去重排序', () => {
    const json = JSON.stringify({
      testResults: [
        { name: 'C:\\repo\\packages\\b\\test\\b.test.ts', status: 'failed' },
        { name: 'C:\\repo\\packages\\a\\test\\a.test.ts', status: 'passed' },
        { name: 'C:/repo/packages/a/test/z.test.ts', status: 'failed' },
      ],
    });
    expect(failedFilesFromJson(json, 'C:\\repo\\')).toEqual([
      'packages/a/test/z.test.ts',
      'packages/b/test/b.test.ts',
    ]);
  });

  it('读不出：返回原因，不返回空清单', () => {
    expect(failedFilesFromJson('{', '/r')).toContain('不是 JSON');
    expect(failedFilesFromJson('{}', '/r')).toContain('testResults');
  });
});

describe('withRetry（--all 的失败重跑）', () => {
  const mk = (first: StepRun, files: string[] | string, second: StepRun) => {
    const reran: string[][] = [];
    const out: string[] = [];
    const r = withRetry({
      run: () => first,
      failedFiles: () => files,
      rerun: (f) => {
        reran.push(f);
        return second;
      },
      out: (l) => out.push(l),
    });
    return { r, reran, out };
  };

  it('首轮过：不重跑', () => {
    const h = mk({ status: 0 }, ['a'], { status: 1 });
    expect(h.r).toEqual({ status: 0 });
    expect(h.reran).toEqual([]);
  });

  it('首轮红、重跑过：算过，救回的文件带出去', () => {
    const h = mk({ status: 1 }, ['packages/a/test/a.test.ts'], { status: 0 });
    expect(h.r).toEqual({ status: 0, rescued: ['packages/a/test/a.test.ts'] });
    expect(h.reran).toEqual([['packages/a/test/a.test.ts']]);
    expect(h.out.join('\n')).toContain('packages/a/test/a.test.ts');
  });

  it('重跑仍红：红，不带 rescued', () => {
    const h = mk({ status: 1 }, ['a'], { status: 1 });
    expect(h.r).toEqual({ status: 1 });
  });

  it('读不出失败清单、清单为空、起不来、被信号杀掉：原样红，不重跑', () => {
    for (const [first, files] of [
      [{ status: 1 }, '没写结果'],
      [{ status: 1 }, []],
      [{ status: null, signal: 'SIGKILL' }, ['a']],
      [{ status: null, error: new Error('x') }, ['a']],
    ] as [StepRun, string[] | string][]) {
      const h = mk(first, files, { status: 0 });
      expect(h.r).toBe(first);
      expect(h.reran).toEqual([]);
    }
  });

  it('check 汇总：救回的文件明说列出，步骤仍算过', () => {
    const out: string[] = [];
    const code = check({
      argv: ['--all'],
      steps: () => [
        { step: { name: 'vitest', run: () => ({ status: 0, rescued: ['packages/a/test/a.test.ts'] }) } },
      ],
      now: () => 0,
      out: (l) => out.push(l),
      err: () => {},
    });
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('首轮失败、重跑通过');
    expect(text).toContain('vitest：packages/a/test/a.test.ts');
  });
});
