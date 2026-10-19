// 钉住 Stop 钩子（agents/hooks/stop.mjs）的规矩（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 规矩：
// 1. 没开无人值守时（没人在这个会话里跑过 `unattended.mjs on`）不拦、不接着聊（仓根临时文件的提醒已删）——不管仓根干不干净、输入好不好，
//    退出码恒为 0，输出里不许有 decision（会拦下 Stop）、不许有 hookSpecificOutput（additionalContext 会让对话接着走）。
// 2. 决定 0028（创始人 2026-10-07 约 02:27 推翻 0026 的「这一轮结束、收尾不拦」）：只有这个会话自己跑了 `on` 才挡；
//    起子代理、监视、后台命令不自动开；off、done / needs-you、满 12 小时、总次数到上限都放行。
// 3. 无人值守未完成工作同步续轮；后台条数不能证明送达。成功新工作重置无进展计数，三次无进展明确暂停故障。
// 命令行外壳：真 spawn 这个文件，喂 stdin，看退出码和 stdout——测的是钩子实际接到 Claude Code 输入时的样子，不是内部函数。
// 这份文件每条都要起真的 node 子进程（本机实测一条 0.4 秒上下；满载并行跑时更慢），默认 5 秒的超时会误红（#718：13 个子进程 6057ms）。
// 子进程一律经 ../child.ts 的 runChild 起：每个子进程自带上限，卡死由它杀掉并抛出；用例不设 vitest 的超时（#264）。
// 子进程的数量那边已经按规矩需要的最少次数收过（见下面那条），不靠放宽时间来盖住「一条测试起了太多子进程」。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild, runChildOk } from '../child.ts';
import { codexSourceFixture } from '../codex-source-fixture.ts';
import { interactiveHookEnv } from '../hook-env.ts';

const HOOK = fileURLToPath(new URL('../../hooks/stop.mjs', import.meta.url));

/** 同步起子进程的用例不设 vitest 的超时：它打断不了同步用例，只能事后量用时，机器一忙就把慢报成红；卡死由 runChild 的上限管（#264） */
const SLOW = { timeout: 0 };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `stop-rules-${name}-`));
  made.push(dir);
  return dir;
}
const g = (cwd: string, ...a: string[]) => runChildOk('git', a, { cwd });

function repoWithStray(): string {
  const dir = temp('repo');
  g(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'stray.png'), 'x');
  return dir;
}

/**
 * 状态目录指到一个空的临时目录、不带会话号：测试不碰真机器上的无人值守状态，也不受跑测试的这个会话自己开没开影响；
 * FLEET_WORKER 清掉：在工人会话里跑这份测试时，它不该把 on 当成机器派的会话拒掉。
 */
function isolatedEnv(stateDir: string, sessionId = ''): NodeJS.ProcessEnv {
  return {
    ...interactiveHookEnv(),
    FLEET_UNATTENDED_DIR: stateDir,
    FLEET_WORKER: '',
    CLAUDE_CODE_SESSION_ID: sessionId,
    CODEX_THREAD_ID: '',
    CODEX_SESSION_ID: '',
    // Mirasim 的引导那一条（#1743）在 mirasim-steer.rules.test.ts 钉；这里指到不在的目录，不读这台机器上的真 diag
    FLEET_MIRASIM_DIR: join(stateDir, 'no-mirasim'),
  };
}

function run(stdin: string, cwd?: string, env?: NodeJS.ProcessEnv) {
  return runChild(process.execPath, [HOOK], {
    input: stdin,
    ...(cwd === undefined ? {} : { cwd }),
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

describe('规矩：没开无人值守时，Stop 钩子不拦、不接着聊', SLOW, () => {
  it('仓根有没跟踪的截图：不再提醒——退出码 0，什么都不打印', () => {
    const dir = repoWithStray();
    const r = run(JSON.stringify({ hook_event_name: 'Stop', cwd: dir, stop_hook_active: false }));
    expect(r.status).toBe(0);
    parseSystemMessageOnly(r.stdout);
    expect(r.stdout.trim()).toBe('');
  });

  it('仓根干净：退出码 0，什么都不打印——不拿「没什么可说」硬凑一条消息', () => {
    const dir = temp('clean');
    g(dir, 'init', '-q', '-b', 'main');
    const r = run(JSON.stringify({ hook_event_name: 'Stop', cwd: dir, stop_hook_active: false }));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('stop_hook_active 是 true：退出码仍是 0，什么都不打印', () => {
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
  return runChild(process.execPath, [UNATTENDED, ...args], { env });
}
function stop(env: NodeJS.ProcessEnv, extra: Record<string, unknown> = {}) {
  const input = { hook_event_name: 'Stop', session_id: SID, cwd: temp('cwd'), ...extra };
  return run(JSON.stringify(input), undefined, env);
}
const blocked = (stdout: string) => stdout.includes('"decision":"block"');

describe('规矩：无人值守——只有这个会话自己跑了 on 才挡，几种放行，防死循环（决定 0028）', SLOW, () => {
  const stateFile = (dir: string) => join(dir, `${SID}.json`);
  const readS = (dir: string) => JSON.parse(readFileSync(stateFile(dir), 'utf8'));
  /** 直接写一份状态：把「已经挡了很多次」这类要起几十个子进程才到的局面一步摆好 */
  const seed = (dir: string, extra: Record<string, unknown>) =>
    writeFileSync(
      stateFile(dir),
      JSON.stringify({
        state: 'on',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        totalBlocks: 0,
        ...extra,
      }),
    );
  const PRETOOL = fileURLToPath(new URL('../../hooks/pretool.mjs', import.meta.url));
  const pretool = (env: NodeJS.ProcessEnv, toolName: string, toolInput: Record<string, unknown>) =>
    runChild(process.execPath, [PRETOOL], {
      input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: temp('c'), session_id: SID }),
      env,
    });

  it('on 之后：Stop 输出 decision:block，退出码仍是 0；stop_hook_active 为真也照样挡（那是我们自己挡出来的）', () => {
    const env = isolatedEnv(temp('state'), SID);
    const turned = cli(['on'], env);
    expect(turned.status).toBe(0);
    expect(turned.stdout).toContain('不代表 Stop 已登记、信任或执行验证');
    for (const active of [false, true]) {
      const r = stop(env, { stop_hook_active: active });
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout.trim());
      expect(out.decision).toBe('block');
    }
  });

  it('挡住时的理由是具体的：等子代理的完成通知、有活就派子代理、有进展记进度、别空转，以及怎么放行；不再叫人起脱离的工人', () => {
    const env = isolatedEnv(temp('state'), SID);
    cli(['on'], env);
    const reason: string = JSON.parse(stop(env).stdout.trim()).reason;
    expect(reason).toContain('CLI 支持的子代理');
    expect(reason).toContain('完成通知');
    expect(reason).toContain('阻塞等待工具');
    expect(reason).toContain('progress note');
    expect(reason).toContain('别空转');
    for (const k of ['done', 'needs-you', 'off']) expect(reason).toContain(`unattended.mjs ${k}`);
    expect(reason).not.toContain('--detached');
    expect(reason).not.toContain('watch --wait');
    expect(reason).not.toMatch(/worker\.mjs/);
  });

  it('没开、或者开的是别的会话：不挡', () => {
    const dir = temp('state');
    expect(cli(['on'], isolatedEnv(dir, 'other-session-0002')).status).toBe(0);
    expect(blocked(stop(isolatedEnv(dir, SID)).stdout)).toBe(false);
  });

  it.each(['CODEX_THREAD_ID', 'CODEX_SESSION_ID'])(
    'Stop 没有事件号时与 CLI 同读 %s，不借别的会话',
    (source) => {
      const dir = temp('state');
      const { home } = codexSourceFixture(dir, SID);
      const env = { ...isolatedEnv(dir), CODEX_HOME: home, [source]: SID };
      expect(cli(['on'], env).status).toBe(0);
      expect(blocked(stop(env, { session_id: undefined }).stdout)).toBe(true);
      const before = readFileSync(stateFile(dir), 'utf8');
      expect(blocked(stop(env, { session_id: 'child-session-0002' }).stdout)).toBe(false);
      expect(readFileSync(stateFile(dir), 'utf8')).toBe(before);
      const invalid = stop(env, { session_id: '../bad' });
      expect(blocked(invalid.stdout)).toBe(false);
      expect(invalid.stdout).toContain('session_id 不合法');
      expect(readFileSync(stateFile(dir), 'utf8')).toBe(before);
    },
  );

  it('Stop 没有事件号、最高环境来源非法时放行并明说，不借低优先级 Codex 状态', () => {
    const dir = temp('state');
    seed(dir, {});
    const env = { ...isolatedEnv(dir, '../bad'), CODEX_THREAD_ID: SID };
    const before = readFileSync(stateFile(dir), 'utf8');
    const result = stop(env, { session_id: undefined });
    expect(blocked(result.stdout)).toBe(false);
    expect(result.stdout).toContain('CLAUDE_CODE_SESSION_ID 的会话号不合法');
    expect(readFileSync(stateFile(dir), 'utf8')).toBe(before);
  });

  it('起子代理、监视、后台命令不自动开：调完 Agent / Monitor / 后台 Bash 之后没有状态文件，Stop 不挡（0026 第 2 条保留）', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    expect(pretool(env, 'Agent', { prompt: 'x', subagent_type: 'general-purpose' }).status).toBe(0);
    expect(pretool(env, 'Monitor', { command: 'sleep 1' }).status).toBe(0);
    expect(pretool(env, 'Bash', { command: 'echo hi', run_in_background: true }).status).toBe(0);
    expect(existsSync(stateFile(dir))).toBe(false);
    expect(blocked(stop(env).stdout)).toBe(false);
  });

  it('【故意造出的失败】旧版「起后台活自动开」留下的状态文件（auto:true）：不认，不挡', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    seed(dir, { auto: true });
    expect(blocked(stop(env).stdout)).toBe(false);
  });

  it('机器派的会话（工人、反方，FLEET_WORKER=1）：on 拒绝，就算有状态文件 Stop 也不挡', () => {
    const dir = temp('state');
    const env = { ...isolatedEnv(dir, SID), FLEET_WORKER: '1' };
    expect(cli(['on'], env).status).toBe(2);
    expect(existsSync(stateFile(dir))).toBe(false);
    seed(dir, {});
    expect(blocked(stop(env).stdout)).toBe(false);
  });

  it('放行一：done、needs-you、off 之后都放行；done 和 needs-you 不写一句话不认', () => {
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

  it('放行二：开着满 12 小时——放行、删掉状态、说一声；--hours 超过 12 不让开', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    expect(cli(['on', '--hours', '13'], env).status).toBe(2);
    expect(cli(['on', '--hours', '12'], env).status).toBe(0);
    const s = readS(dir);
    expect(Date.parse(s.expiresAt) - Date.parse(s.since)).toBe(12 * 3_600_000);
    seed(dir, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const r = stop(env);
    expect(blocked(r.stdout)).toBe(false);
    expect(r.stdout).toContain('过期');
    expect(existsSync(stateFile(dir))).toBe(false);
  });

  it('防死循环：连续三次无实质进展，第四次明确故障暂停，不能仍标 on 假装接续', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    seed(dir, { totalBlocks: 1 });
    const none = { background_tasks: [], session_crons: [] };
    for (let i = 1; i <= 3; i++) expect(blocked(stop(env, none).stdout)).toBe(true);
    expect(readS(dir).streak).toBe(3);
    const r = stop(env, none);
    expect(blocked(r.stdout)).toBe(false);
    expect(r.stdout).toContain('连着挡了 3 次');
    const s = readS(dir);
    expect(s.state).toBe('paused');
    expect(s.note).toContain('接续故障');
    expect(s.streakReleases).toBe(1);
    expect(typeof s.lastStreakReleaseAt).toBe('string');
    expect(blocked(stop(env, none).stdout)).toBe(false);
  });

  it('后台任务/定时唤醒条数不能证明通知送达，仍续轮并要求显式收结果', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    seed(dir, { totalBlocks: 5, streak: 0 });
    const task = { id: 'b1', type: 'subagent', status: 'running', description: '写代码' };
    const r = stop(env, { background_tasks: [task], session_crons: [] });
    expect(r.status).toBe(0);
    expect(blocked(r.stdout)).toBe(true);
    expect(r.stdout).toContain('先收结果');
    expect(readS(dir).streak).toBe(1);
    expect(readS(dir).totalBlocks).toBe(6);
    const shell = { id: 'b2', type: 'shell', status: 'running', command: 'pnpm test' };
    expect(blocked(stop(env, { background_tasks: [shell] }).stdout)).toBe(true);
    expect(
      blocked(
        stop(env, { background_tasks: [], session_crons: [{ id: 'c1', cron: '*/10 * * * *' }] }).stdout,
      ),
    ).toBe(true);
    expect(readS(dir).state).toBe('on');
  });

  it('输入里没有 background_tasks（别家、旧版 Claude Code）：判不出，按什么都没在跑算，照挡；不是数组的也一样', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    seed(dir, {});
    expect(blocked(stop(env).stdout)).toBe(true);
    expect(blocked(stop(env, { background_tasks: 'x', session_crons: 3 }).stdout)).toBe(true);
    expect(readS(dir).streak).toBe(2);
  });

  it('放行五：挡了 200 次到总上限——放行', () => {
    const dir = temp('state');
    seed(dir, { totalBlocks: 200 });
    const r = stop(isolatedEnv(dir, SID));
    expect(blocked(r.stdout)).toBe(false);
    expect(r.stdout).toContain('200 次');
  });

  it('两次挡之间调过工具不算数：PreToolUse 不再记「调了工具」，连着挡的计数照涨（sleep、查一次 PR 不算在干活）', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    seed(dir, { totalBlocks: 3, streak: 2 });
    expect(pretool(env, 'Bash', { command: 'echo hi' }).status).toBe(0);
    expect(readS(dir).toolSinceBlock).toBeUndefined();
    expect(blocked(stop(env).stdout)).toBe(true);
    const s = readS(dir);
    expect(s.state).toBe('on');
    expect(s.streak).toBe(3);
    expect(s.totalBlocks).toBe(4);
  });

  it('故意造出失败：状态文件坏了 / 读不了——放行，并明说是状态读不了（不装作正常收尾，也不困住人）', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    cli(['on'], env);
    writeFileSync(stateFile(dir), '{不是 JSON');
    const bad = stop(env);
    expect(blocked(bad.stdout)).toBe(false);
    expect(bad.stdout).toContain('状态文件不是合法的 JSON');
    writeFileSync(stateFile(dir), JSON.stringify({ state: 'on' }));
    expect(stop(env).stdout).toContain('内容认不出');
    rmSync(stateFile(dir));
    mkdirSync(stateFile(dir)); // 读一个目录：读不了
    const unreadable = stop(env);
    expect(blocked(unreadable.stdout)).toBe(false);
    expect(unreadable.stdout).toContain('读不了状态文件');
  });

  it('故意造出失败：命令行拿不到会话号、不认识的命令、--hours 不合法——都明确失败（退出码非 0），不装作开成了', () => {
    const dir = temp('state');
    expect(cli(['on'], isolatedEnv(dir, '')).status).toBe(2);
    const env = isolatedEnv(dir, SID);
    expect(cli(['乱来'], env).status).toBe(2);
    expect(cli(['on', '--hours', '0'], env).status).toBe(2);
    expect(cli(['on', '--hours', 'abc'], env).status).toBe(2);
    expect(cli(['done', '没开过'], env).status).toBe(1);
    expect(existsSync(stateFile(dir))).toBe(false);
  });

  describe('他说了话也不再写欠账，工具和收尾都不拦（决定 0027）', () => {
    const PROMPT_LOG = fileURLToPath(new URL('../../hooks/prompt-log.mjs', import.meta.url));
    const PRETOOL = fileURLToPath(new URL('../../hooks/pretool.mjs', import.meta.url));
    const say = (env: NodeJS.ProcessEnv, prompt: string) =>
      runChild(process.execPath, [PROMPT_LOG], {
        input: JSON.stringify({ session_id: SID, prompt_id: `p-${prompt.length}`, prompt }),
        env: { ...env, FLEET_PROMPT_LOG_DIR: temp('plog') },
      });
    const tool = (
      env: NodeJS.ProcessEnv,
      name: string,
      input: Record<string, unknown> = { command: 'echo hi' },
    ) =>
      runChild(process.execPath, [PRETOOL], {
        input: JSON.stringify({ tool_name: name, tool_input: input, cwd: temp('c'), session_id: SID }),
        env,
      });
    const owedPath = (dir: string) => join(dir, `${SID}.owed.json`);

    it('他说了话：不写欠账文件，工具放行，收尾不拦', () => {
      const dir = temp('state');
      const env = isolatedEnv(dir, SID);
      expect(say(env, '这样改合理吗？断链在哪').status).toBe(0);
      expect(existsSync(owedPath(dir))).toBe(false);
      expect(tool(env, 'Bash').status).toBe(0);
      expect(blocked(stop(env).stdout)).toBe(false);
    });

    it('送达类工具照样放行', () => {
      const dir = temp('state');
      const env = isolatedEnv(dir, SID);
      expect(tool(env, 'mcp__mirasim__deliver_artifact', { path: 'D:/x/answer.md' }).status).toBe(0);
      expect(tool(env, 'PushNotification', { message: '好了' }).status).toBe(0);
    });

    it('不算他的话：后台通知、上下文总结、「继续」，也不写欠账', () => {
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

    it('【故意造出的失败】旧的坏欠账文件留着：不读、不拦、不崩', () => {
      const dir = temp('state');
      const env = isolatedEnv(dir, SID);
      writeFileSync(owedPath(dir), '{不是 JSON');
      expect(tool(env, 'Bash').status).toBe(0);
      expect(blocked(stop(env).stdout)).toBe(false);
      expect(existsSync(owedPath(dir))).toBe(true);
    });
  });

  it('开会话钩子读得到：开着给一句话（有东西在跑可以结束、等完成通知；什么都没在跑不要空着收尾）、暂停给一句话、没开什么都不给', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    // 经子进程调 sessionLines：.mjs 没有类型声明，不在 TS 里直接 import
    const lines = (): string[] => {
      const code = `import { sessionLines } from ${JSON.stringify(UNATTENDED_URL)}; console.log(JSON.stringify(sessionLines({ dir: process.env.FLEET_UNATTENDED_DIR, sessionId: process.env.CLAUDE_CODE_SESSION_ID })));`;
      const r = runChild(process.execPath, ['--input-type=module', '-e', code], { env });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout.trim());
    };
    expect(lines()).toEqual([]);
    cli(['on'], env);
    expect(lines().join('')).toContain('无人值守开着');
    expect(lines().join('')).toContain('必须接到下一轮');
    expect(lines().join('')).toContain('不能只凭任务存在就结束');
    cli(['needs-you', '要花钱'], env);
    expect(lines().join('')).toContain('暂停着（要花钱）');
  });
});

// 单 #2731（决定 0094）：收轮前对账。10-16 15:06 旧会话说「本机现在没有工人在跑」就收了，队列里还有 4 件。
// 人在不在场都判：本机队列有可接的活、容量够、没有子代理在跑（只有后台命令、监视器在跑也算没有）→ 挡回，理由列前三件；连挡 3 次放行一次。
// 队列、容量读不成不挡、明说没查成；不在 fleet-dao 检出里不管。判法读数换成假的；命令行外壳那几条用假的 work.ts。
interface Reading {
  ok: boolean;
  freeBytes?: number;
  load1?: number;
  cores?: number;
  how?: string;
  why?: string;
}
interface QueueItemLite {
  issue: number;
  title: string;
  takeable: boolean;
}
type QueueRead = { ok: true; items: QueueItemLite[]; problems: string[] } | { ok: false; why: string };
type Decision = { block: true; reason: string } | { block: false; notice?: string };
interface QueueStopLib {
  decideQueueStop(o: {
    input: unknown;
    dir: string;
    sessionId: string;
    readQueue?: (root: string) => Promise<QueueRead>;
    readCap?: () => Promise<Reading>;
  }): Promise<Decision>;
  parseQueue(text: string): QueueRead | { ok: false; why: string };
}
const queueStop = (await import(new URL('../../hooks/queue-stop.mjs', import.meta.url).href)) as QueueStopLib;

describe('规矩：收轮前对账——有可接的活、容量够、没有子代理在跑就挡回（单 #2731）', SLOW, () => {
  const GB = 1024 ** 3;
  const enough: Reading = { ok: true, freeBytes: 16 * GB, load1: 2, cores: 16, how: '假的' };
  const lowMem: Reading = { ok: true, freeBytes: 3 * GB, load1: 2, cores: 16, how: '假的' };
  const busy: Reading = { ok: true, freeBytes: 16 * GB, load1: 13, cores: 16, how: '假的' };
  const unknown: Reading = { ok: false, why: 'CIM 没读成（PowerShell 退出码 1）' };
  const items: QueueItemLite[] = [
    { issue: 11, title: '一', takeable: true },
    { issue: 12, title: '在做', takeable: false },
    { issue: 13, title: '二', takeable: true },
    { issue: 14, title: '三', takeable: true },
    { issue: 15, title: '四', takeable: true },
  ];
  /** 一个假的 fleet-dao 检出：有 packages/conventions/src/bin/work.ts，内容是给定的脚本 */
  function fakeRepo(script = 'process.exit(0)'): string {
    const root = temp('repo');
    mkdirSync(join(root, 'packages', 'conventions', 'src', 'bin'), { recursive: true });
    writeFileSync(join(root, 'packages', 'conventions', 'src', 'bin', 'work.ts'), script);
    return root;
  }
  function decide(
    o: {
      tasks?: unknown[];
      crons?: unknown[];
      queue?: QueueRead;
      cap?: Reading;
      dir?: string;
      cwd?: string;
    } = {},
  ) {
    const calls = { queue: 0, cap: 0 };
    const dir = o.dir ?? temp('state');
    const p = queueStop.decideQueueStop({
      input: {
        hook_event_name: 'Stop',
        session_id: SID,
        cwd: o.cwd ?? fakeRepo(),
        background_tasks: o.tasks ?? [],
        session_crons: o.crons ?? [],
      },
      dir,
      sessionId: SID,
      readQueue: async () => {
        calls.queue++;
        return o.queue ?? { ok: true, items, problems: [] };
      },
      readCap: async () => {
        calls.cap++;
        return o.cap ?? enough;
      },
    });
    return { p, calls, dir };
  }

  it('人在场（没开无人值守）也判：有可接的活、容量够、什么都没在跑 → 挡回，理由列前三件可接的和读数', async () => {
    const { p } = decide();
    const r = await p;
    expect(r.block).toBe(true);
    const reason = r.block ? r.reason : '';
    expect(reason).toContain('#11 一；#13 二；#14 三');
    expect(reason).not.toContain('#15');
    expect(reason).not.toContain('#12');
    expect(reason).toContain('空闲内存 16.0G');
    expect(reason).toContain('pnpm work queue');
  });

  it('显式off优先于队列，不再拉起本会话；另一个从未开启的会话仍照常对账，重新on才恢复', async () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    expect(cli(['on'], env).status).toBe(0);
    expect(cli(['off'], env).status).toBe(0);
    const stopped = decide({ dir });
    expect(await stopped.p).toEqual({ block: false });
    expect(stopped.calls).toEqual({ queue: 0, cap: 0 });
    const root = fakeRepo("throw new Error('off queue must not run')");
    expect(
      run(
        JSON.stringify({ hook_event_name: 'Stop', session_id: SID, cwd: root }),
        undefined,
        env,
      ).stdout.trim(),
    ).toBe('');
    expect((await decide().p).block).toBe(true);
    expect(cli(['on'], env).status).toBe(0);
    expect((await decide({ dir }).p).block).toBe(true);
  });

  it('只有后台命令、监视器在跑：不算有人在干活，照挡', async () => {
    const shell = { id: 'b1', type: 'shell', status: 'running', command: 'pnpm test' };
    const monitor = { id: 'b2', type: 'monitor', status: 'running', description: '盯 PR' };
    expect((await decide({ tasks: [shell, monitor] }).p).block).toBe(true);
  });

  it('有子代理在跑、或有定时唤醒：放行，不读队列、不读容量', async () => {
    const sub = { id: 'a1', type: 'subagent', status: 'running', agent_type: 'general-purpose' };
    for (const o of [{ tasks: [sub] }, { crons: [{ id: 'c1', schedule: '*/10 * * * *' }] }]) {
      const { p, calls } = decide(o);
      expect(await p).toEqual({ block: false });
      expect(calls).toEqual({ queue: 0, cap: 0 });
    }
  });

  it('没有可接的活：放行、不说话', async () => {
    const r = await decide({
      queue: { ok: true, items: [{ issue: 12, title: '在做', takeable: false }], problems: [] },
    }).p;
    expect(r).toEqual({ block: false });
  });

  it('容量不够（空闲内存 < 4G 或负载 > 核数×0.8）：放行、不说话', async () => {
    expect(await decide({ cap: lowMem }).p).toEqual({ block: false });
    expect(await decide({ cap: busy }).p).toEqual({ block: false });
  });

  it('【故意造出的失败】容量没查成：不当成够，不挡，明说没查成和原因', async () => {
    const r = await decide({ cap: unknown }).p;
    expect(r.block).toBe(false);
    expect(r.block ? '' : r.notice).toContain('没查成：CIM 没读成');
  });

  it('【故意造出的失败】队列没查成：不当成没活、也不挡，明说没查成', async () => {
    const r = await decide({ queue: { ok: false, why: '队列命令退出码 1：HTTP 502' } }).p;
    expect(r.block).toBe(false);
    expect(r.block ? '' : r.notice).toContain('没查成本机队列：队列命令退出码 1：HTTP 502');
  });

  it('不在 fleet-dao 检出里（往上找不到 work.ts）：不管、不出声，也不读', async () => {
    const { p, calls } = decide({ cwd: temp('elsewhere') });
    expect(await p).toEqual({ block: false });
    expect(calls).toEqual({ queue: 0, cap: 0 });
  });

  it('连着挡 3 次放行一次（说明是第几次），下一次又从头挡；中间有一次不该挡就清零', async () => {
    const dir = temp('state');
    for (let i = 1; i <= 3; i++) expect((await decide({ dir }).p).block, `第 ${i} 次`).toBe(true);
    const fourth = await decide({ dir }).p;
    expect(fourth.block).toBe(false);
    expect(fourth.block ? '' : fourth.notice).toContain('连着挡了 3 次');
    expect((await decide({ dir }).p).block).toBe(true);
    expect((await decide({ dir, cap: lowMem }).p).block).toBe(false);
    for (let i = 1; i <= 3; i++) expect((await decide({ dir }).p).block).toBe(true);
  });

  it('无人值守已经 done 或 needs-you（paused）：放行（它说了做完、或在等人拍）', async () => {
    for (const state of ['done', 'paused']) {
      const dir = temp('state');
      writeFileSync(
        join(dir, `${SID}.json`),
        JSON.stringify({ state, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), totalBlocks: 0 }),
      );
      expect((await decide({ dir }).p).block, state).toBe(false);
    }
  });

  it('队列输出认得出才算：不是 JSON、少字段都算没查成', () => {
    expect(queueStop.parseQueue('{"items":[{"issue":1,"title":"x","takeable":true}],"problems":[]}').ok).toBe(
      true,
    );
    expect(queueStop.parseQueue('坏的').ok).toBe(false);
    expect(queueStop.parseQueue('{"items":[{"issue":1}],"problems":[]}').ok).toBe(false);
    expect(queueStop.parseQueue('{"items":[]}').ok).toBe(false);
  });

  describe('命令行外壳：真起 stop.mjs，队列命令换成假的 work.ts', () => {
    const queueJson = JSON.stringify({ items: [{ issue: 11, title: '一', takeable: true }], problems: [] });
    it('有子代理在跑：放行，退出码 0、什么都不打印', () => {
      const root = fakeRepo(`console.log(${JSON.stringify(queueJson)})`);
      const sub = { id: 'a1', type: 'subagent', status: 'running' };
      const r = run(
        JSON.stringify({ hook_event_name: 'Stop', session_id: SID, cwd: root, background_tasks: [sub] }),
        undefined,
        isolatedEnv(temp('state'), SID),
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('【故意造出的失败】队列命令自己失败：不挡，systemMessage 写明没查成和它的 stderr', () => {
      const root = fakeRepo("console.error('gh: HTTP 502'); process.exit(1)");
      const r = run(
        JSON.stringify({ hook_event_name: 'Stop', session_id: SID, cwd: root, background_tasks: [] }),
        undefined,
        isolatedEnv(temp('state'), SID),
      );
      expect(r.status).toBe(0);
      expect(blocked(r.stdout)).toBe(false);
      expect(JSON.parse(r.stdout.trim()).systemMessage).toContain(
        '没查成本机队列：队列命令退出码 1：gh: HTTP 502',
      );
    });

    it('机器派的会话（工人，FLEET_WORKER=1）：不对账、不出声', () => {
      const root = fakeRepo('process.exit(1)');
      const r = run(
        JSON.stringify({ hook_event_name: 'Stop', session_id: SID, cwd: root, background_tasks: [] }),
        undefined,
        { ...isolatedEnv(temp('state'), SID), FLEET_WORKER: '1' },
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });
});
