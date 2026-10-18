// 各家过程记录解析共用的小工具：取字段、截断、相对路径、步骤清单、认测试、认额度用满、
// 工具摘要和结果正文的截断。只放「每家都一样」的判法；某一家特有的字段映射留在那一家的读取器里。
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

/** 一行 JSON；不是 JSON 对象就返回 undefined。 */
export function parseFrame(line: string): Record<string, unknown> | undefined {
  try {
    return rec(JSON.parse(line));
  } catch {
    return undefined;
  }
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

/** 会话过程记录里工具输入摘要先取多长（调用方写库前再按上限截）。 */
export const TRANSCRIPT_SUMMARY_MAX = 2000;

/** 进度事件里工具摘要的默认上限。会话记录用 TRANSCRIPT_SUMMARY_MAX，更长。 */
export const TOOL_SUMMARY_MAX = 200;

/** 失败说明（进度事件的 error、失败的工具结果）写进去之前的上限。 */
export const FAILURE_TEXT_MAX = 500;

/** 工具成功了，但命令输出和工具回的文字都没有（cursor、grok 一样）。 */
export const EMPTY_TOOL_RESULT = '（无输出）';

/**
 * 工具输入摘要的公共截断。各渠道先按自己的字段映射挑出一段文本，截断只走这里：
 * 没挑到给空串，超长截断并加省略号。不传 max 时用 TOOL_SUMMARY_MAX。
 */
export function toolSummary(text: string | undefined, max = TOOL_SUMMARY_MAX): string {
  return cut(text ?? '', max);
}

/**
 * 工具结果的正文。字符串原样交回（含空串）。内容块数组按 pick 抽出 text 再拼起来，
 * 默认认块自己的 text、空块留成空串、中间不加分隔（claude 的内容块）。
 * 套了两层的渠道传自己的 pick，并用 sep / dropEmpty 决定怎么拼（grok：块内 content.text，空块不占一行）。
 * 不是字符串也不是数组就给空串。成功却没有正文要不要写成（无输出），各渠道自己定。
 */
export function resultText(
  content: unknown,
  options?: {
    pick?: (block: unknown) => string | undefined;
    sep?: string;
    dropEmpty?: boolean;
  },
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const pick = options?.pick ?? ((block: unknown) => str(rec(block)?.text));
  const parts: string[] = [];
  for (const block of content) {
    const text = pick(block) ?? '';
    if (options?.dropEmpty && !text) continue;
    parts.push(text);
  }
  return parts.join(options?.sep ?? '');
}

/**
 * 失败说明的公共截断。各渠道把退出码、信号、报错字段拼成一段再交到这里。
 * 不改字、不去空白：拼的时候怎么取字段是各家的事。
 */
export function failureText(text: string, max = FAILURE_TEXT_MAX): string {
  return cut(text, max);
}

/** 命令没成功时失败说明的开头：读不到退出码写问号，不写成 0。 */
export function exitCodeText(code: number | undefined): string {
  return `退出码 ${code ?? '?'}`;
}

/**
 * 搜索类工具的摘要：图案，有路径再接「 @ 相对路径」（树内相对、树外原样）。
 * 图案和路径都没有就 undefined，调用方再兜底。
 */
export function searchSummary(
  pattern: string | undefined,
  where: string | undefined,
  cwd: string,
): string | undefined {
  const path = where ? relPath(where, cwd) : undefined;
  const text = [pattern, path].filter((part) => part).join(' @ ');
  return text || undefined;
}

/** 认不出的工具：输入里第一个字符串字段当摘要。空串也算，调用方原样截断。 */
export function firstStringField(input: Record<string, unknown>): string | undefined {
  return Object.values(input).find((value): value is string => typeof value === 'string');
}

/** 待办清单在工具摘要里怎么写。不是数组按 0 条。 */
export function todoSummary(todos: unknown): string {
  return `待办 ${Array.isArray(todos) ? todos.length : 0} 条`;
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
  if (/(^|[^&<>])&(?![&>])/.test(bare)) return '放到后台跑，命令返回时测试还没跑完';
  return undefined;
}

/**
 * 报错原文像不像「账号池额度用完」：402、周限、没额度了、要订阅……只认这几种明确说法。
 * 429 限流、上游抖动不算——那是等一会儿再试，不是换池。（GK-08：xAI 额度用完曾被记成上游抖动。）
 */
export function looksLikeQuotaExhausted(text: string | undefined): boolean {
  if (!text) return false;
  return /\b402\b|payment required|out of credits|run out of|insufficient[ _](?:account )?(balance|credits|quota)|usage limit|quota (?:is |has been )?(exceeded|exhausted)|exceeded your (current )?quota|(?:weekly|monthly|session) limit|\b5[- ]?hour limit|hit your (?:[\w-]+ )?limit|need a [\w ]*subscription|额度(已)?用(完|尽|满)|余额不足/i.test(
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
