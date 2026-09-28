// Cursor CLI 自己的原生钩子（~/.cursor/hooks.json，packages/agents-sync 的 targets.ts 那条 format:'flat' 的登记）：
// payload 没有 tool_name，靠 hook_event_name 认（beforeShellExecution、beforeReadFile），字段名也和 Claude 那套
// （tool_input 套一层）不一样，见 agents/hooks/pretool.mjs 的 decide()。密钥路径判断本身由
// agents/test/rules/pretool.rules.test.ts 钉住；这里只测这两个新输入形状认不认得对，不改、不碰那份钉住的规矩。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Verdict {
  code: number;
  message?: string;
}
interface HookLib {
  decide(raw: string, cwd?: string): Verdict;
}

const hook = fileURLToPath(new URL('../hooks/pretool.mjs', import.meta.url));
const libPromise = import(pathToFileURL(hook).href) as Promise<HookLib>;

describe('Cursor 原生钩子：beforeShellExecution（没有 tool_name，字段是 command、cwd）', () => {
  it('正常命令放行', async () => {
    const lib = await libPromise;
    const got = lib.decide(
      JSON.stringify({ hook_event_name: 'beforeShellExecution', command: 'git status', cwd: '/work/repo' }),
    );
    expect(got).toEqual({ code: 0 });
  });

  it('碰到密钥路径照样拦（拦截规矩本身不因为换了个钩子入口就松）', async () => {
    const lib = await libPromise;
    const got = lib.decide(
      JSON.stringify({
        hook_event_name: 'beforeShellExecution',
        command: 'cat ~/.cursor/fleet-api-key',
        cwd: '/work/repo',
      }),
    );
    expect(got.code).toBe(2);
    expect(got.message).toContain('cursor-agent 的 API 密钥');
  });
});

describe('Cursor 原生钩子：beforeReadFile（没有 tool_name，字段是顶层 file_path）', () => {
  it('正常文件放行', async () => {
    const lib = await libPromise;
    const got = lib.decide(
      JSON.stringify({ hook_event_name: 'beforeReadFile', file_path: '/work/repo/README.md' }),
    );
    expect(got).toEqual({ code: 0 });
  });

  it('读密钥文件照样拦', async () => {
    const lib = await libPromise;
    const got = lib.decide(
      JSON.stringify({ hook_event_name: 'beforeReadFile', file_path: '/home/u/.cursor/fleet-api-key' }),
    );
    expect(got.code).toBe(2);
    expect(got.message).toContain('cursor-agent 的 API 密钥');
  });

  // 故意造出失败：file_path 缺失或不是字符串，认不出要读的路径就必须按拦处理，不能当成没事放行
  it('file_path 缺失：按拦处理，不当成没事放行', async () => {
    const lib = await libPromise;
    const got = lib.decide(JSON.stringify({ hook_event_name: 'beforeReadFile' }));
    expect(got.code).toBe(2);
    expect(got.message).toContain('认不出要读的路径');
  });
});

describe('Cursor 在 Windows 上喂的 stdin 有时带 UTF-8 BOM（社区已知的坑）', () => {
  // U+FEFF 不直接写进源码（容易和真的文件头 BOM 搞混），用 fromCharCode 拼
  const BOM = String.fromCharCode(0xfeff);

  it('payload 前面多一个 BOM：照样解出来当正常 JSON 判，不因为多一个字符就把这次调用也拦下', async () => {
    const lib = await libPromise;
    const withBom = `${BOM}${JSON.stringify({ hook_event_name: 'beforeShellExecution', command: 'git status', cwd: '/work/repo' })}`;
    expect(lib.decide(withBom)).toEqual({ code: 0 });
  });

  // 故意造出失败：BOM 之外真是解不出来的 JSON，摘了 BOM 也一样拦，不能把「摘 BOM」写宽成「怎么样都放行」
  it('BOM 之外还是解不出来的 JSON：照样按拦处理', async () => {
    const lib = await libPromise;
    expect(lib.decide(`${BOM}{ 坏了`).code).toBe(2);
  });
});

describe('两边都不沾：既没有 tool_name，也不是这两个 Cursor 原生事件', () => {
  // 故意造出失败：防止以后有人把 hookEvent 分支的条件写宽了，把认不出的输入也当成放行
  it('认不出的 hook_event_name：按「认不出工具名」拦下，不当成 Cursor 原生事件放行', async () => {
    const lib = await libPromise;
    const got = lib.decide(JSON.stringify({ hook_event_name: 'somethingElse', command: 'git status' }));
    expect(got.code).toBe(2);
    expect(got.message).toContain('认不出工具名');
  });
});
