// 钉住 Stop 钩子（agents/hooks/stop.mjs）的规矩（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 规矩：
// 1. 没开无人值守时（没人在这个会话里跑过 `unattended.mjs on`）只提醒、不拦、不接着聊——不管仓根干不干净、输入好不好，
//    退出码恒为 0，输出里不许有 decision（会拦下 Stop）、不许有 hookSpecificOutput（additionalContext 会让对话接着走）。
// 2. 决定 0028（创始人 2026-10-07 约 02:27 推翻 0026 的「这一轮结束、收尾不拦」）：只有这个会话自己跑了 `on` 才挡；
//    起子代理、监视、后台命令不自动开；off、done / needs-you、满 12 小时、空转到上限、工人都收口了都放行。
// 命令行外壳：真 spawn 这个文件，喂 stdin，看退出码和 stdout——测的是钩子实际接到 Claude Code 输入时的样子，不是内部函数。
// 这份文件每条都要起真的 node 子进程（本机实测一条 0.4 秒上下；满载并行跑时更慢），默认 5 秒的超时会误红（#718：13 个子进程 6057ms）。
// 超时放这么宽只是兜底——挡的是「机器真的卡住了」，不是拿来盖住「一条测试起了太多子进程」：子进程的数量那边已经按规矩需要的最少次数收过（见下面那条）。
// 同目录的先例：discuss.test.ts 的 SLOW、session-start.test.ts 的 SLOW、progress-structure.test.ts 的 SLOW。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * 状态目录指到一个空的临时目录、不带会话号：测试不碰真机器上的无人值守状态，也不受跑测试的这个会话自己开没开影响；
 * 工人目录同理（默认一个空目录 = 没有在跑的工人）；FLEET_WORKER 清掉：在工人会话里跑这份测试时，它不该把 on 当成机器派的会话拒掉。
 */
function isolatedEnv(stateDir: string, sessionId = '', workersDir?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FLEET_UNATTENDED_DIR: stateDir,
    FLEET_WORKERS_DIR: workersDir ?? temp('workers-default'),
    FLEET_WORKER: '',
    CLAUDE_CODE_SESSION_ID: sessionId,
  };
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
        idle: 0,
        totalBlocks: 0,
        toolSinceBlock: true,
        ...extra,
      }),
    );
  /** 登记一个工人：pid 用这个测试进程自己的（一定活着）或一个已经退出的子进程的（一定死了） */
  const addWorker = (workers: string, name: string, alive: boolean, extra: Record<string, unknown> = {}) => {
    const pid = alive ? process.pid : (spawnSync(process.execPath, ['-e', '']).pid as number);
    mkdirSync(join(workers, name), { recursive: true });
    writeFileSync(join(workers, name, 'meta.json'), JSON.stringify({ name, pid, ...extra }));
  };
  const PRETOOL = fileURLToPath(new URL('../../hooks/pretool.mjs', import.meta.url));
  const pretool = (env: NodeJS.ProcessEnv, toolName: string, toolInput: Record<string, unknown>) =>
    spawnSync(process.execPath, [PRETOOL], {
      input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: temp('c'), session_id: SID }),
      encoding: 'utf8',
      env,
    });

  it('on 之后：Stop 输出 decision:block，退出码仍是 0；stop_hook_active 为真也照样挡（那是我们自己挡出来的）', () => {
    const workers = temp('workers');
    addWorker(workers, 'a', true);
    const env = isolatedEnv(temp('state'), SID, workers);
    const turned = cli(['on'], env);
    expect(turned.status).toBe(0);
    expect(turned.stdout).toContain('Agent 子代理');
    for (const active of [false, true]) {
      const r = stop(env, { stop_hook_active: active });
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout.trim());
      expect(out.decision).toBe('block');
    }
  });

  it('挡住时的理由是具体的：继续盯工人（watch --wait 55）、有进展记进度、别空转，以及怎么放行', () => {
    const workers = temp('workers');
    addWorker(workers, 'a', true);
    const env = isolatedEnv(temp('state'), SID, workers);
    cli(['on'], env);
    const reason: string = JSON.parse(stop(env).stdout.trim()).reason;
    expect(reason).toContain('worker.mjs watch --wait 55');
    expect(reason).toContain('france.mjs');
    expect(reason).toContain('progress:note');
    expect(reason).toContain('别空转');
    for (const k of ['done', 'needs-you', 'off']) expect(reason).toContain(`unattended.mjs ${k}`);
    expect(reason).toContain('在跑的工人 1 个');
  });

  it('一个在跑的工人都没有：理由改成「还有子代理就等完成通知，有活就派子代理，没了就 done」，不再叫人起脱离的工人', () => {
    const env = isolatedEnv(temp('state'), SID);
    cli(['on'], env);
    const reason: string = JSON.parse(stop(env).stdout.trim()).reason;
    expect(reason).toContain('没有在跑的工人');
    expect(reason).toContain('Agent 子代理');
    expect(reason).not.toContain('--detached');
    expect(reason).toContain('unattended.mjs done');
  });

  it('没开、或者开的是别的会话：不挡', () => {
    const dir = temp('state');
    expect(cli(['on'], isolatedEnv(dir, 'other-session-0002')).status).toBe(0);
    expect(blocked(stop(isolatedEnv(dir, SID)).stdout)).toBe(false);
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

  it('放行三（防死循环）：还有工人在跑——连着 19 次没调工具仍挡，第 20 次放行并转暂停、写明原因', () => {
    const dir = temp('state');
    const workers = temp('workers');
    addWorker(workers, 'a', true);
    const env = isolatedEnv(dir, SID, workers);
    seed(dir, { idle: 18, totalBlocks: 19, toolSinceBlock: false });
    expect(blocked(stop(env).stdout)).toBe(true); // 这一次算第 19 次空转
    expect(readS(dir).idle).toBe(19);
    const r = stop(env); // 第 20 次
    expect(blocked(r.stdout)).toBe(false);
    expect(r.stdout).toContain('自动暂停');
    expect(r.stdout).toContain('20 次');
    expect(cli(['status'], env).stdout).toContain('paused');
  });

  it('放行四：所有工人都做完或掉线——连着 3 次没调工具就放行（没有什么可盯的）；同一局面有工人在跑则仍挡', () => {
    const dir = temp('state');
    const empty = temp('workers-none');
    // 掉线的、clean 过的都不算在跑
    const gone = temp('workers-gone');
    addWorker(gone, 'dead', false);
    addWorker(gone, 'cleaned', true, { cleanedAt: '2026-10-07T00:00:00Z' });
    const live = temp('workers-live');
    addWorker(live, 'a', true);
    for (const w of [empty, gone]) {
      seed(dir, { idle: 2, totalBlocks: 3, toolSinceBlock: false });
      const r = stop(isolatedEnv(dir, SID, w));
      expect(blocked(r.stdout)).toBe(false);
      expect(r.stdout).toContain('自动暂停');
      expect(r.stdout).toContain('没有在跑的工人');
    }
    seed(dir, { idle: 2, totalBlocks: 3, toolSinceBlock: false });
    expect(blocked(stop(isolatedEnv(dir, SID, live)).stdout)).toBe(true);
  });

  it('放行五：挡了 200 次到总上限——放行', () => {
    const dir = temp('state');
    const workers = temp('workers');
    addWorker(workers, 'a', true);
    seed(dir, { totalBlocks: 200 });
    const r = stop(isolatedEnv(dir, SID, workers));
    expect(blocked(r.stdout)).toBe(false);
    expect(r.stdout).toContain('200 次');
  });

  it('两次挡之间调过工具（PreToolUse 记了一笔）：不算空转，空转计数清零，继续挡', () => {
    const dir = temp('state');
    const workers = temp('workers');
    addWorker(workers, 'a', true);
    const env = isolatedEnv(dir, SID, workers);
    // 已经到了「再空转一次就放行」的边缘；调一个工具就把它救回来
    seed(dir, { idle: 19, totalBlocks: 20, toolSinceBlock: false });
    expect(pretool(env, 'Bash', { command: 'echo hi' }).status).toBe(0);
    expect(readS(dir).toolSinceBlock).toBe(true);
    expect(blocked(stop(env).stdout)).toBe(true);
    const s = readS(dir);
    expect(s.state).toBe('on');
    expect(s.idle).toBe(0);
    expect(s.totalBlocks).toBe(21);
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

  it('开会话钩子读得到：开着给一句话（不要结束、继续盯工人）、暂停给一句话、没开什么都不给', () => {
    const dir = temp('state');
    const env = isolatedEnv(dir, SID);
    // 经子进程调 sessionLines：.mjs 没有类型声明，不在 TS 里直接 import
    const lines = (): string[] => {
      const code = `import { sessionLines } from ${JSON.stringify(UNATTENDED_URL)}; console.log(JSON.stringify(sessionLines({ dir: process.env.FLEET_UNATTENDED_DIR, sessionId: process.env.CLAUDE_CODE_SESSION_ID })));`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout.trim());
    };
    expect(lines()).toEqual([]);
    cli(['on'], env);
    expect(lines().join('')).toContain('无人值守开着');
    expect(lines().join('')).toContain('不要结束');
    expect(lines().join('')).toContain('完成通知');
    cli(['needs-you', '要花钱'], env);
    expect(lines().join('')).toContain('暂停着（要花钱）');
  });
});

describe('规矩的文字：通用段和 commander 技能说「无人值守时这一轮不结束，用子代理干、不脱离会话」（决定 0028、0030）', () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const SHARED = read('../../shared-rules.md');
  const SKILL = read('../../skills/commander/SKILL.md');
  const line = SHARED.split('\n').find((l) => l.startsWith('- 无人值守')) ?? '';

  it('通用段：先 on、起子代理、这一轮不结束、等完成通知、前台等待不超过 60 秒、done / needs-you / off；不再写脱离会话的工人', () => {
    expect(line).toContain('unattended.mjs on');
    expect(line).toContain('Agent 子代理');
    expect(line).toContain('不脱离会话');
    expect(line).not.toContain('worker.mjs');
    expect(line).not.toContain('--detached');
    expect(line).toContain('这一轮不结束');
    expect(line).toContain('完成通知');
    expect(line).toContain('单次前台等待不超过 60 秒');
    for (const k of ['`done`', '`needs-you`', '`off`']) expect(line).toContain(k);
  });

  it('commander 技能：无人值守照子代理一道派活、等完成通知、不结束这一轮；脱离的工人只在创始人明说时用，旧说法（这一轮就结束、不循环 watch、无人值守起脱离工人）已删', () => {
    expect(SKILL).toContain('然后照上面的子代理一道派活，不结束这一轮');
    expect(SKILL).toContain('只在创始人明说「脱离会话」');
    expect(SKILL).not.toContain('只在他说了无人值守、过夜、我不在');
    expect(SKILL).not.toContain('起完工人后用 `worker.mjs watch --wait 55` 一直盯着');
    expect(SKILL).not.toContain('起完工人这一轮就结束');
    expect(SKILL).not.toContain('不要循环 watch');
  });
});
