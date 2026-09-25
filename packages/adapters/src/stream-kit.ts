// 各家过程记录解析共用的小工具：取字段、截断、相对路径、步骤清单、认测试、认额度用满。
// 只放「每家都一样」的判法；某一家特有的形状留在那一家的读取器里。
import type { ProgressEvent, ProgressKind } from '@fleet-dao/shared';
import type { PlanPayload, PlanStep, TestPayload } from './types.ts';

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
 * 命令里含仓库的测试命令就记一次「跑了测试」；只有整条命令的退出码可信时，工具报的成败才能当测试的成败。
 * 不是测试命令返回 undefined。
 */
export function testRun(
  command: string,
  ok: boolean,
  testCommands: readonly string[],
  unknownBecause?: string,
): TestPayload | undefined {
  if (!testCommands.some((t) => command.includes(t))) return undefined;
  const why = unknownBecause ?? exitStatusUntrusted(command);
  return { command: cut(command, 500), ...(why === undefined ? { passed: ok } : { unknownBecause: why }) };
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
  return /\b402\b|payment required|out of credits|run out of|insufficient (balance|credits|quota)|usage limit|quota (exceeded|exhausted)|exceeded your (current )?quota|weekly limit|need a [\w ]*subscription|额度(已)?用(完|尽|满)/i.test(
    text,
  );
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
