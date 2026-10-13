// 调工具前钩子（agents/hooks/pretool.mjs）的两件事：
// ① N1 递归删除护栏：rm -r*、Remove-Item -Recurse、rd/rmdir/del /s 删盘符根、C:\Windows 及其下、Program Files*、ProgramData、
//    用户目录和 AppData 顶层、主检出的 .git，拦；工作目录里的递归删除放行。
// ② 冒烟：钩子被改坏（SyntaxError 退出码 1）在 Claude Code 里不挡工具，等于本机护栏悄悄关掉——真起子进程喂一条 ls，必须退出 0。
// 命令字符串拆开拼：免得跑这条测试的命令、或者有人 grep 它时，本机的护栏把自己拦下。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

interface Verdict {
  code: number;
  message?: string;
}
interface HookLib {
  decide(raw: string, fallbackCwd?: string): Verdict;
}

const HOOK = fileURLToPath(new URL('../hooks/pretool.mjs', import.meta.url));
const lib = (await import(pathToFileURL(HOOK).href)) as HookLib;

const RM = `r${'m'}`;
const RMDIR = `rm${'dir'}`;
const RD = `r${'d'}`;
const DEL = `de${'l'}`;
const REMOVE = `Remove${'-Item'}`;
const WIN = `C:\\Win${'dows'}`;

const run = (tool: string, command: string, cwd = '/work/other') =>
  lib.decide(JSON.stringify({ tool_name: tool, tool_input: { command }, cwd }));

describe('① N1 递归删除护栏：该拦的', () => {
  it.each([
    `${RM} -rf /`,
    `${RM} -rf /*`,
    `${RM} -rf C:/`,
    `${RM} -rf 'C:\\'`,
    `${RM} -rf /c`,
    `${RM} -rf ${WIN}`,
    `${RM} -rf 'C:\\Windows\\System32'`,
    `${RM} -rf "C:/Windows/System32/config"`,
    `${RM} -rf /c/Windows`,
    `${RM} -rf /mnt/c/Windows/Temp`,
    `${RM} -fr "C:/Program Files"`,
    `${RM} -rf "C:/Program Files (x86)/Foo"`,
    `${RM} -rf C:/ProgramData`,
    `${RM} -rf ~`,
    `${RM} -rf ~/`,
    `${RM} -rf ~/*`,
    `${RM} -rf $HOME`,
    `${RM} -rf C:/Users/Administrator`,
    `${RM} -rf 'C:\\Users\\Administrator\\AppData'`,
    `${RM} -rf ~/AppData`,
    `${RM} -rf D:/frank/fleet-dao/.git`,
    `${RM} -rf D:/frank/fleet-dao/.git/worktrees`,
    `${RM} --recursive --force C:/`,
    `${RM} -r -f /`,
    `sudo ${RM} -rf /`,
    `cd /tmp && ${RM} -rf C:/`,
    `echo ok; ${RM} -rf C:/Windows`,
    `bash -c '${RM} -rf C:/Windows'`,
    `ssh vps "${RM} -rf /"`,
    `cat <<EOF\nhi\nEOF\n${RM} -rf C:/`,
  ])('Bash：%s → 拦', (command) => {
    const v = run('Bash', command);
    expect(v.code).toBe(2);
    expect(v.message ?? '').toContain('递归删除');
  });

  it.each([
    `${REMOVE} -Recurse -Force ${WIN}`,
    `${REMOVE} -Path C:\\ -Recurse`,
    `${REMOVE} -LiteralPath 'C:\\Program Files' -Recurse -Force`,
    `${REMOVE} -Recurse -Force $env:USERPROFILE`,
    `${REMOVE} C:\\Users\\Administrator -Recurse`,
    `${REMOVE} C:\\Users\\Administrator\\AppData -Rec`,
    `${RM} -r -fo $env:USERPROFILE`,
    `ri C:\\ProgramData -Recurse`,
    `${DEL} C:\\Windows -Recurse`,
    `${RD} /s /q ${WIN}`,
    `${RMDIR} /s C:\\`,
    `${DEL} /s /q C:\\Windows\\*`,
    `${RD} /S/Q C:\\Users\\Administrator`,
    `cmd /c ${RD} /s /q C:\\`,
    `powershell -Command "${REMOVE} -Recurse C:\\Windows"`,
    `echo hi; ${REMOVE} -Recurse -Force 'C:\\'`,
  ])('PowerShell：%s → 拦', (command) => {
    const v = run('PowerShell', command);
    expect(v.code).toBe(2);
    expect(v.message ?? '').toContain('递归删除');
  });

  it('主检出里的相对路径 .git：会话目录是 fleet-dao 主检出就拦，是工作树就放行', () => {
    expect(run('Bash', `${RM} -rf .git`, 'D:/frank/fleet-dao').code).toBe(2);
    expect(run('Bash', `${RM} -rf ./.git`, 'D:\\frank\\fleet-dao').code).toBe(2);
    expect(run('Bash', `${RM} -rf .git`, 'D:/frank/fleet-dao/.claude/worktrees/slim-p2').code).toBe(0);
    expect(run('Bash', `${RM} -rf .git`, '/work/other').code).toBe(0);
  });

  it('别家的终端（Grok 的 run_terminal_command）也拦', () => {
    expect(run('run_terminal_command', `${RM} -rf C:/`).code).toBe(2);
  });
});

describe('① N1 递归删除护栏：该放行的', () => {
  it.each([
    `${RM} -rf node_modules`,
    `${RM} -rf dist/ build/`,
    `${RM} -rf /tmp/x`,
    `${RM} -rf /tmp/foo/*`,
    `${RM} -rf D:/frank/fleet-dao/.claude/worktrees/slim-p2`,
    `${RM} -rf D:/frank/fleet-dao/_tmp/old`,
    `${RM} -rf C:/Users/Administrator/proj/dist`,
    `${RM} -rf C:/Users/Administrator/AppData/Local/Temp/x`,
    `${RM} -rf C:/Windows-old-copy`,
    `${RM} -rf C:/work/Windows`,
    `${RM} -rf ~/proj/dist`,
    `${RM} -f /etc/hosts.bak`,
    `${RM} C:/Windows/x.txt`,
    `${RM} -rf --no-preserve-root-not-an-option-name x`,
    `ls -R C:/`,
    `echo ${RM} -rf /`,
    `git commit -m "${RM} -rf /"`,
    `cat <<'EOF'\n${RM} -rf C:/Windows\nEOF`,
    `ssh vps "ls /"`,
  ])('Bash：%s → 放行', (command) => {
    expect(run('Bash', command).code).toBe(0);
  });

  it.each([
    `${REMOVE} -Recurse -Force .\\node_modules`,
    `${REMOVE} -Path C:\\Windows\\Temp\\x.txt`,
    `${REMOVE} C:\\Windows\\x.txt -Force`,
    `${REMOVE} -Recurse C:\\Users\\Administrator\\proj\\dist`,
    `${RD} /s /q D:\\frank\\fleet-dao\\_tmp\\old`,
    `${DEL} /q C:\\Windows\\x.txt`,
    `${DEL} C:\\Users\\Administrator\\AppData\\Local\\Temp\\x.txt`,
    `${RM} -Force C:\\Windows\\x.txt`,
    `Get-ChildItem C:\\ -Recurse`,
  ])('PowerShell：%s → 放行', (command) => {
    expect(run('PowerShell', command).code).toBe(0);
  });
});

describe('② 冒烟：真起钩子进程', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  const hook = (stdin: string) => {
    const state = mkdtempSync(join(tmpdir(), 'pretool-smoke-'));
    made.push(state);
    return runChild(process.execPath, [HOOK], {
      input: stdin,
      env: { ...process.env, FLEET_UNATTENDED_DIR: state, CLAUDE_CODE_SESSION_ID: '' },
    });
  };

  it('喂 Bash ls 的 JSON：退出码 0、不往 stderr 写东西', () => {
    const r = hook('{"tool_name":"Bash","tool_input":{"command":"ls"}}');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('钩子进程里真拦：递归删 C 盘根退出码 2，stderr 说明原因', () => {
    const r = hook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: `${RM} -rf C:/` } }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('递归删除');
  });
});
