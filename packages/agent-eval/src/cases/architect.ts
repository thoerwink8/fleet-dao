// architect：开放式的方案题，没法用代码判，用一次 LLM 打分（裁判模型固定 claude-sonnet-5-5）：照题里写的评分标准回 0–1 分加过不过。
// 过线是 0.7，由代码按分数判，不信裁判自己写的 pass。
import type { EvalCase, GradeContext, Verdict } from '../types.ts';
import { UngradableError } from '../types.ts';

export const ARCHITECT_PASS_SCORE = 0.7;

const QUESTION =
  '这是能力演练题，不是真任务：不开 PR、不开单、不写文件（方案直接写在最终回答里，不用写到 specs/ 下）。\n\n' +
  '题目：引擎要限制「同一个项目同时进行的任务数不超过 N」（N 按项目可配）。已知约束：\n' +
  '- 引擎是多个 worker 进程，跑在同一台机器上，会各自独立重启、崩溃；\n' +
  '- 唯一的持久存储是 Postgres，没有 Redis，也不想为此引入新的依赖或服务；\n' +
  '- 任务可能在占着名额时被杀掉，不能让这种名额永远占着（不漏占）；\n' +
  '- 创始人要求按最好的一版做，不为省事做小；动到人闸四类（对外发布、花钱、删数据、改标准）的地方要单独标出。\n' +
  '请出一份方案：先写前提和约束，列两三种做法并写清各自代价，给一个推荐和理由，说明怎么拆成 PR、各片怎么验收，最后写风险和回退办法。';

export const ARCHITECT_RUBRIC: readonly string[] = [
  '前提和约束写清了：多进程、只有 Postgres、会崩溃/被杀、不引入新依赖（至少说到其中三点）',
  '指出「进程内计数」不行并说明原因：多个 worker 进程不共享内存，重启就丢',
  '指出 Redis 之类新依赖不符合约束，或明确把它排除',
  '推荐的是放在 Postgres 里的占位（计数行或租约行），并带过期或心跳，使崩溃后名额自动回收',
  '说明如何保证原子性、不会两个 worker 同时占满超限：行锁、advisory lock、条件插入/更新之类，至少给出一种具体机制',
  '说明崩溃或被杀后怎么回收名额：租约到期、启动对账之类',
  '拆成 PR：每片一个包、验收条在 diff 里看得见，说明哪些归引擎、哪些要指挥官',
  '写了风险和回退办法，并标出（或明确说没有）动到人闸四类的地方',
];

export function judgePrompt(answer: string): string {
  return (
    '你是评审员，给下面这份「方案」打分。只按评分标准打，不凭个人喜好；标准每条满足记 1，部分满足记 0.5，不满足记 0。' +
    '分数 = 各条得分之和 ÷ 条数（0 到 1 之间）。\n\n' +
    `题目：\n${QUESTION}\n\n评分标准：\n${ARCHITECT_RUBRIC.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\n` +
    `待评的方案：\n<<<\n${answer}\n>>>\n\n` +
    '只回一个 JSON 对象，不要别的文字：{"score": <0 到 1 的小数>, "pass": <true 或 false，分数 ≥ 0.7 记 true>, "reason": "<每条一句，说明扣分处>"}'
  );
}

/** 从裁判的回答里读出 { score, reason }。读不出就是判不了。 */
export function parseJudgeAnswer(text: string): { score: number; reason: string } {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new UngradableError(`裁判没回 JSON：${text.slice(0, 120)}`);
  let obj: unknown;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    throw new UngradableError(`裁判的 JSON 读不出：${m[0].slice(0, 120)}`);
  }
  const o = obj as { score?: unknown; reason?: unknown };
  if (typeof o.score !== 'number' || !(o.score >= 0 && o.score <= 1)) {
    throw new UngradableError(`裁判的 score 不是 0–1 的数：${String(o.score)}`);
  }
  return { score: o.score, reason: typeof o.reason === 'string' ? o.reason : '' };
}

async function gradeArchitect(ctx: GradeContext): Promise<Verdict> {
  const { score, reason } = parseJudgeAnswer(await ctx.judge(judgePrompt(ctx.answer)));
  const pass = score >= ARCHITECT_PASS_SCORE;
  return {
    pass,
    score,
    reason: `裁判（claude-sonnet-5-5）打 ${score}，${pass ? '过' : '没过'}线 ${ARCHITECT_PASS_SCORE}：${reason}`,
  };
}

export const ARCHITECT_CASES: EvalCase[] = [
  {
    id: 'architect/engine-concurrency-limit',
    scenario: 'architect',
    name: 'engine-concurrency-limit',
    agent: 'fleet-architect',
    prompt: QUESTION,
    source: { kind: 'fixture' },
    usesJudge: true,
    planted:
      '有已知最优解：多进程 + 只有 Postgres + 会崩溃，所以用 Postgres 里的租约行（带过期时间和心跳），占位用行锁/advisory lock/条件插入保证原子，崩溃靠租约到期或启动对账回收。' +
      '进程内计数、Redis 都要被排除并说明原因。评分标准 8 条（见 architect.ts 的 ARCHITECT_RUBRIC），每条 1/0.5/0，≥ 0.7 算过。',
    why: '约束互相咬合（多进程排除内存计数、无 Redis、崩溃不漏占）；Opus 该把 8 条里大多数写全，Sonnet 可能漏掉原子性或回收机制，Haiku 多半停在「用数据库计数」一句话。',
    grade: gradeArchitect,
  },
];
