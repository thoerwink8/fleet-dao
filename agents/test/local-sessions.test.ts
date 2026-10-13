// 本机会话心跳（#1991）：钩子写心跳、推送、装和卸。
// 故意造出的失败：钩子输入里带提示词、命令参数，落盘的心跳里一个字都没有；推不出去、法国回 401、没配 config 都写进 last-push.json；
// settings.json 坏了不覆盖；常量和法国那边的 schema 对不上就红。
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addHooks, heartbeatCommand, install, removeHooks, uninstall } from '../local-sessions/install.mjs';
import {
  buildReport,
  collect,
  DROP_AFTER_MS,
  gitInfo,
  MAX_SESSIONS,
  PUSH_EVERY_MS,
  PUSH_PATH,
  pushOnce,
  RECENT_STOP_MS,
  SCHEMA_VERSION,
  sessionsDir,
  statusPath,
  TOKEN_HEADER,
  writeHeartbeat,
} from '../local-sessions/lib.mjs';

// 法国那边的定义（packages/shared）。agents 这个 tsc 项目只收 agents 自己的文件，静态引用会把 shared 整包拖进来，
// 所以按路径动态引（vitest 照样跑真的那一份），只声明这里用到的几样。
type Shared = {
  NODE_REPORT_HEADER: string;
  LOCAL_SESSION_RECENT_STOP_MS: number;
  LOCAL_SESSIONS_MAX: number;
  LOCAL_SESSIONS_PATH: string;
  LOCAL_SESSIONS_PUSH_EVERY_MS: number;
  LOCAL_SESSIONS_SCHEMA_VERSION: number;
  LocalSessionsReportSchema: {
    safeParse(v: unknown): { success: boolean };
    parse(v: unknown): { machine: string };
  };
};
const sharedPaths = ['nodes.ts', 'local-sessions.ts'].map((f) =>
  join(import.meta.dirname, '..', '..', 'packages', 'shared', 'src', 'web-api', f),
);
const shared = Object.assign(
  {},
  ...(await Promise.all(sharedPaths.map((p) => import(/* @vite-ignore */ pathToFileURL(p).href)))),
) as Shared;
const {
  NODE_REPORT_HEADER,
  LOCAL_SESSION_RECENT_STOP_MS,
  LOCAL_SESSIONS_MAX,
  LOCAL_SESSIONS_PATH,
  LOCAL_SESSIONS_PUSH_EVERY_MS,
  LOCAL_SESSIONS_SCHEMA_VERSION,
  LocalSessionsReportSchema,
} = shared;

const T0 = new Date('2026-10-13T08:00:00.000Z');
const MIN = 60_000;
const tmp = () => mkdtempSync(join(tmpdir(), 'local-sessions-'));

/** 造一个带 origin 的主检出和一棵工作树。 */
function fakeRepo(): { main: string; tree: string } {
  const root = tmp();
  const main = join(root, 'fleet-dao');
  mkdirSync(join(main, '.git', 'worktrees', 'agent-1'), { recursive: true });
  writeFileSync(join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(
    join(main, '.git', 'config'),
    '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/thoerwink8/fleet-dao.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
  );
  const wtGit = join(main, '.git', 'worktrees', 'agent-1');
  writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/feat/1991-x\n');
  writeFileSync(join(wtGit, 'commondir'), '../..\n');
  const tree = join(main, '.claude', 'worktrees', 'agent-1');
  mkdirSync(join(tree, 'packages'), { recursive: true });
  writeFileSync(join(tree, '.git'), `gitdir: ${wtGit}\n`);
  return { main, tree };
}

describe('常量和法国那边对得上', () => {
  it('版本、路径、请求头、节奏、上限', () => {
    expect(SCHEMA_VERSION).toBe(LOCAL_SESSIONS_SCHEMA_VERSION);
    expect(PUSH_PATH).toBe(`/api${LOCAL_SESSIONS_PATH}`);
    expect(TOKEN_HEADER).toBe(NODE_REPORT_HEADER);
    expect(PUSH_EVERY_MS).toBe(LOCAL_SESSIONS_PUSH_EVERY_MS);
    expect(RECENT_STOP_MS).toBe(LOCAL_SESSION_RECENT_STOP_MS);
    expect(MAX_SESSIONS).toBe(LOCAL_SESSIONS_MAX);
  });
});

describe('认仓', () => {
  it('主检出：owner/name、分支，工作树是 null', () => {
    const { main } = fakeRepo();
    expect(gitInfo(join(main))).toEqual({ repo: 'thoerwink8/fleet-dao', branch: 'main', worktree: null });
  });
  it('工作树里的子目录：同一个仓、工作树的分支、只给工作树目录名', () => {
    const { tree } = fakeRepo();
    expect(gitInfo(join(tree, 'packages'))).toEqual({
      repo: 'thoerwink8/fleet-dao',
      branch: 'feat/1991-x',
      worktree: 'agent-1',
    });
  });
  it('不在 git 仓里：三项都是 null', () => {
    expect(gitInfo(tmp())).toEqual({ repo: null, branch: null, worktree: null });
  });
});

describe('钩子写心跳', () => {
  it('【故意造出的失败】输入里带提示词、命令参数、路径：落盘的心跳只有元信息，那些一个字都没有', () => {
    const home = tmp();
    const { tree } = fakeRepo();
    const beat = writeHeartbeat(
      {
        session_id: 's-1',
        hook_event_name: 'PreToolUse',
        cwd: tree,
        tool_name: 'Bash',
        tool_input: { command: 'cat ~/.ssh/id_rsa SECRET-ARG' },
        prompt: 'SECRET-PROMPT 帮我改登录页',
        transcript_path: 'C:/Users/x/SECRET-PATH.jsonl',
      },
      { home, now: T0 },
    );
    expect(beat).toEqual({
      id: 's-1',
      repo: 'thoerwink8/fleet-dao',
      branch: 'feat/1991-x',
      worktree: 'agent-1',
      subagent: false,
      startedAt: T0.toISOString(),
      lastSeenAt: T0.toISOString(),
      last: 'tool',
      lastTool: 'Bash',
    });
    const disk = readFileSync(join(sessionsDir(home), 's-1.json'), 'utf8');
    expect(disk).not.toMatch(/SECRET|id_rsa|登录页|frank|Users/);
    // 法国那边 strict 收得下
    expect(LocalSessionsReportSchema.safeParse(buildReport({ home, now: T0, machine: '本机' })).success).toBe(
      true,
    );
  });

  it('同一个会话：起的时刻留着第一次的，最后一次动跟着走；一轮做完记 stop、工具名留着', () => {
    const home = tmp();
    writeHeartbeat({ session_id: 's-1', hook_event_name: 'SessionStart', cwd: tmp() }, { home, now: T0 });
    writeHeartbeat(
      { session_id: 's-1', hook_event_name: 'PreToolUse', tool_name: 'Edit' },
      { home, now: new Date(T0.getTime() + MIN) },
    );
    const stop = writeHeartbeat(
      { session_id: 's-1', hook_event_name: 'Stop' },
      { home, now: new Date(T0.getTime() + 2 * MIN) },
    );
    expect(stop).toMatchObject({
      startedAt: T0.toISOString(),
      lastSeenAt: new Date(T0.getTime() + 2 * MIN).toISOString(),
      last: 'stop',
      lastTool: 'Edit',
    });
  });

  it('子代理单算一个会话，带类型', () => {
    const home = tmp();
    const beat = writeHeartbeat(
      {
        session_id: 's-1',
        agent_id: 'a-9',
        agent_type: 'Explore',
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
      },
      { home, now: T0 },
    );
    expect(beat).toMatchObject({ id: 's-1~a-9', subagent: true, agentType: 'Explore' });
  });

  it('认不出的输入（没有会话编号、不认识的事件）：什么都不写', () => {
    const home = tmp();
    expect(writeHeartbeat({ hook_event_name: 'PreToolUse' }, { home, now: T0 })).toBeNull();
    expect(
      writeHeartbeat({ session_id: 's', hook_event_name: 'UserPromptSubmit' }, { home, now: T0 }),
    ).toBeNull();
    expect(collect({ home, now: T0 }).sessions).toEqual([]);
  });
});

describe('凑一份推的', () => {
  it('收场超过 2 小时的不推、超过一天没动的删掉；认不出的文件照实写进 problems', () => {
    const home = tmp();
    const at = (ms: number) => new Date(T0.getTime() + ms);
    writeHeartbeat(
      { session_id: 'live', hook_event_name: 'PreToolUse', tool_name: 'Bash' },
      { home, now: at(-MIN) },
    );
    writeHeartbeat(
      { session_id: 'old-stop', hook_event_name: 'Stop' },
      { home, now: at(-RECENT_STOP_MS - MIN) },
    );
    writeHeartbeat(
      { session_id: 'dead', hook_event_name: 'PreToolUse' },
      { home, now: at(-DROP_AFTER_MS - MIN) },
    );
    writeFileSync(join(sessionsDir(home), 'broken.json'), '{"id":1}');
    const got = collect({ home, now: T0 });
    expect(got.sessions.map((s) => s.id)).toEqual(['live']);
    expect(got.problems).toEqual(['心跳文件 broken.json 认不出']);
    expect(collect({ home, now: T0 }).sessions.map((s) => s.id)).toEqual(['live']);
  });
});

describe('推送', () => {
  const configured = (home: string) => {
    mkdirSync(join(home, '.fleet-dao', 'local-sessions'), { recursive: true });
    writeFileSync(
      join(home, '.fleet-dao', 'local-sessions', 'config.json'),
      JSON.stringify({ url: 'https://fleet.example/', token: 'tok-1', machine: '创始人的电脑' }),
    );
  };
  const lastPush = (home: string) => JSON.parse(readFileSync(statusPath(home), 'utf8'));

  it('推成了：带通行证头、推到 /api/nodes/sessions，记下推了几个', async () => {
    const home = tmp();
    configured(home);
    writeHeartbeat(
      { session_id: 's-1', hook_event_name: 'PreToolUse', tool_name: 'Bash' },
      { home, now: T0 },
    );
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await pushOnce({ home, now: T0, fetchImpl });
    expect(r).toMatchObject({ ok: true, sessions: 1 });
    expect(calls[0]?.url).toBe('https://fleet.example/api/nodes/sessions');
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers[TOKEN_HEADER]).toBe('tok-1');
    const body = LocalSessionsReportSchema.parse(JSON.parse(String(calls[0]?.init.body)));
    expect(body.machine).toBe('创始人的电脑');
    expect(lastPush(home)).toMatchObject({ ok: true, sessions: 1 });
  });

  it('【故意造出的失败】推不出去（网断了）：ok=false、写明原因，不写成推了 0 个', async () => {
    const home = tmp();
    configured(home);
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await pushOnce({ home, now: T0, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/推不出去：connect ECONNREFUSED/);
    expect(r.sessions).toBeUndefined();
    expect(lastPush(home)).toMatchObject({ ok: false });
  });

  it('【故意造出的失败】法国回 401：写状态码和法国说的话', async () => {
    const home = tmp();
    configured(home);
    const fetchImpl = (async () =>
      new Response('{"error":{"code":"node_token_invalid"}}', { status: 401 })) as unknown as typeof fetch;
    const r = await pushOnce({ home, now: T0, fetchImpl });
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect(r.why).toMatch(/法国回 401.*node_token_invalid/);
  });

  it('【故意造出的失败】没配 config.json：不发请求，写明要重装', async () => {
    const home = tmp();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await pushOnce({ home, now: T0, fetchImpl });
    expect(called).toBe(false);
    expect(r.why).toMatch(/没配 .*config\.json/);
  });
});

describe('装和卸', () => {
  const srcDir = join(import.meta.dirname, '..', 'local-sessions');
  const okRun = () => {
    const calls: string[][] = [];
    return {
      calls,
      run: (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        return { status: 0, stdout: '', stderr: '' };
      },
    };
  };
  const okFetch = (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;
  const settingsOf = (home: string) =>
    JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  const other = { type: 'command', command: 'node "C:/Users/x/.fleet-dao/hooks/pretool.mjs"' };

  it('一条命令装：拷脚本、登记五个事件、建计划任务、当场推一次；别人的钩子原样留着；重装不重复', async () => {
    const home = tmp();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: '*', hooks: [other] }] } }),
    );
    const { calls, run } = okRun();
    const opts = {
      home,
      srcDir,
      url: 'https://fleet.example',
      token: 'tok-1',
      platform: 'win32' as const,
      run,
      nodePath: 'C:/node/node.exe',
      fetchImpl: okFetch,
      now: () => T0,
    };
    const steps = await install(opts);
    expect(
      steps.every((s) => s.ok),
      JSON.stringify(steps),
    ).toBe(true);
    await install(opts);
    const s = settingsOf(home);
    expect(s.model).toBe('opus');
    expect(s.hooks.PreToolUse).toEqual([
      { matcher: '*', hooks: [other] },
      { matcher: '*', hooks: [{ type: 'command', command: heartbeatCommand(home), timeout: 5 }] },
    ]);
    for (const e of ['SessionStart', 'Stop', 'SubagentStop', 'SessionEnd'])
      expect(s.hooks[e]).toHaveLength(1);
    expect(calls[0]?.slice(0, 4)).toEqual(['schtasks', '/Create', '/F', '/TN']);
    expect(readFileSync(join(home, '.fleet-dao', 'local-sessions', 'bin', 'run-push.vbs'), 'utf8')).toContain(
      'push.mjs',
    );
  });

  it('一条命令卸：只摘自己那几条、删计划任务、删目录', async () => {
    const home = tmp();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify(addHooks({ hooks: { PreToolUse: [{ hooks: [other] }] } }, heartbeatCommand(home))),
    );
    const { calls, run } = okRun();
    const steps = uninstall({ home, platform: 'win32', run });
    expect(steps.every((x) => x.ok)).toBe(true);
    expect(settingsOf(home)).toEqual({ hooks: { PreToolUse: [{ hooks: [other] }] } });
    expect(calls.map((c) => c[1])).toEqual(['/Query', '/Delete']);
  });

  it('【故意造出的失败】settings.json 是坏 JSON：停下、不覆盖、退出非成功', async () => {
    const home = tmp();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{ broken');
    const { run } = okRun();
    const steps = await install({
      home,
      srcDir,
      url: 'https://fleet.example',
      token: 't',
      platform: 'win32',
      run,
    });
    expect(steps.at(-1)).toMatchObject({ ok: false, step: '钩子' });
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe('{ broken');
  });

  it('【故意造出的失败】第一次装没给地址和通行证：不装', async () => {
    const home = tmp();
    const steps = await install({ home, srcDir, platform: 'win32', run: okRun().run });
    expect(steps).toEqual([{ ok: false, step: '配置', detail: expect.stringMatching(/--url/) }]);
  });

  it('【故意造出的失败】计划任务没建成：报没成，不说装好了', async () => {
    const home = tmp();
    const steps = await install({
      home,
      srcDir,
      url: 'https://fleet.example',
      token: 't',
      platform: 'win32',
      run: () => ({ status: 1, stdout: '', stderr: '拒绝访问' }),
    });
    expect(steps.at(-1)).toMatchObject({
      ok: false,
      step: '定时推送',
      detail: expect.stringMatching(/拒绝访问/),
    });
  });

  it('removeHooks 认不出的形状原样留着', () => {
    const s = { hooks: { Stop: 'x', PreToolUse: [{ matcher: 'Bash' }] } };
    expect(removeHooks(s)).toEqual({ settings: s, removed: 0 });
  });
});
