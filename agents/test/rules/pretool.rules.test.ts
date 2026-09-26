// 钉住调工具前钩子（agents/hooks/pretool.mjs）拦的规矩（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 几条规矩：fleet-dao 里不用 git stash（list、show 放行）；
// 本机不切号、不登录、不退出（ssh 到别处的放行）；bash 里会被当命令执行的反引号全机都拦（单引号、带引号的 heredoc 里放行，
// PowerShell 不管）；fleet-dao 开单走 pnpm issue:new；认不出的输入按拦处理。脚本改了这些判断，这里会红。
// 命令字符串拆开拼：免得跑这条测试的命令、或者有人 grep 它时，本机的护栏把自己拦下。
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PretoolLib {
  decide(raw: string, fallbackCwd?: string): { code: number; message?: string };
  SHELL_TOOLS: Record<string, string>;
}

const HOOKS = fileURLToPath(new URL('../../hooks/', import.meta.url));
const HOOK = join(HOOKS, 'pretool.mjs');
const lib = (await import(pathToFileURL(HOOK).href)) as PretoolLib;

const s = `st${'ash'}`;
const rc = `recl${'aude'}`;
const bt = '`';
const create = `cre${'ate'}`;
const F = '/work/fleet-dao';
const O = '/work/other';

/** [命令, 该给的退出码, 会话目录, 工具名（不写是 Bash；写了 undefined 就是没给工具名）] */
type Case = [string, 0 | 2, string, (string | undefined)?];

const cases: Case[] = [
  [`git ${s} push -q x`, 2, F],
  [`git ${s}`, 2, F],
  [`git -C ../wt ${s} pop`, 2, F],
  [`git ${s} list`, 0, F],
  [`git ${s} show -p`, 0, F],
  ['git status && pnpm test', 0, F],
  [`${rc} org use other-org`, 2, O],
  [`echo "${bt}${rc} login${bt}"`, 2, O],
  [`${rc} logout`, 2, F],
  [`ssh vps 'sudo -u some-user ${rc} login'`, 0, F],
  [`${rc} status`, 0, O],
  [`ssh vps "echo ${bt}${rc} login${bt}"`, 2, F],
  [`ssh vps "x=$(${rc} login)"`, 2, F],
  [`gh issue ${create} --title x`, 2, F],
  [`gh issue ${create} -R owner/fleet-dao --title x`, 2, O],
  [`gh issue ${create} -R owner/fleet-dao-canary --title x`, 0, F],
  [`gh issue ${create} --repo=owner/fleet-dao-canary --title x`, 0, F],
  // 反引号：2026-09-26 那次的原样（node -e 双引号里夹 Markdown 路径）
  [`node -e "p=p.replace(a,'验收见 ${bt}specs/157-x/需求.md${bt}「怎么算做完」')"`, 2, F],
  [`git commit -m "fix: ${bt}foo${bt} 改了"`, 2, O],
  [`echo ${bt}date${bt}`, 2, O],
  [`cat <<EOF\n用 ${bt}code${bt}\nEOF`, 2, O],
  [`cat <<-EOF\n\t用 ${bt}code${bt}\n\tEOF`, 2, O],
  [`echo '单引号里 ${bt}code${bt} 不执行'`, 0, F],
  [`gh api x --jq '.[] | "${bt}\\(.a)${bt}"'`, 0, F],
  [`cat > f.md <<'EOF'\n用 ${bt}code${bt} 写的\nEOF\npnpm test`, 0, F],
  [`cat <<"EOF"\n${bt}x${bt}\nEOF`, 0, F],
  [`cat <<\\EOF\n${bt}x${bt}\nEOF`, 0, F],
  [`git commit -m "$(cat <<'EOF'\nfix(x): 改 ${bt}foo${bt}\n\nCo-Authored-By: a\nEOF\n)"`, 0, F],
  [`git commit -m "$(cat <<EOF\nfix(x): 改 ${bt}foo${bt}\nEOF\n)"`, 2, F],
  [`cat <<'EOF'\n${bt}x${bt}\nEOF\necho "${bt}y${bt}"`, 2, O],
  [`echo "转义过的 \\${bt}code\\${bt} 不执行"`, 0, O],
  [`echo $'ansi ${bt}x${bt}'`, 0, O],
  [`ls # 注释里 ${bt}x${bt} 不执行`, 0, O],
  ['cat <<< "here-string"; echo ok', 0, O],
  ['echo "a $(echo "b") c"', 0, O],
  [`echo "a $(echo "b ${bt}c${bt}") d"`, 2, O],
  // PowerShell 里反引号是转义符，不归这条管
  ['Write-Output "a`nb"', 0, O, 'PowerShell'],
  // 认不出的输入：按拦处理
  ['ls', 2, O, undefined],
  ['ls', 2, O, 'Read'],
];

function input(c: Case): string {
  const [command, , cwd] = c;
  const tool = c.length >= 4 ? c[3] : 'Bash';
  return JSON.stringify({ ...(tool === undefined ? {} : { tool_name: tool }), tool_input: { command }, cwd });
}

describe('调工具前钩子拦的规矩', () => {
  it.each(cases.map((c) => [JSON.stringify(c[0]), c[3] ?? 'Bash', c[1], c] as const))(
    '%s（%s）→ 退出码 %i',
    (_name, _tool, want, c) => {
      const got = lib.decide(input(c));
      expect(got.code).toBe(want);
      if (want === 2) expect(got.message?.length ?? 0).toBeGreaterThan(0);
    },
  );

  it('输入不是 JSON、没有命令：按拦处理', () => {
    expect(lib.decide('不是 JSON').code).toBe(2);
    expect(lib.decide(JSON.stringify({ tool_name: 'Bash', tool_input: {} })).code).toBe(2);
  });
});

// ~/.claude/settings.json 里的这条钩子，Grok、Devin、Cursor 默认也借道读，送进来的是它们自己的格式（targets.ts 的 HOOK_TARGETS）。
// 认不得它们的格式就会把它们的每条终端命令都拦下；认得了，规矩在它们那里照样拦。
describe('借道读这条钩子的几家：格式认得、规矩照拦', () => {
  const stash = `git ${s} pop`;
  it('Grok：camelCase 的 toolName、toolInput，终端工具叫 run_terminal_command', () => {
    const grok = (command: string) =>
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        toolName: 'run_terminal_command',
        toolInput: { command },
        cwd: F,
      });
    expect(lib.decide(grok('git status')).code).toBe(0);
    expect(lib.decide(grok(stash)).code).toBe(2);
    expect(lib.decide(grok(`${rc} login`)).code).toBe(2);
  });

  it('Devin：终端工具叫 exec，输入里没有会话目录——按钩子进程的工作目录认是不是 fleet-dao', () => {
    const devin = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'exec',
      tool_input: { command: stash },
    });
    expect(lib.decide(devin, F).code).toBe(2);
    expect(lib.decide(devin, O).code).toBe(0);
  });

  it('Cursor：终端工具叫 Shell', () => {
    const cursor = (command: string) =>
      JSON.stringify({ tool_name: 'Shell', tool_input: { command }, cwd: F });
    expect(lib.decide(cursor('pnpm test')).code).toBe(0);
    expect(lib.decide(cursor(`gh issue ${create} --title x`)).code).toBe(2);
  });

  it('别家的终端不一定是 bash：反引号那条只对 Bash 管', () => {
    const cmd = `echo ${bt}date${bt}`;
    expect(lib.decide(JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: O })).code).toBe(
      2,
    );
    for (const tool of ['run_terminal_command', 'exec', 'Shell', 'PowerShell']) {
      expect(
        lib.decide(JSON.stringify({ tool_name: tool, tool_input: { command: cmd }, cwd: O })).code,
        tool,
      ).toBe(0);
    }
  });
});

describe('命令行外壳：stdin 进、退出码出', () => {
  const run = (stdin: string) => spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8' });

  it('拦下：退出码 2，理由在 stderr', () => {
    const r = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: `git ${s}` }, cwd: F }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('fleet-dao 里不用 git');
  });

  it('放行：退出码 0，什么都不说', () => {
    const r = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: F }));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('输入不是 JSON：退出码 2', () => {
    const r = run('不是 JSON');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('按拦处理');
  });
});
