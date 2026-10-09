// Kimi Code 的钩子：~/.kimi-code/config.toml 的 [[hooks]]（TOML；targets.ts 的 HOOK_TARGETS 上面写了依据）。
// 本脚本的几条写在文件末尾一块托管块里，两行注释圈起来；块里整块由本脚本写，块外一个字不碰。
// 和权限那块（permissions-vendors.ts）同一个文件、各管各的块，标记不同。
// 每条只写 event、matcher、command、timeout 四个键：Kimi Code 见到别的键整份配置读不起来。
// 读不懂的不动、报出来：块的标记缺一行、重复，或 hooks 被写成了表、内联数组（[[hooks]] 加不进去）。
// 块外也有跑本脚本命令的 [[hooks]] 表（以前手抄的；或 Kimi Code 自己改写配置时把注释连同块的标记丢了）：整张收回块里，
// 别人的 [[hooks]] 一张不碰。不收回的话下次同步再补一块，同一条钩子就登记了两遍。
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Backups } from './backup.ts';
import { type ReadConfig, readConfig, tomlString } from './hooks-codex.ts';
import { type Line, line } from './report.ts';
import { type Ctx, code, relOf, writeAtomic } from './sync.ts';
import { agentNames, type HookTarget, slashed } from './targets.ts';

const BEGIN =
  '# >>> fleet-dao 钩子（同步脚本管：开会话、调工具前两条，改它改仓里 packages/agents-sync/src/targets.ts；块里手改的下次会被覆盖，块外不碰）';
const END = '# <<< fleet-dao 钩子';
const isBegin = (l: string): boolean => l.trim().startsWith('# >>> fleet-dao 钩子（');
const isEnd = (l: string): boolean => l.trim() === END;

/** 托管块里的几行（不含两行标记） */
export function kimiBody(t: HookTarget, commandOf: (script: string) => string): string[] {
  return t.hooks.flatMap((h) => [
    '[[hooks]]',
    `event = ${tomlString(h.event)}`,
    ...(h.matcher === undefined ? [] : [`matcher = ${tomlString(h.matcher)}`]),
    `command = ${tomlString(commandOf(h.script))}`,
    `timeout = ${h.timeout}`,
    '',
  ]);
}

type Planned =
  | { ok: false; why: string }
  | { ok: true; text: string | null; had: 'none' | 'same' | 'different'; outside: number };

/** 块外一行 command = "…" 跑的是不是本脚本的钩子脚本 */
const ownedLine = (l: string): boolean =>
  /^\s*command\s*=/.test(l) &&
  /[\\/]\.fleet-dao[\\/]+(?:hooks[\\/]+[\w.-]+\.mjs|bin[\\/]+quiet-[\w.-]+\.exe)/.test(l);

/** 每一行是不是在多行字符串里（那里的 [ 开头不是表头） */
function inMultiline(lines: string[]): boolean[] {
  const out: boolean[] = [];
  let open: string | null = null;
  for (const l of lines) {
    out.push(open !== null);
    for (const q of ['"""', "'''"]) {
      const n = l.split(q).length - 1;
      if (open === null && n % 2 === 1) open = q;
      else if (open === q && n % 2 === 1) open = null;
    }
  }
  return out;
}

/**
 * 块外跑本脚本命令的 [[hooks]] 表（以前手抄的，或 Kimi Code 自己改写配置时把块的标记丢了）：每张从表头到下一个表头前，
 * 末尾紧挨下一个表头的注释留给下一张。返回要删的行号。
 */
function outsideOwnedTables(lines: string[], skip: (i: number) => boolean): Set<number> {
  const multi = inMultiline(lines);
  const headers = lines.flatMap((l, i) => (!multi[i] && !skip(i) && /^\s*\[/.test(l) ? [i] : []));
  const drop = new Set<number>();
  headers.forEach((h, k) => {
    if (!/^\s*\[\[\s*hooks\s*\]\]/.test(lines[h] ?? '')) return;
    let end = (headers[k + 1] ?? lines.length) - 1;
    for (let i = h + 1; i <= end; i++) if (skip(i)) end = Math.min(end, i - 1);
    while (end > h && /^\s*#/.test(lines[end] ?? '')) end--;
    const range = Array.from({ length: end - h + 1 }, (_, i) => h + i);
    if (range.some((i) => ownedLine(lines[i] ?? ''))) for (const i of range) drop.add(i);
  });
  return drop;
}

/**
 * 换成该有的块后的全文（一样就是 null）。块外跑本脚本命令的 [[hooks]] 表一并收回块里（删掉块外那几张），
 * outside 是收回了几张。
 */
export function planKimi(text: string, body: string[]): Planned {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const begins = lines.flatMap((l, i) => (isBegin(l) ? [i] : []));
  const ends = lines.flatMap((l, i) => (isEnd(l) ? [i] : []));
  let block: { start: number; end: number } | null = null;
  if (begins.length > 0 || ends.length > 0) {
    const [start] = begins;
    const [end] = ends;
    if (begins.length !== 1 || ends.length !== 1 || start === undefined || end === undefined || end < start)
      return { ok: false, why: '钩子那块托管块的开头、结尾两行标记缺一行、重复或颠倒了' };
    block = { start, end };
  }
  const outsideLines = lines.filter((_, i) => block === null || i < block.start || i > block.end);
  const firstTable = outsideLines.findIndex((l) => /^\s*\[/.test(l));
  const top = firstTable === -1 ? outsideLines : outsideLines.slice(0, firstTable);
  if (top.some((l) => /^\s*hooks\s*=/.test(l)))
    return { ok: false, why: '顶层把 hooks 写成了 hooks = …（内联数组），[[hooks]] 加不进去' };
  if (outsideLines.some((l) => /^\s*\[\s*hooks\s*\]/.test(l)))
    return { ok: false, why: '把 hooks 写成了 [hooks] 表，[[hooks]] 加不进去' };
  const inBlock = (i: number): boolean => block !== null && i >= block.start && i <= block.end;
  const drop = outsideOwnedTables(lines, inBlock);
  const outside = [...drop].filter((i) => /^\s*\[\[/.test(lines[i] ?? '')).length;
  const want = [BEGIN, ...body, END];
  const have = block ? lines.slice(block.start, block.end + 1) : [];
  const had: 'none' | 'same' | 'different' = !block
    ? 'none'
    : have.length === want.length && have.every((l, i) => l.trimEnd() === (want[i] as string).trimEnd())
      ? 'same'
      : 'different';
  if (had === 'same' && outside === 0) return { ok: true, text: null, had, outside };
  // 先换块（行号不受删块外那几行影响），再从后往前删块外的表
  const next: string[] = [];
  lines.forEach((l, i) => {
    if (drop.has(i)) return;
    if (block && i === block.start) next.push(...want);
    if (inBlock(i)) return;
    next.push(l);
  });
  if (!block) {
    const tail = next.length > 0 && next[next.length - 1] === '' ? next.pop() : undefined;
    if (next.length > 0 && (next[next.length - 1] ?? '').trim() !== '') next.push('');
    next.push(...want, tail ?? '');
  }
  return { ok: true, text: next.join(eol), had, outside };
}

const events = (t: HookTarget): string => [...new Set(t.hooks.map((h) => h.event))].join('、');

export function kimiKey(ctx: Ctx, t: HookTarget): string {
  return `${relOf(ctx, t.settings).key}#hooks`;
}

const outsideNote = (n: number): string =>
  `块外有 ${n} 条 [[hooks]] 跑的是本脚本的钩子（以前手抄的，或 Kimi Code 改写配置时丢了块的标记），同步会收回块里`;

export function checkKimiHooks(ctx: Ctx, t: HookTarget, commandOf: (script: string) => string): Line {
  const { abs } = relOf(ctx, t.settings);
  const key = kimiKey(ctx, t);
  const who = `（给 ${agentNames(t.readers.filter((r) => ctx.installed.has(r)))}）`;
  let read: ReadConfig;
  try {
    read = readConfig(abs);
  } catch (err) {
    return line('unknown', key, `没查成——读不了（${code(err)}）`);
  }
  if (read.kind === 'bad') return line('drift', key, `漂移——${read.why}，钩子等于没装`);
  if (read.kind === 'absent') return line('missing', key, `缺失——没有这个文件，${events(t)} 钩子没装${who}`);
  const p = planKimi(read.text, kimiBody(t, commandOf));
  if (!p.ok) return line('drift', key, `漂移——${p.why}`);
  if (p.had === 'none' && p.outside === 0)
    return line('missing', key, `缺失——没有本脚本的 [[hooks]] 块，${events(t)} 钩子没装${who}`);
  const problems = [
    ...(p.had === 'none' ? ['没有本脚本的 [[hooks]] 块'] : []),
    ...(p.had === 'different' ? ['[[hooks]] 块和仓里的不一样'] : []),
    ...(p.outside ? [outsideNote(p.outside)] : []),
  ];
  if (problems.length) return line('drift', key, `漂移——${problems.join('；')}`);
  return line('ok', key, `${events(t)} 都登记了${who}`);
}

export function applyKimiHooks(
  ctx: Ctx,
  t: HookTarget,
  commandOf: (script: string) => string,
  backups: Backups,
): Line {
  const { rel, abs } = relOf(ctx, t.settings);
  const key = kimiKey(ctx, t);
  const who = `（给 ${agentNames(t.readers.filter((r) => ctx.installed.has(r)))}）`;
  try {
    const read = readConfig(abs);
    if (read.kind === 'bad') return line('failed', key, `没动——${read.why}；要人看`);
    const p = planKimi(read.kind === 'text' ? read.text : '', kimiBody(t, commandOf));
    if (!p.ok) return line('failed', key, `没动——${p.why}；要人看`);
    if (p.text === null) return line('ok', key, `${events(t)} 都登记了${who}`);
    const saved = read.kind === 'text' ? backups.saveFile(abs, slashed(rel)) : undefined;
    mkdirSync(dirname(abs), { recursive: true });
    writeAtomic(abs, p.text, read.kind === 'text' ? read.mode : undefined);
    const done = [
      read.kind === 'absent' ? '新建' : '改了',
      `${p.had === 'none' ? '登记了' : p.had === 'same' ? '块照旧' : '换成了仓里的'} ${events(t)}（[[hooks]] 块）`,
      ...(p.outside ? [`块外跑本脚本钩子的 ${p.outside} 条 [[hooks]] 收回了块里`] : []),
      ...(saved ? [`原文件备份在 ${saved}`] : []),
    ].join('，');
    return line('changed', key, `${done}${who}`);
  } catch (err) {
    return line('failed', key, `没做成——${code(err)}`);
  }
}
