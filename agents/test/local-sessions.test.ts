// 本机会话心跳（#1991）：钩子写心跳、推送、装和卸。
// 故意造出的失败：钩子输入里带提示词、命令参数，落盘的心跳里一个字都没有；推不出去、法国回 401、没配 config 都写进 last-push.json；
// settings.json 坏了不覆盖；常量和法国那边的 schema 对不上就红。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  addHooks,
  heartbeatCommand,
  install,
  LAUNCH_AGENT_LABEL,
  launchAgentPath,
  launchAgentPlist,
  refresh,
  removeHooks,
  status,
  statusReport,
  uninstall,
} from '../local-sessions/install.mjs';
import {
  buildReport,
  collect,
  DROP_AFTER_MS,
  gitInfo,
  loopPidPath,
  MAX_SESSIONS,
  PUSH_EVERY_MS,
  PUSH_PATH,
  pushOnce,
  RECENT_STOP_MS,
  SCHEMA_VERSION,
  STARTUP_VBS,
  sessionsDir,
  statusPath,
  TOKEN_HEADER,
  writeHeartbeat,
} from '../local-sessions/lib.mjs';
import { acquireLock, reviveLoop } from '../local-sessions/loop.mjs';

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

describe('macOS LaunchAgent 生命周期（全部命令注入，不操作真实 launchd）', () => {
  const srcDir = join(import.meta.dirname, '..', 'local-sessions');
  const domain = 'gui/501';
  const service = `${domain}/${LAUNCH_AGENT_LABEL}`;
  const good = { status: 0, stdout: '', stderr: '' };
  const missing = {
    status: 113,
    stdout: '',
    stderr: `Could not find service "${LAUNCH_AGENT_LABEL}" in domain for user gui: 501`,
  };
  const fixture = () => {
    const home = tmp();
    const calls: string[][] = [];
    let loaded = false;
    let failure: string | undefined;
    let pushed = 0;
    const run = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      expect(cmd).toBe('/bin/launchctl');
      if (args[0] === failure) return { status: 5, stdout: '', stderr: 'denied' };
      if (args[0] === 'print') return args[1] === domain || loaded ? good : missing;
      if (args[0] === 'bootout') loaded = false;
      if (args[0] === 'bootstrap') loaded = true;
      return good;
    };
    const opts = {
      home,
      srcDir,
      platform: 'darwin' as const,
      uid: 501,
      run,
      nodePath: '/opt/node with space&<>"\'/bin/node',
      url: 'https://fleet.example',
      token: 'test-only-token',
      now: () => T0,
      fetchImpl: (async () => {
        pushed++;
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch,
    };
    return {
      home,
      calls,
      opts,
      fail: (command: string) => {
        failure = command;
      },
      pushed: () => pushed,
    };
  };

  it('安装直接定时 push、核实加载与真实试推；重装先卸旧任务，保留别人的文件和钩子', async () => {
    const f = fixture();
    mkdirSync(join(f.home, '.claude'), { recursive: true });
    const otherHook = { type: 'command', command: 'node other.mjs' };
    writeFileSync(
      join(f.home, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [otherHook] }] } }),
    );
    mkdirSync(dirname(launchAgentPath(f.home)), { recursive: true });
    const otherPlist = join(dirname(launchAgentPath(f.home)), 'org.other.plist');
    writeFileSync(otherPlist, 'keep');
    for (let i = 0; i < 2; i++) {
      const steps = await install(f.opts);
      expect(
        steps.every((s) => s.ok),
        JSON.stringify(steps),
      ).toBe(true);
    }
    expect(f.calls.filter((c) => c[1] === 'bootstrap')).toEqual([
      ['/bin/launchctl', 'bootstrap', domain, launchAgentPath(f.home)],
      ['/bin/launchctl', 'bootstrap', domain, launchAgentPath(f.home)],
    ]);
    expect(f.calls.filter((c) => c[1] === 'bootout')).toEqual([['/bin/launchctl', 'bootout', service]]);
    expect(f.calls.findIndex((c) => c[1] === 'bootout')).toBeLessThan(
      f.calls.findLastIndex((c) => c[1] === 'bootstrap'),
    );
    const plist = readFileSync(launchAgentPath(f.home), 'utf8');
    expect(plist).toBe(
      launchAgentPlist(f.opts.nodePath, join(f.home, '.fleet-dao', 'local-sessions', 'bin', 'push.mjs')),
    );
    expect(plist).toContain('node with space&amp;&lt;&gt;&quot;&apos;');
    expect(plist).toContain('<integer>120</integer>');
    expect(plist).not.toMatch(/RunAtLoad|KeepAlive|test-only-token|loop.mjs/);
    expect(f.pushed()).toBe(2);
    const report = statusReport(f.home, f.opts);
    expect(report.ok).toBe(true);
    expect(report.lines.join('\n')).toContain('已加载');
    expect(report.lines.join('\n')).toMatch(/"ok":\s*true/);
    expect(report.lines.join('\n')).not.toContain(f.opts.token);
    const steps = uninstall(f.opts);
    expect(
      steps.every((s) => s.ok),
      JSON.stringify(steps),
    ).toBe(true);
    expect(existsSync(launchAgentPath(f.home))).toBe(false);
    expect(existsSync(join(f.home, '.fleet-dao', 'local-sessions'))).toBe(false);
    expect(readFileSync(otherPlist, 'utf8')).toBe('keep');
    expect(JSON.parse(readFileSync(join(f.home, '.claude', 'settings.json'), 'utf8')).hooks.Stop).toEqual([
      { hooks: [otherHook] },
    ]);
    expect(uninstall(f.opts).every((s) => s.ok)).toBe(true);
  });

  it.each(['$&', '$$', '$`', "$'"])(
    '合法 Node 路径的 %s 不作为替换模板展开，安装、重装、查、卸都能认回自身 plist',
    async (part) => {
      const f = fixture();
      const opts = { ...f.opts, nodePath: `/opt/node${part}/bin/node` };
      expect((await install(opts)).every((s) => s.ok)).toBe(true);
      expect(statusReport(f.home, opts).ok).toBe(true);
      expect((await install(opts)).every((s) => s.ok)).toBe(true);
      expect(statusReport(f.home, opts).ok).toBe(true);
      expect(uninstall(opts).every((s) => s.ok)).toBe(true);
    },
  );

  it.each(['enable', 'bootstrap'])('【失败】%s 不成不试推，留下文件但不冒充装好', async (command) => {
    const f = fixture();
    f.fail(command);
    const steps = await install(f.opts);
    expect(steps.at(-1)).toMatchObject({ ok: false, step: '定时推送' });
    expect(steps.at(-1)?.detail).toContain(command);
    expect(f.pushed()).toBe(0);
    expect(existsSync(launchAgentPath(f.home))).toBe(true);
    expect(statusReport(f.home, f.opts).ok).toBe(false);
  });

  it('【失败】读不到域或服务不能当成未安装；未知查询失败不删自己的配置', async () => {
    const f = fixture();
    expect((await install(f.opts)).every((s) => s.ok)).toBe(true);
    f.fail('print');
    expect(statusReport(f.home, f.opts)).toMatchObject({ ok: false });
    expect(status(f.home, f.opts).join('\n')).toContain('没查成');
    expect(uninstall(f.opts).at(-1)).toMatchObject({ ok: false });
    expect(existsSync(launchAgentPath(f.home))).toBe(true);
    expect(existsSync(join(f.home, '.fleet-dao', 'local-sessions', 'config.json'))).toBe(true);
    const first = fixture();
    first.fail('print');
    expect((await install(first.opts)).at(-1)).toMatchObject({ ok: false });
    expect(existsSync(join(first.home, '.fleet-dao'))).toBe(false);
  });

  it('【失败】bootout 失败保留文件与钩子，不继续重装或卸载', async () => {
    const f = fixture();
    expect((await install(f.opts)).every((s) => s.ok)).toBe(true);
    f.fail('bootout');
    const before = readFileSync(join(f.home, '.claude', 'settings.json'), 'utf8');
    expect(uninstall(f.opts).at(-1)).toMatchObject({ ok: false });
    expect(readFileSync(join(f.home, '.claude', 'settings.json'), 'utf8')).toBe(before);
    expect(existsSync(launchAgentPath(f.home))).toBe(true);
    expect((await install(f.opts)).at(-1)).toMatchObject({ ok: false });
    expect(f.calls.filter((c) => c[1] === 'bootstrap')).toHaveLength(1);
    expect(f.pushed()).toBe(1);
  });

  it('【失败】bootstrap 回零但服务未加载，仍不试推、不冒充成功', async () => {
    const f = fixture();
    const steps = await install({
      ...f.opts,
      run: (_cmd, args) => (args[0] === 'print' && args[1] === service ? missing : good),
    });
    expect(steps.at(-1)).toMatchObject({ ok: false, step: '定时推送' });
    expect(f.pushed()).toBe(0);
  });

  it('【失败】卸载时 settings 坏 JSON，先拒绝，不卸任务也不删除 plist、凭据或脚本', async () => {
    const f = fixture();
    expect((await install(f.opts)).every((s) => s.ok)).toBe(true);
    const settingsPath = join(f.home, '.claude', 'settings.json');
    const original = readFileSync(settingsPath, 'utf8');
    writeFileSync(settingsPath, '{ broken');
    const before = f.calls.length;
    expect(uninstall(f.opts).at(-1)).toMatchObject({ ok: false, step: '钩子' });
    expect(f.calls).toHaveLength(before);
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ broken');
    expect(existsSync(launchAgentPath(f.home))).toBe(true);
    expect(existsSync(join(f.home, '.fleet-dao', 'local-sessions', 'config.json'))).toBe(true);
    expect(existsSync(join(f.home, '.fleet-dao', 'local-sessions', 'bin', 'push.mjs'))).toBe(true);
    writeFileSync(settingsPath, original);
    expect(uninstall(f.opts).every((s) => s.ok)).toBe(true);
  });

  it.each(['backup', 'write'])(
    '【失败】卸载摘钩的 %s 路径被目录占用，保留全部文件，消除冲突可重试',
    async (part) => {
      const f = fixture();
      expect((await install(f.opts)).every((s) => s.ok)).toBe(true);
      const settingsPath = join(f.home, '.claude', 'settings.json');
      const original = readFileSync(settingsPath, 'utf8');
      const conflict =
        part === 'backup' ? `${settingsPath}.local-sessions.bak` : `${settingsPath}.${process.pid}.tmp`;
      mkdirSync(conflict);
      expect(uninstall(f.opts).at(-1)).toMatchObject({ ok: false, step: '钩子' });
      expect(readFileSync(settingsPath, 'utf8')).toBe(original);
      expect(existsSync(launchAgentPath(f.home))).toBe(true);
      expect(existsSync(join(f.home, '.fleet-dao', 'local-sessions', 'config.json'))).toBe(true);
      expect(existsSync(join(f.home, '.fleet-dao', 'local-sessions', 'bin', 'push.mjs'))).toBe(true);
      expect(f.calls.filter((c) => c[1] === 'bootout')).toHaveLength(1);
      rmSync(conflict, { recursive: true });
      expect(uninstall(f.opts).every((s) => s.ok)).toBe(true);
      expect(existsSync(launchAgentPath(f.home))).toBe(false);
      expect(existsSync(join(f.home, '.fleet-dao', 'local-sessions'))).toBe(false);
    },
  );

  it('【失败】陌生平台或 root UID 在任何写入、命令执行前拒绝', async () => {
    const f = fixture();
    expect((await install({ ...f.opts, platform: 'linux' })).at(-1)).toMatchObject({
      ok: false,
      step: '平台',
    });
    expect(uninstall({ ...f.opts, platform: 'linux' }).at(-1)).toMatchObject({ ok: false, step: '平台' });
    expect(statusReport(f.home, { ...f.opts, platform: 'linux' }).ok).toBe(false);
    expect((await install({ ...f.opts, uid: 0 })).at(-1)).toMatchObject({ ok: false });
    expect(existsSync(join(f.home, '.fleet-dao'))).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it.each(['label', 'program', 'override', 'duplicate-key', 'extra-root'])(
    '【失败】已有 plist 的 %s 不属于本任务，不覆盖、不卸载',
    async (part) => {
      const f = fixture();
      mkdirSync(dirname(launchAgentPath(f.home)), { recursive: true });
      const own = launchAgentPlist(
        f.opts.nodePath,
        join(f.home, '.fleet-dao', 'local-sessions', 'bin', 'push.mjs'),
      );
      const foreign =
        part === 'label'
          ? own.replace(LAUNCH_AGENT_LABEL, 'org.someone.else')
          : part === 'program'
            ? own.replace('push.mjs', 'unrelated.mjs')
            : part === 'override'
              ? own.replace(
                  '<key>StartInterval</key>',
                  '<key>Program</key><string>/bin/other</string><key>StartInterval</key>',
                )
              : part === 'duplicate-key'
                ? own.replace(
                    '<key>StartInterval</key>',
                    '<key>Label</key><string>org.other</string><key>StartInterval</key>',
                  )
                : own.replace(
                    '</plist>',
                    '<dict><key>Program</key><string>/bin/other</string></dict></plist>',
                  );
      writeFileSync(launchAgentPath(f.home), foreign);
      expect((await install(f.opts)).at(-1)).toMatchObject({ ok: false });
      expect(statusReport(f.home, f.opts).ok).toBe(false);
      expect(uninstall(f.opts).at(-1)).toMatchObject({ ok: false });
      expect(readFileSync(launchAgentPath(f.home), 'utf8')).toBe(foreign);
      expect(f.calls).toEqual([]);
      expect(existsSync(join(f.home, '.fleet-dao'))).toBe(false);
    },
  );

  it('【失败】同名任务已加载但没有自身 plist，不能判断归属，不执行 bootout', async () => {
    const f = fixture();
    const calls: string[][] = [];
    const run = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return good;
    };
    expect((await install({ ...f.opts, run })).at(-1)).toMatchObject({ ok: false });
    expect(uninstall({ ...f.opts, run }).at(-1)).toMatchObject({ ok: false });
    expect(calls.every((c) => c[1] === 'print')).toBe(true);
    expect(existsSync(join(f.home, '.fleet-dao'))).toBe(false);
  });

  it('【失败】域可读但服务查询出错，不是精确 not found 就不当作未安装', async () => {
    const f = fixture();
    const run = (_cmd: string, args: string[]) =>
      args[1] === domain ? good : { ...missing, stderr: 'permission denied' };
    expect((await install({ ...f.opts, run })).at(-1)).toMatchObject({ ok: false });
    expect(statusReport(f.home, { ...f.opts, run }).ok).toBe(false);
    expect(uninstall({ ...f.opts, run }).at(-1)).toMatchObject({ ok: false });
    expect(existsSync(join(f.home, '.fleet-dao'))).toBe(false);
  });

  it('【失败】试推被法国拒收，安装与状态都保留失败，不把任务已加载当作推送成功', async () => {
    const f = fixture();
    const steps = await install({
      ...f.opts,
      fetchImpl: (async () => new Response('denied', { status: 401 })) as typeof fetch,
    });
    expect(steps.find((s) => s.step === '试推')).toMatchObject({ ok: false });
    const report = statusReport(f.home, f.opts);
    expect(report.ok).toBe(false);
    expect(report.lines.join('\n')).toContain('已加载');
    expect(report.lines.join('\n')).toMatch(/"ok":\s*false/);
    expect(report.lines.join('\n')).not.toContain(f.opts.token);
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

describe('最后一次动读会话记录的修改时间（调工具前不再挂心跳）', () => {
  /** 在 <home>/.claude/projects/<目录>/ 下造一份会话记录，修改时间设成 at */
  const transcript = (home: string, rel: string, text: string, at: Date) => {
    const p = join(home, '.claude', 'projects', 'D--frank-fleet-dao', rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    utimesSync(p, at, at);
    return p;
  };
  const toolLine = (name: string) =>
    `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name, input: { command: 'SECRET-ARG' } }] } })}\n`;

  it('开场之后只有会话记录在动：最后一次动跟着记录走、算在跑，工具名从记录尾巴读；推上去的没有路径和参数', () => {
    const home = tmp();
    writeHeartbeat(
      { session_id: 's-1', hook_event_name: 'SessionStart' },
      { home, now: new Date(T0.getTime() - 20 * MIN) },
    );
    transcript(home, 's-1.jsonl', toolLine('Read') + toolLine('Bash'), new Date(T0.getTime() - 30_000));
    const [s] = collect({ home, now: T0 }).sessions;
    expect(s).toMatchObject({
      id: 's-1',
      lastSeenAt: new Date(T0.getTime() - 30_000).toISOString(),
      last: 'tool',
      lastTool: 'Bash',
    });
    const report = JSON.stringify(buildReport({ home, now: T0, machine: '本机' }));
    expect(report).not.toMatch(/SECRET|projects|jsonl/);
    expect(LocalSessionsReportSchema.safeParse(JSON.parse(report)).success).toBe(true);
  });

  it('一轮做完（Stop）之后记录只晚写了几秒：仍算刚停；隔了一阵又动了：算又在跑', () => {
    const home = tmp();
    const stopAt = new Date(T0.getTime() - 10 * MIN);
    writeHeartbeat({ session_id: 's-1', hook_event_name: 'Stop' }, { home, now: stopAt });
    const p = transcript(home, 's-1.jsonl', toolLine('Edit'), new Date(stopAt.getTime() + 2_000));
    expect(collect({ home, now: T0 }).sessions[0]).toMatchObject({ last: 'stop' });
    utimesSync(p, new Date(T0.getTime() - MIN), new Date(T0.getTime() - MIN));
    expect(collect({ home, now: T0 }).sessions[0]).toMatchObject({
      last: 'tool',
      lastSeenAt: new Date(T0.getTime() - MIN).toISOString(),
    });
  });

  it('子代理读它自己的记录（<会话>/subagents/agent-<编号>.jsonl）', () => {
    const home = tmp();
    writeHeartbeat(
      { session_id: 's-1', agent_id: 'a9', agent_type: 'Explore', hook_event_name: 'SessionStart' },
      { home, now: new Date(T0.getTime() - 20 * MIN) },
    );
    transcript(
      home,
      join('s-1', 'subagents', 'agent-a9.jsonl'),
      toolLine('Grep'),
      new Date(T0.getTime() - MIN),
    );
    expect(collect({ home, now: T0 }).sessions[0]).toMatchObject({
      id: 's-1~a9',
      last: 'tool',
      lastTool: 'Grep',
      lastSeenAt: new Date(T0.getTime() - MIN).toISOString(),
    });
  });

  it('【故意造出的失败】找不到记录：照心跳原样推，不编最后一次动；收场的会话记录再新也不改成在跑', () => {
    const home = tmp();
    const at = new Date(T0.getTime() - 20 * MIN);
    writeHeartbeat({ session_id: 'gone', hook_event_name: 'SessionStart' }, { home, now: at });
    writeHeartbeat({ session_id: 'ended', hook_event_name: 'SessionEnd' }, { home, now: at });
    transcript(home, 'ended.jsonl', toolLine('Bash'), new Date(T0.getTime() - MIN));
    const got = Object.fromEntries(collect({ home, now: T0 }).sessions.map((s) => [s.id, s]));
    expect(got.gone).toMatchObject({ lastSeenAt: at.toISOString(), last: 'start', lastTool: null });
    expect(got.ended).toMatchObject({ last: 'end' });
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
  /** schtasks 拒绝访问（创始人这台电脑的真实情况）；别的命令（Query）也不成。 */
  const deniedRun = (cmd: string, args: string[]) => ({
    status: 1,
    stdout: '',
    stderr: `${cmd} ${args[0]}：错误：拒绝访问。`,
  });
  /** 假的循环进程：谁活着、谁被杀了、起过几回；起一次就在 loop.pid 里写一个新的进程号。 */
  const fakeLoops = (home: string) => {
    const alive = new Set<number>();
    const killed: number[] = [];
    const started: string[][] = [];
    let next = 4000;
    return {
      alive,
      killed,
      started,
      startupDir: join(tmp(), 'Startup'),
      isAlive: (pid: number) => alive.has(pid),
      kill: (pid: number) => {
        killed.push(pid);
        alive.delete(pid);
      },
      startLoop: (nodePath: string, loopPath: string) => {
        started.push([nodePath, loopPath]);
        const pid = next++;
        alive.add(pid);
        writeFileSync(loopPidPath(home), String(pid));
      },
      waitMs: 0,
      sleep: async () => {},
    };
  };
  const fallbackOpts = (home: string, loops: ReturnType<typeof fakeLoops>) => ({
    home,
    srcDir,
    url: 'https://fleet.example',
    token: 'tok-1',
    platform: 'win32' as const,
    run: deniedRun,
    nodePath: 'C:/node/node.exe',
    fetchImpl: okFetch,
    now: () => T0,
    ...loops,
  });
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
    const loops = fakeLoops(home);
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
      ...loops,
    };
    const steps = await install(opts);
    expect(
      steps.every((s) => s.ok),
      JSON.stringify(steps),
    ).toBe(true);
    // 计划任务建成了：写明用的是计划任务，不起循环、启动文件夹里没有自启文件
    expect(steps.find((s) => s.step === '定时推送')?.detail).toMatch(/用的是计划任务/);
    expect(loops.started).toEqual([]);
    expect(existsSync(join(loops.startupDir, STARTUP_VBS))).toBe(false);
    await install(opts);
    const s = settingsOf(home);
    expect(s.model).toBe('opus');
    // 调工具前不再登记心跳（每次调用 138-250ms，推送却 2 分钟一次；最后一次动改读会话记录的修改时间）
    expect(s.hooks.PreToolUse).toEqual([{ matcher: '*', hooks: [other] }]);
    for (const e of ['SessionStart', 'Stop', 'SubagentStop', 'SessionEnd'])
      expect(s.hooks[e]).toEqual([
        { hooks: [{ type: 'command', command: heartbeatCommand(home), timeout: 5, async: true }] },
      ]);
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

  it('【故意造出的失败】计划任务拒绝访问：自动退回启动文件夹自启，起一个循环、读回 last-push.json，写明用的是自启', async () => {
    const home = tmp();
    mkdirSync(join(home, '.fleet-dao', 'local-sessions'), { recursive: true });
    // 旧版手工放在根上的 loop.mjs：重装要删掉
    writeFileSync(join(home, '.fleet-dao', 'local-sessions', 'loop.mjs'), '// old');
    const loops = fakeLoops(home);
    const steps = await install(fallbackOpts(home, loops));
    expect(
      steps.every((s) => s.ok),
      JSON.stringify(steps),
    ).toBe(true);
    const way = steps.find((s) => s.step === '定时推送')?.detail ?? '';
    expect(way).toMatch(/用的是启动文件夹自启/);
    expect(way).toMatch(/拒绝访问/);
    expect(steps.find((s) => s.step === '核对')?.ok).toBe(true);
    expect(statusPath(home)).toBeTruthy();
    expect(JSON.parse(readFileSync(statusPath(home), 'utf8'))).toMatchObject({ ok: true, sessions: 0 });
    // vbs 指向 bin/loop.mjs；循环起了一个；旧位置的 loop.mjs 删了、新位置的拷到了
    const vbs = readFileSync(join(loops.startupDir, STARTUP_VBS), 'utf8');
    expect(vbs).toContain('loop.mjs');
    expect(vbs).toContain(join(home, '.fleet-dao', 'local-sessions', 'bin', 'loop.mjs'));
    expect(loops.started).toHaveLength(1);
    expect(existsSync(join(home, '.fleet-dao', 'local-sessions', 'loop.mjs'))).toBe(false);
    expect(existsSync(join(home, '.fleet-dao', 'local-sessions', 'bin', 'loop.mjs'))).toBe(true);
    // status 写明哪一种、循环活着
    const lines = status(home, { platform: 'win32', run: deniedRun, ...loops });
    expect(lines).toContain(`定时推送：启动文件夹自启（${join(loops.startupDir, STARTUP_VBS)}）`);
    expect(lines.find((l) => l.startsWith('循环进程'))).toMatch(/在跑（进程 4000）/);
  });

  it('【故意造出的失败】计划任务和自启都没成：退出非成功、两个原因都写、不说装好了、不往下试推', async () => {
    const home = tmp();
    const loops = fakeLoops(home);
    // 启动文件夹建不出来：它的上一级是个文件
    const blocker = join(tmp(), 'file');
    writeFileSync(blocker, 'x');
    const steps = await install({ ...fallbackOpts(home, loops), startupDir: join(blocker, 'Startup') });
    expect(steps.at(-1)).toMatchObject({ ok: false, step: '定时推送' });
    const detail = steps.at(-1)?.detail ?? '';
    expect(detail).toMatch(/拒绝访问/);
    expect(detail).toMatch(/退回启动文件夹自启也不行/);
    expect(steps.some((s) => s.step === '试推')).toBe(false);
    expect(steps.some((s) => s.detail.includes('装好了'))).toBe(false);
    expect(loops.started).toEqual([]);
  });

  it('【故意造出的失败】自启写好了但循环没起来：报没成，不说装好了', async () => {
    const home = tmp();
    const loops = { ...fakeLoops(home), startLoop: () => {} };
    const steps = await install(fallbackOpts(home, loops));
    expect(steps.at(-1)).toMatchObject({ ok: false, step: '定时推送' });
    expect(steps.at(-1)?.detail).toMatch(/循环进程没起来/);
    expect(steps.some((s) => s.detail.includes('装好了'))).toBe(false);
  });

  it('【故意造出的失败】没有启动文件夹（认不出 APPDATA）：退回不了，报没成', async () => {
    const home = tmp();
    const { startupDir: _no, ...rest } = fakeLoops(home);
    const steps = await install(fallbackOpts(home, rest as ReturnType<typeof fakeLoops>));
    expect(steps.at(-1)).toMatchObject({ ok: false, step: '定时推送' });
    expect(steps.at(-1)?.detail).toMatch(/没有 APPDATA/);
  });

  it('【故意造出的失败】重装不起第二个循环：先结束旧的再起新的，活着的只有一个', async () => {
    const home = tmp();
    const loops = fakeLoops(home);
    expect((await install(fallbackOpts(home, loops))).every((s) => s.ok)).toBe(true);
    expect([...loops.alive]).toEqual([4000]);
    expect((await install(fallbackOpts(home, loops))).every((s) => s.ok)).toBe(true);
    expect(loops.killed).toEqual([4000]);
    expect(loops.started).toHaveLength(2);
    expect([...loops.alive]).toEqual([4001]);
  });

  it('自启装过、后来计划任务能建了：自启那一套清掉，只留计划任务', async () => {
    const home = tmp();
    const loops = fakeLoops(home);
    await install(fallbackOpts(home, loops));
    const steps = await install({ ...fallbackOpts(home, loops), run: okRun().run });
    expect(steps.find((s) => s.step === '定时推送')?.detail).toMatch(/用的是计划任务/);
    expect(existsSync(join(loops.startupDir, STARTUP_VBS))).toBe(false);
    expect(loops.alive.size).toBe(0);
  });

  it('【故意造出的失败】卸自启：删启动文件夹里的 vbs、结束循环进程、删整个目录，两种都清干净', async () => {
    const home = tmp();
    const loops = fakeLoops(home);
    await install(fallbackOpts(home, loops));
    expect(existsSync(join(loops.startupDir, STARTUP_VBS))).toBe(true);
    const steps = uninstall({ home, platform: 'win32', run: deniedRun, ...loops });
    expect(
      steps.every((s) => s.ok),
      JSON.stringify(steps),
    ).toBe(true);
    expect(existsSync(join(loops.startupDir, STARTUP_VBS))).toBe(false);
    expect(loops.killed).toEqual([4000]);
    expect(loops.alive.size).toBe(0);
    expect(existsSync(join(home, '.fleet-dao', 'local-sessions'))).toBe(false);
    // 计划任务那一路：有就删
    const { calls, run } = okRun();
    const steps2 = uninstall({ home: tmp(), platform: 'win32', run, ...fakeLoops(home) });
    expect(steps2.every((s) => s.ok)).toBe(true);
    expect(calls.map((c) => c[1])).toEqual(['/Query', '/Delete']);
  });

  it('循环抢锁：别的进程还活着就不起第二个；持有者已死或是自己才写上', () => {
    const lock = join(tmp(), 'loop.pid');
    writeFileSync(lock, '111');
    expect(acquireLock({ lock, pid: 222, alive: (p) => p === 111 })).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe('111');
    expect(acquireLock({ lock, pid: 222, alive: () => false })).toBe(true);
    expect(readFileSync(lock, 'utf8')).toBe('222');
    expect(acquireLock({ lock, pid: 222, alive: () => true })).toBe(true);
    writeFileSync(lock, 'garbage');
    expect(acquireLock({ lock, pid: 333, alive: () => true })).toBe(true);
    expect(readFileSync(lock, 'utf8')).toBe('333');
  });

  it('【故意造出的失败】循环死了锁还在（睡眠、重启、被杀）：心跳钩子拉起新的；锁在且进程活着、锁不在都不动', () => {
    const home = tmp();
    const dir = join(home, '.fleet-dao', 'local-sessions');
    mkdirSync(dir, { recursive: true });
    let started = 0;
    const start = () => {
      started += 1;
    };
    expect(reviveLoop({ home, alive: () => false, start })).toBe('no-lock');
    writeFileSync(join(dir, 'loop.pid'), '4242');
    expect(reviveLoop({ home, alive: () => true, start })).toBe('alive');
    expect(started).toBe(0);
    expect(reviveLoop({ home, alive: () => false, start })).toBe('started');
    writeFileSync(join(dir, 'loop.pid'), 'garbage');
    expect(reviveLoop({ home, alive: () => true, start })).toBe('started');
    expect(started).toBe(2);
  });

  it('【故意造出的失败】旧版登记的调工具前心跳（matcher *）：重装、refresh 都摘掉，别人的钩子留着；没装过的机器 refresh 什么都不动', () => {
    const home = tmp();
    mkdirSync(join(home, '.claude'), { recursive: true });
    const old = {
      hooks: {
        PreToolUse: [
          { matcher: '*', hooks: [other] },
          { matcher: '*', hooks: [{ type: 'command', command: heartbeatCommand(home), timeout: 5 }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: heartbeatCommand(home), timeout: 5 }] }],
      },
    };
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(old));
    // 没装过（没有 config.json）：refresh 不动设置
    expect(refresh({ home, srcDir })).toEqual([
      { ok: true, step: '本机会话心跳', detail: expect.stringMatching(/没装/) },
    ]);
    expect(settingsOf(home)).toEqual(old);
    // 装过：拷新脚本、改登记
    mkdirSync(join(home, '.fleet-dao', 'local-sessions'), { recursive: true });
    writeFileSync(
      join(home, '.fleet-dao', 'local-sessions', 'config.json'),
      JSON.stringify({ url: 'https://fleet.example', token: 't' }),
    );
    const steps = refresh({ home, srcDir });
    expect(
      steps.every((x) => x.ok),
      JSON.stringify(steps),
    ).toBe(true);
    const s = settingsOf(home);
    expect(s.hooks.PreToolUse).toEqual([{ matcher: '*', hooks: [other] }]);
    expect(s.hooks.Stop[0].hooks[0]).toMatchObject({ async: true });
    expect(existsSync(join(home, '.fleet-dao', 'local-sessions', 'bin', 'lib.mjs'))).toBe(true);
    // 再跑一次：已经对了就不再写设置
    expect(refresh({ home, srcDir }).find((x) => x.step === '钩子')?.detail).toMatch(/已经是/);
  });

  it('removeHooks 认不出的形状原样留着', () => {
    const s = { hooks: { Stop: 'x', PreToolUse: [{ matcher: 'Bash' }] } };
    expect(removeHooks(s)).toEqual({ settings: s, removed: 0 });
  });
});
