// 真跑验收：经插头起真的 Claude 会话答考题，走提问接口、记库、考试记分、状态判定的全部代码路径。
// 在法国 VPS 上以执行体用户跑（Claude 订阅，套餐内），库用内存里的 PGlite，不连任何真库、不碰任何配置：
//   node packages/jev/test/e2e/exam-e2e.ts <reclaude 绝对路径> [每个接入点考几道，默认 1] [模型，默认 claude-opus-5-5] [接入点，逗号分隔，默认全部]
import { jevAnswers } from '@fleet-dao/db';
import { createTestDb } from '@fleet-dao/db/testing';
import { createClaudeJudgeBackend } from '../../src/backends/claude.ts';
import { BANK } from '../../src/bank.ts';
import { runExam } from '../../src/exam.ts';
import { createJev } from '../../src/jev.ts';
import { DEFAULT_POLICY } from '../../src/policy.ts';
import { SITES, type SiteId } from '../../src/questions.ts';
import { reviewModes } from '../../src/store.ts';

const [reclaude, limitArg = '1', model = 'claude-opus-5-5', sitesArg] = process.argv.slice(2);
if (!reclaude) {
  console.error('用法：node exam-e2e.ts <reclaude 绝对路径> [每个接入点考几道] [模型] [接入点,…]');
  process.exit(2);
}
const limit = Number(limitArg);
const sites = (sitesArg ? sitesArg.split(',') : Object.keys(SITES)) as SiteId[];

const t = await createTestDb();
const policy = { ...DEFAULT_POLICY, dailyCallLimit: 1_000 };
const backend = createClaudeJudgeBackend({ command: [reclaude], model });
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
const asked = reports.flatMap((r) => r.questions).reduce((n, q) => n + q.asked, 0);
const answered = reports.flatMap((r) => r.questions).reduce((n, q) => n + q.answered, 0);
const correct = reports.flatMap((r) => r.questions).reduce((n, q) => n + q.correct, 0);
const checks: [string, boolean][] = [
  ['每一问都记了一行', rows.length === asked],
  ['考试的每一行都带真值（canary）且只记不拦', rows.every((r) => r.truthSource === 'canary' && r.shadow)],
  ['回话的都是钉死的模型', rows.filter((r) => r.ok).every((r) => r.modelVersion?.startsWith(model))],
  ['大部分考题答在题面里', answered >= Math.ceil(asked * 0.8)],
  ['没有哪道题因为这一次考试转成真拦（样本不够）', modes.every((m) => m.mode !== 'enforce')],
];

console.log(
  JSON.stringify(
    {
      model,
      limit,
      seconds: Math.round((Date.now() - started) / 1000),
      totals: { asked, answered, correct },
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
          misses: q.misses,
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
        model: r.modelVersion,
      })),
      checks: Object.fromEntries(checks),
    },
    null,
    2,
  ),
);
await t.close();
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
