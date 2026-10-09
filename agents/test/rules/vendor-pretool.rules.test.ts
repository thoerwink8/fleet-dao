// 钉住各家自己的调工具前钩子（agents/hooks/pretool-<家>.mjs，经 vendor-pretool.mjs 交给 pretool.mjs 的 decide）：
// 那家的格式认得、规矩照拦；认不出的格式按拦处理（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 拦什么由 pretool.rules.test.ts 钉；这里只钉「每家的输入翻得对、回话照那家的协议」。
// 每家至少一条读密钥文件被拦、一条读普通文件或跑普通命令放行、一条故意造出的认不出的格式被拦。
// 命令字符串拆开拼：免得跑这条测试的命令、或者有人 grep 它时，本机的护栏把自己拦下。
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runChild } from '../child.ts';

type Verdict = { code: 0 } | { code: 2; message: string };
type Normalize = (input: Record<string, unknown>, platform: NodeJS.Platform) => unknown;
interface VendorLib {
  judgeVendor(
    raw: string,
    normalize: Normalize,
    opts: { vendor: string; platform?: NodeJS.Platform; cwd?: string },
  ): Verdict;
}

const HOOKS = fileURLToPath(new URL('../../hooks/', import.meta.url));
const load = async <T>(name: string) => (await import(pathToFileURL(join(HOOKS, name)).href)) as T;
const lib = await load<VendorLib>('vendor-pretool.mjs');
const codex = await load<{ normalizeCodex: Normalize }>('pretool-codex.mjs');

const RC = `.recl${'aude'}`;
const s = `st${'ash'}`;
const bt = '`';
const F = '/work/fleet-dao';
const O = '/work/other';

/** 真起一个进程：stdin 进，退出码、stdout、stderr 出（卡死由 runChild 的上限管，#264） */
const run = (script: string, stdin: string) =>
  runChild(process.execPath, [join(HOOKS, script)], { input: stdin });

describe('Codex（~/.codex/hooks.json → pretool-codex.mjs）', () => {
  const judge = (input: unknown, platform: NodeJS.Platform = 'linux') =>
    lib.judgeVendor(typeof input === 'string' ? input : JSON.stringify(input), codex.normalizeCodex, {
      vendor: 'Codex',
      platform,
      cwd: O,
    });
  const bash = (command: string, cwd = O) => ({
    session_id: 's',
    turn_id: 't',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'u',
    tool_input: { command },
    permission_mode: 'default',
    cwd,
  });

  it('读密钥文件的命令被拦（Linux 按 bash、Windows 按 PowerShell 判，两边都拦），理由指到安全查看脚本', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const got = judge(bash(`cat ~/${RC}/device.json`), platform);
      expect([platform, got.code]).toEqual([platform, 2]);
      expect(got.code === 2 ? got.message : '').toContain('secret-shape.mjs');
    }
    expect(judge(bash(`Get-Content $HOME/${RC}/device.json`), 'win32').code).toBe(2);
  });

  it('普通命令、读普通文件放行；fleet-dao 里的规矩照拦（cwd 用输入里的）', () => {
    expect(judge(bash('git status'))).toEqual({ code: 0 });
    expect(judge(bash('cat README.md'))).toEqual({ code: 0 });
    expect(judge(bash(`git ${s} pop`, F)).code).toBe(2);
    expect(judge(bash(`git ${s} pop`, O))).toEqual({ code: 0 });
  });

  it('Windows 上 Codex 用 PowerShell 跑命令：反引号是 PowerShell 的转义，不按 bash 的命令替换拦；Linux 上照拦', () => {
    const cmd = `echo ${bt}date${bt}`;
    expect(judge(bash(cmd), 'win32')).toEqual({ code: 0 });
    expect(judge(bash(cmd), 'linux').code).toBe(2);
  });

  it('故意造出的认不出的格式：工具名不是 Bash、输入不是对象、没有命令、不是 JSON，一律按拦处理', () => {
    expect(judge({ ...bash('git status'), tool_name: 'apply_patch' }).code).toBe(2);
    expect(judge({ ...bash('git status'), tool_name: undefined }).code).toBe(2);
    expect(judge({ ...bash('git status'), tool_input: 'git status' }).code).toBe(2);
    expect(judge({ ...bash('git status'), tool_input: {} }).code).toBe(2);
    expect(judge('不是 JSON').code).toBe(2);
    expect(judge('[1,2]').code).toBe(2);
    const got = judge({ ...bash('git status'), tool_name: 'apply_patch' });
    expect(got.code === 2 ? got.message : '').toContain('认不出工具名');
  });

  it('命令行外壳：拦下退出码 2、理由在 stderr；放行退出码 0、stdout 和 stderr 都空', { timeout: 0 }, () => {
    const blocked = run('pretool-codex.mjs', JSON.stringify(bash(`cat ~/${RC}/device.json`)));
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('secret-shape.mjs');
    const passed = run('pretool-codex.mjs', JSON.stringify(bash('git status')));
    expect([passed.status, passed.stdout, passed.stderr]).toEqual([0, '', '']);
    const garbage = run('pretool-codex.mjs', '不是 JSON');
    expect(garbage.status).toBe(2);
    expect(garbage.stderr).toContain('按拦处理');
  });
});
