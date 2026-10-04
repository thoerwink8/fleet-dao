// 共用小工具（util.ts）：每个函数的行为，加一道「工作流沙箱里也能用」的守卫（零 import、不碰 Node 专有 API）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortableSleep, asRecord, errMessage, isRecord, sleep } from '../src/util.ts';

describe('errMessage', () => {
  it('Error 取 message；子类也一样', () => {
    expect(errMessage(new Error('boom'))).toBe('boom');
    expect(errMessage(new TypeError('bad type'))).toBe('bad type');
  });

  it('不是 Error 也要有可读文字，不吞成空：字符串、对象、数字、null、undefined', () => {
    expect(errMessage('text')).toBe('text');
    expect(errMessage(42)).toBe('42');
    expect(errMessage(null)).toBe('null');
    expect(errMessage(undefined)).toBe('undefined');
    expect(errMessage({ code: 'E' })).toBe('[object Object]');
  });

  it('和全仓原来的写法逐一相同', () => {
    const old = (err: unknown) => (err instanceof Error ? err.message : String(err));
    for (const v of [new Error('x'), 'y', 1, null, undefined, {}, [1, 2], Symbol.iterator.description]) {
      expect(errMessage(v)).toBe(old(v));
    }
  });
});

describe('isRecord / asRecord', () => {
  it('对象算；数组、null、字符串、数字、函数都不算', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    for (const v of [[], [1], null, undefined, 'x', 0, true, () => 1]) expect(isRecord(v)).toBe(false);
  });

  it('asRecord：对象原样给，别的给 null', () => {
    const o = { a: 1 };
    expect(asRecord(o)).toBe(o);
    expect(asRecord([])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord('x')).toBeNull();
  });
});

describe('sleep / abortableSleep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sleep 用全局定时器：假时钟能快进', async () => {
    vi.useFakeTimers();
    let woke = false;
    const p = sleep(10_000).then(() => {
      woke = true;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(woke).toBe(true);
  });

  it('abortableSleep：到点正常醒', async () => {
    vi.useFakeTimers();
    const c = new AbortController();
    const p = abortableSleep(1_000, c.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toBeUndefined();
  });

  it('abortableSleep：叫停时 reject，原因取 signal.reason', async () => {
    vi.useFakeTimers();
    const c = new AbortController();
    const p = abortableSleep(60_000, c.signal);
    const why = new Error('停');
    c.abort(why);
    await expect(p).rejects.toBe(why);
  });

  it('abortableSleep：已经叫停的直接 reject，原因是 signal.reason', async () => {
    const c = new AbortController();
    c.abort();
    await expect(abortableSleep(10, c.signal)).rejects.toBe(c.signal.reason);
  });

  it('abortableSleep：叫停之后不再有残留定时器（醒的那一刻不会再 resolve 一次）', async () => {
    vi.useFakeTimers();
    const c = new AbortController();
    const p = abortableSleep(1_000, c.signal);
    c.abort();
    await expect(p).rejects.toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ——「工作流沙箱里也能用」的守卫——
// Temporal 沙箱里只许 import 不引用 Node / DOM API 的代码，Date、setTimeout、Math.random 被替换成确定性版本
// （https://docs.temporal.io/develop/typescript/workflows/basics）。util.ts 要是 import 了什么、碰了 Node 专有 API，
// 引擎的工作流一 import 它就 bundle 不过或者重放不一致。

/** 去掉注释和字符串后，返回不该出现在 util.ts 里的东西（每条一句话）；空数组 = 干净。 */
export function sandboxProblems(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  const rules: [RegExp, string][] = [
    [/^\s*import\b/m, '有 import'],
    [/\bimport\s*\(/, '有动态 import()'],
    [/^\s*export\s[^;]*\bfrom\b/m, '有 export … from'],
    [/\brequire\s*\(/, '有 require()'],
    [/\bprocess\b/, '碰了 process'],
    [/\bBuffer\b/, '碰了 Buffer'],
    [/\bDate\.now\s*\(/, '用了 Date.now()'],
    [/\bnew Date\s*\(\s*\)/, '用了 new Date()（取当前时间）'],
    [/\bMath\.random\b/, '用了 Math.random'],
    [/\b(?:window|document|localStorage|navigator)\b/, '碰了浏览器全局'],
    [/\bsetInterval\b/, '用了 setInterval'],
  ];
  return rules.filter(([re]) => re.test(code)).map(([, why]) => why);
}

describe('util.ts 守卫：工作流沙箱里也能用', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/util.ts', import.meta.url)), 'utf8');

  it('util.ts 没有 import、不碰 Node 专有 API、不取当前时间、不用随机数', () => {
    expect(sandboxProblems(source)).toEqual([]);
  });

  it('【故意造出的失败】各种违规写法都认得出（认不出就是守卫形同虚设）', () => {
    expect(sandboxProblems("import { x } from 'node:fs';")).toContain('有 import');
    expect(sandboxProblems("const m = await import('node:fs');")).toContain('有动态 import()');
    expect(sandboxProblems("export * from './other.ts';")).toContain('有 export … from');
    expect(sandboxProblems("const f = require('fs');")).toContain('有 require()');
    expect(sandboxProblems('const e = process.env.X;')).toContain('碰了 process');
    expect(sandboxProblems('const t = Date.now();')).toContain('用了 Date.now()');
    expect(sandboxProblems('const t = new Date();')).toContain('用了 new Date()（取当前时间）');
    expect(sandboxProblems('const r = Math.random();')).toContain('用了 Math.random');
    expect(sandboxProblems('const b = Buffer.from("x");')).toContain('碰了 Buffer');
  });

  it('注释和字符串里提到这些词不算违规（只看代码）', () => {
    expect(sandboxProblems("// import process Date.now()\nconst a = 'import x from y';")).toEqual([]);
  });
});
