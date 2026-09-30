// 权限：agents/config/claude-permissions.json 里的 defaultMode、allow、deny、additionalDirectories 合进 ~/.claude/settings.json 的 permissions。
// allow、deny、additionalDirectories 按并集合并：仓里有、机器上没有的补上，机器上自己加的不删；只有 retired 里写明的才摘。
// defaultMode 归本脚本管、每次覆盖。allow 和 deny 里同一条落在相反的两边、类型不对这类不能自动定的，只报漂移、写的时候整份不动，不猜着改。
// 设置文件读不懂（不是 JSON、整份不是对象、permissions 不是对象）就不动，报没做成——不当成空的重写。
// 仓里的源文件读不到、不合规矩（含 bypassPermissions）也报没查成、没做成，不拿空的顶上。
// 合并那套（judge、merged、checkJson、applyJson）不只给 Claude 用：Devin 的 config.json 也是 permissions.allow/deny 三个数组，
// 见 permissions-vendors.ts，翻译成它的写法后走同一套。
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Backups } from './backup.ts';
import { readSettings } from './hooks.ts';
import { type Line, line } from './report.ts';
import { type Ctx, code, relOf, type Sources, writeAtomic } from './sync.ts';
import { PERMISSIONS_TARGET, type Place } from './targets.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 要合进一份 JSON 设置的那几项：defaultMode 不写就不管模式（Devin 那边文档没说清模式键在不在 config.json 里） */
export interface ListSpec {
  defaultMode?: string;
  additionalDirectories: string[];
  allow: string[];
  deny: string[];
  /** 从 allow、deny 里摘掉的（两边都摘） */
  retired: string[];
}

/** 仓里 agents/config/claude-permissions.json 认出来的样子 */
export interface PermSpec extends ListSpec {
  defaultMode: string;
}

/** 不许同步下去的模式：一台机器上的会话全放开检查，不能靠仓里一份文件推给所有机器 */
const FORBIDDEN_MODES = ['bypassPermissions'];

export type PermSource = { ok: true; value: PermSpec } | { ok: false; why: string };

function strings(v: unknown, name: string): string[] | string {
  if (!Array.isArray(v)) return `${name} 不是数组`;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || x.trim() === '') return `${name} 里有不是非空字符串的项`;
    if (out.includes(x)) return `${name} 里「${x}」写了两遍`;
    out.push(x);
  }
  return out;
}

/** 认仓里的源文件；home 用来展开 ${HOME}（换成这台的家目录，路径分隔符按这台的平台） */
export function parsePermissions(text: string, home: string): PermSource {
  let root: unknown;
  try {
    root = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    return { ok: false, why: `不是合法的 JSON（${(err as Error).message}）` };
  }
  if (!isObj(root)) return { ok: false, why: '整份不是一个 JSON 对象' };
  const mode = root.defaultMode;
  if (typeof mode !== 'string' || mode === '') return { ok: false, why: 'defaultMode 没写或不是字符串' };
  if (FORBIDDEN_MODES.includes(mode)) return { ok: false, why: `defaultMode 不许写 ${mode}` };
  const lists: Record<string, string[]> = {};
  for (const name of ['additionalDirectories', 'allow', 'deny', 'retired']) {
    const got = strings(root[name], name);
    if (typeof got === 'string') return { ok: false, why: got };
    lists[name] = got;
  }
  const allow = lists.allow as string[];
  const deny = lists.deny as string[];
  const retired = lists.retired as string[];
  const both = allow.find((a) => deny.includes(a));
  if (both) return { ok: false, why: `「${both}」同时在 allow 和 deny 里` };
  const gone = retired.find((r) => allow.includes(r) || deny.includes(r));
  if (gone) return { ok: false, why: `「${gone}」既在 retired 里、又还在 allow 或 deny 里` };
  const dirs = (lists.additionalDirectories as string[]).map((d) =>
    d.startsWith('${HOME}') ? join(home, d.slice('${HOME}'.length)) : d,
  );
  return { ok: true, value: { defaultMode: mode, additionalDirectories: dirs, allow, deny, retired } };
}

/** 机器上 permissions 一处和源文件对不上的地方 */
export interface Diff {
  /** 该有、没有的（defaultMode 没写也算） */
  missing: string[];
  /** 读到了但要改的：已退役的还留着、defaultMode 不一样 */
  drift: string[];
  /** 本脚本不替人定的：allow 和 deny 相反、类型不对 */
  stuck: string[];
  /** 机器上自己加的、不归本脚本管的条数 */
  others: number;
}

const LISTS = ['allow', 'deny', 'additionalDirectories'] as const;

/** 逐项对：root 是整份设置文件 */
export function judge(root: unknown, spec: ListSpec): Diff {
  const out: Diff = { missing: [], drift: [], stuck: [], others: 0 };
  if (!isObj(root)) {
    out.stuck.push('整份不是一个 JSON 对象');
    return out;
  }
  const have = root.permissions;
  if (have !== undefined && !isObj(have)) {
    out.stuck.push('permissions 不是对象');
    return out;
  }
  const perm: Obj = have ?? {};
  if (spec.defaultMode !== undefined) {
    if (perm.defaultMode === undefined) out.missing.push(`defaultMode（该是 ${spec.defaultMode}）`);
    else if (perm.defaultMode !== spec.defaultMode)
      out.drift.push(`defaultMode 是 ${JSON.stringify(perm.defaultMode)}，该是 ${spec.defaultMode}`);
  }
  for (const name of LISTS) {
    const cur = perm[name];
    if (cur !== undefined && !Array.isArray(cur)) {
      out.stuck.push(`${name} 不是数组`);
      continue;
    }
    const list: unknown[] = cur ?? [];
    const want = spec[name];
    const missing = want.filter((w) => !list.includes(w));
    if (missing.length) out.missing.push(`${name} 少 ${missing.length} 条（${missing.join('、')}）`);
    const retired = list.filter((x): x is string => typeof x === 'string' && spec.retired.includes(x));
    if (name !== 'additionalDirectories' && retired.length)
      out.drift.push(`${name} 还留着已退役的 ${retired.join('、')}`);
    // 相反的一边：allow 里出现仓里要 deny 的，或反过来
    const opposite = name === 'allow' ? spec.deny : name === 'deny' ? spec.allow : [];
    const clash = list.filter((x): x is string => typeof x === 'string' && opposite.includes(x));
    if (clash.length)
      out.stuck.push(`${name} 里有仓里放在另一边的 ${clash.join('、')}（allow 和 deny 相反）`);
    out.others += list.filter(
      (x) => !want.includes(x as string) && !spec.retired.includes(x as string),
    ).length;
  }
  return out;
}

/** 去掉已退役的、补上仓里有而机器上没有的；别的一条不碰 */
export function merged(root: Obj, spec: ListSpec): Obj {
  const next = structuredClone(root);
  const perm: Obj = isObj(next.permissions) ? next.permissions : {};
  if (spec.defaultMode !== undefined) perm.defaultMode = spec.defaultMode;
  for (const name of LISTS) {
    // 仓里这项是空的、机器上也没有：不凭空建一个空数组
    if (spec[name].length === 0 && !Array.isArray(perm[name])) continue;
    const list: unknown[] = Array.isArray(perm[name]) ? (perm[name] as unknown[]) : [];
    const kept =
      name === 'additionalDirectories' ? list : list.filter((x) => !spec.retired.includes(x as string));
    for (const w of spec[name]) if (!kept.includes(w)) kept.push(w);
    perm[name] = kept;
  }
  next.permissions = perm;
  return next;
}

/** 查一份 JSON 设置里的 permissions；key 是报告里这一项的名字，noFile 是文件不存在时说的话 */
export function checkJson(abs: string, key: string, spec: ListSpec, noFile: string): Line[] {
  let read: ReturnType<typeof readSettings>;
  try {
    read = readSettings(abs);
  } catch (err) {
    return [line('unknown', key, `没查成——读不了（${code(err)}）`)];
  }
  if (read.kind === 'none') return [line('missing', key, `缺失——没有这个文件，${noFile}`)];
  if (read.kind === 'bad') return [line('drift', key, `漂移——${read.why}，权限等于没装`)];
  const d = judge(read.root, spec);
  const bad = [...d.stuck, ...d.drift];
  if (bad.length) return [line('drift', key, `漂移——${bad.join('；')}`)];
  if (d.missing.length) return [line('missing', key, `缺失——${d.missing.join('；')}`)];
  return [
    line(
      'ok',
      key,
      `${spec.defaultMode === undefined ? '' : `defaultMode ${spec.defaultMode}、`}allow ${spec.allow.length} 条、deny ${spec.deny.length} 条都在，机器上自己加的 ${d.others} 条没动`,
    ),
  ];
}

/** 写一份 JSON 设置里的 permissions：补缺、摘退役的，别的不碰；读不懂、相反的整份不动 */
export function applyJson(ctx: Ctx, place: Place, key: string, spec: ListSpec, backups: Backups): Line[] {
  const { rel, abs } = relOf(ctx, place);
  try {
    const read = readSettings(abs);
    if (read.kind === 'bad') return [line('failed', key, `没动——${read.why}；要人看`)];
    const root: unknown = read.kind === 'none' ? {} : read.root;
    const before = judge(root, spec);
    if (before.stuck.length) return [line('failed', key, `没动——${before.stuck.join('；')}；要人看`)];
    if (before.missing.length === 0 && before.drift.length === 0)
      return [line('ok', key, `已经一致，机器上自己加的 ${before.others} 条没动`)];
    const next = merged(root as Obj, spec);
    const eol = read.kind === 'ok' && read.text.includes('\r\n') ? '\r\n' : '\n';
    const text = `${JSON.stringify(next, null, 2)}\n`.replaceAll('\n', eol);
    const saved = read.kind === 'ok' ? backups.saveFile(abs, rel.replaceAll('\\', '/')) : undefined;
    mkdirSync(dirname(abs), { recursive: true });
    writeAtomic(abs, text, undefined);
    const parts = [
      read.kind === 'none' ? '新建' : '改了',
      [...before.missing, ...before.drift].join('；'),
      `机器上自己加的 ${before.others} 条没动`,
      ...(saved ? [`原文件备份在 ${saved}`] : []),
    ];
    return [line('changed', key, parts.join('，'))];
  } catch (err) {
    return [line('failed', key, `没做成——${code(err)}`)];
  }
}

const KEY = (ctx: Ctx): string => `${relOf(ctx, PERMISSIONS_TARGET.settings).key}#permissions`;

/** 这台有没有装读它的那家 */
const wanted = (ctx: Ctx): boolean => PERMISSIONS_TARGET.readers.some((r) => ctx.installed.has(r));

/** 这次整段不写的原因（--user 替别的用户写时给），不写就只报一行 skip */
export type PermSkip = string;

/** 仓里的源文件认出来；读不到或不合规矩就是没认成，说清为什么 */
export function permissionSource(ctx: Ctx, src: Sources): PermSource {
  if (!src.permissions.ok) return src.permissions;
  return parsePermissions(src.permissions.text, ctx.home);
}

export function checkPermissions(ctx: Ctx, src: Sources, skip?: PermSkip): Line[] {
  const key = KEY(ctx);
  if (skip) return [line('skip', key, skip)];
  if (!wanted(ctx)) return [line('skip', key, '没装 Claude Code，跳过')];
  const spec = permissionSource(ctx, src);
  if (!spec.ok)
    return [line('unknown', key, `没查成——仓里的 agents/config/claude-permissions.json：${spec.why}`)];
  return checkJson(
    relOf(ctx, PERMISSIONS_TARGET.settings).abs,
    key,
    spec.value,
    '权限（defaultMode、allow、deny）没装',
  );
}

export function applyPermissions(ctx: Ctx, src: Sources, backups: Backups, skip?: PermSkip): Line[] {
  const key = KEY(ctx);
  if (skip) return [line('skip', key, skip)];
  if (!wanted(ctx)) return [line('skip', key, '没装 Claude Code，跳过')];
  const spec = permissionSource(ctx, src);
  if (!spec.ok)
    return [line('failed', key, `没做成——仓里的 agents/config/claude-permissions.json：${spec.why}`)];
  return applyJson(ctx, PERMISSIONS_TARGET.settings, key, spec.value, backups);
}
