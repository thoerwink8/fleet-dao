// 路由探针的两种探测（#1798 片 5，方案 3.1）：连通只回 pong；身份题只给标了 identityCheck、活跃、题库有题的模型。
// 身份题问知识截止期附近的事实：说出新答案算通过；说出旧答案判「疑似换成旧模型」；认不出只记、照通。
// 题库按模型备 2–3 道、按天轮换。Claude 家族和 flash/haiku 档不备题（写进 NO_IDENTITY_QUESTION）。

import type { RouteProbeKind, RouteProbeTier } from '@fleet-dao/db';

export type { RouteProbeKind, RouteProbeTier };

export interface IdentityQuestion {
  id: string;
  /** 问模型的那句。 */
  text: string;
  /** 一眼看懂的短写（写进 probe_detail）。 */
  short: string;
  /** 新答案的几种写法（中英文名等）；对上任意一个算通过。 */
  newAnswers: readonly string[];
  /** 旧答案的几种写法；说中任意一个判疑似换成旧模型。 */
  oldAnswers: readonly string[];
  /** 这道题的事实什么时候变的（给人复查用）。 */
  changedAt: string;
}

/** 标了 identityCheck 的渠道下、开着却故意不备题的模型，以及理由。 */
export const NO_IDENTITY_QUESTION: Readonly<Record<string, string>> = {
  'sonnet-5.5': 'Claude 家族不备题（F1：厂家直连或一方订阅不问；中转上的 Claude 也不问）',
  'opus-5.5': 'Claude 家族不备题（F1）',
  'haiku-4.5': 'Claude 家族 / haiku 档不备题（F1：低级模型被换差别不大）',
  'haiku-5.5': 'Claude 家族 / haiku 档不备题（F1）',
  'deepseek-flash': 'flash 档不备题（F1：低级模型被换差别不大）',
  'glm-5.3-flash': 'flash 档不备题（F1）',
};

/** 日本现任首相（2025-10 高市早苗就任；旧答案含石破茂、岸田文雄）。 */
const JP_PM: IdentityQuestion = {
  id: 'jp-pm-takaichi',
  text: '现任日本首相是谁？答案只写人名。',
  short: '日本首相',
  newAnswers: ['高市早苗', '高市', 'Takaichi', 'Sanae Takaichi', 'Takaichi Sanae'],
  oldAnswers: ['石破茂', '石破', 'Ishiba', 'Shigeru Ishiba', '岸田文雄', '岸田', 'Kishida', 'Fumio Kishida'],
  changedAt: '2025-10',
};

/** 美国现任总统（2025-01 特朗普第二任期就任；旧答案拜登）。 */
const US_PRES: IdentityQuestion = {
  id: 'us-pres-trump47',
  text: '现任美国总统是谁？答案只写人名。',
  short: '美国总统',
  newAnswers: ['唐纳德·特朗普', '唐纳德·川普', '特朗普', '川普', 'Trump', 'Donald Trump', 'Donald J. Trump'],
  oldAnswers: ['乔·拜登', '拜登', 'Biden', 'Joe Biden', 'Joseph Biden', 'Joseph R. Biden'],
  changedAt: '2025-01',
};

/** 英国现任首相（2024-07 斯塔默就任；旧答案苏纳克）。 */
const UK_PM: IdentityQuestion = {
  id: 'uk-pm-starmer',
  text: '现任英国首相是谁？答案只写人名。',
  short: '英国首相',
  newAnswers: ['基尔·斯塔默', '斯塔默', 'Starmer', 'Keir Starmer'],
  oldAnswers: ['里希·苏纳克', '苏纳克', 'Sunak', 'Rishi Sunak'],
  changedAt: '2024-07',
};

const GPT_BANK: readonly IdentityQuestion[] = [JP_PM, US_PRES, UK_PM];

/**
 * 按模型编号的身份题库。只给中转上可能被偷换、又值得查的模型备题。
 * Claude / flash / haiku 不在这里（见 NO_IDENTITY_QUESTION）。
 */
export const IDENTITY_QUESTIONS: Readonly<Record<string, readonly IdentityQuestion[]>> = {
  'gpt-6-sol': GPT_BANK,
  'gpt-6-luna': GPT_BANK,
  'gpt-6-astra': GPT_BANK,
  'gpt-5.6-luna': GPT_BANK,
  'gpt-5.6-sol': GPT_BANK,
  'gpt-5.6-terra': GPT_BANK,
  'kimi-k3': [JP_PM, US_PRES],
  'deepseek-v4-pro': [JP_PM, US_PRES],
  'glm-5.3': [JP_PM, US_PRES],
};

export function hasIdentityQuestions(modelId: string): boolean {
  const bank = IDENTITY_QUESTIONS[modelId];
  return !!bank && bank.length > 0;
}

/**
 * 三种都满足才回 identity：渠道标了 identityCheck、档是活跃、题库里有这个模型的题。
 * 其余（含 Claude 走中转但没备题）一律 ping。
 */
export function probeKindFor(
  target: { identityCheck: boolean; modelId: string },
  tier: RouteProbeTier,
): RouteProbeKind {
  if (target.identityCheck && tier === 'active' && hasIdentityQuestions(target.modelId)) {
    return 'identity';
  }
  return 'ping';
}

/** 按天轮换（UTC 日序对题数取余）。同一天连着几次问同一道，答案前后能比。 */
export function pickIdentityQuestion(
  modelId: string,
  now: Date,
  bank: Readonly<Record<string, readonly IdentityQuestion[]>> = IDENTITY_QUESTIONS,
): IdentityQuestion | null {
  const questions = bank[modelId];
  if (!questions || questions.length === 0) return null;
  const day = Math.floor(now.getTime() / 86_400_000);
  return questions[((day % questions.length) + questions.length) % questions.length] as IdentityQuestion;
}

/** 连通探测：只要回一个词 pong。 */
export function pingPrompt(): string {
  return '这是连通性测试。不要调用任何工具，不要解释，只回一个词：pong';
}

/** 身份探测：第一行 pong，第二行答案，第三行自报身份。 */
export function identityPrompt(q: IdentityQuestion): string {
  return [
    '这是路由探针的身份测试。不要调用任何工具，不要解释，严格按下面三行回复，不要多写别的：',
    '第一行只写 pong',
    '第二行写「答案：」加上下面这道题的最终答案',
    '第三行写「模型：」加上你自报的厂家和型号',
    `题目：${q.text}`,
  ].join('\n');
}

export function probePromptFor(kind: RouteProbeKind, question: IdentityQuestion | null): string {
  if (kind === 'identity' && question) return identityPrompt(question);
  return pingPrompt();
}

export interface ProbeReply {
  /** 第一个非空行整行就是 pong（不分大小写）。 */
  pong: boolean;
  /** 「答案：」那一行冒号后面的原话，没有这一行是 null。 */
  answer: string | null;
  /** 「模型：」那一行冒号后面的原话，没有这一行是 null。 */
  identity: string | null;
}

/** 去掉 markdown 的粗体、反引号、代码块围栏，按行拆开（去空行）。 */
function cleanLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) => line.replace(/\*\*|__|`/g, '').trim())
    .filter((line) => line !== '');
}

export function parseProbeReply(text: string): ProbeReply {
  const lines = cleanLines(text);
  const labelled = (label: string): string | null => {
    for (const line of lines) {
      const m = new RegExp(`^${label}\\s*[:：]\\s*(.*)$`).exec(line);
      if (m) return (m[1] ?? '').trim();
    }
    return null;
  };
  return {
    pong: /^pong$/i.test(lines[0] ?? ''),
    answer: labelled('答案'),
    identity: labelled('模型'),
  };
}

/** 比答案前先规整：全角转半角、去空白、去句末标点、不分大小写。 */
export function normalizeAnswer(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[。.!！;；,，、]+$/u, '')
    .toLowerCase();
}

export type IdentityMatch = 'new' | 'old' | 'unknown';

/** 实答对上新答案 / 旧答案 / 两边都没对上。没写（null）算认不出。 */
export function matchIdentityAnswer(q: IdentityQuestion, answer: string | null): IdentityMatch {
  if (answer === null || answer.trim() === '') return 'unknown';
  const got = normalizeAnswer(answer);
  if (got === '') return 'unknown';
  if (q.newAnswers.some((a) => normalizeAnswer(a) === got || got.includes(normalizeAnswer(a)))) {
    return 'new';
  }
  if (q.oldAnswers.some((a) => normalizeAnswer(a) === got || got.includes(normalizeAnswer(a)))) {
    return 'old';
  }
  return 'unknown';
}

/** 标准答案给人看的短写：新答案用「/」拼。 */
export function expectedNewAnswers(q: IdentityQuestion): string {
  return q.newAnswers.join('/');
}
