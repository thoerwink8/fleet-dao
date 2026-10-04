// 钉住调工具前钩子（agents/hooks/pretool.mjs）的「前台等待上限」（改标准：改这个文件要创始人同意，agents/test/rules/ 在清单里）。
// 规矩（创始人 2026-10-04「选 1」）：单次前台等待不超过 60 秒，不分无人值守与否——他在我干活时发的话只在两次工具调用的间隙送到，
// 一条长前台等待中间没有间隙，话卡在那儿，进程一断还会丢。长的用 run_in_background，后台跑的不受限。
// 脚本改了这条判断，这里会红；【故意造出的失败】那条证明拦得住、而且认不出的输入不会被当成超了。
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

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

  it('真的从命令行进来也是退出码 2，原因在 stderr（钩子是按进程调的）', () => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'sleep 300' }, cwd: '/work/other' }),
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('run_in_background');
  });
});
