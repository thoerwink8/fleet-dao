// 钉住 Stop 钩子（agents/hooks/stop.mjs）的规矩（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 唯一不能被脚本悄悄改掉的规矩：这个钩子只提醒、不拦、不接着聊——不管仓根干不干净、输入好不好，退出码恒为 0，
// 输出里不许有 decision（会拦下 Stop）、不许有 hookSpecificOutput（additionalContext 会让对话接着走）。
// 命令行外壳：真 spawn 这个文件，喂 stdin，看退出码和 stdout——测的是钩子实际接到 Claude Code 输入时的样子，不是内部函数。
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HOOK = fileURLToPath(new URL('../../hooks/stop.mjs', import.meta.url));

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `stop-rules-${name}-`));
  made.push(dir);
  return dir;
}
const g = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function repoWithStray(): string {
  const dir = temp('repo');
  g(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'stray.png'), 'x');
  return dir;
}

function run(stdin: string, cwd?: string) {
  return spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', cwd });
}

/** 输出不是空的时候，必须是合法 JSON，而且只有 systemMessage 这一个字段 */
function parseSystemMessageOnly(stdout: string): void {
  const trimmed = stdout.trim();
  if (trimmed === '') return;
  const parsed: unknown = JSON.parse(trimmed);
  expect(parsed).toEqual({ systemMessage: expect.any(String) });
}

describe('规矩：Stop 钩子只提醒、不拦、不接着聊', () => {
  it('仓根有像临时文件的：退出码 0，systemMessage 提醒，没有 decision、没有 hookSpecificOutput', () => {
    const dir = repoWithStray();
    const r = run(JSON.stringify({ hook_event_name: 'Stop', cwd: dir, stop_hook_active: false }));
    expect(r.status).toBe(0);
    parseSystemMessageOnly(r.stdout);
    expect(r.stdout).toContain('stray.png');
    expect(r.stdout).not.toContain('decision');
    expect(r.stdout).not.toContain('hookSpecificOutput');
  });

  it('仓根干净：退出码 0，什么都不打印——不拿「没什么可说」硬凑一条消息', () => {
    const dir = temp('clean');
    g(dir, 'init', '-q', '-b', 'main');
    const r = run(JSON.stringify({ hook_event_name: 'Stop', cwd: dir, stop_hook_active: false }));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('stop_hook_active 是 true（这一轮是别的 Stop 钩子带下去的）：不重复提醒，退出码仍是 0', () => {
    const dir = repoWithStray();
    const r = run(JSON.stringify({ hook_event_name: 'Stop', cwd: dir, stop_hook_active: true }));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('故意造出失败：stdin 不是 JSON——退出码仍是 0（Stop 上退出码 2 是「不许停」，读不懂输入不能拦下收尾）', () => {
    const r = run('这不是 JSON');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('故意造出失败：cwd 指到一个根本不是 git 仓的目录——安静退出，不当成「有问题」也不崩', () => {
    const dir = temp('not-a-repo');
    const r = run(JSON.stringify({ hook_event_name: 'Stop', cwd: dir, stop_hook_active: false }));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('故意造出失败：cwd 指到一个已经被删掉的目录——安静退出，不崩、不拦', () => {
    const gone = join(temp('gone-parent'), 'was-here');
    const r = run(JSON.stringify({ hook_event_name: 'Stop', cwd: gone, stop_hook_active: false }));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('故意造出失败：连 cwd 字段都没给——退回钩子自己的工作目录，不崩、退出码仍是 0', () => {
    // 钩子进程的工作目录明确指到一个不是仓的临时目录：不靠「测试恰好在哪个仓里跑」这种会变的状态
    const notARepo = temp('no-cwd-field');
    const r = run(JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }), notARepo);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});
