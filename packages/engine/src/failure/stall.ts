// 停滞判断：按「有没有进展」判，不按报错长什么样判（设计第六节「按进展判死活」、第八节「沉默就催」）。纯函数：时刻由调用方给。
// 结论是「在等 / 在绕圈 / 死了」之一，没停滞就是 progressing；过程记录没读成就是 unscanned（没查成），不当成没动静。
// 每个结论带规则编号和依据。拿不准的（有动静、没推进、又看不出在重复）出一道 Jev 题（停滞预判）；
// Jev 只能把它判成停滞，不能把停滞判回正常。

import { type JevQuestion, type JevReply, readJevReply } from './jev.ts';
import { type Bound, count, fraction, positive, resolvePolicy } from './policy.ts';
import { duration, excerpt, parseTime } from './scan.ts';

export type StallKind = 'waiting' | 'looping' | 'dead';
export type StallChoice = StallKind | 'unclear';

export interface StallToolCall {
  /** 执行体里的工具原名：Bash、Read、Edit…… */
  name: string;
  /** 命令原文、文件路径、搜索词（插头进度事件里的 summary）。 */
  summary: string;
  /** 插头给的归类：read、edit、run……；edit 之间的重复不算绕圈。 */
  action?: string;
  ok?: boolean;
}

export interface StallFacts {
  now: string;
  /** 会话开始干活的时刻。 */
  startedAt: string;
  /**
   * 过程记录最后一条新事件（说话、工具、重试帧……任何一条）。null = 读到了，但还没有事件；
   * 不给 = 过程记录没读成，结论是 unscanned（没查成）——不能当成「一直没动静」把正在干活的会话判死。
   */
  lastEventAt?: string | null;
  /** 步骤清单最后一次推进（有一步变成进行中或完成）；执行体不报步骤清单就不给。 */
  lastStepAt?: string;
  /** 最后一次有新提交。 */
  lastCommitAt?: string;
  /** 最后一次改文件。只在没有步骤清单时算推进：有步骤清单时，改来改去不推进步骤不算。 */
  lastFileChangeAt?: string;
  /** false = 进程已经退了；不给 = 没查成（不当成死了）。 */
  processAlive?: boolean;
  /** 还没结束的工具调用。 */
  toolsInFlight?: readonly { name: string; since: string }[];
  /** 会话自己在等的东西：等人回答（fleet ask）、等权限批准、等上游（重试帧、重连）。 */
  waiting?: { on: 'human' | 'permission' | 'upstream'; since: string; detail?: string };
  /** 最近的工具调用，老的在前。 */
  recentTools?: readonly StallToolCall[];
  transcriptTail?: readonly string[];
  /** 问过 Jev 才有。 */
  jev?: JevReply<StallChoice>;
}

export interface StallPolicy {
  /** 没有工具在跑、过程记录这么久没新事件 → 死了。windsurf-dao#1499：384 个健康会话单次模型调用 p95 140–229 秒、最长 320 秒。 */
  silentSeconds: number;
  /** 一个工具跑这么久还没完 → 死了（Claude 插头给 Bash 的最长超时是 30 分钟）。 */
  toolMaxSeconds: number;
  /** 等权限批准这么久 → 死了：无头会话没人会批（旧系统一次会话停在权限请求上，2 分钟后被取消，只记了 failed）。 */
  permissionWaitMaxSeconds: number;
  /** 上游一直重试、重连这么久 → 死了（codex 连不上时一直打 Reconnecting，自己不退）。起步值，待实测。 */
  upstreamWaitMaxSeconds: number;
  /** 有动静但这么久没推进，开始看是不是在绕圈。起步值，旧系统没有这个数。 */
  noProgressSeconds: number;
  /** 同一个动作（中间没改文件）做了几次算绕圈。起步值。 */
  repeatThreshold: number;
  /** 拿不准的区间上限：有动静但这么久没推进，Jev 不在也判绕圈。起步值。 */
  giveUpSeconds: number;
  jevConfidenceFloor: number;
}

export const DEFAULT_STALL_POLICY: Readonly<StallPolicy> = Object.freeze({
  silentSeconds: 360,
  toolMaxSeconds: 1800,
  permissionWaitMaxSeconds: 360,
  upstreamWaitMaxSeconds: 600,
  noProgressSeconds: 900,
  repeatThreshold: 3,
  giveUpSeconds: 2700,
  jevConfidenceFloor: 0.7,
});

export interface StallVerdict {
  /** unscanned = 过程记录没读成，判不了（没查成），调用方别据此重开会话。 */
  state: 'progressing' | StallKind | 'unscanned';
  /** state = waiting 时：在等什么。 */
  waitingOn?: 'human' | 'permission' | 'tool' | 'upstream';
  /** W* = 在等，L* = 在绕圈，D* = 死了，G* = 有进展或拿不准先不动，U1 = 没查成。 */
  rule: string;
  /** 依据，一句白话。 */
  basis: string;
  via: 'rule' | 'jev';
  /** 拿不准、又还没问过 Jev 时给。 */
  jevQuestion?: JevQuestion<StallChoice>;
}

export const STALL_OPTIONS: readonly StallChoice[] = ['waiting', 'looping', 'dead', 'unclear'];

const EDIT_TOOL = /^(?:edit|write|multiedit|notebookedit|search_replace|str_replace\w*|apply_patch)$/i;

/** 给了但认不出的时刻就抛错（调用方按「停滞没查成」处理）：读坏的时刻不能被当成「刚有动静」或「没有动静」。 */
export function judgeStall(facts: StallFacts, policyInput?: Partial<StallPolicy>): StallVerdict {
  const policy = resolveStallPolicy(policyInput);
  const now = mustTime(facts.now, 'now');
  mustTime(facts.startedAt, 'startedAt');
  for (const [name, value] of [
    ['lastEventAt', facts.lastEventAt],
    ['lastStepAt', facts.lastStepAt],
    ['lastCommitAt', facts.lastCommitAt],
    ['lastFileChangeAt', facts.lastFileChangeAt],
    ['waiting.since', facts.waiting?.since],
    ...(facts.toolsInFlight ?? []).map((t, i) => [`toolsInFlight[${i}].since`, t.since] as const),
  ] as const) {
    if (value !== undefined && value !== null) mustTime(value, name);
  }
  /** 多少秒前；没有这个时刻（null / 不给）回 undefined。 */
  const ago = (iso: string | null | undefined) => {
    const t = parseTime(iso ?? undefined);
    return t === undefined ? undefined : Math.max(0, (now - t) / 1000);
  };
  const since = (iso: string) => ago(iso) ?? 0;

  if (facts.processAlive === false) {
    return dead('D1', '进程已经退了，没交代结果');
  }
  const waiting = facts.waiting;
  if (waiting?.on === 'human') {
    return {
      state: 'waiting',
      waitingOn: 'human',
      rule: 'W1',
      basis: `在等人回答${waiting.detail ? `：${excerpt(waiting.detail)}` : ''}（已等 ${duration(since(waiting.since))}）`,
      via: 'rule',
    };
  }
  if (waiting?.on === 'permission') {
    const waited = since(waiting.since);
    if (waited >= policy.permissionWaitMaxSeconds) {
      return dead('D2', `等权限批准 ${duration(waited)} 了，无头会话没人会批`);
    }
    return waitingOn('permission', 'W2', `在等权限批准（${duration(waited)}）`);
  }
  const tools = facts.toolsInFlight ?? [];
  if (tools.length > 0) {
    const longest = tools.reduce((a, b) => (since(a.since) >= since(b.since) ? a : b));
    const ran = since(longest.since);
    if (ran >= policy.toolMaxSeconds) {
      return dead(
        'D3',
        `工具 ${longest.name} 跑了 ${duration(ran)}，超过上限 ${duration(policy.toolMaxSeconds)}`,
      );
    }
    return waitingOn('tool', 'W3', `工具 ${longest.name} 在跑（${duration(ran)}），跑测试时不出字是正常的`);
  }
  if (waiting?.on === 'upstream') {
    const waited = since(waiting.since);
    const what = waiting.detail ? `：${excerpt(waiting.detail)}` : '';
    if (waited >= policy.upstreamWaitMaxSeconds) {
      return dead('D4', `上游一直重试、连不上，已经 ${duration(waited)}${what}`);
    }
    return waitingOn('upstream', 'W4', `在等上游（${duration(waited)}）${what}`);
  }

  if (facts.lastEventAt === undefined) {
    return {
      state: 'unscanned',
      rule: 'U1',
      basis: '过程记录没读成，判不了有没有动静（没查成，不是没动静）',
      via: 'rule',
    };
  }
  // 沉默从最近的一个动静算起：新事件、步骤推进、新提交、改文件，哪个最近算哪个。
  const silent = Math.min(
    ...[facts.lastEventAt, facts.lastStepAt, facts.lastCommitAt, facts.lastFileChangeAt, facts.startedAt].map(
      (t) => ago(t) ?? Number.POSITIVE_INFINITY,
    ),
  );
  if (silent >= policy.silentSeconds) {
    return dead('D5', `${duration(silent)}没有任何动静（新事件、步骤、提交、改文件都没有），也没有工具在跑`);
  }

  const hasSteps = facts.lastStepAt !== undefined;
  const progressMarks = [facts.startedAt, facts.lastStepAt, facts.lastCommitAt];
  if (!hasSteps) progressMarks.push(facts.lastFileChangeAt);
  const stuck = Math.min(...progressMarks.map((t) => ago(t) ?? Number.POSITIVE_INFINITY));
  const what = hasSteps ? '步骤清单、提交都没动' : '提交、改文件都没动';
  if (stuck >= policy.noProgressSeconds) {
    const repeat = longestRepeat(facts.recentTools ?? []);
    if (repeat && repeat.count >= policy.repeatThreshold) {
      return {
        state: 'looping',
        rule: 'L1',
        basis: `${duration(stuck)}没推进，同一个动作做了 ${repeat.count} 次：${repeat.tool.name} ${excerpt(repeat.tool.summary, 40)}`,
        via: 'rule',
      };
    }
    if (stuck >= policy.giveUpSeconds) {
      return {
        state: 'looping',
        rule: 'L2',
        basis: `有动静，但 ${duration(stuck)}没推进（${what}）`,
        via: 'rule',
      };
    }
    const read = readJevReply(facts.jev, {
      options: STALL_OPTIONS,
      confidenceFloor: policy.jevConfidenceFloor,
    });
    if ('use' in read && (read.use === 'looping' || read.use === 'dead')) {
      return {
        state: read.use,
        rule: 'LJ',
        basis: `Jev 判${read.use === 'looping' ? '在绕圈' : '死了'}：有动静，但 ${duration(stuck)}没推进（${what}）`,
        via: 'jev',
      };
    }
    const why =
      facts.jev === undefined
        ? '可以问 Jev'
        : 'skip' in read
          ? read.skip
          : read.use === 'unclear'
            ? 'Jev 也看不出来'
            : `Jev 判「${read.use}」，不改结论（它只能判停滞，不能判正常）`;
    return {
      state: 'progressing',
      rule: 'G2',
      basis: `有动静，但 ${duration(stuck)}没推进（${what}），拿不准，先不动；${why}`,
      via: 'rule',
      ...(facts.jev === undefined ? { jevQuestion: stallQuestion(facts, stuck, silent, policy) } : {}),
    };
  }
  return {
    state: 'progressing',
    rule: 'G1',
    basis: `${duration(silent)}前还有动静，${duration(stuck)}前有推进`,
    via: 'rule',
  };
}

function mustTime(iso: string, name: string): number {
  const t = parseTime(iso);
  if (t === undefined) throw new Error(`停滞判不了：${name} 的时刻认不出（${String(iso)}）`);
  return t;
}

function dead(rule: string, basis: string): StallVerdict {
  return { state: 'dead', rule, basis, via: 'rule' };
}

function waitingOn(on: 'permission' | 'tool' | 'upstream', rule: string, basis: string): StallVerdict {
  return { state: 'waiting', waitingOn: on, rule, basis, via: 'rule' };
}

/** 中间没改文件的同一个动作（工具名 + 摘要）最多做了几次。改了文件就重新数：边改边跑测试是正常的修法。 */
export function longestRepeat(
  tools: readonly StallToolCall[],
): { tool: StallToolCall; count: number } | undefined {
  const counts = new Map<string, { tool: StallToolCall; count: number }>();
  let best: { tool: StallToolCall; count: number } | undefined;
  for (const tool of tools) {
    if (tool.action === 'edit' || EDIT_TOOL.test(tool.name)) {
      counts.clear();
      continue;
    }
    const key = `${tool.name}\u0000${tool.summary.replace(/\s+/g, ' ').trim()}`;
    const entry = counts.get(key) ?? { tool, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
    if (!best || entry.count > best.count) best = entry;
  }
  return best;
}

function stallQuestion(
  facts: StallFacts,
  stuckSeconds: number,
  silentSeconds: number,
  policy: StallPolicy,
): JevQuestion<StallChoice> {
  const lines = [
    `会话开始：${facts.startedAt}；现在：${facts.now}`,
    `${duration(stuckSeconds)}没推进；最近一次动静在 ${duration(silentSeconds)}前`,
    '最近的工具调用（老的在前）：',
    ...(facts.recentTools ?? []).map(
      (t) => `- ${t.name} ${t.summary}${t.ok === undefined ? '' : t.ok ? ' （成功）' : ' （失败）'}`,
    ),
    '最后几段过程记录：',
    ...(facts.transcriptTail?.length ? facts.transcriptTail : ['（没有）']),
  ];
  return {
    questionId: 'stall-predict',
    prompt:
      '一个写码会话有动静，但很久没有推进。只看下面的材料，判断它现在的状态；看不出就选 unclear，不要猜。',
    options: STALL_OPTIONS,
    hints: {
      waiting: '在等一件正常要等的事（长命令、上游、人），等下去会有结果',
      looping: '在绕圈：反复做同样的事、改了又改回去、同一个错误一直没解决',
      dead: '已经不会再有进展了（卡死、放弃、在等一件不会发生的事）',
      unclear: '看不出来',
    },
    sample: lines.join('\n'),
    confidenceFloor: policy.jevConfidenceFloor,
  };
}

const STALL_POLICY_BOUNDS: { readonly [K in keyof StallPolicy]: Bound } = {
  silentSeconds: positive,
  toolMaxSeconds: positive,
  permissionWaitMaxSeconds: positive,
  upstreamWaitMaxSeconds: positive,
  noProgressSeconds: positive,
  // 至少做两次才叫重复。
  repeatThreshold: count(2),
  giveUpSeconds: positive,
  jevConfidenceFloor: fraction,
};

/** 缺的取默认值，给了但不对的报错。 */
export function resolveStallPolicy(partial?: Partial<StallPolicy>): StallPolicy {
  return resolvePolicy('停滞判断策略', DEFAULT_STALL_POLICY, STALL_POLICY_BOUNDS, partial);
}
