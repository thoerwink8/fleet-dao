// 单子里问创始人（#259；docs/decisions/0003-fusion-flow.md 第 5 条第 2 步）：他多半不在场，问他不许卡住活。
// 提问一律带选项和推荐。这张单范围内的岔路按推荐先做、不等；超出这张单范围的另开一张单等他拍，这张单绕开它接着做；
// 碰人闸四类（对外发布、花钱、删数据、改标准）的也先按推荐做，只挡那一步（合并前等他批）。只有他本人才有的东西
// （账号、权限、登录）不算提问，是「这一块等他」（fleet blocked --needs access）。
// 他晚到的回答：选的就是推荐的只记一笔；选了别的，单子还没合就在下一个存档点交给主导改，已经合了就开后续单。
// 这里只判，不碰库和网络：后端收提问、引擎走存档点、对账开后续单、卡片写什么都照这里。

import { ASK_MAX_OPTIONS, type TaskState } from '@fleet-dao/shared';
import { CATEGORIES } from './config.ts';

/** 人闸四类：碰到的只挡那一步（合并前等人批）。 */
export const ASK_HOLDS = ['release', 'spend', 'delete', 'standard'] as const;
export type AskHold = (typeof ASK_HOLDS)[number];

export const ASK_HOLD_NAMES: Readonly<Record<AskHold, string>> = {
  release: '对外发布',
  spend: '花钱',
  delete: '删数据',
  standard: '改标准',
};

/** task = 这张单范围内的岔路；outside = 超出这张单的范围（另开单）；hold = 碰人闸四类。 */
export type AskScope = 'task' | 'outside' | 'hold';

/** 一次最多几个选项：和命令行本地挡的是同一个数（shared 的 agent-api.ts）。 */
export { ASK_MAX_OPTIONS };

/** 会话里怎么问（退回时原样告诉它）。 */
export const ASK_USAGE = 'fleet ask "<问题>" -o <甲> -o <乙> --recommend <甲>';

export interface AskInput {
  question: string;
  options?: readonly string[] | undefined;
  /** 推荐哪个：照抄其中一个选项。 */
  recommend?: string | undefined;
  /** 超出这张单的范围：另开一张单等他拍。 */
  outside?: boolean | undefined;
  /** 碰了人闸四类的哪一类。 */
  hold?: string | undefined;
}

export interface ScopedAsk {
  question: string;
  /** 推荐的排第一个（卡片上第一个按钮是主按钮）。 */
  options: string[];
  recommended: string;
  scope: AskScope;
  hold?: AskHold;
}

export type AskCheck = { ok: true; ask: ScopedAsk } | { ok: false; why: string };

const BLOCKED_HINT =
  '只有创始人本人才有的东西（账号、权限、登录）不是提问，用 fleet blocked "<缺什么>" --needs access';

/** 提问合不合格：至少两个选项、推荐的照抄其中一个；超出范围和人闸二选一。不合格的退回会话补齐，写明怎么补。 */
export function checkAsk(input: AskInput): AskCheck {
  const question = input.question.trim();
  if (!question) return { ok: false, why: '问题是空的' };
  const options: string[] = [];
  for (const raw of input.options ?? []) {
    const o = raw.trim();
    if (o && !options.includes(o)) options.push(o);
  }
  if (options.length < 2) {
    return {
      ok: false,
      why: `提问要带至少两个选项和推荐（${ASK_USAGE}）：引擎按推荐先做、不停下等，创始人之后改了会在下一个存档点告诉你。${BLOCKED_HINT}`,
    };
  }
  if (options.length > ASK_MAX_OPTIONS) {
    return {
      ok: false,
      why: `选项最多 ${ASK_MAX_OPTIONS} 个（现在 ${options.length} 个）：挑出最像样的几个`,
    };
  }
  const recommended = input.recommend?.trim() ?? '';
  if (!recommended) {
    return { ok: false, why: `没写推荐哪个（--recommend，照抄其中一个选项）：${ASK_USAGE}` };
  }
  if (!options.includes(recommended)) {
    return { ok: false, why: `推荐的「${recommended}」不在选项里：--recommend 要照抄其中一个选项` };
  }
  const hold = input.hold?.trim();
  if (input.outside && hold) {
    return {
      ok: false,
      why: '超出这张单范围的另开一张单（那张单自己管人闸）：--outside 和 --hold 只能选一个',
    };
  }
  if (hold !== undefined && hold !== '' && !(ASK_HOLDS as readonly string[]).includes(hold)) {
    return { ok: false, why: `人闸认不出：${hold}（只有 ${ASK_HOLDS.join('、')} 四类）` };
  }
  const ordered = [recommended, ...options.filter((o) => o !== recommended)];
  if (input.outside) return { ok: true, ask: { question, options: ordered, recommended, scope: 'outside' } };
  if (hold) {
    return {
      ok: true,
      ask: { question, options: ordered, recommended, scope: 'hold', hold: hold as AskHold },
    };
  }
  return { ok: true, ask: { question, options: ordered, recommended, scope: 'task' } };
}

/**
 * 他晚到的回答怎么算（只管按推荐先做了的：task、hold 两种）。
 * confirmed = 选的就是推荐的，只记一笔；applied = 选了别的，已经交给主导照改了；change = 选了别的、单子还没合，
 * 下一个存档点交给主导改；follow-up = 选了别的、这张单已经合了（没来得及改），开后续单；recorded = 选了别的、
 * 这张单没做成就停了（叫停、失败），只记下，重开时照他选的做。
 */
export type LateAnswer = 'confirmed' | 'applied' | 'change' | 'follow-up' | 'recorded';

export function lateAnswer(input: {
  recommended: string;
  answer: string;
  /** 主导已经照改了（存档点交出去了）。 */
  applied: boolean;
  taskState: TaskState;
}): LateAnswer {
  if (input.answer.trim() === input.recommended.trim()) return 'confirmed';
  if (input.applied) return 'applied';
  if (input.taskState === 'done') return 'follow-up';
  if (input.taskState === 'stopped' || input.taskState === 'failed') return 'recorded';
  return 'change';
}

/** 一条提问在库里的样子（判晚到的回答、记数要看的几样）。 */
export interface AskFacts {
  scope?: AskScope | undefined;
  recommended?: string | undefined;
  answer?: string | undefined;
  applied?: boolean | undefined;
}

export interface AskTally {
  /** 这张单范围内按推荐先做的（task）、碰人闸先按推荐做的（hold）。 */
  assumed: number;
  /** 其中他回了、选的就是推荐的。 */
  confirmed: number;
  /** 其中他回了、改选了别的（事后被改）。 */
  changed: number;
  /** 超出范围、另开单的。 */
  outside: number;
  /** 还是老样子（没带推荐）的提问：没法算进前面几样。 */
  legacy: number;
}

/** 按推荐先走、事后被改的次数（给检验制度用，#257）。 */
export function tallyAsks(asks: readonly AskFacts[]): AskTally {
  const t: AskTally = { assumed: 0, confirmed: 0, changed: 0, outside: 0, legacy: 0 };
  for (const a of asks) {
    if (a.scope === 'outside') t.outside += 1;
    else if ((a.scope === 'task' || a.scope === 'hold') && a.recommended !== undefined) {
      t.assumed += 1;
      if (a.answer === undefined) continue;
      if (a.answer.trim() === a.recommended.trim()) t.confirmed += 1;
      else t.changed += 1;
    } else t.legacy += 1;
  }
  return t;
}

// ---- 引擎和对账（#259 第 2 个 PR）：存档点交给 Lead 照改、PR 正文「按推荐先做了」、关单记数、另开单

/** 引擎、对账要看的一条提问（库里 asks 一行）。和 AskFacts 同形，tallyAsks 直接能数。 */
export interface TaskAsk {
  id: string;
  question: string;
  /** 带了推荐的，推荐的排第一个。 */
  options: readonly string[];
  scope?: AskScope | undefined;
  recommended?: string | undefined;
  hold?: AskHold | undefined;
  answer?: string | undefined;
  /** 交给主导照改过了（库里 applied_at 有值）。 */
  applied: boolean;
  /** 另开的单：超出范围的那张，或他改选了别的、原单已经合了开的后续单。 */
  followUpIssue?: number | undefined;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, max: number) => {
  const t = oneLine(s);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** 按推荐先做了的（task、hold）、带着推荐的：只有这种才谈得上「他改选了别的」。 */
function assumed(a: TaskAsk): a is TaskAsk & { recommended: string } {
  return (a.scope === 'task' || a.scope === 'hold') && a.recommended !== undefined;
}

/**
 * 存档点（Fusion 每一步交界）要交给 Lead 照改的：按推荐先做了的、他回了别的、还没照改、也没另开后续单的（单子还在做，
 * lateAnswer 判 change）。handed = 已经交给 Lead、还没照改完的，不再算新的。单子合了之后才到的归对账开后续单，不经这里。
 */
export function lateChanges(asks: readonly TaskAsk[], handed: readonly string[] = []): TaskAsk[] {
  return asks.filter(
    (a) =>
      assumed(a) &&
      a.answer !== undefined &&
      a.followUpIssue === undefined &&
      !handed.includes(a.id) &&
      lateAnswer({
        recommended: a.recommended,
        answer: a.answer,
        applied: a.applied,
        taskState: 'running',
      }) === 'change',
  );
}

/** 交给 Lead 的一条（返工意见里原样给它）：问的什么、按推荐先做的是哪个、他改选了哪个。 */
export function changeLine(a: TaskAsk): string {
  const gate = a.scope === 'hold' && a.hold ? `（碰人闸：${ASK_HOLD_NAMES[a.hold]}）` : '';
  const answer = oneLine(a.answer ?? '');
  return `问「${clip(a.question, 200)}」${gate}：按推荐先做的是「${oneLine(a.recommended ?? '')}」，创始人改选了「${answer}」，照「${answer}」改`;
}

/**
 * PR 正文「按推荐先做了」一栏（#259）：这张单问过创始人、没等回答就按推荐先做了的（task、hold），他回了的写明回了什么；
 * 超出范围、绕开了另开单的也列上。老式的（没带推荐的）不列。
 */
export function assumedLines(asks: readonly TaskAsk[]): string[] {
  const out: string[] = [];
  for (const a of asks) {
    const q = clip(a.question, 60);
    if (a.scope === 'outside') {
      out.push(
        `${q} → 超出这张单的范围，绕开了，另开一张单等创始人拍${a.followUpIssue ? `（#${a.followUpIssue}）` : '（对账时开）'}`,
      );
      continue;
    }
    if (!assumed(a)) continue;
    const rec = clip(a.recommended, 40);
    const gate = a.scope === 'hold' && a.hold ? `（碰人闸：${ASK_HOLD_NAMES[a.hold]}，合并前等他批）` : '';
    if (a.answer === undefined) {
      out.push(`${q} → 先按推荐做了「${rec}」${gate}，创始人还没回`);
      continue;
    }
    const late = lateAnswer({
      recommended: a.recommended,
      answer: a.answer,
      applied: a.applied,
      taskState: 'running',
    });
    const answer = clip(a.answer, 40);
    out.push(
      late === 'confirmed'
        ? `${q} → 按推荐做了「${rec}」${gate}，创始人确认了`
        : `${q} → 先按推荐做了「${rec}」${gate}，创始人改选了「${answer}」，${late === 'applied' ? '已照改' : '下个存档点照改'}`,
    );
  }
  return out;
}

/** 另开的单：outside = 超出范围的那一块等他拍；follow-up = 他改选了别的、原单已经合了，照他选的改。 */
export type AskIssueKind = 'outside' | 'follow-up';

/**
 * 这一条提问要不要另开一张单（对账每轮判）：超出范围的开一张等他拍；按推荐先做了的，他改选了别的、原单已经合了
 * （没来得及照改，lateAnswer 判 follow-up）开后续单。开过的（follow_up_issue 有值）不再开。
 */
export function askIssueKind(a: TaskAsk, taskState: TaskState): AskIssueKind | null {
  if (a.followUpIssue !== undefined) return null;
  if (a.scope === 'outside') return 'outside';
  if (!assumed(a) || a.answer === undefined) return null;
  const late = lateAnswer({ recommended: a.recommended, answer: a.answer, applied: a.applied, taskState });
  return late === 'follow-up' ? 'follow-up' : null;
}

/** 另开的单贴哪个类别、挂哪个版本：原单此刻的样子（GitHub 上现读）。 */
export interface AskIssueOriginal {
  labels: readonly string[];
  milestone: { number: number; title: string } | null;
  /** 仓里此刻还开着的里程碑。 */
  openMilestones: readonly { number: number; title: string }[];
}

export interface AskIssuePlacement {
  /** 恰好一个类别：照抄原单的，原单没贴或贴了不止一个就按「需求」。母单这些别的标签不抄：另开的是独立单，不挂成子单。 */
  labels: string[];
  /** 挂的版本；null = 未排期。 */
  milestone: { number: number; title: string } | null;
  /** 后续单本该挂原单的版本，可那个版本已经关了：先放未排期，正文写明。 */
  closedMilestone?: string | undefined;
}

/**
 * 另开的单放哪（design 第五节「没人拍板」）：后续单挂原单的同一个版本（开着才挂——挂在当前版本上的独立单会被自动派，
 * 照他选的改掉），原单没挂版本就一样未排期；超出范围的一律未排期，等他拍（AI 不往进行中的版本里加他没拍过的活，0003 第 2 条）。
 */
export function askIssuePlacement(kind: AskIssueKind, original: AskIssueOriginal): AskIssuePlacement {
  const categories = CATEGORIES.filter((c) => original.labels.includes(c));
  const labels = categories.length === 1 ? categories : ['需求'];
  if (kind === 'outside' || original.milestone === null) return { labels, milestone: null };
  const want = original.milestone;
  if (original.openMilestones.some((m) => m.number === want.number)) {
    return { labels, milestone: { number: want.number, title: want.title } };
  }
  return { labels, milestone: null, closedMilestone: want.title };
}

export interface AskIssueFacts {
  kind: AskIssueKind;
  ask: TaskAsk;
  /** 原单。 */
  original: { issueNumber: number; title: string };
  placement: AskIssuePlacement;
}

/**
 * 另开的单的标题和正文（引擎开，写进公开的单：开之前 github 包过卫生检查）。正文照 pnpm issue:new 的样子：开头写起因
 * （原话）和怎么理解，后面「## 怎么算做完」。引擎不往主线直接写，开单时没法连需求文档一起建：正文里写明接手前先补一份。
 */
export function askIssueText(f: AskIssueFacts): { title: string; body: string } {
  const { ask, original } = f;
  const n = original.issueNumber;
  const rec = oneLine(ask.recommended ?? '');
  const options = ask.options.map((o) => {
    const t = oneLine(o);
    return t === rec ? `「${t}」（AI 推荐）` : `「${t}」`;
  });
  const question = ask.question.trim();
  const needDoc =
    '这张单是引擎对账时开的，还没有需求文档（引擎不往主线直接写）：接手前照这张单写一份 `specs/<本单号>-<短名>/需求.md` 合进主线，正文补上「文档：」那一行，引擎才接得了。';
  if (f.kind === 'follow-up') {
    const answer = oneLine(ask.answer ?? '');
    const where = f.placement.milestone
      ? `挂原单的同一个版本（${f.placement.milestone.title}）`
      : f.placement.closedMilestone
        ? `原单的版本「${f.placement.closedMilestone}」已经关了，先放未排期，等排版本`
        : '原单没挂版本，一样未排期';
    return {
      title: `#${n} 的后续：${clip(question.split('\n')[0] ?? question, 60)}改成「${clip(answer, 24)}」`,
      body: [
        `创始人在 #${n}（${clip(original.title, 80)}）的提问里改选了「${answer}」。`,
        '',
        `AI 理解：#${n} 做的时候问了他，他不在场，就按推荐先做了「${rec}」，已经合进主线；他之后选了「${answer}」，没来得及在那张单里照改，另开这张照他选的改（#259「问创始人不挡路」）。${where}。`,
        '',
        `**问**：${question}`,
        `**选项**：${options.join('、')}`,
        `**创始人选了**：「${answer}」`,
        '',
        '## 怎么算做完',
        '',
        `- #${n} 里按推荐先做的「${rec}」改成创始人选的「${answer}」，受影响的地方和测试跟着改`,
        '- CI 绿，合进主线',
        '',
        needDoc,
      ].join('\n'),
    };
  }
  return {
    title: `#${n} 问到的、超出范围的：${clip(question.split('\n')[0] ?? question, 80)}`,
    body: [
      `#${n}（${clip(original.title, 80)}）做的时候问到的，超出那张单的范围。`,
      '',
      `AI 理解：那张单绕开这一块接着做，这一块另开这张单等创始人拍（#259「问创始人不挡路」）；先放未排期，他拍了再排版本。他的回答（在 #${n} 的提问卡片上点的）会记在这张单的评论里。`,
      '',
      `**问**：${question}`,
      `**选项**：${options.join('、')}`,
      '',
      '## 怎么算做完',
      '',
      `- 创始人拍了选哪个（#${n} 的提问卡片上点，或者在这张单上说），照他拍的把这一块做完`,
      '- CI 绿，合进主线',
      '',
      needDoc,
    ].join('\n'),
  };
}

/** 超出范围的那张单上记他的回答（对账写，一条提问一条评论）。 */
export function outsideAnswerComment(a: TaskAsk, originalIssue: number): string {
  const answer = oneLine(a.answer ?? '');
  const same = a.recommended !== undefined && answer === oneLine(a.recommended);
  return `创始人在 #${originalIssue} 的提问卡片上选了「${answer}」${same ? '（就是 AI 推荐的）' : ''}：这一块照它做。`;
}
