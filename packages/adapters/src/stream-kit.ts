// 各家过程记录解析共用的小工具：取字段、截断、相对路径、步骤清单、认测试、认额度用满。
// 只放「每家都一样」的判法；某一家特有的形状留在那一家的读取器里。
import type { ProgressEvent, ProgressKind } from '@fleet-dao/shared';
import type { PlanPayload, PlanStep, TestPayload, TranscriptEntry } from './types.ts';

export function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** exactOptionalPropertyTypes 下，值为 undefined 时干脆不带这个键。 */
export function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/**
 * 按「我们的名字 → 帧里的字段名」挑出数字字段；帧里没有的就不带——读不到不许记成 0（0 是「读到了、就是零」）。
 */
export function numbers<K extends string>(
  src: Record<string, unknown> | undefined,
  fields: Record<K, string>,
): { [P in K]?: number } {
  const out: { [P in K]?: number } = {};
  if (!src) return out;
  for (const [ours, theirs] of Object.entries(fields) as [K, string][]) {
    const value = num(src[theirs]);
    if (value !== undefined) out[ours] = value;
  }
  return out;
}

/** 工作树里的文件给相对路径，树外的原样给。 */
export function relPath(path: string, cwd: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = norm(cwd);
  const full = norm(path);
  return base && full.startsWith(`${base}/`) ? full.slice(base.length + 1) : full;
}

/** 进度事件里工具输入摘要的长度。 */
export const TOOL_SUMMARY_MAX = 200;
/** 会话过程记录里工具输入摘要先取多长（调用方写库前再按上限截）。 */
export const TRANSCRIPT_SUMMARY_MAX = 2000;
/** 助手的话（say 事件）取多长。 */
export const SAY_MAX = 2000;
/** 工具失败原因取多长。 */
export const FAILURE_MAX = 500;
/** 接口、会话报错原文取多长。 */
export const ERROR_MAX = 1000;
/** 工具成功但没有任何输出时给人看的正文。 */
export const NO_OUTPUT = '（无输出）';
/** 测试命令放到后台跑时的「结果未知」原因。 */
export const BACKGROUND_RUN = '放到后台跑，命令返回时测试还没跑完';

/** 工具输入摘要的收尾：读不到就是空串，再按 max 截。 */
export function toolSummaryText(text: string | undefined, max = TOOL_SUMMARY_MAX): string {
  return cut(text ?? '', max);
}

/**
 * 认不出的工具没有专用字段时，取对象里第一个字符串。空串也算（和 str 不同：空串是读到了）；
 * 数字和嵌套对象跳过。三家兜底同一套，改一处即可。
 */
export function firstString(record: Record<string, unknown>): string | undefined {
  return Object.values(record).find((v): v is string => typeof v === 'string');
}

/** 搜索类工具的摘要：「模式 @ 相对路径」，缺哪样省哪样。 */
export function searchSummary(pattern: string | undefined, where: string | undefined, cwd: string): string {
  return [pattern, where ? relPath(where, cwd) : undefined].filter((x) => x).join(' @ ');
}

/** 待办清单工具的摘要。 */
export function todosSummary(todos: unknown): string {
  return `待办 ${Array.isArray(todos) ? todos.length : 0} 条`;
}

/**
 * 失败原因：「标签：说明」，没有说明就只有标签；按 FAILURE_MAX 截。空串不算有说明。
 * 标签、说明从帧里怎么掏，各家不一样，留在各家的读取器里。
 */
export function failureText(label: string, detail?: string): string {
  return cut(detail ? `${label}：${detail}` : label, FAILURE_MAX);
}

/** 命令失败：原因是退出码、超时或信号，说明是命令自己说的话。 */
export function commandFailure(why: string, said: string | undefined): string {
  return failureText(why, said);
}

/** 工具结果的 content（字符串，或带 text 的块数组）拼成正文；别的形状返回空串。 */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => str(rec(c)?.text) ?? '').join('');
  return '';
}

/** 认不出的帧、工具种类按键计数。 */
export function tally(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** 一行 JSON；不是 JSON 对象就返回 undefined。 */
export function parseFrame(line: string): Record<string, unknown> | undefined {
  try {
    return rec(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** 各家读取器摘要里都有的帧计数。 */
export interface FrameCounts {
  frames: number;
  nonJsonLines: number;
  nonJsonSample?: string;
}

/**
 * 读一行、记账：空行返回 undefined 不计数；不是 JSON 对象的计一条 nonJsonLines、留第一条的样子；是帧就 frames 加一。
 */
export function takeFrame(raw: string, counts: FrameCounts): Record<string, unknown> | undefined {
  const line = raw.trim();
  if (!line) return undefined;
  const frame = parseFrame(line);
  if (!frame) {
    counts.nonJsonLines++;
    counts.nonJsonSample ??= cut(line, 200);
    return undefined;
  }
  counts.frames++;
  return frame;
}

export function progressEvent(runId: string, at: Date, kind: ProgressKind, payload: unknown): ProgressEvent {
  return { runId, at: at.toISOString(), kind, payload };
}

/**
 * 一条会话过程记录。可选字段读不到就不带键（不拿空串、false 冒充）。文本原文给，不截断：截断和打码在调用方写库前做。
 */
export function transcriptEntry(
  at: Date,
  kind: TranscriptEntry['kind'],
  text: string,
  extra: {
    tool?: string | undefined;
    ok?: boolean | undefined;
    meta?: Record<string, unknown> | undefined;
  } = {},
): TranscriptEntry {
  return {
    at: at.toISOString(),
    kind,
    text,
    ...optional('tool', extra.tool),
    ...optional('ok', extra.ok),
    ...optional('meta', extra.meta),
  };
}

const PLAN_LIMIT = 30;

/**
 * 各家待办清单 → fleet 的步骤清单。状态写法各家不同（in_progress / TODO_STATUS_IN_PROGRESS / completed……），
 * 认不出的当 pending；取消的步骤算结束，标题上注明。一条标题都没有就返回 undefined。
 */
export function planFromTodos(
  items: readonly { title?: string; status?: string }[],
): PlanPayload | undefined {
  const steps: PlanStep[] = [];
  for (const item of items) {
    const title = item.title?.trim();
    if (!title) continue;
    const status = (item.status ?? '').toLowerCase();
    const cancelled = /cancel/.test(status);
    const state: PlanStep['state'] =
      cancelled || /complete|done|finish/.test(status)
        ? 'done'
        : /progress|active|running/.test(status)
          ? 'in_progress'
          : 'pending';
    steps.push({ title: cut(cancelled ? `${title}（已取消）` : title, 190), state });
    if (steps.length === PLAN_LIMIT) break;
  }
  return steps.length ? { steps, source: 'stream' } : undefined;
}

/**
 * 命令真的跑了仓库的测试命令就记一次「跑了测试」；只有整条命令的退出码可信时，工具报的成败才能当测试的成败。
 * 不是测试命令返回 undefined。
 */
export function testRun(
  command: string,
  ok: boolean,
  testCommands: readonly string[],
  unknownBecause?: string,
): TestPayload | undefined {
  if (!testCommands.some((t) => invokesTestCommand(command, t))) return undefined;
  const why = unknownBecause ?? exitStatusUntrusted(command);
  return { command: cut(command, 500), ...(why === undefined ? { passed: ok } : { unknownBecause: why }) };
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
const WRAPPER = /^(?:time|command|exec|timeout(?:\s+-\S+)*\s+\S+)\s+/;

/**
 * 命令是不是真的跑了这条测试命令：按 && || ; | & 换行拆成一段段（引号里的先抹掉），测试命令要在某一段的开头
 * （段首的环境变量赋值、cd 之后、time / timeout 这类包一层的不算数）。只在字里出现不算：
 * grep "pnpm test:changed" AGENTS.md、echo、cat 这类会话常干的事，原先按「命令里含测试命令」算，会被记成
 * 「跑了测试、通过」，交活核对就收下一个根本没跑过测试的会话。
 */
export function invokesTestCommand(command: string, testCommand: string): boolean {
  const want = testCommand.trim();
  if (!want) return false;
  // 仓的测试命令本身就是几条串起来的（pnpm build && pnpm test）：拆开就对不上了，照原来按「含」认
  if (/[;&|\n]/.test(want)) return command.includes(want);
  const bare = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  for (const segment of bare.split(/&&|\|\||[;|&\n]/)) {
    let s = segment
      .trim()
      .replace(/^\(+\s*/, '')
      .replace(/\s*\)+$/, '');
    for (let prev = ''; prev !== s; ) {
      prev = s;
      s = s.replace(ENV_ASSIGN, '').replace(WRAPPER, '');
    }
    if (s === want || s.startsWith(`${want} `) || s.startsWith(`${want}\t`) || s.startsWith(`${want}>`))
      return true;
  }
  return false;
}

export function cleanTestCommands(testCommands: readonly string[] | undefined): string[] {
  return (testCommands ?? []).map((c) => c.trim()).filter((c) => c);
}

/**
 * 整条命令的退出码是不是就是测试的退出码；不是就返回原因。只有是的时候，工具报的成败才能当测试的成败。
 * `pnpm check | tail` 的退出码是 tail 的，测试挂了也记成通过——这类一律记「结果未知」。
 */
export function exitStatusUntrusted(command: string): string | undefined {
  // 引号里的 | ; & 是参数不是语法，先抹掉
  let bare = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''").trim();
  let pipefail = false;
  const preamble = /^set\s+-[a-z]*o\s+pipefail\s*(?:;|&&)\s*/;
  if (preamble.test(bare)) {
    pipefail = true;
    bare = bare.replace(preamble, '');
  }
  if (bare.includes('\n')) return '多行命令，退出码是最后一行的';
  if (bare.includes('||')) return '带 ||，失败会被吞掉';
  if (bare.includes(';')) return '带 ;，退出码是最后一条命令的';
  if (/(^|[^|])\|(?!\|)/.test(bare) && !pipefail) return '带管道又没开 pipefail，退出码是管道最后一段的';
  if (/(^|[^&<>])&(?![&>])/.test(bare)) return BACKGROUND_RUN;
  return undefined;
}

/**
 * 报错原文像不像「账号池额度用完」：402、周限、没额度了、要订阅……只认这几种明确说法。
 * 429 限流、上游抖动不算——那是等一会儿再试，不是换池。（GK-08：xAI 额度用完曾被记成上游抖动。）
 */
export function looksLikeQuotaExhausted(text: string | undefined): boolean {
  if (!text) return false;
  return /\b402\b|payment required|out of credits|run out of|insufficient[ _](?:account )?(balance|credits|quota)|usage limit|quota (?:is |has been )?(exceeded|exhausted)|exceeded your (current )?quota|weekly limit|need a [\w ]*subscription|额度(已)?用(完|尽|满)|余额不足/i.test(
    text,
  );
}

/**
 * 中转的上游额度用完、欠费时，有的中转不报错，而是把通知当成模型的回答回来（快照 phase=done、error 为空；
 * #2249：「Your quota is exhausted. API key status: exceeded … USDT balance: -2.16 USDT」）。
 * 只认整段回答就是这么一条通知：去掉首尾空白后以通知开头、整段不长。回答里只是提到这些词（测试输出、
 * 改额度相关代码时的正文）不算——和规则表 codeFieldOnly 一个道理，原文里有这个词不说明是这么失败的。
 */
const RELAY_QUOTA_NOTICE =
  /^(?:error:\s*)?(?:your (?:api )?quota (?:is|has been) (?:exhausted|exceeded)|insufficient[ _](?:account[ _])?(?:balance|credits?|quota|funds)|(?:your )?(?:account )?balance is (?:insufficient|not enough)|api key status: exceeded|(?:账户|账号)?余额不足|(?:账户|账号)?已欠费)/i;
/** 通知都是一两句话加几行账户信息；比这长的是正经回答。 */
const RELAY_NOTICE_MAX_CHARS = 600;

/** 整段回答是中转的额度用完 / 欠费通知时返回通知原文（压成一行），否则 undefined。 */
export function relayQuotaNotice(answer: string | undefined): string | undefined {
  const text = answer?.trim();
  if (!text || text.length > RELAY_NOTICE_MAX_CHARS || !RELAY_QUOTA_NOTICE.test(text)) return undefined;
  return text.replace(/\s*\n\s*/g, ' ');
}

/** stderr 的最后几行（去掉空行），给「没有终帧」时当原因看。 */
export function lastLines(text: string, lines = 3, max = 500): string | undefined {
  const tail = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l)
    .slice(-lines)
    .join(' ⏎ ');
  return tail ? cut(tail, max) : undefined;
}
