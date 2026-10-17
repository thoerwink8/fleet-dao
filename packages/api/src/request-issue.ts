// 驾驶舱「提需求」开单的正文和端口（#2060，母单 #2047 第 B 片；方案 specs/2047-提需求/方案.md 第一节规则 1、2、3、5、第六节）。
// 改这里之前必须知道：
// - 正文由草稿拼：场景、原话、已知的模块、怎么算做完四节；四节齐不齐的检查是 @fleet-dao/conventions 的 checkIssueBody，
//   和 `pnpm issue:new` 同一个函数，这里不另写。驾驶舱开的单交给引擎（不传 local）：「怎么算做完」里要 diff 外证据的条目
//   （截图、线上、现场、审计……）照那个函数拒开（决定 0093）。
// - 「原话」一节由系统按时间把人发的消息（kind=human）逐条拼出来，每条带说话人、渠道、时间，正文一个字不改（只在每行前加「> 」做引用）；
//   指挥官、系统、引擎的话不进原话。AI 的归纳（草稿的「要什么」）另起一段，写明是 AI 写的（人改定的栏写明是人改的）。
//   openIssue 会把正文里的 @ 提醒和 HTML 注释记号中和掉（加不可见字符），那是写进 GitHub 那一步的安全处理，不是这里改字。
// - 末尾写提出人、拍板人、「来自驾驶舱 需求 N」和驾驶舱链接。引擎拉单时认提出人按「来自驾驶舱 需求 N」找到库里的开单记录
//   （packages/db 的 requesterForRequestIssue），不看 GitHub 上的作者（单是「引擎」机器人开的）。
// - 正文写进 GitHub 前过卫生检查：openIssue / commentIssue 自己会过（packages/github 的 assertPublishable），这里把它的拒绝翻成 409 + 原因。
import {
  checkIssueBody,
  HUMAN_DECISION_LABEL,
  isKindLabel,
  issueBodyTooLong,
  KIND_LABELS,
  resolveQueryAxes,
} from '@fleet-dao/conventions';
import { currentVersion } from '@fleet-dao/core';
import type { RequestChannel, RequestDraft, RequestDraftField } from '@fleet-dao/shared';

/** 开单要的外部能力（引擎机器人的 GitHub）。真实现在 main.ts 用 @fleet-dao/github 装配；测试换成假的。 */
export interface RequestIssuePort {
  /** 开一张单（幂等，按 key 认；同一个 key 以前开过回 created:false 和原来那张）。 */
  openIssue(input: {
    repo: { owner: string; name: string };
    key: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; url: string; created: boolean }>;
  /** 在一张单上留一条评论（幂等，按 key 认）。 */
  commentIssue(input: {
    repo: { owner: string; name: string };
    issueNumber: number;
    key: string;
    body: string;
  }): Promise<{ commentId: number; url: string; created: boolean }>;
  /** 单子此刻开没开着、关的原因。读不到抛错。 */
  readIssueState(input: {
    repo: { owner: string; name: string };
    issueNumber: number;
  }): Promise<{ state: 'open' | 'closed'; stateReason: string | null }>;
}

/**
 * 驾驶舱提需求开的单挂当前版本（#2683）：创始人开的进当前版本（docs/workflow.md「进度和单」），不落未排期——落了会被闲置清理关掉。
 * 当前版本＝还开着的 v<N> 里程碑（一周一版、到期自动收口，永远只开一个；万一不止一个取 N 最小的，和拉单排序同一份认法）。
 * 一个开着的 v<N> 都没有就不挂（未排期），读不到里程碑照抛：不拿「没读到」当「没有当前版本」。
 */
export async function currentMilestoneOf(
  readOpenMilestones: () => Promise<readonly { number: number; title: string }[]>,
): Promise<number | null> {
  return currentVersion(await readOpenMilestones())?.milestone.number ?? null;
}

export const ISSUES_NOT_HERE = '这台后端没接上 GitHub（开发环境，或机器人凭据没读到），开不了单';

/** 拼正文要的一条原话：说话人是登录会话里的用户（库里的 author），不是消息里写的字。 */
export interface QuotedMessage {
  authorName: string;
  channel: RequestChannel;
  at: Date;
  body: string;
}

export interface IssueBodyInput {
  seq: number;
  draft: RequestDraft;
  /** 人改过的栏：这些栏不写「AI 写的」。 */
  humanEdited: readonly RequestDraftField[];
  /** 人发的消息，已按时间排好（id 升序）。 */
  messages: readonly QuotedMessage[];
  requesterName: string;
  /** 拍板人；自己能拍板的发起人自己确定时是他自己。 */
  deciderName: string;
  /** 驾驶舱地址（config.publicUrl 的 origin，不带末尾斜杠）。 */
  cockpitUrl: string;
}

const CHANNEL_WORDS: Record<RequestChannel, string> = { web: '网页', mobile: '手机' };

/** 北京时间到分钟：「2026-10-14 09:30」。 */
export function stamp(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** 整段做成引用（每行前加「> 」，空行加「>」）：文字本身一个字不动，去掉前缀就是原样。 */
export function quote(text: string): string {
  return text
    .split('\n')
    .map((l) => (l === '' ? '>' : `> ${l}`))
    .join('\n');
}

/** 把 quote 的前缀去掉，还原成原文（测试和拼的人都用它核对「一字不改」）。 */
export function unquote(block: string): string {
  return block
    .split('\n')
    .map((l) => (l === '>' ? '' : l.replace(/^> /, '')))
    .join('\n');
}

export function composeIssueBody(input: IssueBodyInput): string {
  const { draft } = input;
  const out: string[] = [];
  const section = (title: string, body: string) => out.push(`## ${title}`, '', body.trim(), '');

  section('场景', draft.scene ?? '');

  const quotes = input.messages.map(
    (m) => `**${m.authorName}**（${CHANNEL_WORDS[m.channel]}，${stamp(m.at)}）：\n${quote(m.body)}`,
  );
  const parts = [quotes.join('\n\n')];
  if (draft.want?.trim()) {
    const byHuman = input.humanEdited.includes('want');
    parts.push(
      byHuman
        ? `**要什么**（草稿里这一栏是人改定的）：\n${draft.want.trim()}`
        : `**AI 归纳**（这一段是 AI 写的，不是原话）：\n${draft.want.trim()}`,
    );
  }
  section('原话', parts.filter(Boolean).join('\n\n'));

  section('已知的模块', draft.modules ?? '');
  if (draft.notDo?.trim()) section('不做什么', draft.notDo);
  if (draft.size?.trim()) section('规模建议', draft.size);
  section('怎么算做完', (draft.done ?? []).map((d) => `- ${d}`).join('\n'));

  // 单独一节：末尾的话不能并进「怎么算做完」（那一节写没写字是按小标题之间的内容判的）
  out.push(
    '## 来源',
    '',
    `提出人：${input.requesterName}`,
    `拍板人：${input.deciderName}`,
    `来自驾驶舱 需求 ${input.seq}：${input.cockpitUrl}/intake?r=${input.seq}`,
    '',
  );
  return out.join('\n');
}

export type OpenCheck =
  | { ok: true; title: string; body: string; labels: string[] }
  | { ok: false; why: string };

/** 开单前的全部检查：类别、四节、字数。不过回一句中文原因（页面原样显示），一次 GitHub 请求都没发。 */
export function checkOpening(input: IssueBodyInput): OpenCheck {
  const kind = input.draft.kind?.trim() || '需求';
  if (!isKindLabel(kind)) {
    return { ok: false, why: `类别「${kind}」认不出：只能是 ${KIND_LABELS.join('、')}，单没开。` };
  }
  const body = composeIssueBody(input);
  const checked = checkIssueBody(body);
  if (!checked.ok) return { ok: false, why: checked.why };
  const tooLong = issueBodyTooLong(body);
  if (tooLong) return { ok: false, why: tooLong };
  const axis = resolveQueryAxes([], input.draft.modules);
  if (axis.problems.length > 0)
    return {
      ok: false,
      why: `已知的模块中还需明确两轴（独立声明行：域: engine|api|mirasim；性质: bug|perf|process）：${axis.problems.join('；')}`,
    };
  const labels: string[] = [kind, ...axis.labels];
  // 草稿里「要不要人拍」有内容（碰发布、花钱、删数据、改标准）：贴「要人拍」，引擎不自己拉
  if (input.draft.needsHuman?.trim()) labels.push(HUMAN_DECISION_LABEL);
  return { ok: true, title: input.draft.title, body, labels };
}

/** 一张单在 seqsForIssues 结果里的键：`owner/name#号`，仓名小写（GitHub 上大小写不算差别）。 */
export const issueKey = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`;

/** 幂等键：需求号 + 草稿版本号。 */
export const openingKey = (seq: number, draftVersion: number): string => `request:${seq}:v${draftVersion}`;

/** 引擎提问绑定的评论网址里取评论号；认不出回 null。 */
export function commentIdOf(ref: string): number | null {
  const m = /#issuecomment-(\d+)$/.exec(ref);
  return m?.[1] ? Number(m[1]) : null;
}

/** 评论网址里取 仓、单号；认不出回 null。 */
export function issueOfCommentRef(
  ref: string,
): { repo: { owner: string; name: string }; issueNumber: number } | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)#issuecomment-\d+$/.exec(ref);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { repo: { owner: m[1], name: m[2] }, issueNumber: Number(m[3]) };
}
