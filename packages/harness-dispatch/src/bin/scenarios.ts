// 新内核场景验收（#3775）：node packages/harness-dispatch/src/bin/scenarios.ts <命令>
//   run <success|timeout|killed|blocked|duplicate|rate-limit|all>   造一个场景、等到活收尾、打事件链表、清掉批次
//   chain <会话号>                                                    只打事件链（场景还没收尾、或者事后再看）
//   cleanup <会话号>                                                  删场景留在 fleet2 里的批次、影子产物、回执、已收尾的活
//   manual                                                            说明脚本造不了的两种（断网、重启接回）
// 环境：FLEET2_DATABASE_URL（法国上 postgres:///fleet，PGHOST=/var/run/postgresql PGUSER=fleet）；
//       FLEET2_MIRROR_ROOT（取默认基线用，默认 /var/lib/fleet2/mirrors）。选项：--repo、--base-sha、--wait-min（默认 40）、--keep。
// 只写 fleet2 的表；不碰系统服务。内核一次只跑一个工人，场景的活排在已有的影子单后面，等不到就如实退出，事件链等以后用 chain 看。
import { homedir } from 'node:os';
import { makeRedactor } from '@fleet-dao/harness-runner';
import type { Db } from '@fleet-dao/harness-store';
import * as schema from '@fleet-dao/harness-store/schema';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { runCommand } from '../command.ts';
import {
  cleanupScenario,
  formatChain,
  formatRateLimit,
  jobsOf,
  MANUAL_SCENARIOS,
  readChain,
  requestStop,
  runRateLimit,
  SCENARIO_NAMES,
  type ScenarioName,
  scenarioId,
  scenarioSpec,
  submitScenario,
} from '../scenarios.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
// 命令和它的参数在最前面，选项（--xxx）在后面
const [cmd, arg] = args.filter((a, i) => i < 2 && !a.startsWith('--'));

const sql = postgres(process.env.FLEET2_DATABASE_URL ?? 'postgres:///fleet', { max: 2, onnotice: () => {} });
const db = drizzle(sql, { schema }) as unknown as Db;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s: string) => console.log(s);
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).toLowerCase();

async function baseSha(repo: string): Promise<string> {
  const given = flag('base-sha');
  if (given) return given;
  const root = process.env.FLEET2_MIRROR_ROOT ?? '/var/lib/fleet2/mirrors';
  const mirror = `${root}/${repo}.git`;
  const r = await runCommand({
    command: ['git', '--git-dir', mirror, 'rev-parse', 'refs/heads/main'],
    cwd: homedir(),
    timeoutMs: 30_000,
    redact: makeRedactor([]),
  });
  const sha = r.stdout.trim();
  if (!r.ran || r.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(
      `读不到镜像 ${mirror} 的 main：${r.spawnError ?? r.stderrTail.trim()}；用 --base-sha 给一个镜像里有的提交`,
    );
  }
  return sha;
}

async function runOne(name: ScenarioName): Promise<boolean> {
  if (name === 'rate-limit') {
    say(`\n== rate-limit：专用队列上排多于每分钟上限的活，自己领 ==`);
    say(formatRateLimit(await runRateLimit(db, stamp)));
    return true;
  }
  const repo = flag('repo') ?? 'thoerwink8/fleet-dao';
  const spec = scenarioSpec(name);
  const id = scenarioId(stamp, name);
  const sub = await submitScenario(db, id, spec, { repo, baseSha: await baseSha(repo) });
  say(`\n== ${name}：会话 ${id}，请求事件 ${sub.eventIds.join(',')}，批次 ${sub.batchId} ==`);
  const deadline = Date.now() + Number(flag('wait-min') ?? 40) * 60_000;
  let stopped = false;
  let state = '';
  for (;;) {
    const js = await jobsOf(db, sub.eventIds);
    state = js.map((j) => j.state).join(',');
    if (js.length > 0 && js.every((j) => ['done', 'dead', 'cancelled'].includes(j.state))) break;
    if (spec.stopWhenSpawned && !stopped) {
      const chain = await readChain(db, id);
      if (chain.some((r) => r.type === 'worker.spawned')) {
        say(
          `工人已起，写叫停请求（user-stop），事件 ${await requestStop(db, id, sub.taskId, '场景验收：人叫停')}`,
        );
        stopped = true;
      }
    }
    if (Date.now() > deadline) {
      say(
        `等了 ${flag('wait-min') ?? 40} 分钟还没收尾（活状态 ${state || '还没排出'}）：不清理，之后用 chain ${id} 看、cleanup ${id} 清`,
      );
      say(formatChain(await readChain(db, id)));
      return false;
    }
    await sleep(5_000);
  }
  await sleep(3_000); // 终局交回记在完成活之前，补丁、收尾事件稍后
  const js = await jobsOf(db, sub.eventIds);
  say(
    `排出的活 ${js.length} 件（提交 ${sub.eventIds.length} 次）：${js.map((j) => `${j.key} ${j.state} 尝试${j.attempts}/${j.maxAttempts}${j.lastError ? ` 末次错误=${j.lastError.slice(0, 80)}` : ''}`).join('；')}`,
  );
  say(formatChain(await readChain(db, id), { width: 150 }));
  if (!args.includes('--keep')) await cleanupScenario(db, id, sub.eventIds);
  return true;
}

try {
  if (cmd === 'run' && arg) {
    const names = arg === 'all' ? [...SCENARIO_NAMES] : [arg as ScenarioName];
    if (names.some((n) => !SCENARIO_NAMES.includes(n)))
      throw new Error(`场景只认 ${SCENARIO_NAMES.join('、')}、all`);
    let ok = true;
    for (const n of names) ok = (await runOne(n)) && ok;
    process.exitCode = ok ? 0 : 3;
  } else if (cmd === 'chain' && arg) {
    say(formatChain(await readChain(db, arg), { width: 150 }));
  } else if (cmd === 'cleanup' && arg) {
    const ids = (await readChain(db, arg))
      .filter((r) => r.type === 'worker.spawn.requested')
      .map((r) => r.id);
    await cleanupScenario(db, arg, ids);
    say(`已清 ${arg} 的批次、影子产物、回执和已收尾的活（${ids.length} 个请求）`);
  } else if (cmd === 'manual') {
    for (const [k, v] of Object.entries(MANUAL_SCENARIOS)) say(`${k}：${v}\n`);
  } else {
    console.error(
      '用法：scenarios.ts run <success|timeout|killed|blocked|duplicate|rate-limit|all> | chain <会话号> | cleanup <会话号> | manual',
    );
    process.exitCode = 2;
  }
} finally {
  await sql.end({ timeout: 5 });
}
