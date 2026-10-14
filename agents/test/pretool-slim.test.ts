// 调工具前钩子（agents/hooks/pretool.mjs）的「规则减法」（决定 0089，创始人 2026-10-13 17:54「都同意……你全都修复掉」）：
// ① 前台等待上限整段删掉（两天拦 18 次全是误伤）：不拦。决定 0093 起，Claude Code 里 timeout 写得超过 60 秒的
//    由钩子改成后台跑放行（updatedInput 加 run_in_background，见 pretool-background.test.ts）；别家的输入不改。
// ② `cd <目录> && <只读查看命令>` 不拦（cdReadVerdict 已删）。
// ③ 打印进程命令行：Claude Code 里看得清、整条只有看进程和过滤文字的，改成用 updatedInput 自动接 redact-secrets.mjs 放行；
//    看不清的、夹了别的命令的、远端的也改写接上 redactor，但不替它们跳过权限确认（决定 0093）；
//    往文件里写的（> 文件、tee）和别家 AI 的，照旧拦下给配方。
// ④ GENERIC_RE（*.key、*.pem 这类）在 heredoc 正文里只认带 / 或 \ 的路径：脚本里的 `item.key;` 不再当密钥文件；真密钥照拦。
// 命令字符串拆开拼：免得跑这条测试的命令、或者有人 grep 它时，本机的护栏把自己拦下。
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

interface Verdict {
  code: number;
  message?: string;
  updatedInput?: Record<string, unknown>;
  context?: string;
}
interface HookLib {
  decide(raw: string, fallbackCwd?: string): Verdict;
  withRedactor(command: string, kind: 'bash' | 'powershell'): string;
  [k: string]: unknown;
}

const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
const HOOK = join(HOOKS, 'pretool.mjs');
const lib = (await import(pathToFileURL(HOOK).href)) as HookLib;

const O = '/work/other';
const PS = `p${'s'}`;
const PG = `pg${'rep'}`;
const REDACT = '"$HOME/.fleet-dao/hooks/redact-secrets.mjs"';

/** Claude Code 的 PreToolUse 输入（字段照 code.claude.com/docs/en/hooks 的例子） */
const cc = (tool: string, toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: 's1',
    transcript_path: '/home/u/.claude/projects/x/s1.jsonl',
    cwd: O,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: 'toolu_01',
    ...extra,
  });
/** 别家借道、或 vendor-pretool 翻好的输入：只有工具名、参数、目录 */
const bare = (tool: string, toolInput: Record<string, unknown>) =>
  JSON.stringify({ tool_name: tool, tool_input: toolInput, cwd: O });

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe('① 前台等待上限删掉', () => {
  it.each([
    ['Bash', { command: 'sleep 600' }],
    ['PowerShell', { command: 'Start-Sleep -Seconds 600' }],
  ])('%s %j：没写 timeout 的放行、不改写（Claude Code 的输入和别家的都一样）', (tool, input) => {
    expect(lib.decide(cc(tool, input))).toEqual({ code: 0 });
    expect(lib.decide(bare(tool, input))).toEqual({ code: 0 });
  });

  it.each([
    ['Bash', { command: 'pnpm test', timeout: 420_000 }],
    ['Bash', { command: 'git fetch && sleep 90 && echo ok', timeout: 100_000 }],
  ])('%s %j：不拦；Claude Code 里改成后台跑，别家的原样放行', (tool, input) => {
    const v = lib.decide(cc(tool, input));
    expect(v.code).toBe(0);
    expect(v.updatedInput).toEqual({ ...input, run_in_background: true });
    expect(lib.decide(bare(tool, input))).toEqual({ code: 0 });
  });

  it('前台等待的那几个导出没了', () => {
    expect(lib.MAX_FOREGROUND_WAIT_SECONDS).toBeUndefined();
    expect(lib.foregroundWait).toBeUndefined();
    expect(lib.isSubagentCall).toBeUndefined();
  });
});

describe('② cd 进目录再查看：不拦（没有安全后果，cd x && cat y 能跑出正确结果）', () => {
  it.each([
    ['Bash', 'cd /x && cat a'],
    ['Bash', 'cd /x && sed -n 1,9p a'],
    ['Bash', 'cd /x; ls -la'],
    ['Bash', 'cd /x && grep -n foo a | head -5'],
    ['PowerShell', 'cd D:\\x; Get-Content a'],
    ['PowerShell', 'Set-Location D:\\x; type a'],
  ])('%s：%s → 放行（Claude Code 的输入和别家的都一样）', (tool, command) => {
    expect(lib.decide(cc(tool, { command }))).toEqual({ code: 0 });
    expect(lib.decide(bare(tool, { command }))).toEqual({ code: 0 });
  });

  it('cdReadVerdict 这个导出没了', () => {
    expect(lib.cdReadVerdict).toBeUndefined();
  });
});

describe('③ 打印进程命令行：Claude Code 里自动接 redactor 放行', () => {
  it.each([
    ['Bash', `${PS} -ef`],
    ['Bash', `${PS} aux | grep node | head -5`],
    ['Bash', `${PG} -af lark`],
    ['Bash', 'cat /proc/1234/cmdline'],
    ['PowerShell', 'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine'],
    ['PowerShell', 'tasklist /v'],
  ])('%s：%s → 放行，updatedInput 的 command 接上了 redactor、原来的命令原样在里面', (tool, command) => {
    const v = lib.decide(cc(tool, { command, description: '看进程', timeout: 30_000 }));
    expect(v.code).toBe(0);
    const ui = v.updatedInput ?? {};
    expect(ui.description).toBe('看进程');
    expect(ui.timeout).toBe(30_000);
    expect(String(ui.command)).toContain(command);
    expect(String(ui.command)).toContain(`| node ${REDACT}`);
    expect(v.context).toContain('redact-secrets.mjs');
  });

  it.each([
    ['Bash', `${PS} -ef; rm -rf /tmp/x`],
    ['Bash', `ssh fr '${PS} -ef'`],
    ['Bash', `${PS} -ef | awk '{print $2}'`],
  ])(
    '夹了别的命令、看不清、远端的：也接上 redactor，但不带 allow（照常走权限确认）%s：%s',
    (tool, command) => {
      const v = lib.decide(cc(tool, { command }));
      expect(v.code).toBe(0);
      expect(String(v.updatedInput?.command)).toContain(`| node ${REDACT}`);
      expect((v as { approve?: boolean }).approve).toBe(false);
    },
  );

  it.each([
    ['Bash', `${PS} -ef > /tmp/p.txt`],
    ['Bash', `${PS} -ef | tee /tmp/p.txt`],
  ])('往文件里写的：写进文件的那份不经过 redactor，照旧拦下给配方 %s：%s', (tool, command) => {
    const v = lib.decide(cc(tool, { command }));
    expect(v.code).toBe(2);
    expect(v.message).toContain('redact-secrets.mjs');
  });

  it('写到 /dev/null 的不算往文件写：照常改写放行', () => {
    const v = lib.decide(cc('Bash', { command: `${PS} -ef 2>/dev/null` }));
    expect(v.code).toBe(0);
    expect(String(v.updatedInput?.command)).toContain(`| node ${REDACT}`);
  });

  it('自己已经接了 redactor：放行，不再改写', () => {
    expect(lib.decide(cc('Bash', { command: `${PS} -ef | node ${REDACT}` }))).toEqual({ code: 0 });
  });

  it('别家的输入：照旧拦下（不知道它认不认 updatedInput）', () => {
    expect(lib.decide(bare('Bash', { command: `${PS} -ef` })).code).toBe(2);
  });

  it('改写出来的 bash 命令真跑一遍：输出里的口令被打码', () => {
    const home = mkdtempSync(join(tmpdir(), 'pretool-slim-'));
    made.push(home);
    mkdirSync(join(home, '.fleet-dao', 'hooks'), { recursive: true });
    for (const f of ['redact-secrets.mjs', 'redact.mjs'])
      copyFileSync(join(HOOKS, f), join(home, '.fleet-dao', 'hooks', f));
    const secret = ['s3cr3t', 'Value9'].join('');
    const cmd = lib.withRedactor(`echo "lark-mcp -s ${secret}"`, 'bash');
    const r = runChild('bash', ['-c', cmd], { env: { ...process.env, HOME: home } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('lark-mcp');
    expect(r.stdout).not.toContain(secret);
  });

  it('真的钩子进程：stdout 是 permissionDecision allow + updatedInput，退出码 0', () => {
    const r = runChild(process.execPath, [HOOK], {
      input: cc('Bash', { command: `${PS} -ef`, description: 'x' }),
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput?: {
        hookEventName?: string;
        permissionDecision?: string;
        updatedInput?: { command?: string; description?: string };
        additionalContext?: string;
      };
    };
    expect(out.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(out.hookSpecificOutput?.updatedInput?.command).toContain('redact-secrets.mjs');
    expect(out.hookSpecificOutput?.updatedInput?.description).toBe('x');
    expect(out.hookSpecificOutput?.additionalContext).toContain('redact-secrets.mjs');
  });
});

describe('④ heredoc 正文里的 *.key 只认带路径分隔符的', () => {
  const RC = `.recl${'aude'}`;
  it.each([
    "node --input-type=module <<'EOF'\nconst k = item.key;\nconsole.log(k)\nEOF",
    'cat <<EOF > a.js\nconst k = item.key;\nEOF',
    "python - <<'EOF'\nfor item in d: print(item.key)\nEOF",
    "cat > a.ts <<-'EOF'\n\tconst p = cfg.pem;\n\tEOF",
  ])('脚本里的属性名不当密钥文件：放行 %j', (command) => {
    expect(lib.decide(cc('Bash', { command }))).toEqual({ code: 0 });
  });

  it.each([
    'cat ~/.config/gh/hosts.yml',
    'grep FLEET_DATABASE_URL /etc/fleet-dao/api.env',
    'grep -r FLEET_DATABASE_URL ~',
    'cat server.key',
    `cat ~/${RC}/device.json`,
    "cat <<'EOF'\n/etc/ssl/server.key\nEOF",
    "cat <<'EOF'\nC:\\certs\\server.key\nEOF",
    "cat <<'EOF' > a.js\nconst k = item.key;\nEOF\ncat server.key",
    "node - <<'EOF'\nrequire('fs').readFileSync('/home/u/.config/gh/hosts.yml')\nEOF",
  ])('真密钥照拦 %j', (command) => {
    expect(lib.decide(cc('Bash', { command })).code).toBe(2);
    expect(lib.decide(bare('Bash', { command })).code).toBe(2);
  });
});
