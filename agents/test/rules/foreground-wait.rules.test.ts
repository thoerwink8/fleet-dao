// 钉住调工具前钩子（agents/hooks/pretool.mjs）的「前台等待上限」（改标准：改这个文件要创始人同意，agents/test/rules/ 在清单里）。
// 规矩（创始人 2026-10-04「选 1」）：单次前台等待不超过 60 秒，不分无人值守与否——他在我干活时发的话只在两次工具调用的间隙送到，
// 一条长前台等待中间没有间隙，话卡在那儿，进程一断还会丢。长的用 run_in_background，后台跑的不受限。
// 脚本改了这条判断，这里会红；【故意造出的失败】那条证明拦得住、而且认不出的输入不会被当成超了。
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runChild } from '../child.ts';

interface PretoolLib {
  decide(raw: string, fallbackCwd?: string): { code: number; message?: string };
  foregroundWait(toolInput: unknown, cmd: string, kind: string): { seconds: number; what: string } | null;
  MAX_FOREGROUND_WAIT_SECONDS: number;
}
const HOOK = fileURLToPath(new URL('../../hooks/pretool.mjs', import.meta.url));
const lib = (await import(pathToFileURL(HOOK).href)) as PretoolLib;

const run = (tool: string, input: Record<string, unknown>) =>
  lib.decide(JSON.stringify({ tool_name: tool, tool_input: input, cwd: '/work/other' }));

describe('前台等待上限', () => {
  it('上限是 60 秒', () => {
    expect(lib.MAX_FOREGROUND_WAIT_SECONDS).toBe(60);
  });

  // 决定 0078：通用段「Agent 子代理」那条和 commander 技能写的等待上限，跟钩子卡的是同一个数（通用段只写这一处，steer-and-subagents 钉着）
  it('通用段和 commander 技能写的上限就是钩子卡的这个数', () => {
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    const n = lib.MAX_FOREGROUND_WAIT_SECONDS;
    expect(read('../../shared-rules.md')).toContain(`单次前台等待不超过 ${n} 秒`);
    expect(read('../../skills/commander/SKILL.md')).toContain(`前台单次等待不超过 ${n} 秒`);
  });

  it.each([
    ['Bash', { command: 'sleep 120' }],
    ['Bash', { command: 'git fetch && sleep 90 && echo ok' }],
    ['Bash', { command: 'sleep 2m' }],
    ['Bash', { command: 'pnpm test', timeout: 300_000 }],
    ['PowerShell', { command: 'Start-Sleep -Seconds 120' }],
    ['PowerShell', { command: 'Start-Sleep 90' }],
    ['PowerShell', { command: 'Start-Sleep -s 61' }],
    ['PowerShell', { command: 'Start-Sleep -Milliseconds 90000' }],
    ['PowerShell', { command: 'pnpm build', timeout: 61_000 }],
  ])('%s %j：拦下，并说怎么改', (tool, input) => {
    const v = run(tool, input);
    expect(v.code).toBe(2);
    expect(v.message).toContain('run_in_background');
    expect(v.message).toContain('60 秒');
  });

  it.each([
    ['Bash', { command: 'sleep 30' }],
    ['Bash', { command: 'sleep 60' }],
    ['Bash', { command: 'sleep 1m' }],
    ['Bash', { command: 'echo "sleep 999 只是文字里提到"' }],
    ['Bash', { command: 'pnpm test', timeout: 60_000 }],
    ['PowerShell', { command: 'Start-Sleep -Seconds 45' }],
    ['PowerShell', { command: 'Start-Sleep -Milliseconds 500' }],
    ['PowerShell', { command: 'Get-Date' }],
  ])('%s %j：放行', (tool, input) => {
    expect(run(tool, input).code).toBe(0);
  });

  it('框架给没写 timeout 的调用自动补 120000：不能因此把每条普通命令都拦了（#827 当天误拦过）；显式写别的数照拦', () => {
    expect(run('Bash', { command: 'git status', timeout: 120_000 }).code).toBe(0);
    expect(run('PowerShell', { command: 'Get-Date', timeout: 120_000 }).code).toBe(0);
    expect(run('Bash', { command: 'git status', timeout: 119_999 }).code).toBe(2);
    expect(run('Bash', { command: 'git status', timeout: 120_001 }).code).toBe(2);
    // 默认的 timeout 不能给 sleep 开后门
    expect(run('Bash', { command: 'sleep 100', timeout: 120_000 }).code).toBe(2);
  });

  // 创始人 2026-10-06「这种方式不太正确……把不合理的 subagent 方式改掉」：上限是为了他的话能在两次调用之间送到主会话；
  // 子代理不和他对话，套上只剩代价（#1118 一个活 143 次调用、25 分钟）。Claude Code 只在子代理里的钩子调用带 agent_id。
  it('子代理（输入带 agent_id）：前台等多久都放行；主会话的规矩一条不变', () => {
    const sub = (input: Record<string, unknown>) =>
      lib.decide(
        JSON.stringify({ tool_name: 'Bash', tool_input: input, cwd: '/work/other', agent_id: 'a1b2c3' }),
      );
    expect(sub({ command: 'sleep 600' }).code).toBe(0);
    expect(sub({ command: 'pnpm test', timeout: 900_000 }).code).toBe(0);
    expect(run('Bash', { command: 'sleep 600' }).code).toBe(2);
  });

  it('【故意造出的失败】agent_id 空着、不是字符串：不算子代理，照主会话拦', () => {
    for (const bad of ['', '   ', 7, null, true]) {
      const v = lib.decide(
        JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'sleep 600' },
          cwd: '/work/other',
          agent_id: bad,
        }),
      );
      expect(v.code, JSON.stringify(bad)).toBe(2);
    }
  });

  it('后台跑的不受限：run_in_background 为真，再长的 sleep 和 timeout 都放行', () => {
    expect(run('Bash', { command: 'sleep 600', run_in_background: true }).code).toBe(0);
    expect(run('Bash', { command: 'pnpm test', timeout: 900_000, run_in_background: true }).code).toBe(0);
    expect(run('PowerShell', { command: 'Start-Sleep 600', run_in_background: true }).code).toBe(0);
  });

  it('【故意造出的失败】run_in_background 写成字符串 "true" 不算后台；timeout 不是数字不当成超了', () => {
    expect(run('Bash', { command: 'sleep 600', run_in_background: 'true' }).code).toBe(2);
    expect(lib.foregroundWait({ timeout: 'abc' }, 'echo', 'bash')).toBeNull();
    expect(lib.foregroundWait({ timeout: Number.NaN }, 'echo', 'bash')).toBeNull();
    expect(lib.foregroundWait(undefined, 'echo', 'bash')).toBeNull();
  });

  // 同步起子进程：卡死由 runChild 给子进程的上限管，不靠 vitest 的超时（它打断不了同步用例，#264）
  it('真的从命令行进来也是退出码 2，原因在 stderr（钩子是按进程调的）', { timeout: 0 }, () => {
    const r = runChild(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'sleep 300' }, cwd: '/work/other' }),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('run_in_background');
  });
});
