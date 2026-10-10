// architect：开放式的方案题，没法用代码判，用一次 LLM 打分（裁判模型固定 claude-sonnet-5-5）：照题里写的评分标准逐条回 0/0.5/1。
// 分数是各条的平均，过线是 0.7，由代码按逐条得分算、判，不信裁判自己写的 score 和 pass。
// 真题（#1714）另有「必须满分的几条」：当时真栽在那几条上的，那几条没拿满，总分再高也不过。
import type { CaseSource, EvalCase, GradeContext, Verdict } from '../types.ts';
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

/** 一道方案题：题目、评分标准、必须满分的几条（1 起的编号，没有就只看总分）。 */
export interface ArchitectSpec {
  question: string;
  rubric: readonly string[];
  mustFull?: readonly number[];
}

const ENGINE_LIMIT: ArchitectSpec = { question: QUESTION, rubric: ARCHITECT_RUBRIC };

export function judgePrompt(answer: string, spec: ArchitectSpec = ENGINE_LIMIT): string {
  return (
    '你是评审员，给下面这份「方案」打分。只按评分标准打，不凭个人喜好；标准每条满足记 1，部分满足记 0.5，不满足记 0。' +
    '一条标准里写了「必须」的，方案里要明确写出那种做法才记 1，只泛泛提到相关字眼记 0.5 或 0。\n\n' +
    `题目：\n${spec.question}\n\n评分标准：\n${spec.rubric.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\n` +
    `待评的方案：\n<<<\n${answer}\n>>>\n\n` +
    `只回一个 JSON 对象，不要别的文字：{"items": [<${spec.rubric.length} 个数，按标准顺序，每个是 0、0.5 或 1>], "reason": "<每条一句，说明扣分处>"}`
  );
}

/**
 * 从裁判的回答里读出逐条得分、分数（逐条的平均）和理由。读不出、条数不对、得分不是 0/0.5/1 就是判不了。
 * 没给 items 的旧写法只认 score（0–1）：items 是 undefined，带必须满分条的题会因此判不了。
 */
export function parseJudgeAnswer(
  text: string,
  rubricSize: number = ARCHITECT_RUBRIC.length,
): { score: number; items: number[] | undefined; reason: string } {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new UngradableError(`裁判没回 JSON：${text.slice(0, 120)}`);
  let obj: unknown;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    throw new UngradableError(`裁判的 JSON 读不出：${m[0].slice(0, 120)}`);
  }
  const o = obj as { items?: unknown; score?: unknown; reason?: unknown };
  const reason = typeof o.reason === 'string' ? o.reason : '';
  if (o.items !== undefined) {
    const items = o.items;
    if (
      !Array.isArray(items) ||
      items.length !== rubricSize ||
      !items.every((x) => x === 0 || x === 0.5 || x === 1)
    ) {
      throw new UngradableError(
        `裁判的 items 不是 ${rubricSize} 个 0/0.5/1：${JSON.stringify(items).slice(0, 120)}`,
      );
    }
    const score = Math.round((items.reduce((a: number, b: number) => a + b, 0) / rubricSize) * 1000) / 1000;
    return { score, items, reason };
  }
  if (typeof o.score !== 'number' || !(o.score >= 0 && o.score <= 1)) {
    throw new UngradableError(`裁判的 score 不是 0–1 的数：${String(o.score)}`);
  }
  return { score: o.score, items: undefined, reason };
}

function gradeArchitect(spec: ArchitectSpec) {
  return async (ctx: GradeContext): Promise<Verdict> => {
    const { score, items, reason } = parseJudgeAnswer(
      await ctx.judge(judgePrompt(ctx.answer, spec)),
      spec.rubric.length,
    );
    const must = spec.mustFull ?? [];
    if (must.length > 0 && items === undefined) {
      throw new UngradableError('这道题有必须满分的几条，裁判却没给逐条得分（items）');
    }
    const short = must.filter((n) => items?.[n - 1] !== 1);
    const pass = score >= ARCHITECT_PASS_SCORE && short.length === 0;
    const mustNote = short.length > 0 ? `；必须满分的第 ${short.join('、')} 条没拿满（当时真栽在这里）` : '';
    return {
      pass,
      score,
      reason: `裁判（claude-sonnet-5-5）打 ${score}${items ? `（逐条 ${items.join(' ')}）` : ''}，${pass ? '过' : '没过'}线 ${ARCHITECT_PASS_SCORE}${mustNote}：${reason}`,
    };
  };
}

// —— 真题（#1714）：从本仓真出过事的方案里取，快照取方案落地之前的那个提交，必须满分的是后来出事、返工补上的那几条 ——

const REAL_PREAMBLE =
  '这是能力演练题，不是真任务：不开 PR、不开单、不写文件（方案直接写在最终回答里，不用写到 specs/ 下）。' +
  '当前目录是 fleet-dao 仓在某个历史提交的快照（没有 .git），要看现有代码和文档就读它。\n\n';

/** #1681 冷验收两家都验：#1690（Opus 5.5）照这条落地，合进去之后才发现会白跑、会让作者族互验，#1697 返工。 */
const TWO_FAMILY_COMMIT = '2fefe8c1f79d8a6ef8201fe3a912a1015e13491f';
const TWO_FAMILY: ArchitectSpec = {
  question:
    REAL_PREAMBLE +
    '题目：决定 0076 第 4 条（`docs/decisions/0076-route-strictly-by-order.md`，#1681）要冷验收「挑不出别家时自己兜」：' +
    '作者族认不出（如 Cursor Auto），或别家一家都派不出，就从两个不同的族各挑一个模型各验一遍，两家都过才算过；连两个不同的族都凑不齐，才停下等人。\n' +
    '冷验收现在的做法在 `packages/engine/src/verifier-invoke.ts`（invokeVerifier：按族挑模型、起一次性会话、判结论）和 ' +
    '`packages/engine/src/real/task-verify.ts`（createColdVerify：选路、预占名额、切号登记、waitReason 决定过一会儿重来）。\n' +
    '请出一份落地方案：先写前提和约束，列两三种做法和各自代价，给推荐和理由，说清和现有选路（等空位、等额度、熔断）怎么配合，' +
    '怎么拆成 PR、各片怎么验收，最后写风险和回退办法；动到人闸四类（对外发布、花钱、删数据、改标准）的地方单独标出。',
  rubric: [
    '前提写清：冷验收的要义是换一家来验、写代码的族不能自己验自己；两个入口（作者族认不出、别家派不出）；两家都过才算过',
    '指出「挑不出」要分两种：此刻等得来（等空位、等额度、熔断到点）和真派不出（没路由、被关、硬挡），接口上要能区分（例如选路回「在等」而不是和派不出一样回空）',
    '必须写明：别家只是在等（等得来）时，回「等待、过一会儿重来」，不改成两家都验——否则凑出来的两家里会混进作者族，等于作者族互验',
    '必须写明：两家都验时先把两个不同族的模型都挑出来，挑齐了才起会话；只凑出一家时一个会话都不起（否则这一家白跑一遍，下次重来又整个再跑）',
    '挑中却没用上的预占名额要放掉；切号登记跟着真正起会话的那一家，而不是挑模型的那一下',
    '两家结论怎么合写清：都过才过，任一家没过时列出各自的问题；同一族只算一家',
    '拆成 PR，每片的验收条在 diff 里看得见（例如：只凑出一家时不起会话的测试、别家在等时回等待的测试）',
    '写了风险和回退办法，并标出（或明确说没有）动到人闸四类的地方',
  ],
  mustFull: [3, 4],
};

/** #1256 发完恢复发版前的开关：#1265（Sonnet 5.5）只在驱动跑到恢复那一步才恢复，驱动中途死掉总开关就一直关着（#1674，#1700 返工）。 */
const RESTORE_COMMIT = 'a4858039d9ee29f41650e91aa24c4a7b4c21ae4f';
const RESTORE_SWITCH: ArchitectSpec = {
  question:
    REAL_PREAMBLE +
    '题目：#1256（决定 0032 第 4 条，`docs/decisions/0032-release-by-main-commit.md`）：发版照「暂停派活、等手头活收完、部署」走，' +
    '发完要恢复到发版前的样子——发版前开着的引擎总开关和各项目的「让 AI 接活」开关，发完自动开回；发版前就关着的保持关；' +
    '取代现在「每次发完一律置关、等人去点」。恢复动作写进操作记录，恢复不成功要报警。\n' +
    '发版有两个入口：驾驶舱「发布到法国」按钮（法国上的 `deploy/france/release-request/`）和本机命令行发版车' +
    '（`agents/skills/commander/scripts/release-train*.mjs`，一步步 ssh 到法国做）；部署本身是 `deploy/release.sh`。\n' +
    '请出一份落地方案：先写前提和约束，列两三种做法和各自代价，给推荐和理由，怎么拆成 PR、各片怎么验收，最后写风险和回退办法；' +
    '动到人闸四类（对外发布、花钱、删数据、改标准）的地方单独标出。',
  rubric: [
    '前提写清：两个入口都要管；发版前的开关状态要记下；发前关着的保持关；恢复写操作记录；恢复不成功报警',
    '发版前的开关状态落盘在发版流程的进程之外、下一个进程读得到的地方（状态文件或库），不只放在驱动进程的内存里',
    '必须写明：驱动（发版车或按钮背后的流程）中途死掉（ssh 断、进程被杀、机器重启）时开关会一直关着，要有认出「驱动已死」的办法（心跳、pid、租约之类）和接着走或补做恢复的路径',
    '必须写明：巡查或报警能把「总开关关着、却没有活着的发版在跑」报出来，不靠人记得去点',
    '恢复只恢复「发版前开着、这一趟关掉的」，不把发版期间人手动关掉的又开回来（或说明这种冲突怎么处理）',
    '恢复的时机写清：部署和健康检查过了才恢复；发版失败时恢复还是保持关并报警，写明',
    '拆成 PR，每片的验收条在 diff 里看得见；release.sh 和两个入口谁负责关、谁负责恢复写清，不两处各改各的',
    '写了风险和回退办法，并标出发版属于人闸「对外发布」这一类',
  ],
  mustFull: [3, 4],
};

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
    grade: gradeArchitect(ENGINE_LIMIT),
  },
  realCase({
    name: 'two-family-verify',
    spec: TWO_FAMILY,
    source: { kind: 'repo', commit: TWO_FAMILY_COMMIT },
    planted:
      '标准答案是 #1690 落地后 #1697 返工补上的两条（必须满分的第 3、4 条）：选路说某族「在等」要和「派不出」分开，别家在等时回等待、不改成两家都验（不然作者族互验）；' +
      '两家都验先把两个不同族的模型都挑齐再起会话，只凑出一家时一个都不起。其余 6 条是一般方案该有的。快照是决定 0076 记下、#1690 还没合的那个提交。',
    why:
      '当时 Opus 5.5 照这条写了 #1690，合进去后两处出事才由 #1697 返工：别家在等额度时它把「挑不出」当成「派不出」，改成两家都验、混进了作者族；' +
      '两家都验时挑到一家就起会话，凑不齐第二家时这一家白跑，下次重来又整个再跑。这两条只有想清楚选路的「等」和派不出不是一回事、两家要先挑齐才写得出。',
  }),
  realCase({
    name: 'release-restore-switch',
    spec: RESTORE_SWITCH,
    source: { kind: 'repo', commit: RESTORE_COMMIT },
    planted:
      '标准答案是 #1265 落地后 #1700 返工补上的两条（必须满分的第 3、4 条）：驱动中途死掉时要认得出（心跳、pid）并能接着走或补做恢复；' +
      '巡查要把「总开关关着、没有活着的发版」报出来。其余 6 条是一般方案该有的。快照是 #1265 合进去之前的那个提交。',
    why:
      '当时 Sonnet 5.5 写的 #1265 只在发版车跑到「恢复」那一步才把开关开回；2026-10-10 发版车驱动中途死掉，法国引擎总开关就一直关着没人恢复，' +
      'status 也认不出驱动已死（#1674），#1700 才补上驱动死活、接着走和巡查报警。要想到「流程自己会死在半路」才写得出。',
  }),
];

function realCase(c: {
  name: string;
  spec: ArchitectSpec;
  source: CaseSource;
  planted: string;
  why: string;
}): EvalCase {
  return {
    id: `architect/${c.name}`,
    scenario: 'architect',
    name: c.name,
    agent: 'fleet-architect',
    prompt: c.spec.question,
    source: c.source,
    usesJudge: true,
    planted: c.planted,
    why: c.why,
    grade: gradeArchitect(c.spec),
  };
}
