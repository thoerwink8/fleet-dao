import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeArgs,
  type ClaudeArgsSpec,
  PRETOOL_MATCHER,
  PRETOOL_SCRIPT,
  pretoolSettings,
} from '../src/claude-code/args.ts';

const ID = '8e188c1c-4430-4735-9eb2-bbb3d9f012c6';
const base: ClaudeArgsSpec = {
  model: 'claude-opus-5-5',
  session: { mode: 'new', id: ID },
  permissionMode: 'bypassPermissions',
};

describe('buildClaudeArgs', () => {
  it('新会话：无头 stream-json 必带 --verbose，只读项目级设置、调工具前那条钩子另经 --settings 带上，权限弹窗一律当场拒，用我们给的会话号', () => {
    expect(buildClaudeArgs(base)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'claude-opus-5-5',
      '--setting-sources',
      'project',
      '--settings',
      pretoolSettings(),
      '--strict-mcp-config',
      '--permission-mode',
      'bypassPermissions',
      '--permission-prompts',
      'none',
      '--session-id',
      ID,
    ]);
  });

  it('续会话用 --resume，不再带 --session-id', () => {
    const args = buildClaudeArgs({ ...base, session: { mode: 'resume', id: ID } });
    expect(args.slice(-2)).toEqual(['--resume', ID]);
    expect(args).not.toContain('--session-id');
  });

  it('--allowedTools 放在最后、值并成一个参数（它吃变长参数，后面不能再有别的）', () => {
    const args = buildClaudeArgs({ ...base, allowedTools: ['Read', 'Bash(git diff:*)'], effort: 'high' });
    expect(args.slice(-2)).toEqual(['--allowedTools', 'Read,Bash(git diff:*)']);
    expect(args).toContain('--effort');
  });

  it('不用 --bare（经 reclaude 起会认证失败，回一条 <synthetic> 占位）', () => {
    expect(buildClaudeArgs(base)).not.toContain('--bare');
  });

  it('默认存会话记录（干活的会话要能续）；persistSession: false 才带 --no-session-persistence', () => {
    expect(buildClaudeArgs(base)).not.toContain('--no-session-persistence');
    expect(buildClaudeArgs({ ...base, persistSession: true })).not.toContain('--no-session-persistence');
    expect(buildClaudeArgs({ ...base, persistSession: false })).toContain('--no-session-persistence');
  });

  it('不存记录又要续会话、fork：写错了，当场拒（不存的会话续不上）', () => {
    expect(() =>
      buildClaudeArgs({ ...base, persistSession: false, session: { mode: 'resume', id: ID } }),
    ).toThrow('只能是新会话');
    expect(() =>
      buildClaudeArgs({
        ...base,
        persistSession: false,
        session: { mode: 'fork', from: '11111111-1111-4111-8111-111111111111', id: ID },
      }),
    ).toThrow('只能是新会话');
  });

  it('拒绝不合法的模型名和会话号', () => {
    expect(() => buildClaudeArgs({ ...base, model: '--bare' })).toThrow('模型名');
    expect(() => buildClaudeArgs({ ...base, model: 'opus 5' })).toThrow('模型名');
    expect(() => buildClaudeArgs({ ...base, session: { mode: 'resume', id: 'latest' } })).toThrow('UUID');
  });
});

describe('fork（换会话用户接着干：带着旧会话的记录开一个新编号）', () => {
  const FROM = '11111111-1111-4111-8111-111111111111';

  it('拼成 --resume <旧编号> --fork-session --session-id <新编号>', () => {
    const args = buildClaudeArgs({ ...base, session: { mode: 'fork', from: FROM, id: ID } });
    expect(args.slice(-5)).toEqual(['--resume', FROM, '--fork-session', '--session-id', ID]);
  });

  it('from、id 都要是 UUID', () => {
    expect(() => buildClaudeArgs({ ...base, session: { mode: 'fork', from: 'latest', id: ID } })).toThrow(
      'UUID',
    );
    expect(() =>
      buildClaudeArgs({ ...base, session: { mode: 'fork', from: FROM, id: 'not-a-uuid' } }),
    ).toThrow('UUID');
  });

  it('from 和 id 不能一样（fork 出来的必须是新编号）', () => {
    expect(() => buildClaudeArgs({ ...base, session: { mode: 'fork', from: FROM, id: FROM } })).toThrow(
      '不能和旧会话号一样',
    );
  });
});

// 调工具前那条钩子：引擎起 Claude 带 --setting-sources project，用户级 settings.json 里登记的钩子它不读，经 --settings 带上。
// 钩子命令在 sh -c 里跑（Claude 在 Linux 上就这么跑命令式钩子），这里照样跑出来看退出码。
const hasSh = spawnSync('sh', ['-c', 'exit 0'], { timeout: 60_000, killSignal: 'SIGKILL' }).status === 0;

/** 照 Claude 的做法跑一次钩子命令：stdin 一份钩子输入 */
function runHook(command: string, input: unknown): { status: number | null; stderr: string } {
  const r = spawnSync('sh', ['-c', command], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  if (r.error || r.signal) throw new Error(`钩子命令没跑完：${r.error?.message ?? r.signal}`);
  return { status: r.status, stderr: r.stderr };
}

const hookCommand = (settings: string) => {
  const parsed = JSON.parse(settings) as {
    hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[] };
  };
  return parsed.hooks.PreToolUse[0]?.hooks[0]?.command ?? '';
};

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: tmpdir() });

describe('调工具前那条钩子经 --settings 带上', { timeout: 0 }, () => {
  it('只登记 PreToolUse 一组：挂在 Bash、PowerShell、Read、Grep 上（和 agents-sync 给 Claude 登记的那组一样），跑仓里这份 pretool.mjs', () => {
    const settings = JSON.parse(pretoolSettings()) as Record<string, unknown>;
    expect(Object.keys(settings)).toEqual(['hooks']);
    expect(settings.hooks).toEqual({
      PreToolUse: [
        {
          matcher: 'Bash|PowerShell|Read|Grep',
          hooks: [{ type: 'command', command: hookCommand(pretoolSettings()), timeout: 10 }],
        },
      ],
    });
    expect(PRETOOL_MATCHER).toBe('Bash|PowerShell|Read|Grep');
    expect(PRETOOL_SCRIPT.replaceAll('\\', '/')).toMatch(/\/agents\/hooks\/pretool\.mjs$/);
    expect(existsSync(PRETOOL_SCRIPT)).toBe(true);
    expect(hookCommand(pretoolSettings())).toContain(`'${process.execPath}' '${PRETOOL_SCRIPT}'`);
  });

  it.skipIf(!hasSh)('真跑仓里这份：正常命令放行（0），规矩拦的拦下（2，原话给模型）', () => {
    const command = hookCommand(pretoolSettings());
    expect(runHook(command, bash('git status'))).toEqual({ status: 0, stderr: '' });
    const blocked = runHook(command, bash('reclaude org use solo'));
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('reclaude');
    expect(blocked.stderr).not.toContain('没跑成');
  });

  it.skipIf(!hasSh)(
    '【故意造出的失败】脚本崩了、node 起不来：Claude 会当「钩子出错」照样放行，这里一律改成 2、说清没跑成',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'pretool-'));
      const crash = join(dir, 'crash.mjs');
      writeFileSync(crash, 'process.exit(1);\n');
      const crashed = runHook(hookCommand(pretoolSettings(crash)), bash('git status'));
      expect(crashed.status).toBe(2);
      expect(crashed.stderr).toContain('fleet-guard：调工具前的钩子没跑成（退出码 1），按拦处理');

      const noNode = runHook(hookCommand(pretoolSettings(crash, join(dir, 'no-such-node'))), bash('ls'));
      expect(noNode.status).toBe(2);
      expect(noNode.stderr).toContain('没跑成（退出码 127）');

      // 脚本自己拦下（2）：原样交回，不再加一句
      const deny = join(dir, 'deny.mjs');
      writeFileSync(deny, "process.stderr.write('拦下了\\n'); process.exit(2);\n");
      expect(runHook(hookCommand(pretoolSettings(deny)), bash('ls'))).toEqual({
        status: 2,
        stderr: '拦下了\n',
      });
    },
  );

  it('路径里带单引号也不会拆坏命令', () => {
    expect(hookCommand(pretoolSettings("/tmp/it's/pretool.mjs", '/usr/bin/node'))).toBe(
      `'/usr/bin/node' '/tmp/it'\\''s/pretool.mjs' || { c=$?; [ "$c" = 2 ] || echo "fleet-guard：调工具前的钩子没跑成（退出码 $c），按拦处理" >&2; exit 2; }`,
    );
  });
});
