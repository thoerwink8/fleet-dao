// pnpm check：参数解析、四样都跑完再统一判红、--all 走全量、算不出改到的测试时报失败。
import { describe, expect, it } from 'vitest';
import { check, judge, parseCheckArgs, type StepRun } from '../src/check.ts';

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
