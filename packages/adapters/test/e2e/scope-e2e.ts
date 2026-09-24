// 真跑验收（要能建 systemd scope：root，或配了权限的引擎用户）：会话放进 scope 之后，
// 1. 孙进程 setsid 又不理 SIGTERM、父进程也不理 SIGTERM，强杀后 cgroup 必须清空；
// 2. 执行体正常退出，留下一个 setsid 又清空了环境（会话标记也没了）的后台进程——只有 cgroup 找得到它，也要收掉。
// 用法：node packages/adapters/test/e2e/scope-e2e.ts [slice]，默认 fleet-agents.slice。只起假执行体，不花额度。
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROCESS_LIMITS, type ProcessLimits, runAgentProcess } from '../../src/process.ts';
import { alive, scopeProcCount } from '../../src/procs.ts';
import type { FakeScript } from '../fake-agent.ts';

const slice = process.argv[2] ?? 'fleet-agents.slice';
const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, '..', 'fake-agent.ts');
const fixture = join(here, '..', 'fixtures', 'claude-code', 'cc-haiku-read.ndjson');
const dir = mkdtempSync(join(tmpdir(), 'fleet-scope-e2e-'));

async function run(name: string, script: FakeScript, limits: Partial<ProcessLimits>) {
  const pidFile = join(dir, `${name}.pid`);
  const scriptFile = join(dir, `${name}.json`);
  writeFileSync(scriptFile, JSON.stringify({ ...script, childPidTo: pidFile }));
  const unit = `fleet-e2e-${randomUUID().slice(0, 8)}`;
  const scope = { slice, unit };
  let pid = 0;
  let cgroup = '';
  const report = await runAgentProcess(
    {
      command: [process.execPath, fake, scriptFile],
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/' },
      stdin: 'x',
      limits: { ...DEFAULT_PROCESS_LIMITS, ...limits },
      runId: `e2e-${unit}`,
      scope,
    },
    {
      onSpawn: (info) => {
        pid = info.pid;
      },
      onLine: () => {
        if (!cgroup) cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();
      },
    },
  );
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  return {
    name,
    cgroup,
    report: {
      exitCode: report.exitCode,
      signal: report.signal,
      killed: report.killed?.reason,
      stragglers: report.stragglers,
      leftovers: report.leftovers,
      reapError: report.reapError,
    },
    grandchildAlive: alive(grandchild),
    leftInScope: scopeProcCount(scope),
    inScope: cgroup.includes(`/${slice}/${unit}.scope`),
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
rmSync(dir, { recursive: true, force: true });

const checks: [string, boolean][] = [
  ['会话进了 scope', killed.inScope && exited.inScope],
  [
    '强杀后孙进程没了、cgroup 清空',
    !killed.grandchildAlive && killed.leftInScope === 0 && killed.report.leftovers === 0,
  ],
  [
    '正常退出后清空了环境的后台进程也收掉、cgroup 清空',
    !exited.grandchildAlive && exited.leftInScope === 0 && exited.report.stragglers >= 1,
  ],
];
console.log(JSON.stringify({ slice, killed, exited, checks: Object.fromEntries(checks) }, null, 2));
const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
console.log(failed.length ? `FAIL：${failed.join('、')}` : 'PASS');
process.exitCode = failed.length ? 1 : 0;
