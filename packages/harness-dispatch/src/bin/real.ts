// 真执行的人手命令（#3783，第 7 片）。配置同内核（环境变量），在法国上以 fleet 跑：
//   node packages/harness-dispatch/src/bin/real.ts freeze <批次号> <owner/仓#单号>…   冻结一批（基线取主线现在的提交；单要开着、不是 PR）
//   node packages/harness-dispatch/src/bin/real.ts status <owner/仓#单号>…           这张单走到切回表的哪一行、外部动作、事件链；另带整张 outbox 各状态条数和到期没做的最老一条秒数
//   node packages/harness-dispatch/src/bin/real.ts release <owner/仓#单号> [--pr handoff|close]   按状态切回旧系统
// 输出是 JSON，一份一行，方便贴进 PR。freeze 只写 fleet2.real_batch_items，不碰 GitHub 和旧库；release 才会写（分支改名、关 PR、放回旧系统）。
import { issueStream } from '@fleet-dao/harness-contract';
import { makeRedactor, secretsFromEnv } from '@fleet-dao/harness-runner';
import {
  countOpsByState,
  type Db,
  events,
  freezeRealBatch,
  getPublishRun,
  latestPublishRun,
  listOpsForTask,
  oldestDueAgeSeconds,
  readStream,
} from '@fleet-dao/harness-store';
import * as schema from '@fleet-dao/harness-store/schema';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { appTokenSource, PUBLISH_PERMISSIONS } from '../github-app.ts';
import { githubReader } from '../github-read.ts';
import { githubWriter } from '../github-write.ts';
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
  console.error(
    '用法：real.ts freeze <批次号> <owner/仓#单号>… | status <owner/仓#单号>… | release <owner/仓#单号> [--pr handoff|close]',
  );
  return process.exit(2);
};

function parseRef(s: string): { repo: string; issue: number } {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  if (!m) {
    console.error(`单号写法不对（要 owner/仓#号）：${s}`);
    return process.exit(2);
  }
  return { repo: m[1] as string, issue: Number(m[2]) };
}

const [cmd, ...rest] = process.argv.slice(2);
const sql = postgres(need('FLEET2_DATABASE_URL'), { max: 2, onnotice: () => {} });
const db = drizzle(sql, { schema }) as unknown as Db;
const redact = makeRedactor(secretsFromEnv(env));
const appFile = need('FLEET2_GITHUB_APP_FILE');
const gh = githubReader({ tokenFor: appTokenSource({ file: appFile }) });

try {
  if (cmd === 'freeze') {
    const [batchId, ...refs] = rest;
    if (!batchId || refs.length === 0) usage();
    const items = [];
    for (const r of refs.map(parseRef)) {
      const facts = await gh.issueFacts(r.repo, r.issue);
      if (facts.isPr) throw new Error(`${r.repo}#${r.issue} 是 PR，不是单`);
      if (!facts.open) throw new Error(`${r.repo}#${r.issue} 已经关了`);
      items.push({ ...r, baseSha: await gh.headSha(r.repo, 'main'), snapshotAt: new Date() });
    }
    await freezeRealBatch(db, batchId as string, items);
    out({ frozen: batchId, items: items.map((i) => ({ repo: i.repo, issue: i.issue, baseSha: i.baseSha })) });
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
    const backlog = {
      counts: await countOpsByState(db),
      oldestDueAgeSeconds: await oldestDueAgeSeconds(db),
    };
    for (const r of rest.map(parseRef)) {
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
        outbox: backlog,
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
    const ref = parseRef(refStr as string);
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
  console.error(redact(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
