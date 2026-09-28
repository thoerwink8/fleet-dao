// 钩子：agents/hooks/ 下的脚本整份拷进 ~/.fleet-dao/hooks/，再在各家的设置文件里登记（targets.ts 的 HOOK_TARGETS）。
// 设置文件里只动本脚本管的那几条：命令指向 ~/.fleet-dao/hooks/ 下的脚本，或者以前手装在 fleet-guard 目录的两条（接管时换掉）。
// 别的钩子、别的设置一条不碰；设置文件读不懂（不是 JSON、整份不是对象、hooks 不是对象）就不动，报没做成——不当成空的重写。
// 替别的用户写（--user，法国装机）时开会话那条不登记（HookSkip）：它要在这个用户自己能拉、能写的 fleet-dao 检出里快进、同步；
// 调工具前那条照装：法国会话用户家里就有 reclaude 的设备密钥，借道读这份设置的 Grok、Cursor 起的会话也要拦。
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Backups } from './backup.ts';
import { type Line, line } from './report.ts';
import { type Ctx, code, lstatOrNull, relOf, type Sources, writeAtomic } from './sync.ts';
import {
  AGENTS,
  agentNames,
  HOOK_GAPS,
  HOOK_TARGETS,
  HOOKS_DIR,
  type HookSpec,
  type HookTarget,
  type Platform,
  placeOn,
} from './targets.ts';
import { linkTarget, readTree, removeEntry, sameTree, treeDiff, writeTree } from './tree.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 设置里登记的命令：node 加脚本的绝对路径（一律 / 分隔、加引号：cmd、PowerShell、bash 都认）。
 * winSafe 开着、平台是 win32 时（targets.ts HookTarget.winSafeCommand 的注释）：包成
 * `powershell.exe -EncodedCommand <base64>`，命令行本身只剩字母数字，不管被哪个壳转手都不会切错。 */
export function hookCommand(home: string, platform: Platform, script: string, winSafe = false): string {
  const plain = `node "${join(home, placeOn(HOOKS_DIR, platform), script).replaceAll('\\', '/')}"`;
  if (!winSafe || platform !== 'win32') return plain;
  return windowsSafeCommand(`${plain}; exit $LASTEXITCODE`);
}

/** PowerShell 脚本文本包成 -EncodedCommand（UTF-16LE 再转 base64，PowerShell 自己吃这个编码） */
function windowsSafeCommand(script: string): string {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64}`;
}

/** 命令是不是 windowsSafeCommand 包出来的；是就把里面的 PowerShell 脚本文本解出来 */
function decodeWindowsSafe(command: string): string | null {
  const m = /-EncodedCommand\s+(\S+)/i.exec(command);
  if (!m?.[1]) return null;
  try {
    return Buffer.from(m[1], 'base64').toString('utf16le');
  } catch {
    return null;
  }
}

/** 这条命令是不是本脚本管的：返回它跑的脚本名、是不是以前手装的那份；不是就返回 null */
export function ownedScript(command: unknown): { script: string; legacy: boolean } | null {
  if (typeof command !== 'string') return null;
  const c = (decodeWindowsSafe(command) ?? command).replaceAll('\\', '/');
  const now = /\/\.fleet-dao\/hooks\/([\w.-]+\.mjs)(?![\w.-])/.exec(c);
  if (now?.[1]) return { script: now[1], legacy: false };
  const old = /\/fleet-guard\/(session-start|pretool)\.mjs(?![\w.-])/.exec(c);
  if (old?.[1]) return { script: `${old[1]}.mjs`, legacy: true };
  return null;
}

interface Found {
  event: string;
  matcher: unknown;
  handler: Obj;
  script: string;
  legacy: boolean;
}

/** hooks 里本脚本管的每一条，外加不归它管的有几条。flat 格式（Cursor）没有 matcher、没有分组，
 * hooks[event] 数组里的每一项直接就是一条 handler（{command,timeout}）。 */
function scan(hooks: Obj, format: 'nested' | 'flat'): { owned: Found[]; others: number } {
  const owned: Found[] = [];
  let others = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    if (format === 'flat') {
      for (const handler of groups) {
        const mine = isObj(handler) ? ownedScript(handler.command) : null;
        if (mine && isObj(handler)) owned.push({ event, matcher: undefined, handler, ...mine });
        else others++;
      }
      continue;
    }
    for (const group of groups) {
      if (!isObj(group) || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        const mine = isObj(handler) ? ownedScript(handler.command) : null;
        if (mine && isObj(handler)) owned.push({ event, matcher: group.matcher, handler, ...mine });
        else others++;
      }
    }
  }
  return { owned, others };
}

const sameMatcher = (have: unknown, want: string | undefined): boolean =>
  want === undefined ? have === undefined || have === '' : have === want;

/** 报出来的名字：事件（脚本，matcher） */
const specName = (h: HookSpec): string =>
  `${h.event}（${h.script}${h.matcher === undefined ? '' : `，matcher ${h.matcher}`}）`;

interface Judged {
  /** 一条都没登记的事件（脚本名） */
  missing: string[];
  problems: string[];
  others: number;
  legacy: number;
}

function judge(root: unknown, t: HookTarget, home: string, platform: Platform): Judged {
  const out: Judged = { missing: [], problems: [], others: 0, legacy: 0 };
  if (!isObj(root)) {
    out.problems.push('整份不是一个 JSON 对象');
    return out;
  }
  if (root.disableAllHooks === true) out.problems.push('disableAllHooks 开着：钩子一条都不跑');
  if (root.hooks === undefined) {
    out.missing.push(...t.hooks.map(specName));
    return out;
  }
  if (!isObj(root.hooks)) {
    out.problems.push('hooks 不是对象');
    return out;
  }
  const format = t.format ?? 'nested';
  const { owned, others } = scan(root.hooks, format);
  out.others = others;
  // 同一个脚本可以按不同的 matcher 登记几条（调工具前那条：Claude 的工具名一组、Devin 的一组），按事件加 matcher 对号
  const claimed = new Set<Found>();
  for (const spec of t.hooks) {
    const mine = owned.filter(
      (f) =>
        !f.legacy &&
        f.script === spec.script &&
        f.event === spec.event &&
        sameMatcher(f.matcher, spec.matcher),
    );
    if (mine.length === 0) {
      out.missing.push(specName(spec));
      continue;
    }
    for (const f of mine) claimed.add(f);
    if (mine.length > 1) out.problems.push(`${spec.script} 登记了 ${mine.length} 次（${specName(spec)}）`);
    const f = mine[0] as Found;
    const wrong: string[] = [];
    if (format === 'nested' && f.handler.type !== 'command') wrong.push('type 不是 command');
    if (f.handler.command !== hookCommand(home, platform, spec.script, t.winSafeCommand === true))
      wrong.push('命令和本机该有的不一样');
    if (f.handler.timeout !== spec.timeout)
      wrong.push(`timeout 是 ${String(f.handler.timeout)}，应是 ${spec.timeout}`);
    if (wrong.length) out.problems.push(`${spec.script}（${specName(spec)}）：${wrong.join('、')}`);
  }
  const known = new Set(t.hooks.map((h) => h.script));
  const legacy = new Set<string>();
  for (const f of owned) {
    if (f.legacy) {
      out.legacy++;
      legacy.add(f.script);
    } else if (!known.has(f.script)) out.problems.push(`还登记着仓里已经没有的 ${f.script}`);
    else if (!claimed.has(f))
      out.problems.push(
        `${f.script} 多登记了一条：挂在 ${f.event} 上、matcher 是 ${JSON.stringify(f.matcher ?? null)}，不是该有的那几条`,
      );
  }
  for (const script of legacy) out.problems.push(`还挂着以前手装的 ${script}（fleet-guard 目录那份）`);
  return out;
}

type Read = { kind: 'none' } | { kind: 'ok'; text: string; root: unknown } | { kind: 'bad'; why: string };

function readSettings(abs: string): Read {
  const st = lstatOrNull(abs);
  if (st === null) return { kind: 'none' };
  if (st.isSymbolicLink())
    return { kind: 'bad', why: `这是个链接（→ ${linkTarget(abs)}），不是本脚本能改的文件` };
  if (!st.isFile()) return { kind: 'bad', why: '这里不是文件' };
  const text = readFileSync(abs, 'utf8');
  try {
    return { kind: 'ok', text, root: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (err) {
    return { kind: 'bad', why: `不是合法的 JSON（${(err as Error).message}），它自己也读不了` };
  }
}

/** 装了要钩子的哪几家 */
function whoFor(ctx: Ctx, t: HookTarget): string {
  return `（给 ${agentNames(
    t.readers.filter((r) => ctx.installed.has(r)),
    t.borrowed,
  )}）`;
}

function noneLine(): string {
  const all = [...new Set(HOOK_TARGETS.flatMap((t) => t.readers))];
  return `没装读钩子设置的那几家（${agentNames(all)}），跳过`;
}

/** 这次不登记的一类钩子（事件名）和为什么；脚本目录照装 */
export interface HookSkip {
  event: string;
  why: string;
}

/** 这台装了的那几家要的钩子；skip 那类去掉（去掉后一条不剩的设置文件整份不管） */
function wanted(ctx: Ctx, skip?: HookSkip): HookTarget[] {
  return HOOK_TARGETS.filter((t) => t.readers.some((r) => ctx.installed.has(r)))
    .map((t) => (skip ? { ...t, hooks: t.hooks.filter((h) => h.event !== skip.event) } : t))
    .filter((t) => t.hooks.length > 0);
}

function skipLines(skip?: HookSkip): Line[] {
  return skip ? [line('skip', skip.event, skip.why)] : [];
}

/** 装了、但没装钩子的各家：逐家一行说为什么 */
function gapLines(ctx: Ctx): Line[] {
  const out: Line[] = [];
  for (const [id, why] of Object.entries(HOOK_GAPS) as [keyof typeof AGENTS, string][]) {
    if (ctx.installed.has(id)) out.push(line('skip', AGENTS[id].name, `没装钩子——${why}`));
  }
  return out;
}

function scriptsKey(ctx: Ctx): { abs: string; key: string } {
  const { abs, key } = relOf(ctx, HOOKS_DIR);
  return { abs, key };
}

function checkScripts(ctx: Ctx, src: Sources): Line {
  const { abs, key } = scriptsKey(ctx);
  if (!src.hooks.ok) return line('unknown', key, `没查成——${src.hooks.why}`);
  try {
    const st = lstatOrNull(abs);
    if (st === null) return line('missing', key, '缺失——钩子脚本没装');
    if (st.isSymbolicLink()) return line('drift', key, `漂移——被换成了链接（→ ${linkTarget(abs)}）`);
    if (!st.isDirectory()) return line('drift', key, '漂移——这里不是目录');
    const have = readTree(abs).files;
    if (!sameTree(src.hooks.tree, have))
      return line('drift', key, `漂移——和仓里不一样（${treeDiff(src.hooks.tree, have)}）`);
    return line('ok', key, `${src.hooks.tree.size} 个文件和仓里的 agents/hooks/ 一样`);
  } catch (err) {
    return line('unknown', key, `没查成——读不了（${code(err)}）`);
  }
}

function describe(t: HookTarget): string {
  return [...new Set(t.hooks.map((h) => h.event))].join('、');
}

function checkSettings(ctx: Ctx, t: HookTarget): Line {
  const { abs, key } = relOf(ctx, t.settings);
  const who = whoFor(ctx, t);
  let read: Read;
  try {
    read = readSettings(abs);
  } catch (err) {
    return line('unknown', key, `没查成——读不了（${code(err)}）`);
  }
  if (read.kind === 'none') return line('missing', key, `缺失——没有这个文件，${describe(t)} 钩子没装${who}`);
  if (read.kind === 'bad') return line('drift', key, `漂移——${read.why}，钩子等于没装`);
  const j = judge(read.root, t, ctx.home, ctx.platform);
  if (j.problems.length) return line('drift', key, `漂移——${j.problems.join('；')}`);
  if (j.missing.length) return line('missing', key, `缺失——没登记 ${j.missing.join('、')}，钩子没装${who}`);
  return line('ok', key, `${describe(t)} 都登记了，别的 ${j.others} 条钩子不归本脚本管${who}`);
}

export function checkHooks(ctx: Ctx, src: Sources, skip?: HookSkip): Line[] {
  const targets = wanted(ctx, skip);
  const out: Line[] = [];
  if (targets.length === 0) {
    out.push(line('skip', scriptsKey(ctx).key, noneLine()));
  } else {
    out.push(checkScripts(ctx, src));
    for (const t of targets) out.push(checkSettings(ctx, t));
  }
  return [...out, ...skipLines(skip), ...gapLines(ctx)];
}

function applyScripts(ctx: Ctx, src: Sources): Line {
  const { abs, key } = scriptsKey(ctx);
  if (!src.hooks.ok) return line('failed', key, `没做成——${src.hooks.why}`);
  try {
    const st = lstatOrNull(abs);
    const same =
      st?.isDirectory() === true && !st.isSymbolicLink() && sameTree(src.hooks.tree, readTree(abs).files);
    if (same) {
      return line('ok', key, `${src.hooks.tree.size} 个文件和仓里的 agents/hooks/ 一样`);
    }
    if (st !== null) removeEntry(abs);
    writeTree(abs, src.hooks.tree);
    return line(
      'changed',
      key,
      `${st === null ? '装上了' : '换成了仓里的版本'}（${[...src.hooks.tree.keys()].sort().join('、')}）`,
    );
  } catch (err) {
    return line('failed', key, `没做成——${code(err)}`);
  }
}

/** 去掉本脚本管的（含以前手装的），再按仓里的登记一遍；别的钩子原样留着。flat 格式（Cursor）没有分组，
 * hooks[event] 数组里直接是 handler，本脚本管的挑出来就地删掉即可，不用剥分组。 */
function merged(root: Obj, t: HookTarget, home: string, platform: Platform): Obj {
  const format = t.format ?? 'nested';
  const next = structuredClone(root);
  const hooks: Obj = isObj(next.hooks) ? next.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    if (format === 'flat') {
      const left = groups.filter((h) => !(isObj(h) && ownedScript(h.command)));
      if (left.length === 0) delete hooks[event];
      else hooks[event] = left;
      continue;
    }
    let removed = false;
    const kept = groups.filter((g) => {
      if (!isObj(g) || !Array.isArray(g.hooks)) return true;
      const handlers: unknown[] = g.hooks;
      const left = handlers.filter((h) => !(isObj(h) && ownedScript(h.command)));
      if (left.length === handlers.length) return true;
      g.hooks = left;
      removed = true;
      return left.length > 0;
    });
    if (removed && kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  for (const spec of t.hooks) {
    const command = hookCommand(home, platform, spec.script, t.winSafeCommand === true);
    const list = Array.isArray(hooks[spec.event]) ? (hooks[spec.event] as unknown[]) : [];
    list.push(format === 'flat' ? { command, timeout: spec.timeout } : group(spec, command));
    hooks[spec.event] = list;
  }
  next.hooks = hooks;
  // Cursor 的 hooks.json 要有顶层 version（cursor.com/docs/hooks）：机器上第一次跑、文件还不在时补上
  if (format === 'flat' && next.version === undefined) next.version = 1;
  return next;
}

function group(spec: HookSpec, command: string): Obj {
  return {
    ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
    hooks: [{ type: 'command', command, timeout: spec.timeout }],
  };
}

function applySettings(ctx: Ctx, t: HookTarget, backups: Backups): Line {
  const { rel, abs, key } = relOf(ctx, t.settings);
  const who = whoFor(ctx, t);
  try {
    const read = readSettings(abs);
    if (read.kind === 'bad') return line('failed', key, `没动——${read.why}；要人看`);
    const root: unknown = read.kind === 'none' ? {} : read.root;
    if (!isObj(root)) return line('failed', key, '没动——整份不是一个 JSON 对象；要人看');
    if (root.hooks !== undefined && !isObj(root.hooks))
      return line('failed', key, '没动——hooks 不是对象；要人看');
    const before = judge(root, t, ctx.home, ctx.platform);
    const disabled = root.disableAllHooks === true;
    const fine = before.missing.length === 0 && before.problems.every((p) => p.startsWith('disableAllHooks'));
    if (fine) {
      if (disabled)
        return line(
          'failed',
          key,
          '钩子登记着，可 disableAllHooks 开着、一条都不跑（不是本脚本开的，没动它）；要人看',
        );
      return line('ok', key, `${describe(t)} 都登记了，别的 ${before.others} 条钩子不归本脚本管${who}`);
    }
    const next = merged(root, t, ctx.home, ctx.platform);
    const eol = read.kind === 'ok' && read.text.includes('\r\n') ? '\r\n' : '\n';
    const text = `${JSON.stringify(next, null, 2)}\n`.replaceAll('\n', eol);
    const saved = read.kind === 'ok' ? backups.saveFile(abs, rel.replaceAll('\\', '/')) : undefined;
    mkdirSync(dirname(abs), { recursive: true });
    writeAtomic(abs, text, undefined);
    const parts = [
      read.kind === 'none' ? '新建' : '改了',
      `登记了 ${describe(t)}`,
      ...(before.legacy > 0 ? [`换掉了以前手装的 ${before.legacy} 条`] : []),
      `别的 ${before.others} 条钩子没动`,
      ...(saved ? [`原文件备份在 ${saved}`] : []),
    ];
    const done = `${parts.join('，')}${who}`;
    if (disabled)
      return line(
        'failed',
        key,
        `${done}；可 disableAllHooks 开着、一条都不跑（不是本脚本开的，没动它），要人看`,
      );
    return line('changed', key, done);
  } catch (err) {
    return line('failed', key, `没做成——${code(err)}`);
  }
}

export function applyHooks(ctx: Ctx, src: Sources, backups: Backups, skip?: HookSkip): Line[] {
  const targets = wanted(ctx, skip);
  const out: Line[] = [];
  if (targets.length === 0) {
    out.push(line('skip', scriptsKey(ctx).key, noneLine()));
    return [...out, ...skipLines(skip), ...gapLines(ctx)];
  }
  const scripts = applyScripts(ctx, src);
  out.push(scripts);
  for (const t of targets) {
    if (scripts.kind === 'failed') {
      out.push(line('failed', relOf(ctx, t.settings).key, '没动——钩子脚本没装上，不登记指向空处的命令'));
      continue;
    }
    const missingScript = t.hooks.find((h) => src.hooks.ok && !src.hooks.tree.has(h.script));
    if (missingScript) {
      out.push(
        line('failed', relOf(ctx, t.settings).key, `没动——仓里的 agents/hooks/ 没有 ${missingScript.script}`),
      );
      continue;
    }
    out.push(applySettings(ctx, t, backups));
  }
  return [...out, ...skipLines(skip), ...gapLines(ctx)];
}
