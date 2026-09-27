// 统一错误处理（src/http.ts）：#364 一直没查出根因，起因之一是全局错误处理记日志时只打 `err.stack`——
// drizzle 把驱动的错包成「Failed query: …」，真正的 SQLSTATE、驱动原话都在 err.cause 里，`err.stack` 不会
// 自动带上 cause 链（只有 console.error/util.inspect 才认），日志里就只剩外层那句，看不出为什么。
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { errorHandler, fullStack } from '../src/http.ts';
import type { Logger } from '../src/ports.ts';

function fakeLog(): Logger & { errors: Array<[string, Record<string, unknown> | undefined]> } {
  const errors: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    info: () => {},
    warn: () => {},
    error: (message, fields) => {
      errors.push([message, fields]);
    },
    errors,
  };
}

describe('fullStack：串起 err.cause 链，不被 Error.prototype.stack 吞掉', () => {
  it('没有 cause：就是这个错误自己的 stack', () => {
    const err = new Error('boom');
    expect(fullStack(err)).toBe(err.stack);
  });

  it('有 cause：拼上一层「caused by」，内层的 message 看得到', () => {
    const inner = new Error('connection terminated unexpectedly');
    const outer = new Error('Failed query: select 1 from tasks', { cause: inner });
    const out = fullStack(outer);
    expect(out).toContain('Failed query: select 1 from tasks');
    expect(out).toContain('caused by:');
    expect(out).toContain('connection terminated unexpectedly');
  });

  it('【故意造出的失败】cause 链绕了很多层（造错的代码写坏了才会这样）：截断，不无限递归拖死日志', () => {
    let err: Error = new Error('root cause');
    for (let i = 0; i < 20; i++) err = new Error(`wrapped ${i}`, { cause: err });
    expect(fullStack(err)).toContain('截断');
  });

  it('cause 不是 Error（驱动偶尔直接抛一个字符串）：转成字符串带出来，不炸', () => {
    const outer = new Error('outer', { cause: 'raw driver string' });
    expect(fullStack(outer)).toContain('raw driver string');
  });
});

describe('errorHandler：未处理的错误记日志时带上完整 cause 链', () => {
  it('查库的错（Failed query 包着真正的驱动错误）撞上全局错误处理：日志里看得到 cause 里的原话，不止外层那句', async () => {
    const log = fakeLog();
    const app = new Hono();
    app.onError(errorHandler(log));
    app.get('/x', () => {
      throw new Error('Failed query: select 1 from tasks', {
        cause: Object.assign(new Error('connection terminated unexpectedly'), { code: '57014' }),
      });
    });
    const res = await app.request('/x');
    expect(res.status).toBe(500);
    expect(log.errors).toHaveLength(1);
    const entry = log.errors[0];
    if (!entry) throw new Error('没记到日志');
    const [message, fields] = entry;
    expect(message).toBe('未处理的错误');
    expect(String(fields?.error)).toContain('Failed query: select 1 from tasks');
    expect(String(fields?.error)).toContain('connection terminated unexpectedly'); // #364：以前这一句会被吞掉
  });
});
