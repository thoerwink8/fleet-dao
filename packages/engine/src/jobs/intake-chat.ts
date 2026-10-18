// 驾驶舱「提需求」的指挥官会话（#2061，母单 #2047 第 C 片；方案 specs/2047-提需求/方案.md 第四、五节）：引擎这头的一轮。
// 后端排一轮（request_chats.state = queued），这里每两秒看一眼：接手 → 起会话或续会话 → 边跑边写写到哪了（后端的 SSE 照它推）
// → 认会话交回来的话 → 写回话和草稿补丁；没接上写「指挥官暂停了：原因」。另外收掉闲置 30 分钟的会话、删检出。
// 真装配（选路、检出、Spawner、一次性会话登记）在 real/intake-chat.ts。
// 改这里之前必须知道：
// - 会话交回话正文、一份草稿补丁，到了给方案的轮次再加一张方案卡（shared 的 parseCommanderOutput 认）。补丁在写回的事务里
//   按「人改过的栏」分（db 的 finishCommanderReply），方案卡的草稿版本号也在那里按落库后的版本填。认不出的回话明说，不拿半截当回话。
// - 续会话（--resume）只喂上一轮之后的新消息；会话没了（检出删了、换了模型、换了路由）就按存下来的消息和草稿重起，整份喂。
// - 停下有三种：人点停下（不算暂停）、切号或发布排空（算暂停，写原因）、超时或会话没成（算暂停）。
// - 起会话那一下抛了、没选到路由：这一轮写暂停原因、会话回 idle，不卡在 running。
import { StopReason } from '@fleet-dao/adapters';
import type { ChatSessionAfter, ClaimedRequestChat } from '@fleet-dao/db';
import {
  COMMANDER_BLOCK,
  INTAKE_CHAT_LIMITS,
  INTAKE_PROPOSAL_AFTER_TURNS,
  type IntakeChatLimits,
  parseCommanderOutput,
  parseReviewOutput,
  REQUEST_DRAFT_FIELD_WORDS,
  REQUEST_KINDS,
  REQUEST_QUESTION_MAX_OPTIONS,
  REQUEST_QUESTION_MIN_OPTIONS,
  REVIEW_BLOCK,
  type RequestChatPhase,
  visibleCommanderText,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';

/** 每几秒看一眼有没有排着的。 */
export const INTAKE_CHAT_POLL_MS = 2_000;
/** 一轮最长多久（分钟）：到点停下、写暂停原因。 */
export const INTAKE_CHAT_TURN_MINUTES = 15;
/** 同时最多接几轮（不同需求）。 */
export const INTAKE_CHAT_MAX_CONCURRENT = 4;
/** 会话一阵子没出声时，每隔多久看一眼有没有人点停下。 */
export const INTAKE_CHAT_STOP_CHECK_MS = 2_000;

/** 交给真装配的一次会话。 */
export interface IntakeSessionInput {
  kind: 'reply' | 'review';
  requestId: string;
  seq: number;
  repo: ClaimedRequestChat['repo'];
  /** 续会话用的那份（只有新消息）和重起用的那份（整份存档）：续不成（路由换了、检出没了）真装配改用 fresh。 */
  prompt: { resume: string | null; fresh: string };
  /** 活着的会话：给了就先试着续。 */
  resume: { sessionId: string; routeId: string; workdir: string } | null;
  /** 这条需求选的模型；null = 按「提需求」用途的顺序。 */
  modelId: string | null;
  /** 挑错要避开的模型族（别家：指挥官那一族不挑自己的）。 */
  avoidModelIds: string[];
  timeoutMinutes: number;
  signal: AbortSignal;
  onProgress: (p: { phase: RequestChatPhase; text: string }) => void;
}

export type IntakeSessionOutcome =
  | {
      ok: true;
      text: string;
      /** 会话活下来的样子（挑错是一次性的，全空）。 */
      session: ChatSessionAfter;
      /** 实际回话的模型（记在意见卡上）。 */
      modelId: string;
    }
  | {
      ok: false;
      why: string;
      /** 是有人点了停下（不算暂停）。 */
      stoppedByHuman?: boolean;
      /** 失败后会话还剩什么：检出删了就全空，下次按存档重起。 */
      session: ChatSessionAfter;
    };

export interface IntakeChatDeps {
  claim(): Promise<ClaimedRequestChat | null>;
  progress(requestId: string, p: { phase: RequestChatPhase; text: string }): Promise<{ stop: boolean }>;
  stopRequested(requestId: string): Promise<boolean>;
  runSession(input: IntakeSessionInput): Promise<IntakeSessionOutcome>;
  finishReply(input: {
    requestId: string;
    reply: string;
    question?: { text: string; options: string[] };
    proposal?: { summary: string };
    patch?: Record<string, unknown>;
    session: ChatSessionAfter;
  }): Promise<void>;
  finishReview(input: {
    requestId: string;
    draftVersion: number;
    model: string;
    items: string[];
  }): Promise<void>;
  fail(input: {
    requestId: string;
    why: string;
    stoppedByHuman?: boolean;
    session: ChatSessionAfter;
  }): Promise<void>;
  /** 闲置收会话：该收的那几条、删检出、清掉会话。 */
  idle(cutoff: Date): Promise<{ requestId: string; workdir: string }[]>;
  removeDir(dir: string): Promise<void>;
  forget(input: { requestId: string; workdir: string }): Promise<boolean>;
  /** 引擎起来时：上一个进程卡在 running 的收掉。 */
  recover(): Promise<number>;
  limits?: IntakeChatLimits;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

const EMPTY_SESSION: ChatSessionAfter = { sessionId: null, routeId: null, modelId: null, workdir: null };

// —— 提示词 ——

const KIND_WORDS: Record<string, string> = {
  human: '人',
  commander: '指挥官',
  system: '系统',
  engine_ask: '引擎提问',
  review: '别家挑错',
};

function line(m: ClaimedRequestChat['messages'][number]): string {
  const who = m.kind === 'human' ? `${m.authorName ?? '某人'}（人）` : (KIND_WORDS[m.kind] ?? m.kind);
  const card =
    m.card?.type === 'question'
      ? `\n  （问题：${m.card.question}；选项：${m.card.options.join(' / ')}；或者「我自己说」）`
      : m.card?.type === 'proposal'
        ? `\n  （方案卡：草稿第 ${m.card.draftVersion} 版）\n  ${m.card.summary}`
        : m.card?.type === 'review'
          ? `\n${m.card.items.map((i, n) => `  ${n + 1}. ${i.text}（${i.verdict === 'adopt' ? '采用' : i.verdict === 'reject' ? '不用' : '还没标'}）`).join('\n')}`
          : '';
  return `[${m.createdAt.toISOString()}] ${who}：${m.body}${card}`;
}

function draftBlock(c: ClaimedRequestChat): string {
  const edited = c.humanEdited.length
    ? c.humanEdited.map((f) => `${REQUEST_DRAFT_FIELD_WORDS[f]}（${f}）`).join('、')
    : '没有';
  return [
    `## 草稿（第 ${c.draftVersion} 版）`,
    '```json',
    JSON.stringify(c.draft, null, 2),
    '```',
    `## 人改过的栏（你别直接改；要改照样写进 patch，服务端会转成「建议改」给人看）`,
    edited,
  ].join('\n');
}

const OUTPUT_RULES = [
  '## 交回格式',
  '先写给人看的回话（中文，短句）。最后附一块（可以不附：只说话、不问、不改草稿、不给方案）：',
  `\`\`\`${COMMANDER_BLOCK}`,
  '{"question": {"text": "一个问题", "options": ["选项一", "选项二"]}, "patch": {"scene": "……"}}',
  '```',
  '到了给方案的轮次，不要写 question，改成 proposal：',
  `\`\`\`${COMMANDER_BLOCK}`,
  '{"proposal": {"summary": "标题：…\\n类别：…\\n场景：…\\n已知的模块：…\\n要什么：…\\n怎么算做完：…\\n不做什么：…\\n规模建议：…\\n要不要人拍：…"}, "patch": {"scene": "……"}}',
  '```',
  `- question：出方案之前一次只问一个问题，选项 ${REQUEST_QUESTION_MIN_OPTIONS}～${REQUEST_QUESTION_MAX_OPTIONS} 个；页面另加「我自己说」，你不用写。到了给方案的轮次不要再追问，不要写 question。`,
  '- proposal.summary：完整草稿摘要，上面九栏都写上；没填的写「还没写」。页面会画出「确认开单」和每一栏的「改」。草稿版本号由服务端按写回后的版本填，你别写。',
  '- 每一轮都先把能从代码和已有对话里推出来的草稿栏写进 patch，能填的都填上。',
  `- 过了给方案的节点（第 ${INTAKE_PROPOSAL_AFTER_TURNS} 次发言之后），创始人又提了新信息：下一轮直接给更新后的 proposal，把新信息写进 patch，不回到逐条提问。`,
  '- patch 只能有这些键：title、kind、scene、modules、want、done（字符串数组，每条是一条看得见的验收）、notDo、size、needsHuman（碰发布、花钱、删数据、改标准时写为什么要人拍）。',
  '- modules 除模块路径外，必须独立两行写出查询分类「域: engine|api|mirasim」「性质: bug|perf|process」（各选一个值，不写竖线列表）。按实际范围和工作性质判断，不从 kind 自动映射；无法确定时继续澄清，不交开单方案。现有草稿缺这两行时先补 patch，后端缺分类会拒开。',
  `- kind 只能是 ${REQUEST_KINDS.join('、')} 之一（文档、重构这类都算「杂项」）。`,
  '- 除了 done，别的键的值都是一段字符串；要列几条就写成一段多行文字（每行「- 」开头），别写成数组。',
  '- 回话里说「改了哪几栏」只说 patch 里真有的栏。',
  '- 原话由系统按时间拼，你碰不到、也不要往草稿里写原话。',
].join('\n');

/** 人说过几次：第几次发言之后，由提示词要求给方案。指挥官自己的回话不算。 */
function humanTurns(c: ClaimedRequestChat): number {
  return c.messages.filter((m) => m.kind === 'human').length;
}

/** 提示词里写明当前是第几次发言之后；到了阈值必须给方案，不再追问。 */
function roundBlock(c: ClaimedRequestChat): string {
  const n = humanTurns(c);
  const head = `## 这一轮\n当前是第 ${n} 次发言之后（人已经说了 ${n} 次；方案从第 ${INTAKE_PROPOSAL_AFTER_TURNS} 次发言之后给出）。`;
  if (n >= INTAKE_PROPOSAL_AFTER_TURNS) {
    return [
      head,
      '已经到了给方案的时候：这一轮必须输出一张 proposal 卡，summary 写完整草稿摘要。不要再追问，不要写 question。页面会给出「确认开单」和「改某一栏」。',
      '创始人要是又提了新信息：把新信息写进 patch，这一轮直接给更新后的 proposal，不回到逐条提问。',
    ].join('\n');
  }
  return [
    head,
    '还没到给方案的轮次：先把能从代码和已有对话里推出来的草稿栏写进 patch；缺的、代码里查不到的，一次只问一个问题。',
  ].join('\n');
}

/** 重起（第一次、或会话收掉了、换了模型）：整份存档喂进去。 */
export function freshCommanderPrompt(c: ClaimedRequestChat): string {
  return [
    `你是 fleet-dao 驾驶舱「提需求」里的指挥官，在帮人把口语需求聊清楚、写成仓 ${c.repo.owner}/${c.repo.name} 的一张单（需求 ${c.seq}）。`,
    '当前目录是这个仓主线的只读检出：可以读代码、跑只读命令（先读再问），不改文件、不提交、不推送。你手上没有 GitHub 令牌：开单、评论由引擎和后端做。',
    '规矩：每一轮先把能从代码和已有对话里推出来的草稿栏填上；问之前先看代码里已经有什么；能从代码里查到的别问人。出方案之前，一次只问一个问题。',
    roundBlock(c),
    draftBlock(c),
    '## 对话（按时间）',
    c.messages.map(line).join('\n') || '（还没有）',
    OUTPUT_RULES,
  ].join('\n\n');
}

/** 续会话：只喂上一轮之后的新消息和现在的草稿。没有新消息（有人点「让指挥官接着问」）就说还没给方案就给方案。 */
export function resumeCommanderPrompt(c: ClaimedRequestChat): string {
  const fresh = c.messages.filter((m) => c.lastMessageId === null || m.id > c.lastMessageId);
  return [
    '## 你上一轮回话之后的新消息',
    fresh.map(line).join('\n') || '（没有新消息：有人点了「让指挥官接着问」。还没给方案就给方案）',
    roundBlock(c),
    draftBlock(c),
    OUTPUT_RULES,
  ].join('\n\n');
}

/** 别家挑错：一次性会话，只挑草稿的错。 */
export function reviewPrompt(c: ClaimedRequestChat): string {
  return [
    `你是另一家模型，被请来给仓 ${c.repo.owner}/${c.repo.name} 的一张单草稿（需求 ${c.seq}）挑错。当前目录是主线的只读检出，可以读代码核对。`,
    '只挑错，不改草稿：场景说清没有、验收条是不是 diff 里看得见的、范围有没有写死、有没有碰发布、花钱、删数据、改标准却没写要人拍、和代码里已有的东西冲不冲突。',
    draftBlock(c),
    '## 对话（按时间）',
    c.messages.map(line).join('\n') || '（还没有）',
    '## 交回格式',
    `最后附一块（每条一句话，最多 20 条）：\n\`\`\`${REVIEW_BLOCK}\n{"items": ["……", "……"]}\n\`\`\``,
  ].join('\n\n');
}

// —— 一轮 ——

/** 接手的这一轮跑完：成没成都把会话放回 idle（写回话、意见卡或暂停原因），不抛。 */
export async function runIntakeChatTurn(deps: IntakeChatDeps, c: ClaimedRequestChat): Promise<void> {
  const stop = new AbortController();
  let humanStop = false;
  // 会话一阵子没出声也要看有没有人点停下
  const watch = setInterval(() => {
    deps
      .stopRequested(c.requestId)
      .then((s) => {
        if (s && !stop.signal.aborted) {
          humanStop = true;
          stop.abort(new StopReason('user-stop', '有人点了停下'));
        }
      })
      .catch((err: unknown) => deps.log('warn', '指挥官会话：停没停没查成', { error: errMessage(err) }));
  }, INTAKE_CHAT_STOP_CHECK_MS);
  // 写到哪了：写库排成一条链，按先后落；写不进只记日志
  let chain: Promise<unknown> = Promise.resolve();
  const onProgress = (p: { phase: RequestChatPhase; text: string }) => {
    chain = chain
      .then(() => deps.progress(c.requestId, p))
      .then((r) => {
        if (r.stop && !stop.signal.aborted) {
          humanStop = true;
          stop.abort(new StopReason('user-stop', '有人点了停下'));
        }
      })
      .catch((err: unknown) => deps.log('warn', '指挥官会话：写到哪了没写进去', { error: errMessage(err) }));
  };
  const alive =
    c.session.sessionId && c.session.routeId && c.session.workdir
      ? { sessionId: c.session.sessionId, routeId: c.session.routeId, workdir: c.session.workdir }
      : null;
  try {
    const review = c.job === 'review';
    const out = await deps.runSession({
      kind: c.job,
      requestId: c.requestId,
      seq: c.seq,
      repo: c.repo,
      prompt: review
        ? { resume: null, fresh: reviewPrompt(c) }
        : { resume: alive ? resumeCommanderPrompt(c) : null, fresh: freshCommanderPrompt(c) },
      resume: review ? null : alive,
      modelId: review ? null : c.modelChoice,
      // 别家：指挥官现在用的模型不挑自己的
      avoidModelIds: review ? [c.session.modelId ?? c.modelChoice].filter((m): m is string => !!m) : [],
      timeoutMinutes: INTAKE_CHAT_TURN_MINUTES,
      signal: stop.signal,
      onProgress,
    });
    await chain;
    if (!out.ok) {
      const stoppedByHuman = humanStop || out.stoppedByHuman === true;
      await deps.fail({
        requestId: c.requestId,
        why: stoppedByHuman ? '指挥官停下了（有人点了停下）' : out.why,
        stoppedByHuman,
        // 挑错是另起的一次性会话：指挥官的会话原样留着
        session: review ? { ...c.session } : out.session,
      });
      return;
    }
    if (review) {
      const got = parseReviewOutput(out.text);
      if (!got.ok) {
        await deps.fail({
          requestId: c.requestId,
          why: `别家的意见认不出：${got.why}`,
          session: { ...c.session },
        });
        return;
      }
      await deps.finishReview({
        requestId: c.requestId,
        draftVersion: c.draftVersion,
        model: out.modelId,
        items: got.items,
      });
      return;
    }
    const got = parseCommanderOutput(out.text);
    if (!got.ok) {
      // 会话本身没坏：留着下次接着续
      await deps.fail({
        requestId: c.requestId,
        why: `指挥官的回话认不出：${got.why}`,
        session: out.session,
      });
      return;
    }
    await deps.finishReply({
      requestId: c.requestId,
      reply: got.value.reply,
      ...(got.value.question ? { question: got.value.question } : {}),
      ...(got.value.proposal ? { proposal: got.value.proposal } : {}),
      ...(got.value.patch ? { patch: got.value.patch } : {}),
      session: out.session,
    });
  } catch (err) {
    deps.log('error', '指挥官会话：这一轮没跑成', { request: c.seq, error: errMessage(err) });
    await deps
      .fail({ requestId: c.requestId, why: `这一轮没跑成：${errMessage(err)}`, session: EMPTY_SESSION })
      .catch((e: unknown) => deps.log('error', '指挥官会话：暂停原因也没写进去', { error: errMessage(e) }));
  } finally {
    clearInterval(watch);
  }
}

/** 闲置 idleMinutes 分钟的会话收掉：删检出、清掉会话号（下次按存档重起）。删不掉的留着下一眼再删，不清会话。 */
export async function reapIdleIntakeChats(deps: IntakeChatDeps): Promise<number> {
  const limits = deps.limits ?? INTAKE_CHAT_LIMITS;
  const cutoff = new Date(deps.now().getTime() - limits.idleMinutes * 60_000);
  let reaped = 0;
  for (const row of await deps.idle(cutoff)) {
    try {
      await deps.removeDir(row.workdir);
    } catch (err) {
      deps.log('warn', '指挥官会话：闲置的检出没删掉，下一眼再删', {
        dir: row.workdir,
        error: errMessage(err),
      });
      continue;
    }
    if (await deps.forget(row)) reaped += 1;
  }
  return reaped;
}

/** 文字流：读代码时推「正在读代码……」，说话时推写到哪了（去掉给服务端看的那一块）。 */
export function progressOf(
  state: { text: string },
  entry: { kind: string; text: string },
): { phase: RequestChatPhase; text: string } | null {
  if (entry.kind === 'tool_call') return { phase: 'reading_code', text: visibleCommanderText(state.text) };
  if (entry.kind === 'assistant') {
    state.text = state.text ? `${state.text}\n\n${entry.text}` : entry.text;
    return { phase: 'writing', text: visibleCommanderText(state.text) };
  }
  return null;
}

export interface IntakeChatPoller {
  stop(): void;
}

/** 起来先收掉上一个进程卡住的；之后每 everyMs 看一眼：接手排着的（同时最多 maxConcurrent 轮）、收闲置的。 */
export function startIntakeChat(
  make: () => IntakeChatDeps,
  options: { everyMs?: number; maxConcurrent?: number } = {},
): IntakeChatPoller {
  const max = options.maxConcurrent ?? INTAKE_CHAT_MAX_CONCURRENT;
  const running = new Set<Promise<void>>();
  let ticking = false;
  let stopped = false;
  let recovered = false;
  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    const deps = make();
    try {
      if (!recovered) {
        const n = await deps.recover();
        recovered = true;
        if (n > 0) deps.log('warn', `指挥官会话：收掉了上一个引擎进程卡住的 ${n} 轮`);
      }
      while (!stopped && running.size < max) {
        const c = await deps.claim();
        if (!c) break;
        const p = runIntakeChatTurn(deps, c).finally(() => running.delete(p));
        running.add(p);
      }
      await reapIdleIntakeChats(deps);
    } catch (err) {
      deps.log('error', '指挥官会话：这一眼没看成', { error: errMessage(err) });
    } finally {
      ticking = false;
    }
  };
  const handle = setInterval(() => void tick(), options.everyMs ?? INTAKE_CHAT_POLL_MS);
  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}
