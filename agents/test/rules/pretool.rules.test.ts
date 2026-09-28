// 钉住调工具前钩子（agents/hooks/pretool.mjs）拦的规矩（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 只留两条：本机不跑 reclaude login / logout / org use；fleet-dao 里不直接 gh issue create（-R 指到别的仓放行）。
// 只认命令位置上的命令词（开头、; && || | 之后、$( ) 里面、bash -c / pwsh -Command 里面）。
// heredoc 正文、引号里、注释里、普通参数里提到这些字样的不拦。认不出的输入按拦处理。
// 把判断改成「整段字符串里出现这些字样就拦」，「正文里的字样不拦」那一组会红。
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PretoolLib {
  decide(raw: string, fallbackCwd?: string): { code: number; message?: string };
  SHELL_TOOLS: Record<string, string>;
}

const HOOK = fileURLToPath(new URL('../../hooks/pretool.mjs', import.meta.url));
const lib = (await import(pathToFileURL(HOOK).href)) as PretoolLib;

const F = '/work/fleet-dao';
const O = '/work/other';

/** [命令, 该给的退出码, 会话目录, 工具名（不写是 Bash）] */
type Case = [string, 0 | 2, string, string?];

function input(c: Case): string {
  const [command, , cwd, tool = 'Bash'] = c;
  return JSON.stringify({ tool_name: tool, tool_input: { command }, cwd });
}

function run(c: Case) {
  return lib.decide(input(c));
}

describe('两条小拦：真正会执行的命令才拦', () => {
  const block: Case[] = [
    ['reclaude login', 2, O],
    ['reclaude logout', 2, F],
    ['reclaude org use other-org', 2, O],
    ['Reclaude.EXE Login', 2, O],
    ['sudo reclaude login', 2, O],
    ['sudo -u someone -E reclaude org use x', 2, O],
    ['FOO=1 reclaude logout', 2, O],
    ['env FOO=1 reclaude login', 2, O],
    ["bash -c 'reclaude login'", 2, O],
    ["bash -lc 'reclaude org use x'", 2, O],
    ['pwsh -Command "reclaude logout"', 2, O],
    ['pwsh -NoProfile -Command "reclaude login"', 2, O],
    ['echo start; reclaude login', 2, O],
    ['true && reclaude logout', 2, O],
    ['false || reclaude org use x', 2, O],
    ['echo hi | reclaude login', 2, O],
    ['echo "$(reclaude login)"', 2, O],
    ['echo $(reclaude org use x)', 2, O],
    ['ssh vps "x=$(reclaude login)"', 2, O],
    ['gh issue create --title x', 2, F],
    ['gh.exe issue create --title x', 2, F],
    ['sudo gh issue create --title x', 2, F],
    ['FOO=1 gh issue create --title x', 2, F],
    ["bash -c 'gh issue create --title x'", 2, F],
    ['echo ok; gh issue create --title x', 2, F],
    ['true && gh issue create --title x', 2, F],
    ['false || gh issue create --title x', 2, F],
    ['echo hi | gh issue create --title x', 2, F],
    ['echo $(gh issue create --title x)', 2, F],
    ['gh issue create -R owner/fleet-dao --title x', 2, O],
    ['gh issue create --repo=owner/fleet-dao --title x', 2, O],
    ['gh --repo owner/fleet-dao issue create --title x', 2, O],
    ['cd /work/fleet-dao && gh issue create --title x', 2, O],
  ];

  it.each(block.map((c) => [c[0], c[3] ?? 'Bash', c] as const))('%s（%s）拦下', (_name, _tool, c) => {
    const got = run(c);
    expect(got.code).toBe(2);
    expect(got.message?.length ?? 0).toBeGreaterThan(0);
  });

  it('切号的提示说清会断会话；直接开单的提示指向 pnpm issue:new', () => {
    expect(run(['reclaude login', 2, O]).message).toContain('会话当场断掉');
    expect(run(['gh issue create --title x', 2, F]).message).toContain('pnpm issue:new');
  });
});

// 判断如果改成整段字符串包含，下面每一条都会红：字样都在，可都不是要执行的命令。
describe('【故意造出的失败】正文、引号、注释、参数里的字样不拦', () => {
  const allow: Case[] = [
    ['echo "gh issue create --title x"', 0, F],
    ['echo "reclaude org use other-org"', 0, F],
    ["echo 'reclaude login'", 0, F],
    ["echo 'gh issue create'", 0, F],
    ['echo gh issue create --title x', 0, F],
    ['echo reclaude login', 0, F],
    ['ls # gh issue create\nls # reclaude org use x', 0, F],
    [
      "cat > /tmp/body.md <<'EOF'\n不要直接 gh issue create\n也不要 reclaude org use x\nEOF\ngit status",
      0,
      F,
    ],
    ['cat <<EOF\ngh issue create --title x\nEOF', 0, F],
    ['git commit -m "$(cat <<\'EOF\'\n正文里写了 gh issue create，不是在开单\nEOF\n)"', 0, F],
    ["ssh vps 'reclaude login'", 0, F],
    ["ssh vps 'gh issue create --title x'", 0, F],
    ['reclaude status', 0, O],
    ['reclaude org list', 0, O],
    ['gh issue comment 1 --body x', 0, F],
    ['gh issue create -R owner/fleet-dao-canary --title x', 0, F],
    ['gh issue create --repo=owner/fleet-dao-canary --title x', 0, F],
    ['gh issue create --title x', 0, O],
    ['git stash', 0, F],
    ['cat ~/.reclaude/device.json', 0, O],
    ["@'\ngh issue create\nreclaude login\n'@", 0, F, 'PowerShell'],
    ['Write-Output "a`nreclaude login"', 0, F, 'PowerShell'],
  ];

  it.each(allow.map((c) => [c[0].slice(0, 48), c[3] ?? 'Bash', c] as const))(
    '%s（%s）放行',
    (_name, _tool, c) => {
      expect(run(c).code).toBe(0);
    },
  );
});

describe('【故意造出的失败】输入认不出按拦；改成认不出也放行就会红', () => {
  it('不是 JSON、没有命令、认不出的工具名', () => {
    expect(lib.decide('不是 JSON').code).toBe(2);
    expect(lib.decide(JSON.stringify({ tool_name: 'Bash', tool_input: {} })).code).toBe(2);
    expect(lib.decide(JSON.stringify({ tool_input: { command: 'ls' }, cwd: O })).code).toBe(2);
    expect(
      lib.decide(JSON.stringify({ tool_name: 'Edit', tool_input: { command: 'ls' }, cwd: O })).code,
    ).toBe(2);
    expect(
      lib.decide(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/work/a.md' }, cwd: O })).code,
    ).toBe(2);
    for (const got of [
      lib.decide('不是 JSON'),
      lib.decide(JSON.stringify({ tool_name: 'Edit', tool_input: { command: 'ls' } })),
    ]) {
      expect(got.message).toContain('按拦处理');
    }
  });
});

describe('借道读这条钩子的几家：格式认得、规矩照拦', () => {
  it('Grok：camelCase 的 toolName、toolInput，终端工具叫 run_terminal_command', () => {
    const grok = (command: string) =>
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        toolName: 'run_terminal_command',
        toolInput: { command },
        cwd: F,
      });
    expect(lib.decide(grok('git status')).code).toBe(0);
    expect(lib.decide(grok('echo "gh issue create"')).code).toBe(0);
    expect(lib.decide(grok('reclaude login')).code).toBe(2);
  });

  it('Devin：终端工具叫 exec；切号不分仓都拦', () => {
    const devin = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'exec',
      tool_input: { command: 'reclaude logout' },
    });
    expect(lib.decide(devin, O).code).toBe(2);
    expect(lib.decide(devin, F).code).toBe(2);
  });

  it('Cursor：终端工具叫 Shell', () => {
    const cursor = (command: string) =>
      JSON.stringify({ tool_name: 'Shell', tool_input: { command }, cwd: F });
    expect(lib.decide(cursor('pnpm test')).code).toBe(0);
    expect(lib.decide(cursor('gh issue create --title x')).code).toBe(2);
    expect(lib.decide(cursor('echo gh issue create')).code).toBe(0);
  });

  it('登记进 SHELL_TOOLS 的名字，正常命令放行', () => {
    for (const name of Object.keys(lib.SHELL_TOOLS)) {
      const got = lib.decide(
        JSON.stringify({ tool_name: name, tool_input: { command: 'git status' }, cwd: O }),
      );
      expect([name, got.code]).toEqual([name, 0]);
    }
  });
});

describe('命令行外壳：stdin 进、退出码出', { timeout: 0 }, () => {
  const runHook = (stdin: string) => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: stdin,
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    if (r.error !== undefined || r.status === null)
      throw new Error(`钩子没跑完：${r.error?.message ?? r.signal}`);
    return r;
  };

  it('拦下：退出码 2，理由在 stderr', () => {
    const r = runHook(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'reclaude login' }, cwd: O }),
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('会话当场断掉');
  });

  it('放行：退出码 0，什么都不说', () => {
    const r = runHook(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: "cat <<'EOF'\ngh issue create\nEOF" },
        cwd: F,
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('输入不是 JSON：退出码 2', () => {
    const r = runHook('不是 JSON');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('按拦处理');
  });
});
