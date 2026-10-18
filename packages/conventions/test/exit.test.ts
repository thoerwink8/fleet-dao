// 入口收尾（../src/exit.ts）：runMain 设 process.exitCode、自然退出，不调 process.exit。真起 node 跑（设 exitCode 会改测试进程自己的
// 退出码，不能在这里直接调）；不带 --no-wasm-dynamic-tiering，Windows 上照样要拿到对的退出码。
import { describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

const EXIT = new URL('../src/exit.ts', import.meta.url).href;

/** 跑一段 ESM 代码，开头已经引入了 runMain、exitWith。父进程开了 FORCE_COLOR 时 console.log 会给数字上色，这里关掉，断言对的是退出码和名字。 */
const run = (code: string) => {
  // 展开 process.env 只留下写明的字段，FORCE_COLOR 会报不存在；标成 ProcessEnv 才能删掉父进程带来的上色。
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  return runChild(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { runMain, exitWith, ExitRequest } from ${JSON.stringify(EXIT)};\n${code}`,
    ],
    { env },
  );
};

describe('runMain：入口的退出码由它设，不调 process.exit', { timeout: 0 }, () => {
  it('回数字就是退出码；不回是 0', () => {
    expect(run('runMain(() => 3);').status).toBe(3);
    expect(run('runMain(() => undefined);').status).toBe(0);
  });

  it('exitWith 提前退出：后面的不再跑，退出码是它给的', () => {
    const r = run('runMain(() => { exitWith(2); console.log("不该打出来"); });');
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
  });

  it('异步的：await 之后 exitWith、回数字都认', () => {
    expect(
      run('runMain(async () => { await new Promise((r) => setTimeout(r, 5)); exitWith(4); });').status,
    ).toBe(4);
    expect(run('runMain(async () => { await null; return 5; });').status).toBe(5);
  });

  it('入口自己设的 exitCode：不回数字时不盖掉', () => {
    expect(run('runMain(() => { process.exitCode = 6; return undefined; });').status).toBe(6);
  });

  it('【故意造出的失败】别的错照样红：同步抛的打栈退出 1，异步抛的打出来退出 1，都不当成 0', () => {
    const sync = run('runMain(() => { throw new Error("同步坏了"); });');
    expect(sync.status).toBe(1);
    expect(sync.stderr).toContain('同步坏了');
    const later = run('runMain(async () => { await null; throw new Error("异步坏了"); });');
    expect(later.status).toBe(1);
    expect(later.stderr).toContain('异步坏了');
  });

  it('ExitRequest 带着退出码（入口里接住再抛的认它）', () => {
    expect(run('const e = new ExitRequest(7); console.log(e.code, e.name);').stdout.trim()).toBe(
      '7 ExitRequest',
    );
  });
});
