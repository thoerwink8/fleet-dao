// 真跑验收：用真的后端答考题，走提问接口、记库、每日上限、考试记分、状态判定的全部代码路径。
// 在法国 VPS 上跑（Claude 后端以会话用户，TypeSafe 以读得到密钥文件的用户），库用内存里的 PGlite，不连任何真库、不碰任何配置：
//   node packages/jev/test/e2e/exam-e2e.ts <后端> [每个接入点考几道（按标准答案轮着取），默认 1] [接入点,…，默认全部] [今天还能花的美元，默认按上限]
//   后端：claude:<reclaude 绝对路径>[@模型，默认 claude-opus-5-5]
//        typesafe:<机器配置文件>[@模型，默认 jev-1.13.0]（配置格式见 packages/jev/config.example.json；按量计费，受每日花费上限管）
import { jevAnswers } from '@fleet-dao/db';
import { createTestDb } from '@fleet-dao/db/testing';
import type { JevBackend } from '../../src/backend.ts';
import { createClaudeJudgeBackend } from '../../src/backends/claude.ts';
import { BANK } from '../../src/bank.ts';
import { backendForRoute, loadJevConfig } from '../../src/config.ts';
import { runExam } from '../../src/exam.ts';
import { createJev } from '../../src/jev.ts';
import { DEFAULT_POLICY } from '../../src/policy.ts';
import { SITES, type SiteId } from '../../src/questions.ts';
import { reviewModes } from '../../src/store.ts';

const [backendArg, limitArg = '1', sitesArg, usdArg] = process.argv.slice(2);
const parsed = /^(claude|typesafe):([^@]+)(?:@(.+))?$/.exec(backendArg ?? '');
if (!parsed) {
  console.error(
    '用法：node exam-e2e.ts <claude:reclaude 路径[@模型] | typesafe:配置文件[@模型]> [每个接入点考几道] [接入点,…] [今天还能花的美元]',
  );
  process.exit(2);
}
const [, kind, target = '', modelArg] = parsed;
let backend: JevBackend;
if (kind === 'claude') {
  backend = createClaudeJudgeBackend({ command: [target], model: modelArg ?? 'claude-opus-5-5' });
} else {
  backend = await backendForRoute(
    { hostId: 'api-shell', model: modelArg ?? 'jev-1.13.0' },
    await loadJevConfig(target),
  );
}
const limit = Number(limitArg);
const sites = (sitesArg && sitesArg !== 'all' ? sitesArg.split(',') : Object.keys(SITES)) as SiteId[];
// 考试的次数另算（examDailyCallLimit）；花费上限和生产共用，给了「今天还能花的美元」就按它。
const policy = {
  ...DEFAULT_POLICY,
  examDailyCallLimit: 1_000,
  ...(usdArg === undefined ? {} : { dailyUsdCap: Number(usdArg) }),
};

const t = await createTestDb();
const jev = createJev({ db: t.db, backend, policy });
const started = Date.now();
const reports = [];
for (const site of sites) {
  const t0 = Date.now();
  const report = await runExam(jev, site, { limit });
  reports.push({ site, seconds: Math.round((Date.now() - t0) / 1000), questions: report.questions });
  console.error(`考完 ${site}（${Math.round((Date.now() - t0) / 1000)} 秒）`);
}

const rows = await t.db.select().from(jevAnswers);
const modes = await reviewModes(t.db, BANK, { policy });
const all = reports.flatMap((r) => r.questions);
const asked = all.reduce((n, q) => n + q.asked, 0);
const answered = all.reduce((n, q) => n + q.answered, 0);
const sure = all.reduce((n, q) => n + q.sure, 0);
const correct = all.reduce((n, q) => n + q.correct, 0);
const costUsd = rows.reduce((n, r) => n + ((r.sample as { costUsd?: number }).costUsd ?? 0), 0);
const answeredRows = rows.filter((r) => r.ok);
const bucket = (lo: number, hi: number) =>
  answeredRows.filter((r) => (r.confidence ?? 0) >= lo && (r.confidence ?? 0) < hi).length;
const rightRows = answeredRows.filter((r) => r.answer === r.truth);
const checks: [string, boolean][] = [
  ['每一问都记了一行', rows.length === asked],
  ['考试的每一行都带真值（canary）且只记不拦', rows.every((r) => r.truthSource === 'canary' && r.shadow)],
  ['回话的都是钉死的模型', rows.filter((r) => r.ok).every((r) => r.modelVersion?.startsWith(backend.model))],
  ['大部分考题答在题面里', answered >= Math.ceil(asked * 0.8)],
  ['花费没超每日上限', costUsd <= policy.dailyUsdCap],
  ['没有哪道题因为这一次考试转成真拦（样本不够）', modes.every((m) => m.mode !== 'enforce')],
];

console.log(
  JSON.stringify(
    {
      backend: backend.kind,
      model: backend.model,
      limit,
      seconds: Math.round((Date.now() - started) / 1000),
      totals: {
        asked,
        answered,
        sure,
        correct,
        // 不论把握，选项和标准答案一致的
        agree: rightRows.length,
        costUsd,
        inputTokens: rows.reduce((n, r) => n + (r.inputTokens ?? 0), 0),
      },
      confidence: {
        '<0.5': bucket(0, 0.5),
        '0.5–0.7': bucket(0.5, 0.7),
        '0.7–0.9': bucket(0.7, 0.9),
        '≥0.9': bucket(0.9, 1.01),
        rightMean: rightRows.length
          ? rightRows.reduce((n, r) => n + (r.confidence ?? 0), 0) / rightRows.length
          : null,
        wrong: answeredRows
          .filter((r) => r.answer !== r.truth)
          .map((r) => ({
            q: r.questionId,
            subject: r.subject,
            got: r.answer,
            truth: r.truth,
            confidence: r.confidence,
          })),
      },
      reports: reports.map((r) => ({
        site: r.site,
        seconds: r.seconds,
        questions: r.questions.map((q) => ({
          id: q.questionId,
          asked: q.asked,
          answered: q.answered,
          sure: q.sure,
          correct: q.correct,
          reasons: q.reasons,
        })),
      })),
      calls: rows.map((r) => ({
        q: r.questionId,
        subject: r.subject,
        ok: r.ok,
        answer: r.answer,
        truth: r.truth,
        confidence: r.confidence,
        failReason: r.failReason,
        latencyMs: r.latencyMs,
        inputTokens: r.inputTokens,
        costUsd: (r.sample as { costUsd?: number }).costUsd,
        model: r.modelVersion,
        // 没判出来时库里记的原文，比如「因每日花费上限没问：……」
        detail: (r.sample as { detail?: string }).detail,
      })),
      checks: Object.fromEntries(checks),
    },
    null,
    2,
  ),
);
await t.close();
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
