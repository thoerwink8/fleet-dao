// 钉住 Stop 钩子（agents/hooks/stop.mjs）的规矩（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 规矩（决定 0026，创始人 2026-10-06 17:25「按照你推荐」）：
// 1. 只提醒、不拦、不接着聊——不管仓根干不干净、输入好不好、旧的无人值守状态还在不在，退出码恒为 0，
//    输出里不许有 decision（会拦下 Stop）、不许有 hookSpecificOutput（additionalContext 会让对话接着走）。
// 2. `unattended.mjs on` 不再写状态、不再挡收尾，只告诉去起脱离会话的工人。
// 命令行外壳：真 spawn 这个文件，喂 stdin，看退出码和 stdout——测的是钩子实际接到 Claude Code 输入时的样子，不是内部函数。
// 这份文件每条都要起真的 node 子进程（本机实测一条 0.4 秒上下；满载并行跑时更慢），默认 5 秒的超时会误红（#718：13 个子进程 6057ms）。
// 超时放这么宽只是兜底——挡的是「机器真的卡住了」，不是拿来盖住「一条测试起了太多子进程」：子进程的数量那边已经按规矩需要的最少次数收过（见下面那条）。
// 同目录的先例：discuss.test.ts 的 SLOW、session-start.test.ts 的 SLOW、progress-structure.test.ts 的 SLOW。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HOOK = fileURLToPath(new URL('../../hooks/stop.mjs', import.meta.url));

/** 这份文件每条都起真 node 子进程（本机满载时一个 0.4 秒上下），默认 5 秒太紧：60 秒兜底（同 discuss.test.ts 的 SLOW） */
const SLOW = { timeout: 60_000 };

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

describe('规矩：没开无人值守时，Stop 钩子只提醒、不拦、不接着聊', SLOW, () => {
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

const UNATTENDED_URL = new URL('../../hooks/unattended.mjs', import.meta.url).href;
const UNATTENDED = fileURLToPath(UNATTENDED_URL);
const SID = 'test-session-0001';

function cli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [UNATTENDED, ...args], { encoding: 'utf8', env });
}
function stop(env: NodeJS.ProcessEnv, extra: Record<string, unknown> = {}) {
  const input = { hook_event_name: 'Stop', session_id: SID, cwd: temp('cwd'), ...extra };
  return run(JSON.stringify(input), undefined, env);
}
const blocked = (stdout: string) => stdout.includes('"decision":"block"');

describe('规矩：收尾不再被挡住，on 只指向脱离会话的工人', SLOW, () => {
  it('on 不写状态、退出码 0，Stop 没有 decision；没有会话号也一样', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    const turned = cli(['on'], env);
    expect(turned.status).toBe(0);
    expect(turned.stdout).toContain('0026');
    expect(turned.stdout).toContain('worker.mjs');
    expect(existsSync(join(dir, `${SID}.json`))).toBe(false);
    expect(cli(['on'], isolatedEnv(dir, '')).status).toBe(0);
    const r = stop(env);
    expect(r.status).toBe(0);
    expect(blocked(r.stdout)).toBe(false);
    expect(r.stdout).not.toContain('hookSpecificOutput');
  });

  it('【故意造出的失败】旧状态文件写着开着：Stop 仍不拦，文件也不被改成暂停', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    const file = join(dir, `${SID}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        state: 'on',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        idle: 0,
        totalBlocks: 40,
        toolSinceBlock: true,
      }),
    );
    const r = stop(env);
    expect(r.status).toBe(0);
    expect(blocked(r.stdout)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8')).state).toBe('on');
  });

  it('不认识的命令明确失败；没开过就 done，也明确失败，不装作收尾了', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    expect(cli(['乱来'], env).status).toBe(2);
    expect(cli(['done', '没开过'], env).status).toBe(1);
    expect(existsSync(join(dir, `${SID}.json`))).toBe(false);
  });

  describe('他说了话：收尾清账，工具不被拦', () => {
    const PROMPT_LOG = fileURLToPath(new URL('../../hooks/prompt-log.mjs', import.meta.url));
    const PRETOOL = fileURLToPath(new URL('../../hooks/pretool.mjs', import.meta.url));
    const say = (env: NodeJS.ProcessEnv, prompt: string) =>
      spawnSync(process.execPath, [PROMPT_LOG], {
        input: JSON.stringify({ session_id: SID, prompt_id: `p-${prompt.length}`, prompt }),
        encoding: 'utf8',
        env: { ...env, FLEET_PROMPT_LOG_DIR: temp('plog') },
      });
    const tool = (
      env: NodeJS.ProcessEnv,
      name: string,
      input: Record<string, unknown> = { command: 'echo hi' },
    ) =>
      spawnSync(process.execPath, [PRETOOL], {
        input: JSON.stringify({ tool_name: name, tool_input: input, cwd: temp('c'), session_id: SID }),
        encoding: 'utf8',
        env,
      });
    const owedPath = (dir: string) => join(dir, `${SID}.owed.json`);
    const age = (dir: string, minutes: number) => {
      const o = JSON.parse(readFileSync(owedPath(dir), 'utf8'));
      writeFileSync(
        owedPath(dir),
        JSON.stringify({ ...o, at: new Date(Date.now() - minutes * 60_000).toISOString() }),
      );
    };
    const leaveOn = (dir: string) => {
      writeFileSync(
        join(dir, `${SID}.json`),
        JSON.stringify({
          state: 'on',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          idle: 0,
          totalBlocks: 0,
          toolSinceBlock: true,
        }),
      );
    };

    it('旧状态还开着、话欠了 11 分钟：工具放行（退出码 0），收尾清账、不拦', () => {
      const dir = temp('state');
      const env = isolatedEnv(dir, SID);
      leaveOn(dir);
      expect(say(env, '这样改合理吗？断链在哪').status).toBe(0);
      age(dir, 11);
      const nag = tool(env, 'Bash');
      expect(nag.status).toBe(0);
      expect(nag.stderr).not.toContain('还没有东西送到他手上');
      expect(blocked(stop(env).stdout)).toBe(false);
      expect(existsSync(owedPath(dir))).toBe(false);
    });

    it('调了送达类工具就清账', () => {
      const dir = temp('state');
      const env = isolatedEnv(dir, SID);
      say(env, '这样改合理吗？断链在哪');
      expect(tool(env, 'mcp__mirasim__deliver_artifact', { path: 'D:/x/answer.md' }).status).toBe(0);
      expect(existsSync(owedPath(dir))).toBe(false);
    });

    it('不算他的话：后台活的完成通知、上下文总结的开场白、「继续」这种几个字的', () => {
      const dir = temp('state');
      const env = isolatedEnv(dir, SID);
      for (const p of [
        '<task-notification> <task-id>x</task-id>',
        'This session is being continued from…',
        '继续',
      ]) {
        say(env, p);
        expect(existsSync(owedPath(dir)), p).toBe(false);
      }
    });

    it('【故意造出的失败】欠账文件坏了：不拦、不崩', () => {
      const dir = temp('state');
      const env = isolatedEnv(dir, SID);
      leaveOn(dir);
      writeFileSync(owedPath(dir), '{不是 JSON');
      const nag = tool(env, 'Bash');
      expect(nag.status).toBe(0);
      expect(blocked(stop(env).stdout)).toBe(false);
    });
  });

  it('开会话不再塞「这一轮不要结束」；暂停过的只留原因', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    const lines = (): string[] => {
      const code = `import { sessionLines } from ${JSON.stringify(UNATTENDED_URL)}; console.log(JSON.stringify(sessionLines({ dir: process.env.FLEET_UNATTENDED_DIR, sessionId: process.env.CLAUDE_CODE_SESSION_ID })));`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout.trim());
    };
    expect(lines()).toEqual([]);
    writeFileSync(
      join(dir, `${SID}.json`),
      JSON.stringify({
        state: 'on',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        idle: 0,
        totalBlocks: 0,
      }),
    );
    expect(lines()).toEqual([]);
    writeFileSync(
      join(dir, `${SID}.json`),
      JSON.stringify({
        state: 'paused',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        idle: 0,
        totalBlocks: 0,
        note: '要花钱',
      }),
    );
    expect(lines().join('')).toContain('暂停过（要花钱）');
    expect(lines().join('')).toContain('可以结束');
    expect(lines().join('')).not.toContain('不要结束');
  });
});
