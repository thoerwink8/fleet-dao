// 真跑验收（法国，以引擎用户 fleet 跑：只有它能经 sudo 调 fleet-agent-scope）：会话经帮手脚本放进 scope 之后，
// 1. 身份是会话用户，HOME 是它的；FLEET_* 经 sudo 的环境带进去，执行体自己的开关经 /usr/bin/env 带进去，引擎的 PATH 进不去；
// 2. 孙进程 setsid 又不理 SIGTERM、父进程也不理 SIGTERM，强杀后 cgroup 必须清空；
// 3. 执行体正常退出，留下一个 setsid 又清空了环境（会话标记也没了）的后台进程——只有 cgroup 找得到它，也要收掉；
// 4. 像凭据的变量不许写上命令行：当场拒，不起会话。
// 用法：sudo -u fleet node packages/adapters/test/e2e/scope-e2e.ts [会话用户]，默认 fleet-agent-carpool。只起假执行体，不花额度。
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROCESS_LIMITS, type ProcessLimits, runAgentProcess } from '../../src/process.ts';
import { alive, type CgroupScope, type SessionUser, scopeProcCount } from '../../src/procs.ts';
import type { FakeScript } from '../fake-agent.ts';

const user = (process.argv[2] ?? 'fleet-agent-carpool') as SessionUser;
const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, '..', 'fake-agent.ts');
const fixture = join(here, '..', 'fixtures', 'claude-code', 'cc-haiku-read.ndjson');
const dir = mkdtempSync(join(tmpdir(), 'fleet-scope-e2e-'));
// 会话用户要进得去、写得了（假执行体往这里写进程号和环境）
chmodSync(dir, 0o777);

async function run(
  name: string,
  script: FakeScript,
  limits: Partial<ProcessLimits>,
  env: Record<string, string> = {},
) {
  const pidFile = join(dir, `${name}.pid`);
  const envFile = join(dir, `${name}.env`);
  const idFile = join(dir, `${name}.id`);
  const scriptFile = join(dir, `${name}.json`);
  writeFileSync(scriptFile, JSON.stringify({ ...script, childPidTo: pidFile, envTo: envFile, idTo: idFile }));
  const scope: CgroupScope = { id: `e2e-${randomUUID().slice(0, 8)}`, user, limits: { tasksMax: 64 } };
  let inScopeWhileRunning: number | undefined;
  const report = await runAgentProcess(
    {
      command: [process.execPath, fake, scriptFile],
      cwd: dir,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: '/home/fleet',
        LANG: 'C.UTF-8',
        FLEET_API: 'http://127.0.0.1:8788',
        ...env,
      },
      stdin: 'x',
      limits: { ...DEFAULT_PROCESS_LIMITS, ...limits },
      runId: `e2e-${scope.id}`,
      scope,
    },
    {
      onLine: () => {
        inScopeWhileRunning ??= scopeProcCount(scope);
      },
    },
  );
  const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const grandchild = Number(read(pidFile) || 0);
  const seenEnv = read(envFile) ? (JSON.parse(read(envFile)) as Record<string, string>) : {};
  return {
    name,
    report: {
      exitCode: report.exitCode,
      signal: report.signal,
      killed: report.killed?.reason,
      spawnError: report.spawnError,
      stragglers: report.stragglers,
      leftovers: report.leftovers,
      reapError: report.reapError,
      stderr: report.stderrTail.slice(-300),
    },
    identity: read(idFile)
      ? (JSON.parse(read(idFile)) as { uid: number; gid: number; groups: number[] })
      : undefined,
    env: {
      USER: seenEnv.USER,
      HOME: seenEnv.HOME,
      PATH: seenEnv.PATH,
      FLEET_API: seenEnv.FLEET_API,
      FLEET_RUN_ID: seenEnv.FLEET_RUN_ID,
      GROK_DISABLE_AUTOUPDATER: seenEnv.GROK_DISABLE_AUTOUPDATER,
    },
    inScopeWhileRunning,
    grandchildAlive: grandchild > 0 && alive(grandchild),
    leftInScope: scopeProcCount(scope),
  };
}

const killed = await run(
  '超时强杀',
  {
    replay: fixture,
    replayLines: 3,
    after: 'hang-with-child',
    childDetached: true,
    childIgnoresSigterm: true,
    ignoreSigterm: true,
  },
  { wallClockMs: 3_000, killGraceMs: 300 },
  { GROK_DISABLE_AUTOUPDATER: '1' },
);
const exited = await run(
  '正常退出留后台',
  {
    replay: fixture,
    after: 'exit-leaving-child',
    childDetached: true,
    childIgnoresSigterm: true,
    childCleanEnv: true,
  },
  { killGraceMs: 300 },
);
const refused = await run('凭据上命令行', { replay: fixture }, {}, { CURSOR_API_KEY: 'not-a-key' });
rmSync(dir, { recursive: true, force: true });

const uid = Number(
  readFileSync('/etc/passwd', 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${user}:`))
    ?.split(':')[2],
);
const checks: [string, boolean][] = [
  ['会话进了 scope', (killed.inScopeWhileRunning ?? 0) > 0 && (exited.inScopeWhileRunning ?? 0) > 0],
  [
    '身份是会话用户、只在自己的组里',
    killed.identity?.uid === uid && killed.identity.groups.every((g) => g === killed.identity?.gid),
  ],
  [
    'HOME 是会话用户的，引擎的 HOME 没带进去',
    killed.env.HOME === `/home/${user}` && killed.env.USER === user,
  ],
  [
    'FLEET_* 经 sudo 带进去了，执行体开关经 env 带进去了',
    killed.env.FLEET_API === 'http://127.0.0.1:8788' &&
      killed.env.GROK_DISABLE_AUTOUPDATER === '1' &&
      Boolean(killed.env.FLEET_RUN_ID),
  ],
  ['PATH 用的是 FLEET_SESSION_PATH', killed.env.PATH === '/usr/local/bin:/usr/bin:/bin'],
  [
    '强杀后孙进程没了、cgroup 清空',
    !killed.grandchildAlive && killed.leftInScope === 0 && killed.report.leftovers === 0,
  ],
  [
    '正常退出后清空了环境的后台进程也收掉、cgroup 清空',
    !exited.grandchildAlive && exited.leftInScope === 0 && exited.report.stragglers >= 1,
  ],
  ['像凭据的变量不上命令行：当场拒', Boolean(refused.report.spawnError?.includes('CURSOR_API_KEY'))],
];
console.log(
  JSON.stringify(
    { user, killed, exited, refused: refused.report, checks: Object.fromEntries(checks) },
    null,
    2,
  ),
);
const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
console.log(failed.length ? `FAIL：${failed.join('、')}` : 'PASS');
process.exitCode = failed.length ? 1 : 0;
