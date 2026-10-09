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
const gemini = await load<{ normalizeGemini: Normalize }>('pretool-gemini.mjs');
const agy = await load<{ normalizeAgy: Normalize; agyReply(v: Verdict): string }>('pretool-agy.mjs');
const kimi = await load<{ normalizeKimi: Normalize }>('pretool-kimi.mjs');

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

describe('Gemini CLI（~/.gemini/settings.json 的 BeforeTool → pretool-gemini.mjs）', () => {
  const HOME = '/home/alice';
  const judge = (input: unknown, platform: NodeJS.Platform = 'linux') =>
    lib.judgeVendor(typeof input === 'string' ? input : JSON.stringify(input), gemini.normalizeGemini, {
      vendor: 'Gemini CLI',
      platform,
      cwd: O,
    });
  const call = (tool_name: string, tool_input: unknown, cwd = O) => ({
    session_id: 's',
    transcript_path: '/tmp/t.json',
    cwd,
    hook_event_name: 'BeforeTool',
    timestamp: '2026-10-09T14:00:00Z',
    tool_name,
    tool_input,
  });

  it('读密钥文件被拦：run_shell_command 的命令、read_file、read_many_files、grep_search 搜到密钥目录', () => {
    const cases: [string, unknown][] = [
      ['run_shell_command', { command: `cat ~/${RC}/device.json` }],
      ['read_file', { file_path: `${HOME}/${RC}/device.json` }],
      ['read_file', { absolute_path: `${HOME}/${RC}/device.json` }],
      ['read_many_files', { include: ['README.md', `${HOME}/${RC}/*.json`] }],
      ['grep_search', { pattern: 'token', dir_path: `${HOME}/${RC}` }],
      ['search_file_content', { pattern: 'token', path: `${HOME}/${RC}` }],
    ];
    for (const [tool, args] of cases) {
      const got = judge(call(tool, args));
      expect([tool, got.code]).toEqual([tool, 2]);
      expect(got.code === 2 ? got.message : '').toContain('secret-shape.mjs');
    }
    expect(
      judge(call('run_shell_command', { command: `Get-Content $HOME/${RC}/device.json` }), 'win32').code,
    ).toBe(2);
  });

  it('跑普通命令、读普通文件、在代码目录搜内容放行；排除的通配不当成要读的路径', () => {
    expect(judge(call('run_shell_command', { command: 'git status', dir_path: 'src' }))).toEqual({ code: 0 });
    expect(judge(call('read_file', { file_path: '/work/other/README.md' }))).toEqual({ code: 0 });
    expect(judge(call('read_many_files', { include: ['src/**/*.ts'], exclude: ['**/.env'] }))).toEqual({
      code: 0,
    });
    expect(judge(call('grep_search', { pattern: 'TODO', dir_path: 'src', exclude_pattern: '.env' }))).toEqual(
      {
        code: 0,
      },
    );
  });

  it('dir_path 是命令在哪个目录跑：fleet-dao 里的规矩按它判', () => {
    expect(judge(call('run_shell_command', { command: `git ${s} pop`, dir_path: F }, O)).code).toBe(2);
    expect(judge(call('run_shell_command', { command: `git ${s} pop` }, F)).code).toBe(2);
    expect(judge(call('run_shell_command', { command: `git ${s} pop` }, O))).toEqual({ code: 0 });
  });

  it('Windows 上 Gemini CLI 用 PowerShell 跑命令：反引号不按 bash 的命令替换拦；Linux 上照拦', () => {
    const cmd = `echo ${bt}date${bt}`;
    expect(judge(call('run_shell_command', { command: cmd }), 'win32')).toEqual({ code: 0 });
    expect(judge(call('run_shell_command', { command: cmd }), 'linux').code).toBe(2);
  });

  it('故意造出的认不出的格式：没挂的工具名、输入不是对象、没有路径、没有命令、不是 JSON，一律按拦处理', () => {
    const bad: unknown[] = [
      call('write_file', { file_path: 'x', content: 'y' }),
      call('run_shell_command', 'git status'),
      call('run_shell_command', { description: '没有命令' }),
      call('read_file', { start_line: 1 }),
      call('read_many_files', { include: 'README.md' }),
      call('grep_search', { dir_path: 'src' }),
      '不是 JSON',
    ];
    for (const input of bad) expect([input, judge(input).code]).toEqual([input, 2]);
  });

  it('命令行外壳：拦下退出码 2、理由在 stderr；放行退出码 0、stdout 空着（Gemini CLI 要求 stdout 只能是 JSON）', () => {
    const blocked = run(
      'pretool-gemini.mjs',
      JSON.stringify(call('read_file', { file_path: `${HOME}/${RC}/device.json` })),
    );
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('secret-shape.mjs');
    expect(blocked.stdout).toBe('');
    const passed = run(
      'pretool-gemini.mjs',
      JSON.stringify(call('run_shell_command', { command: 'git status' })),
    );
    expect([passed.status, passed.stdout, passed.stderr]).toEqual([0, '', '']);
  });
});

describe('Antigravity（~/.gemini/config/hooks.json 的 fleet-dao 那一项 → pretool-agy.mjs）', () => {
  const HOME = '/home/alice';
  const judge = (input: unknown, platform: NodeJS.Platform = 'linux') =>
    lib.judgeVendor(typeof input === 'string' ? input : JSON.stringify(input), agy.normalizeAgy, {
      vendor: 'Antigravity',
      platform,
      cwd: '/somewhere/else',
    });
  const call = (name: string, args: unknown, workspace = O) => ({
    toolCall: { name, args },
    stepIdx: 19,
    conversationId: 'c',
    workspacePaths: [workspace],
    transcriptPath: '/tmp/t.jsonl',
    artifactDirectoryPath: '/tmp/a',
    modelName: 'auto',
  });

  it('读密钥文件被拦：run_command 的命令、view_file、grep_search 搜到密钥目录', () => {
    const cases: [string, unknown][] = [
      ['run_command', { CommandLine: `cat ~/${RC}/device.json`, Cwd: O }],
      ['view_file', { AbsolutePath: `${HOME}/${RC}/device.json` }],
      ['grep_search', { SearchPath: `${HOME}/${RC}`, Query: 'token', MatchPerLine: true }],
      ['grep_search', { SearchPath: '/work/other', Query: 'token', Includes: [`${HOME}/${RC}/device.json`] }],
    ];
    for (const [tool, args] of cases) {
      const got = judge(call(tool, args));
      expect([tool, got.code]).toEqual([tool, 2]);
      expect(got.code === 2 ? got.message : '').toContain('secret-shape.mjs');
    }
  });

  it('跑普通命令、读普通文件、只列文件名的搜索放行', () => {
    expect(judge(call('run_command', { CommandLine: 'git status', Cwd: O }))).toEqual({ code: 0 });
    expect(judge(call('view_file', { AbsolutePath: '/work/other/README.md' }))).toEqual({ code: 0 });
    expect(
      judge(
        call('grep_search', {
          SearchPath: '/work/other/src',
          Query: 'TODO',
          Includes: ['*.ts'],
          MatchPerLine: true,
        }),
      ),
    ).toEqual({ code: 0 });
  });

  it('输入里没有 cwd：会话目录取 workspacePaths，run_command 自带的 Cwd 优先；fleet-dao 里的规矩照拦', () => {
    expect(judge(call('run_command', { CommandLine: `git ${s} pop` }, F)).code).toBe(2);
    expect(judge(call('run_command', { CommandLine: `git ${s} pop`, Cwd: F }, O)).code).toBe(2);
    expect(judge(call('run_command', { CommandLine: `git ${s} pop` }, O))).toEqual({ code: 0 });
  });

  it('故意造出的认不出的格式：没挂的工具名、snake_case 的 Claude 写法、没有 toolCall、args 不是对象、没有路径或命令，一律按拦处理', () => {
    const bad: unknown[] = [
      call('write_to_file', { TargetFile: 'x' }),
      { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: O },
      { stepIdx: 1 },
      call('run_command', 'git status'),
      call('run_command', { Cwd: O }),
      call('view_file', { Path: 'README.md' }),
      call('grep_search', { SearchPath: O }),
      '不是 JSON',
    ];
    for (const input of bad) expect([input, judge(input).code]).toEqual([input, 2]);
  });

  it('回话照 Antigravity 的协议：拦下 { decision: deny, reason }；放行回 {}，不回 allow（allow 会绕过它自己的审批）', () => {
    expect(JSON.parse(agy.agyReply({ code: 2, message: '理由' }))).toEqual({
      decision: 'deny',
      reason: '理由',
    });
    expect(JSON.parse(agy.agyReply({ code: 0 }))).toEqual({});
  });

  it('命令行外壳：拦下、放行都退出 0，结论在 stdout 的 JSON 里', () => {
    const blocked = run(
      'pretool-agy.mjs',
      JSON.stringify(call('view_file', { AbsolutePath: `${HOME}/${RC}/device.json` })),
    );
    expect(blocked.status).toBe(0);
    const verdict = JSON.parse(blocked.stdout) as { decision?: string; reason?: string };
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('secret-shape.mjs');
    const passed = run(
      'pretool-agy.mjs',
      JSON.stringify(call('run_command', { CommandLine: 'git status', Cwd: O })),
    );
    expect([passed.status, JSON.parse(passed.stdout)]).toEqual([0, {}]);
    const garbage = run('pretool-agy.mjs', '不是 JSON');
    expect(JSON.parse(garbage.stdout).decision).toBe('deny');
  });
});

describe('Kimi Code（~/.kimi-code/config.toml 的 [[hooks]] → pretool-kimi.mjs）', () => {
  const HOME = '/home/alice';
  const judge = (input: unknown) =>
    lib.judgeVendor(typeof input === 'string' ? input : JSON.stringify(input), kimi.normalizeKimi, {
      vendor: 'Kimi Code',
      platform: 'win32',
      cwd: '/somewhere/else',
    });
  const call = (tool_name: string, tool_input: unknown, cwd = O) => ({
    hook_event_name: 'PreToolUse',
    session_id: 's',
    session_title: 't',
    client_type: 'kimi_code_cli',
    cwd,
    tool_name,
    tool_input,
  });

  it('读密钥文件被拦：Bash 的命令、Read 的 path、Grep 搜到密钥目录', () => {
    const cases: [string, unknown][] = [
      ['Bash', { command: `cat ~/${RC}/device.json` }],
      ['Read', { path: `${HOME}/${RC}/device.json` }],
      ['Grep', { pattern: 'token', path: `${HOME}/${RC}`, output_mode: 'content' }],
    ];
    for (const [tool, args] of cases) {
      const got = judge(call(tool, args));
      expect([tool, got.code]).toEqual([tool, 2]);
      expect(got.code === 2 ? got.message : '').toContain('secret-shape.mjs');
    }
  });

  it('跑普通命令、读普通文件、在代码目录搜内容放行；Kimi 的 Grep 不写 output_mode 只列文件名，从项目根往下搜不按「打内容」拦', () => {
    expect(judge(call('Bash', { command: 'git status' }))).toEqual({ code: 0 });
    expect(judge(call('Read', { path: '/work/other/README.md' }))).toEqual({ code: 0 });
    expect(judge(call('Grep', { pattern: 'TODO', path: '/work/other/src' }))).toEqual({ code: 0 });
    expect(judge(call('Grep', { pattern: 'TODO', path: HOME, output_mode: 'count_matches' }))).toEqual({
      code: 0,
    });
    expect(judge(call('Grep', { pattern: 'TODO', path: HOME, output_mode: 'content' })).code).toBe(2);
  });

  it('Kimi 的 Bash 在 Windows 上也是 Git Bash：反引号照拦；timeout 按秒，超过前台等待上限照拦；参数里的 cwd 优先', () => {
    expect(judge(call('Bash', { command: `echo ${bt}date${bt}` })).code).toBe(2);
    expect(judge(call('Bash', { command: 'pnpm test', timeout: 300 })).code).toBe(2);
    expect(judge(call('Bash', { command: 'pnpm test', timeout: 300, run_in_background: true }))).toEqual({
      code: 0,
    });
    expect(judge(call('Bash', { command: 'pnpm test', timeout: 30 }))).toEqual({ code: 0 });
    expect(judge(call('Bash', { command: `git ${s} pop`, cwd: F }, O)).code).toBe(2);
    expect(judge(call('Bash', { command: `git ${s} pop` }, O))).toEqual({ code: 0 });
  });

  it('故意造出的认不出的格式：没挂的工具名、输入不是对象、没有路径或命令、不是 JSON，一律按拦处理（Kimi 把别的退出码当放行，所以只能退出 2）', () => {
    const bad: unknown[] = [
      call('Write', { path: 'x', content: 'y' }),
      call('Bash', 'git status'),
      call('Bash', { description: '没有命令' }),
      call('Read', { line_offset: 1 }),
      call('Grep', { path: 'src' }),
      '不是 JSON',
    ];
    for (const input of bad) expect([input, judge(input).code]).toEqual([input, 2]);
  });

  it('命令行外壳：拦下退出码 2、理由在 stderr；放行退出码 0、什么都不说', () => {
    const blocked = run(
      'pretool-kimi.mjs',
      JSON.stringify(call('Read', { path: `${HOME}/${RC}/device.json` })),
    );
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('secret-shape.mjs');
    const passed = run('pretool-kimi.mjs', JSON.stringify(call('Bash', { command: 'git status' })));
    expect([passed.status, passed.stdout, passed.stderr]).toEqual([0, '', '']);
    const garbage = run('pretool-kimi.mjs', '不是 JSON');
    expect(garbage.status).toBe(2);
  });
});
