// 真执行的人手命令（#3783，第 7 片；freeze 的 --dry-run 见 #3865）。配置同内核（环境变量），在法国上以 fleet 跑：
//   node packages/harness-dispatch/src/bin/real.ts freeze [--dry-run] <批次号> <owner/仓#单号>…   冻结一批（基线取主线现在的提交；单要开着、不是 PR）。--dry-run 只打印清单，不写库
//   node packages/harness-dispatch/src/bin/real.ts status <owner/仓#单号>…           这张单走到切回表的哪一行、外部动作、事件链
//   node packages/harness-dispatch/src/bin/real.ts release <owner/仓#单号> [--pr handoff|close]   按状态切回旧系统
// 输出是 JSON，一份一行，方便贴进 PR。freeze 只写 fleet2.real_batch_items，不碰 GitHub 和旧库；--dry-run 连这一张表也不写。release 才会写（分支改名、关 PR、放回旧系统）。
import { issueStream } from '@fleet-dao/harness-contract';
import { makeRedactor, secretsFromEnv } from '@fleet-dao/harness-runner';
import {
  type Db,
  events,
  getPublishRun,
  latestPublishRun,
  listOpsForTask,
  readStream,
} from '@fleet-dao/harness-store';
import * as schema from '@fleet-dao/harness-store/schema';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { appTokenSource, PUBLISH_PERMISSIONS } from '../github-app.ts';
import { githubReader } from '../github-read.ts';
import { githubWriter } from '../github-write.ts';
import { FreezeUsageError, parseIssueRef, REAL_USAGE, runRealFreeze } from '../real-batch.ts';
import { type PrChoice, switchBack, taskStage } from '../switch-back.ts';
import { currentFencing, releaseTask } from '../task-claim.ts';

const env = process.env;
const need = (k: string): string => {
  const v = env[k];
  if (!v) {
    console.error(`没给 ${k}`);
    process.exit(2);
  }
  return v;
};
const out = (o: unknown) => console.log(JSON.stringify(o));
const usage = (): never => {
  throw new FreezeUsageError(REAL_USAGE);
};

const [cmd, ...rest] = process.argv.slice(2);
const sql = postgres(need('FLEET2_DATABASE_URL'), { max: 2, onnotice: () => {} });
const db = drizzle(sql, { schema }) as unknown as Db;
const redact = makeRedactor(secretsFromEnv(env));
const appFile = need('FLEET2_GITHUB_APP_FILE');
const gh = githubReader({ tokenFor: appTokenSource({ file: appFile }) });

try {
  if (cmd === 'freeze') {
    const result = await runRealFreeze(db, rest, gh);
    console.log(redact(JSON.stringify(result.body)));
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  } else if (cmd === 'status') {
    if (rest.length === 0) usage();
    const write = githubWriter({
      tokenFor: appTokenSource({ file: appFile, permissions: PUBLISH_PERMISSIONS }),
    });
    const deps = {
      db,
      github: write,
      fencingOf: (ref: { repo: string; issue: number }) => currentFencing(db, ref),
      release: (
        ref: { repo: string; issue: number },
        f: number,
        to: { state: 'queued' | 'stopped'; doing: string },
      ) => releaseTask(db, ref, f, to),
    };
    for (const r of rest.map(parseIssueRef)) {
      const { stage, facts } = await taskStage(deps, r);
      const run = await latestPublishRun(db, r);
      const chain = await db
        .select({ id: events.id, stream: events.streamId, type: events.type, at: events.createdAt })
        .from(events)
        .where(eq(events.streamId, issueStream(r)))
        .orderBy(asc(events.id))
        .limit(50);
      out({
        ref: `${r.repo}#${r.issue}`,
        stage,
        fencing: facts.fencing,
        run: run
          ? { runId: run.runId, state: run.state, model: run.model, verdict: run.verdict, branch: run.branch }
          : null,
        ops: (await listOpsForTask(db, r)).map((o) => ({
          kind: o.kind,
          state: o.state,
          attempts: o.attempts,
        })),
        issueEvents: chain,
        sessionEvents: run ? (await readStream(db, `worker:${run.runId}`, 0, 10)).map((e) => e.type) : [],
        publishRun: run ? (await getPublishRun(db, run.runId))?.reason : null,
      });
    }
  } else if (cmd === 'release') {
    const [refStr, ...flags] = rest;
    if (!refStr) usage();
    const i = flags.indexOf('--pr');
    const pr = i >= 0 ? (flags[i + 1] as PrChoice | undefined) : undefined;
    if (pr !== undefined && pr !== 'handoff' && pr !== 'close') usage();
    const ref = parseIssueRef(refStr as string);
    const result = await switchBack(
      {
        db,
        github: githubWriter({
          tokenFor: appTokenSource({ file: appFile, permissions: PUBLISH_PERMISSIONS }),
        }),
        fencingOf: (r) => currentFencing(db, r),
        release: (r, f, to) => releaseTask(db, r, f, to),
      },
      ref,
      { ...(pr ? { pr } : {}), why: '人手切回' },
    );
    out({ ref: refStr, ...result });
  } else {
    usage();
  }
} catch (err) {
  if (err instanceof FreezeUsageError) {
    console.error(err.message);
    process.exitCode = 2;
  } else {
    console.error(redact(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
} finally {
  await sql.end({ timeout: 5 });
}
