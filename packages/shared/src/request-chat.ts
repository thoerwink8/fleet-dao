// 驾驶舱「提需求」的指挥官会话的判法（#2061，母单 #2047 第 C 片；方案 specs/2047-提需求/方案.md 第四、五节）。
// 后端（packages/api 的 request-chat-pg.ts）判该不该排一轮、能不能排；引擎（packages/engine 的 jobs/intake-chat.ts）
// 认会话交回来的话、分草稿补丁。判法只有这一份。
// 改这里之前必须知道：
// - 会话交回话正文、一份草稿补丁，到了给方案的轮次再加一张方案卡。补丁只能改 REQUEST_DRAFT_FIELDS 那几栏；
//   碰到人改过的栏不改，转成「建议改」。方案卡的草稿版本号由写回时按落库后的版本填。
// - 出方案之前一次只问一个问题，带 2～4 个选项（页面另加「我自己说」）。人说满 INTAKE_PROPOSAL_AFTER_TURNS 次之后
//   必须给方案卡，不再追问；不合规矩的回话明说认不出，不拿半截当回话。每条最多 maxTurns 轮的硬上限不动。
// - 只有一个人说过话时每句都回；两个人都说过话以后，只在 @指挥官 或有人点「让指挥官接着问」时才说话。
// - 限额是软闸、能调（INTAKE_CHAT_LIMITS 是默认值）；超了、引擎关着、额度熔断都回「指挥官暂停了：原因」，人话照存。
import { z } from 'zod';
import {
  REQUEST_DRAFT_FIELDS,
  REQUEST_KINDS,
  REQUEST_PROPOSAL_SUMMARY_MAX,
  REQUEST_QUESTION_MAX_OPTIONS,
  REQUEST_QUESTION_MIN_OPTIONS,
  type RequestCard,
  type RequestDraftField,
  RequestDraftSchema,
} from './web-api/requests.ts';

/**
 * 人说满这么多次之后，这一轮必须给出方案卡，不再逐条追问。
 * 这是提示词里的节点，不是硬上限：每条最多几轮仍是 INTAKE_CHAT_LIMITS.maxTurns。
 */
export const INTAKE_PROPOSAL_AFTER_TURNS = 3;

/** 限额：每人同时最多几条在聊、每条最多几轮、闲置多久收掉会话（分钟）。 */
export interface IntakeChatLimits {
  maxActivePerUser: number;
  maxTurns: number;
  idleMinutes: number;
}

export const INTAKE_CHAT_LIMITS: IntakeChatLimits = { maxActivePerUser: 3, maxTurns: 40, idleMinutes: 30 };

/** 调限额的环境变量（后端和引擎读同一份）：不设用默认值；设了认不出（不是正整数）就抛，不悄悄用默认。 */
export const INTAKE_CHAT_LIMIT_ENV = {
  maxActivePerUser: 'FLEET_INTAKE_CHAT_MAX_ACTIVE',
  maxTurns: 'FLEET_INTAKE_CHAT_MAX_TURNS',
  idleMinutes: 'FLEET_INTAKE_CHAT_IDLE_MINUTES',
} as const satisfies Record<keyof IntakeChatLimits, string>;

export function intakeChatLimitsFrom(env: Readonly<Record<string, string | undefined>>): IntakeChatLimits {
  const out = { ...INTAKE_CHAT_LIMITS };
  for (const key of Object.keys(INTAKE_CHAT_LIMIT_ENV) as (keyof IntakeChatLimits)[]) {
    const name = INTAKE_CHAT_LIMIT_ENV[key];
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') continue;
    if (!/^[1-9]\d{0,5}$/.test(raw)) throw new Error(`${name} 要是正整数：${raw}`);
    out[key] = Number(raw);
  }
  return out;
}

/** 选路用途：「提需求」。 */
export const INTAKE_CHAT_PURPOSE = 'intake-chat' as const;

/** 暂停原因的开头：页面原样显示。 */
export const COMMANDER_PAUSED_PREFIX = '指挥官暂停了：';

export function pausedWhy(why: string): string {
  return why.startsWith(COMMANDER_PAUSED_PREFIX) ? why : `${COMMANDER_PAUSED_PREFIX}${why}`;
}

/** 正文里写「@指挥官」算 @ 了它。 */
export function mentionsCommander(body: string): boolean {
  return /@指挥官/.test(body);
}

/**
 * 指挥官该不该接这句。humanSpeakerIds：这条需求里说过话的人（含刚说这句的人），去重前后都行。
 * nudge：有人点了「让指挥官接着问」。
 */
export function commanderShouldReply(input: {
  humanSpeakerIds: readonly string[];
  mentioned: boolean;
  nudge: boolean;
}): { reply: boolean; why: string } {
  if (input.nudge) return { reply: true, why: '有人点了「让指挥官接着问」' };
  const speakers = new Set(input.humanSpeakerIds).size;
  if (speakers <= 1) return { reply: true, why: '只有一个人在聊：每句都回' };
  if (input.mentioned) return { reply: true, why: '被 @指挥官' };
  return { reply: false, why: '两个人都说过话了：没 @指挥官，也没人点「让指挥官接着问」' };
}

export type CommanderTurnVerdict = { ok: true } | { ok: false; code: CommanderRefusal; why: string };
export type CommanderRefusal = 'busy' | 'turns' | 'active' | 'engine_off' | 'no_model';

/**
 * 能不能排一轮（回话或挑错）：会话已经在跑、这条聊满了轮数、这个人同时在聊的满了、引擎总开关关着（额度熔断也是关着）、
 * 「提需求」用途没配模型。不能时 why 以「指挥官暂停了：」开头。
 */
export function judgeCommanderTurn(input: {
  busy: boolean;
  turns: number;
  /** 这个人另外几条需求的指挥官会话还活着（排着、在跑、或会话没收掉）。 */
  otherActive: number;
  /** 这一条的会话已经活着：它不占新的名额。 */
  thisActive: boolean;
  engine: { on: true } | { on: false; why: string };
  modelsConfigured: boolean;
  limits: IntakeChatLimits;
}): CommanderTurnVerdict {
  const refuse = (code: CommanderRefusal, why: string): CommanderTurnVerdict => ({
    ok: false,
    code,
    why: pausedWhy(why),
  });
  if (input.busy) return refuse('busy', '它还在回上一句，等它说完再叫');
  if (!input.engine.on) {
    return refuse(
      'engine_off',
      `引擎总开关关着（${input.engine.why}），起不了指挥官：主页打开总开关后再发一句`,
    );
  }
  if (!input.modelsConfigured) {
    return refuse('no_model', '「提需求」用途（intake-chat）没配模型：请创始人在路由页给它配上');
  }
  if (input.turns >= input.limits.maxTurns) {
    return refuse(
      'turns',
      `这条已经聊了 ${input.turns} 轮，到了每条 ${input.limits.maxTurns} 轮的上限：把草稿定下来，或「接着这条提」另开一条`,
    );
  }
  if (!input.thisActive && input.otherActive >= input.limits.maxActivePerUser) {
    return refuse(
      'active',
      `你已经有 ${input.otherActive} 条在和指挥官聊，同时最多 ${input.limits.maxActivePerUser} 条：先聊完或放下一条`,
    );
  }
  return { ok: true };
}

// —— 会话交回来的话 ——

/** 回话末尾给服务端看的那一块：```fleet-intake 加 JSON。 */
export const COMMANDER_BLOCK = 'fleet-intake';
/** 别家挑错交回来的那一块：```fleet-review 加 JSON。 */
export const REVIEW_BLOCK = 'fleet-review';

const QuestionSchema = z.object({
  text: z.string().trim().min(1).max(500),
  options: z
    .array(z.string().trim().min(1).max(200))
    .min(
      REQUEST_QUESTION_MIN_OPTIONS,
      `选项要 ${REQUEST_QUESTION_MIN_OPTIONS}～${REQUEST_QUESTION_MAX_OPTIONS} 个`,
    )
    .max(
      REQUEST_QUESTION_MAX_OPTIONS,
      `选项要 ${REQUEST_QUESTION_MIN_OPTIONS}～${REQUEST_QUESTION_MAX_OPTIONS} 个`,
    ),
});

/** 回话块里的方案：完整草稿摘要。草稿版本号不在这里，写回时按落库后的版本填。 */
const ProposalInBlockSchema = z
  .object({
    summary: z.string().trim().min(1).max(REQUEST_PROPOSAL_SUMMARY_MAX),
  })
  .strict();

const CommanderBlockSchema = z
  .object({
    question: QuestionSchema.optional(),
    proposal: ProposalInBlockSchema.optional(),
    patch: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** 方案卡：完整草稿摘要，带写回后的草稿版本号。确认开单带这一版。 */
export const ProposalCardSchema = z.object({
  type: z.literal('proposal'),
  draftVersion: z.number().int().positive(),
  summary: z.string().trim().min(1).max(REQUEST_PROPOSAL_SUMMARY_MAX),
});
export type ProposalCard = z.infer<typeof ProposalCardSchema>;

export function proposalCard(
  draftVersion: number,
  summary: string,
): Extract<RequestCard, { type: 'proposal' }> {
  return { type: 'proposal', draftVersion, summary };
}

export interface CommanderProposal {
  summary: string;
}

export interface CommanderOutput {
  reply: string;
  question?: { text: string; options: string[] };
  /** 给了方案就不再同时留下问题。 */
  proposal?: CommanderProposal;
  patch?: Record<string, unknown>;
}

const blockPattern = (name: string) => new RegExp(`\`\`\`${name}\\s*\\n([\\s\\S]*?)\\n?\`\`\``, 'g');

/** 最后一块（会话可能在正文里举例）：回块里的 JSON 原文和块开头在正文里的位置；没有返回 null。 */
function lastBlock(text: string, name: string): { json: string; start: number } | null {
  let found: { json: string; start: number } | null = null;
  for (const m of text.matchAll(blockPattern(name))) found = { json: m[1] ?? '', start: m.index ?? 0 };
  return found;
}

function zodWhy(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '整块'}：${i.message}`).join('；');
}

/**
 * 认指挥官交回来的话：正文 + 末尾一块 ```fleet-intake（可以没有：只说话、不问、不改草稿）。
 * 正文空、块里不是 JSON、多了别的键、选项不是 2～4 个：明说认不出（ok: false），不拿半截当回话。
 */
export function parseCommanderOutput(
  text: string,
): { ok: true; value: CommanderOutput } | { ok: false; why: string } {
  const block = lastBlock(text, COMMANDER_BLOCK);
  const reply = (block ? text.slice(0, block.start) : text).trim();
  if (!reply) return { ok: false, why: '回话正文是空的' };
  if (!block) return { ok: true, value: { reply } };
  let raw: unknown;
  try {
    raw = JSON.parse(block.json);
  } catch (err) {
    return {
      ok: false,
      why: `${COMMANDER_BLOCK} 那一块不是 JSON：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = CommanderBlockSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, why: `${COMMANDER_BLOCK} 那一块不合规矩：${zodWhy(parsed.error)}` };
  // 方案和问题一起交：认方案，问题丢掉（到了给方案的轮次不再追问）
  const proposal = parsed.data.proposal;
  return {
    ok: true,
    value: {
      reply,
      ...(proposal ? { proposal } : parsed.data.question ? { question: parsed.data.question } : {}),
      ...(parsed.data.patch ? { patch: parsed.data.patch } : {}),
    },
  };
}

const ReviewBlockSchema = z
  .object({ items: z.array(z.string().trim().min(1).max(2000)).min(1).max(20) })
  .strict();

/** 认别家挑错交回来的意见：```fleet-review {"items": [...]}，一条都没有、不是 JSON 都明说认不出。 */
export function parseReviewOutput(text: string): { ok: true; items: string[] } | { ok: false; why: string } {
  const block = lastBlock(text, REVIEW_BLOCK);
  if (!block) return { ok: false, why: `没有 ${REVIEW_BLOCK} 那一块` };
  let raw: unknown;
  try {
    raw = JSON.parse(block.json);
  } catch (err) {
    return {
      ok: false,
      why: `${REVIEW_BLOCK} 那一块不是 JSON：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = ReviewBlockSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, why: `${REVIEW_BLOCK} 那一块不合规矩：${zodWhy(parsed.error)}` };
  return { ok: true, items: parsed.data.items };
}

/** 流给页面看的那段：去掉末尾给服务端看的块（写到一半的也去掉）。 */
export function visibleCommanderText(text: string): string {
  const at = text.indexOf(`\`\`\`${COMMANDER_BLOCK}`);
  return (at >= 0 ? text.slice(0, at) : text).trim();
}

// —— 草稿补丁 ——

export interface CommanderPatchSplit {
  /** 直接改进草稿的栏。 */
  apply: Partial<Record<RequestDraftField, unknown>>;
  /** 人改过的栏：不改，转成「建议改」。 */
  suggest: { field: RequestDraftField; value: unknown }[];
  /** 服务端拒掉的：不在能改的那几栏里、值不合规矩。 */
  rejected: { field: string; why: string }[];
}

const FIELD_SET: ReadonlySet<string> = new Set(REQUEST_DRAFT_FIELDS);

/**
 * 文字栏（除了「怎么算做完」都是一段文字）收到字符串数组时，拼成每行「- 」开头的一段：
 * 模型列「已知的模块」「不做什么」很自然地写成数组，法国点验时两轮都因此整栏被拒（#2047）。别的形状照旧按约定验。
 */
function listAsText(field: RequestDraftField, value: unknown): unknown {
  if (field === 'done' || !Array.isArray(value)) return value;
  if (!value.every((x): x is string => typeof x === 'string')) return value;
  const items = value.map((x) => x.trim()).filter((x) => x.length > 0);
  if (items.length === 0) return undefined;
  return items.length === 1 ? items[0] : items.map((x) => `- ${x}`).join('\n');
}

/**
 * 分指挥官的草稿补丁：只认 REQUEST_DRAFT_FIELDS 那几栏（原话、状态、拍板人这些都不在里面）；值按草稿的约定验；
 * 人改过的栏一律不改，转成「建议改」。
 */
export function splitCommanderPatch(
  patch: Record<string, unknown>,
  humanEdited: readonly RequestDraftField[],
): CommanderPatchSplit {
  const out: CommanderPatchSplit = { apply: {}, suggest: [], rejected: [] };
  const edited = new Set<string>(humanEdited);
  for (const [field, value] of Object.entries(patch)) {
    if (!FIELD_SET.has(field)) {
      out.rejected.push({ field, why: '不在指挥官能改的栏里' });
      continue;
    }
    const f = field as RequestDraftField;
    const checked = RequestDraftSchema.shape[f].safeParse(listAsText(f, value));
    if (
      f === 'kind' &&
      checked.success &&
      typeof checked.data === 'string' &&
      !(REQUEST_KINDS as readonly string[]).includes(checked.data)
    ) {
      out.rejected.push({ field, why: `类别只能是${REQUEST_KINDS.join('、')}` });
      continue;
    }
    if (!checked.success || checked.data === undefined) {
      out.rejected.push({ field, why: checked.success ? '值是空的' : zodWhy(checked.error) });
      continue;
    }
    if (edited.has(f)) out.suggest.push({ field: f, value: checked.data });
    else out.apply[f] = checked.data;
  }
  return out;
}

/** 栏的中文名（芯片「改了单子：……」、建议改卡用）。 */
export const REQUEST_DRAFT_FIELD_WORDS: Record<RequestDraftField, string> = {
  title: '标题',
  kind: '类别',
  scene: '场景',
  modules: '已知的模块',
  want: '要什么',
  done: '怎么算做完',
  notDo: '不做什么',
  size: '规模建议',
  needsHuman: '要不要人拍',
};
