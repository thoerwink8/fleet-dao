// MCP 服务器配置：~/.claude.json 的 mcpServers.playwright.args 里加 --output-dir _tmp/playwright（#380）。
//
// 这份 JSON 是用户自己攒的、各家机器上装的 MCP 都不一样——和钩子、权限那份 ~/.claude/settings.json 不一样，
// 不能整段接管，只能动列出来的那一小处：
//   1) 只「改」已经配好的 playwright 条目，不「加」：这台没配 Playwright MCP 的不该凭空装一个（没装就跳过、不算漂移）。
//   2) 改的范围收敛到 args 数组里 --output-dir 这一对的值：已经有就改成 _tmp/playwright（值不对的也对齐）；没有就补上这一对。
//      args 数组里别的参数（--browser、--headless、--executable-path……）一个不动，顺序也不动。
//   3) args 不是数组、playwright 条目不是对象、mcpServers 不是对象、整份不是 JSON——一律报出来「没查成 / 没做成」，
//      不猜、不拿空的顶上（猜错了会把整份配置改坏）。
//
// 输出目录写相对路径（_tmp/playwright，不带 ./ 前缀、不带平台分隔符）：Claude Code 起 MCP 服务器时拿每次会话
// 所在的项目目录当 cwd，相对路径就跟着项目走，截图就落在那个仓的 _tmp/playwright/——通用段的规矩就是
// 「仓根 _tmp/，各仓 .gitignore 忽略它」。写成绝对路径会把别台机器、别个仓的截图也堆到一个固定地方。
//
// --user 替别的用户写（法国装机）时不管：~/.claude.json 是 Claude Code 自己每次会话都要读写的活文件，
// 替别的用户写它超出了这张单（#380）定的范围；那边要管的由引擎起会话时的参数自己带。
import type { Backups } from './backup.ts';
import { readSettings } from './hooks.ts';
import { type Line, line } from './report.ts';
import { type Ctx, code, relOf, writeAtomic } from './sync.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 配置里 Playwright MCP 的条目名：本机的 ~/.claude.json 里 mcpServers 下就叫这个 */
export const SERVER_NAME = 'playwright';
/** 要管的参数和该有的值 */
export const OUTPUT_FLAG = '--output-dir';
export const OUTPUT_DIR = '_tmp/playwright';

/** Claude Code 的 MCP 服务器清单在家里这一份（不是 .claude/ 底下的，和 settings.json 是两份） */
export const MCP_TARGET = { win32: '.claude.json', linux: '.claude.json' } as const;

const keyOf = (ctx: Ctx): string => `${relOf(ctx, MCP_TARGET).key}#mcpServers.${SERVER_NAME}`;

/** 三种认读结果：没配、配了（args 列出原文）、读不懂（说清是哪一层不对） */
export type Located =
  | { kind: 'absent' }
  | { kind: 'has'; args: readonly unknown[] }
  | { kind: 'unreadable'; why: string };

/** 在整份 ~/.claude.json 的根对象里找 playwright 条目 */
export function locate(root: unknown): Located {
  if (!isObj(root)) return { kind: 'unreadable', why: '整份不是一个 JSON 对象' };
  const servers = root.mcpServers;
  if (servers === undefined) return { kind: 'absent' };
  if (!isObj(servers)) return { kind: 'unreadable', why: 'mcpServers 不是对象' };
  const entry = servers[SERVER_NAME];
  if (entry === undefined) return { kind: 'absent' };
  if (!isObj(entry)) return { kind: 'unreadable', why: `mcpServers.${SERVER_NAME} 不是对象` };
  const args = entry.args;
  if (args === undefined) return { kind: 'has', args: [] };
  if (!Array.isArray(args)) return { kind: 'unreadable', why: `mcpServers.${SERVER_NAME}.args 不是数组` };
  return { kind: 'has', args };
}

/**
 * 在 args 里找 --output-dir 这一对：返回 值的下标（值 = args[at]），
 * 没有返回 null；写两遍、值不是字符串、悬在末尾没值——读不懂。
 */
function valueAt(args: readonly unknown[]): number | null | { why: string } {
  const hits: number[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === OUTPUT_FLAG) hits.push(i);
  if (hits.length === 0) return null;
  if (hits.length > 1) return { why: `${OUTPUT_FLAG} 写了 ${hits.length} 遍` };
  const flag = hits[0] as number;
  if (flag + 1 >= args.length) return { why: `${OUTPUT_FLAG} 后面没有值` };
  if (typeof args[flag + 1] !== 'string') return { why: `${OUTPUT_FLAG} 的值不是字符串` };
  return flag + 1;
}

/** 查 args 里 --output-dir 这一对该有的样子 */
export type Judged =
  | { kind: 'ok' }
  | { kind: 'missing' }
  | { kind: 'drift'; have: string }
  | { kind: 'broken'; why: string };

export function judgeArgs(args: readonly unknown[]): Judged {
  const at = valueAt(args);
  if (at === null) return { kind: 'missing' };
  if (typeof at !== 'number') return { kind: 'broken', why: at.why };
  const have = args[at] as string;
  return have === OUTPUT_DIR ? { kind: 'ok' } : { kind: 'drift', have };
}

/** 把 args 改成该有的样子（不动别的参数、不重排）；已经对了返回 null，读不懂返回原因 */
export function fixArgs(
  args: readonly unknown[],
): { ok: true; args: unknown[] | null } | { ok: false; why: string } {
  const at = valueAt(args);
  if (typeof at === 'object' && at !== null) return { ok: false, why: at.why };
  if (at === null) return { ok: true, args: [...args, OUTPUT_FLAG, OUTPUT_DIR] };
  if (args[at] === OUTPUT_DIR) return { ok: true, args: null };
  const next = args.slice();
  next[at] = OUTPUT_DIR;
  return { ok: true, args: next };
}

export function checkMcp(ctx: Ctx): Line[] {
  const key = keyOf(ctx);
  if (!ctx.installed.has('claude')) return [line('skip', key, '没装 Claude Code，跳过')];
  const { abs } = relOf(ctx, MCP_TARGET);
  let read: ReturnType<typeof readSettings>;
  try {
    read = readSettings(abs);
  } catch (err) {
    return [line('unknown', key, `没查成——读不了（${code(err)}）`)];
  }
  // 没这份文件 = Claude Code 装了但还没起过会话，照「没配」处理：不凭空建
  if (read.kind === 'none')
    return [line('skip', key, `没有 ${relOf(ctx, MCP_TARGET).key}（Claude Code 还没起过），跳过`)];
  if (read.kind === 'bad') return [line('unknown', key, `没查成——${read.why}`)];
  const at = locate(read.root);
  if (at.kind === 'unreadable') return [line('unknown', key, `没查成——${at.why}`)];
  if (at.kind === 'absent') return [line('skip', key, `这台没配 ${SERVER_NAME} MCP，跳过（不凭空装）`)];
  const j = judgeArgs(at.args);
  if (j.kind === 'ok') return [line('ok', key, `一致（${OUTPUT_FLAG} ${OUTPUT_DIR}）`)];
  if (j.kind === 'missing') return [line('missing', key, `缺失——args 里没有 ${OUTPUT_FLAG} ${OUTPUT_DIR}`)];
  if (j.kind === 'drift')
    return [line('drift', key, `漂移——${OUTPUT_FLAG} 是 ${JSON.stringify(j.have)}，该是 ${OUTPUT_DIR}`)];
  return [line('unknown', key, `没查成——args 里 ${j.why}`)];
}

export function applyMcp(ctx: Ctx, backups: Backups): Line[] {
  const key = keyOf(ctx);
  if (!ctx.installed.has('claude')) return [line('skip', key, '没装 Claude Code，跳过')];
  const { rel, abs } = relOf(ctx, MCP_TARGET);
  let read: ReturnType<typeof readSettings>;
  try {
    read = readSettings(abs);
  } catch (err) {
    return [line('failed', key, `没做成——读不了（${code(err)}）`)];
  }
  if (read.kind === 'none')
    return [line('skip', key, `没有 ${relOf(ctx, MCP_TARGET).key}（Claude Code 还没起过），跳过、不凭空建`)];
  if (read.kind === 'bad') return [line('failed', key, `没动——${read.why}；要人看`)];
  const at = locate(read.root);
  if (at.kind === 'unreadable') return [line('failed', key, `没动——${at.why}；要人看`)];
  if (at.kind === 'absent')
    return [line('skip', key, `这台没配 ${SERVER_NAME} MCP，跳过、不凭空装（要装由人自己装）`)];
  const fix = fixArgs(at.args);
  if (!fix.ok) return [line('failed', key, `没动——args 里 ${fix.why}；要人看`)];
  if (fix.args === null) return [line('ok', key, `一致（${OUTPUT_FLAG} ${OUTPUT_DIR}）`)];
  // 改一份 deep clone 再整体写回；args 数组里别的参数一个不动
  const root = structuredClone(read.root) as Obj;
  const servers = root.mcpServers as Obj;
  const entry = servers[SERVER_NAME] as Obj;
  const judged = judgeArgs(at.args);
  entry.args = fix.args;
  const eol = read.text.includes('\r\n') ? '\r\n' : '\n';
  const text = `${JSON.stringify(root, null, 2)}\n`.replaceAll('\n', eol);
  try {
    const saved = backups.saveFile(abs, rel.replaceAll('\\', '/'));
    writeAtomic(abs, text, undefined);
    const what =
      judged.kind === 'missing'
        ? `在 args 末尾补上 ${OUTPUT_FLAG} ${OUTPUT_DIR}`
        : `把 ${OUTPUT_FLAG} 从 ${JSON.stringify((judged as { have: string }).have)} 改成 ${OUTPUT_DIR}`;
    return [line('changed', key, `${what}（args 里别的参数没动；原文件备份在 ${saved}）`)];
  } catch (err) {
    return [line('failed', key, `没做成——${code(err)}`)];
  }
}
