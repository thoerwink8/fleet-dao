// 钉住 Stop 钩子（agents/hooks/stop.mjs）的规矩（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 规矩两条，都不能被脚本悄悄改掉：
// 1. 没开无人值守时只提醒、不拦、不接着聊——不管仓根干不干净、输入好不好，退出码恒为 0，输出里不许有 decision（会拦下 Stop）、
//    不许有 hookSpecificOutput（additionalContext 会让对话接着走）。
// 2. 开了无人值守（unattended.mjs on，创始人 2026-10-03「选 a」）才许拦：输出 decision:block；做完、要他拍板、暂停、过期、
//    状态读不了、连着没干活，都放行，绝不把人困住。
// 命令行外壳：真 spawn 这个文件，喂 stdin，看退出码和 stdout——测的是钩子实际接到 Claude Code 输入时的样子，不是内部函数。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** 状态目录指到一个空的临时目录、不带会话号：测试不碰真机器上的无人值守状态，也不受跑测试的这个会话自己开没开影响 */
function isolatedEnv(stateDir: string, sessionId = ''): NodeJS.ProcessEnv {
  return { ...process.env, FLEET_UNATTENDED_DIR: stateDir, CLAUDE_CODE_SESSION_ID: sessionId };
}

function run(stdin: string, cwd?: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
    cwd,
    env: env ?? isolatedEnv(temp('state')),
  });
}

/** 输出不是空的时候，必须是合法 JSON，而且只有 systemMessage 这一个字段 */
function parseSystemMessageOnly(stdout: string): void {
  const trimmed = stdout.trim();
  if (trimmed === '') return;
  const parsed: unknown = JSON.parse(trimmed);
  expect(parsed).toEqual({ systemMessage: expect.any(String) });
}

describe('规矩：没开无人值守时，Stop 钩子只提醒、不拦、不接着聊', () => {
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

const UNATTENDED = fileURLToPath(new URL('../../hooks/unattended.mjs', import.meta.url));
const SID = 'test-session-0001';

function cli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [UNATTENDED, ...args], { encoding: 'utf8', env });
}
function stop(env: NodeJS.ProcessEnv, extra: Record<string, unknown> = {}) {
  const input = { hook_event_name: 'Stop', session_id: SID, cwd: temp('cwd'), ...extra };
  return run(JSON.stringify(input), undefined, env);
}
const blocked = (stdout: string) => stdout.includes('"decision":"block"');

describe('规矩：开着无人值守才拦，其余一律放行', () => {
  it('开着：Stop 输出 decision:block 和怎么结束的办法，退出码仍是 0；stop_hook_active 为真也照样拦（那是我们自己挡出来的）', () => {
    const env = isolatedEnv(temp('state'), SID);
    expect(cli(['on'], env).status).toBe(0);
    for (const active of [false, true]) {
      const r = stop(env, { stop_hook_active: active });
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout.trim());
      expect(out.decision).toBe('block');
      expect(out.reason).toContain('unattended.mjs done');
      expect(out.reason).toContain('unattended.mjs needs-you');
    }
  });

  it('没开、或者开的是别的会话：不拦', () => {
    const dir = temp('state');
    expect(cli(['on'], isolatedEnv(dir, 'other-session-0002')).status).toBe(0);
    expect(blocked(stop(isolatedEnv(dir, SID)).stdout)).toBe(false);
  });

  it('done、needs-you、off 之后都放行；done 和 needs-you 不写一句话不认', () => {
    const env = isolatedEnv(temp('state'), SID);
    for (const cmd of ['done', 'needs-you']) {
      cli(['on'], env);
      expect(cli([cmd], env).status).toBe(2);
      expect(blocked(stop(env).stdout)).toBe(true);
      expect(cli([cmd, '一句话'], env).status).toBe(0);
      expect(blocked(stop(env).stdout)).toBe(false);
    }
    cli(['on'], env);
    cli(['off'], env);
    expect(blocked(stop(env).stdout)).toBe(false);
  });

  it('故意造出失败：被挡回去后连着 3 次没调工具——放行并转成暂停，写明原因（不无限空转）', () => {
    const env = isolatedEnv(temp('state'), SID);
    cli(['on'], env);
    const results = [1, 2, 3, 4].map(() => stop(env));
    expect(results.map((r) => blocked(r.stdout))).toEqual([true, true, true, false]);
    expect(results[3]?.stdout).toContain('自动暂停');
    expect(cli(['status'], env).stdout).toContain('paused');
  });

  it('两次挡之间调过工具（PreToolUse 记了一笔）：不算空转，可以一直挡', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    cli(['on'], env);
    const PRETOOL = fileURLToPath(new URL('../../hooks/pretool.mjs', import.meta.url));
    for (let i = 0; i < 6; i += 1) {
      expect(blocked(stop(env).stdout), `第 ${i + 1} 次`).toBe(true);
      const t = spawnSync(process.execPath, [PRETOOL], {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'echo hi' },
          cwd: temp('c'),
          session_id: SID,
        }),
        encoding: 'utf8',
        env,
      });
      expect(t.status).toBe(0);
    }
  });

  it('故意造出失败：状态文件坏了 / 读不了——放行，并明说是状态读不了（不装作正常收尾，也不困住人）', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    cli(['on'], env);
    writeFileSync(join(dir, `${SID}.json`), '{不是 JSON');
    const bad = stop(env);
    expect(blocked(bad.stdout)).toBe(false);
    expect(bad.stdout).toContain('状态文件不是合法的 JSON');
    writeFileSync(join(dir, `${SID}.json`), JSON.stringify({ state: 'on' }));
    expect(stop(env).stdout).toContain('内容认不出');
    rmSync(join(dir, `${SID}.json`));
    mkdirSync(join(dir, `${SID}.json`)); // 读一个目录：读不了
    const unreadable = stop(env);
    expect(blocked(unreadable.stdout)).toBe(false);
    expect(unreadable.stdout).toContain('读不了状态文件');
  });

  it('故意造出失败：过期了——放行、删掉状态、说一声', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    cli(['on'], env);
    const file = join(dir, `${SID}.json`);
    const s = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...s, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const r = stop(env);
    expect(blocked(r.stdout)).toBe(false);
    expect(r.stdout).toContain('过期');
    expect(existsSync(file)).toBe(false);
  });

  it('故意造出失败：命令行拿不到会话号、不认识的命令、--hours 不合法——都明确失败（退出码非 0），不装作开成了', () => {
    const dir = temp('state');
    expect(cli(['on'], isolatedEnv(dir, '')).status).toBe(2);
    const env = isolatedEnv(dir, SID);
    expect(cli(['乱来'], env).status).toBe(2);
    expect(cli(['on', '--hours', '0'], env).status).toBe(2);
    expect(cli(['on', '--hours', '99'], env).status).toBe(2);
    expect(cli(['on', '--hours', 'abc'], env).status).toBe(2);
    expect(cli(['done', '没开过'], env).status).toBe(1);
    expect(existsSync(join(dir, `${SID}.json`))).toBe(false);
  });

  it('开会话钩子读得到：开着给一句话、暂停给一句话、没开什么都不给', async () => {
    const { sessionLines } = await import('../../hooks/unattended.mjs');
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    expect(sessionLines({ dir, sessionId: SID })).toEqual([]);
    cli(['on'], env);
    expect(sessionLines({ dir, sessionId: SID }).join('')).toContain('无人值守开着');
    cli(['needs-you', '要花钱'], env);
    expect(sessionLines({ dir, sessionId: SID }).join('')).toContain('暂停着（要花钱）');
  });
});
