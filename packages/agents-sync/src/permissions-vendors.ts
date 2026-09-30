// 其他几家 AI 的权限：仓里那一份权限意图（agents/config/claude-permissions.json，Claude 的写法）翻译成各家自己的配置格式。
// 各家的位置、格式、依据见 targets.ts 的 KIMI_PERMISSIONS 那一段。三种写法：
// - Kimi、Codex：文本文件里一块「托管块」（BEGIN/END 两行注释圈起来，块里整块由本脚本写、块外一个字不碰）；Kimi 另有顶层一行 default_permission_mode。
// - Devin：JSON，permissions.allow/deny 两个数组，和 Claude 那份走同一套合并（permissions.ts 的 judge、merged）：补缺、不删自己加的。
// - Grok 不用翻译：它直接读 ~/.claude/settings.json 的 permissions；别的几家做不到的在 targets.ts 的 PERMISSION_GAPS 里说明。
// 翻译不了的规则（这家没有对应的工具或写法）不硬翻：数出来在报告里说「有几条没同步」。
// 文本读不懂（多行字符串、托管块的两行标记缺一行或重复）就不动、报没做成，不猜着改。
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Backups } from './backup.ts';
import {
  applyJson,
  checkJson,
  type ListSpec,
  type PermSkip,
  type PermSpec,
  permissionSource,
} from './permissions.ts';
import { type Line, line } from './report.ts';
import { type Ctx, code, lstatOrNull, relOf, type Sources, writeAtomic } from './sync.ts';
import {
  AGENTS,
  type AgentId,
  agentNames,
  CODEX_PERMISSIONS,
  DEVIN_PERMISSIONS,
  KIMI_PERMISSIONS,
  PERMISSION_GAPS,
  type Place,
  slashed,
} from './targets.ts';
import { linkTarget } from './tree.ts';

// ───────────────────────── 翻译 ─────────────────────────

/** Claude 写法的一条规则拆成工具名和括号里的参数（没有括号 = 整个工具） */
export function parseRule(rule: string): { tool: string; arg: string | null } {
  const m = /^([A-Za-z_][\w]*)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m?.[1]) return { tool: rule.trim(), arg: null };
  return { tool: m[1], arg: m[2] ?? null };
}

/** Bash(git:*)、PowerShell(git:*)：返回命令名 git；带空格、通配在中间这类别的写法返回 null */
export function shellPrefix(rule: string): string | null {
  const p = parseRule(rule);
  if ((p.tool !== 'Bash' && p.tool !== 'PowerShell') || p.arg === null) return null;
  return /^([\w.-]+):\*$/.exec(p.arg)?.[1] ?? null;
}

export interface Translated {
  allow: string[];
  deny: string[];
  retired: string[];
  /** 这家没有对应写法、没同步的规则条数（allow 和 deny 里的，按 Claude 的写法数） */
  skipped: number;
}

type Mapper = (rule: string) => string | null;

function translate(spec: PermSpec, map: Mapper): Translated | string {
  let skipped = 0;
  const conv = (list: string[], count: boolean): string[] => {
    const out: string[] = [];
    for (const r of list) {
      const m = map(r);
      if (m === null) {
        if (count) skipped++;
      } else if (!out.includes(m)) out.push(m);
    }
    return out;
  };
  const allow = conv(spec.allow, true);
  const deny = conv(spec.deny, true);
  const retired = conv(spec.retired, false);
  const both = allow.find((a) => deny.includes(a));
  if (both) return `翻译后「${both}」既在放行里、又在拒绝里`;
  return { allow, deny, retired, skipped };
}

const KIMI_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit'];

/** Kimi：工具名照抄（只认它文档里列的），Bash(git:*) → Bash(git *) */
export const toKimi: Mapper = (rule) => {
  const cmd = shellPrefix(rule);
  if (cmd) return `Bash(${cmd} *)`;
  const p = parseRule(rule);
  return p.arg === null && KIMI_TOOLS.includes(p.tool) ? p.tool : null;
};

/** Codex：只有命令前缀（Bash、PowerShell 的 x:* 都翻成 x），别的工具 Codex 的规则管不到 */
export const toCodex: Mapper = (rule) => shellPrefix(rule);

/** Devin：Bash(git:*) → Exec(git)，Read → Read(**)，Write、Edit → Write(**)，Grep、Glob → 工具名小写 */
export const toDevin: Mapper = (rule) => {
  const cmd = shellPrefix(rule);
  if (cmd) return `Exec(${cmd})`;
  const p = parseRule(rule);
  if (p.arg !== null) return null;
  if (p.tool === 'Read') return 'Read(**)';
  if (p.tool === 'Write' || p.tool === 'Edit') return 'Write(**)';
  if (p.tool === 'Grep') return 'grep';
  if (p.tool === 'Glob') return 'glob';
  return null;
};

// ───────────────────────── 托管块 ─────────────────────────

const BEGIN =
  '# >>> fleet-dao 权限（同步脚本管：改它改仓里 agents/config/claude-permissions.json，块里手改的下次会被覆盖；块外的内容不碰）';
const END = '# <<< fleet-dao 权限';
const isBegin = (l: string): boolean => l.trim().startsWith('# >>> fleet-dao 权限');
const isEnd = (l: string): boolean => l.trim().startsWith('# <<< fleet-dao 权限');

type Found = { kind: 'none' } | { kind: 'ok'; start: number; end: number } | { kind: 'bad'; why: string };

function findBlock(lines: string[]): Found {
  const begins = lines.flatMap((l, i) => (isBegin(l) ? [i] : []));
  const ends = lines.flatMap((l, i) => (isEnd(l) ? [i] : []));
  if (begins.length === 0 && ends.length === 0) return { kind: 'none' };
  const [start] = begins;
  const [end] = ends;
  if (begins.length !== 1 || ends.length !== 1 || start === undefined || end === undefined || end < start)
    return { kind: 'bad', why: '托管块的开头、结尾两行标记缺一行、重复或颠倒了' };
  return { kind: 'ok', start, end };
}

const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');
const splitLines = (text: string): string[] => text.split(/\r?\n/);

/** 把托管块换成 body（没有就接在文件末尾）；返回新文本，已经一样返回 null */
function withBlock(
  text: string,
  body: string[],
): { ok: true; text: string | null } | { ok: false; why: string } {
  const lines = splitLines(text);
  const found = findBlock(lines);
  if (found.kind === 'bad') return { ok: false, why: found.why };
  const block = [BEGIN, ...body, END];
  if (found.kind === 'ok') {
    const have = lines.slice(found.start, found.end + 1);
    if (have.length === block.length && have.every((l, i) => l.trimEnd() === (block[i] as string).trimEnd()))
      return { ok: true, text: null };
    lines.splice(found.start, found.end - found.start + 1, ...block);
    return { ok: true, text: lines.join(eolOf(text)) };
  }
  // 文件末尾是空行（以换行结尾）时 split 出来最后一个是 ''，块插在它前面，末尾照旧只一个换行
  const tail = lines.length > 0 && lines[lines.length - 1] === '' ? lines.pop() : undefined;
  if (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() !== '') lines.push('');
  lines.push(...block, tail ?? '');
  return { ok: true, text: lines.join(eolOf(text)) };
}

// ───────────────────────── Kimi 的 default_permission_mode ─────────────────────────

const KIMI_MODE = '"yolo"';
const KIMI_MODE_WHY =
  '# fleet-dao 同步脚本管：yolo = 日常编辑和命令自动跑、危险的仍问（Kimi 的 auto 是什么都不问，不用）';

/** 顶层那行 default_permission_mode（第一个 [表头] 之前）：不对就改成 yolo，没有就加在文件最前面 */
function withKimiMode(
  text: string,
): { ok: true; text: string | null; state: 'ok' | 'missing' | 'drift' } | { ok: false; why: string } {
  if (text.includes('"""') || text.includes("'''"))
    return { ok: false, why: '有多行字符串，逐行认不准哪行是表头' };
  const lines = splitLines(text);
  const table = lines.findIndex((l) => /^\s*\[/.test(l));
  const top = table === -1 ? lines.length : table;
  const hits: { i: number; value: string }[] = [];
  for (let i = 0; i < top; i++) {
    const m = /^\s*default_permission_mode\s*=\s*(.*)$/.exec(lines[i] ?? '');
    if (m) hits.push({ i, value: (m[1] ?? '').replace(/\s+#.*$/, '').trim() });
  }
  if (hits.length > 1) return { ok: false, why: 'default_permission_mode 写了不止一遍' };
  const hit = hits[0];
  if (hit) {
    if (hit.value === KIMI_MODE) return { ok: true, text: null, state: 'ok' };
    lines[hit.i] = `default_permission_mode = ${KIMI_MODE}`;
    return { ok: true, text: lines.join(eolOf(text)), state: 'drift' };
  }
  const head = [KIMI_MODE_WHY, `default_permission_mode = ${KIMI_MODE}`];
  if ((lines[0] ?? '') !== '' || lines.length > 1) head.push('');
  return { ok: true, text: [...head, ...lines].join(eolOf(text)), state: 'missing' };
}

// ───────────────────────── 文本类两家（Kimi、Codex）的查和写 ─────────────────────────

interface TextVendor {
  id: 'kimi' | 'codex';
  name: string;
  target: { file: Place; readers: readonly AgentId[] };
  map: Mapper;
  /** 托管块里的几行 */
  body: (t: Translated) => string[];
  /** 块以外还要管的（Kimi 的默认模式）：返回新文本和状态 */
  extra?: (text: string) => ReturnType<typeof withKimiMode>;
}

const q = JSON.stringify;

const KIMI: TextVendor = {
  id: 'kimi',
  name: 'Kimi Code',
  target: KIMI_PERMISSIONS,
  map: toKimi,
  // 先匹配的生效：拒绝排在放行前面
  body: (t) => [
    ...t.deny.flatMap((p) => ['[[permission.rules]]', 'decision = "deny"', `pattern = ${q(p)}`, '']),
    ...t.allow.flatMap((p) => ['[[permission.rules]]', 'decision = "allow"', `pattern = ${q(p)}`, '']),
  ],
  extra: withKimiMode,
};

const CODEX: TextVendor = {
  id: 'codex',
  name: 'Codex',
  target: CODEX_PERMISSIONS,
  map: toCodex,
  // 几条同时命中取最严的（forbidden > prompt > allow），顺序无所谓
  body: (t) => [
    ...t.deny.map((c) => `prefix_rule(pattern=[${q(c)}], decision="forbidden")`),
    ...t.allow.map((c) => `prefix_rule(pattern=[${q(c)}], decision="allow")`),
  ],
};

type Planned =
  | { ok: false; why: string }
  | { ok: true; next: string; problems: { kind: 'missing' | 'drift'; text: string }[] };

/** 该有的文本是什么样、和现在差在哪 */
function plan(v: TextVendor, before: string, t: Translated): Planned {
  let text = before;
  const problems: { kind: 'missing' | 'drift'; text: string }[] = [];
  if (v.extra) {
    const m = v.extra(text);
    if (!m.ok) return m;
    if (m.text !== null) {
      text = m.text;
      problems.push({
        kind: m.state === 'drift' ? 'drift' : 'missing',
        text: m.state === 'drift' ? 'default_permission_mode 不是 yolo' : '没有 default_permission_mode',
      });
    }
  }
  const b = withBlock(text, v.body(t));
  if (!b.ok) return b;
  if (b.text !== null) {
    problems.push({ kind: 'drift', text: '规则块和仓里的不一样' });
    text = b.text;
  }
  return { ok: true, next: text, problems };
}

type FileRead = { kind: 'absent' } | { kind: 'text'; text: string } | { kind: 'bad'; why: string };

function readText(abs: string): FileRead {
  const st = lstatOrNull(abs);
  if (st === null) return { kind: 'absent' };
  if (st.isSymbolicLink())
    return { kind: 'bad', why: `这是个链接（→ ${linkTarget(abs)}），不是本脚本能改的文件` };
  if (!st.isFile()) return { kind: 'bad', why: '这里不是文件' };
  return { kind: 'text', text: readFileSync(abs, 'utf8').replace(/^﻿/, '') };
}

const skippedNote = (n: number): string =>
  n > 0 ? `；另有 ${n} 条 Claude 的规则这家没有对应写法、没同步` : '';

function checkText(ctx: Ctx, v: TextVendor, t: Translated): Line[] {
  const { abs, key: file } = relOf(ctx, v.target.file);
  const key = `${file}#permission`;
  let read: FileRead;
  try {
    read = readText(abs);
  } catch (err) {
    return [line('unknown', key, `没查成——读不了（${code(err)}）`)];
  }
  if (read.kind === 'bad') return [line('drift', key, `漂移——${read.why}`)];
  if (read.kind === 'absent') return [line('missing', key, `缺失——没有这个文件，${v.name} 的权限没装`)];
  const p = plan(v, read.text, t);
  if (!p.ok) return [line('unknown', key, `没查成——${p.why}`)];
  if (p.problems.length === 0)
    return [
      line('ok', key, `拒绝 ${t.deny.length} 条、放行 ${t.allow.length} 条都在${skippedNote(t.skipped)}`),
    ];
  const drift = p.problems.some((x) => x.kind === 'drift');
  return [
    line(
      drift ? 'drift' : 'missing',
      key,
      `${drift ? '漂移' : '缺失'}——${p.problems.map((x) => x.text).join('；')}`,
    ),
  ];
}

function applyText(ctx: Ctx, v: TextVendor, t: Translated, backups: Backups): Line[] {
  const { rel, abs, key: file } = relOf(ctx, v.target.file);
  const key = `${file}#permission`;
  try {
    const read = readText(abs);
    if (read.kind === 'bad') return [line('failed', key, `没动——${read.why}；要人看`)];
    const before = read.kind === 'text' ? read.text : '';
    const p = plan(v, before, t);
    if (!p.ok) return [line('failed', key, `没动——${p.why}；要人看`)];
    if (p.problems.length === 0)
      return [
        line('ok', key, `拒绝 ${t.deny.length} 条、放行 ${t.allow.length} 条都在${skippedNote(t.skipped)}`),
      ];
    const saved = read.kind === 'text' ? backups.saveFile(abs, slashed(rel)) : undefined;
    mkdirSync(dirname(abs), { recursive: true });
    writeAtomic(abs, p.next, undefined);
    return [
      line(
        'changed',
        key,
        [
          read.kind === 'absent' ? '新建' : '改了',
          `${p.problems.map((x) => x.text).join('；')}（拒绝 ${t.deny.length} 条、放行 ${t.allow.length} 条${skippedNote(t.skipped)}）`,
          ...(saved ? [`原文件备份在 ${saved}`] : []),
        ].join('，'),
      ),
    ];
  } catch (err) {
    return [line('failed', key, `没做成——${code(err)}`)];
  }
}

// ───────────────────────── 入口 ─────────────────────────

const TEXT_VENDORS = [KIMI, CODEX] as const;

function devinSpec(t: Translated): ListSpec {
  return { additionalDirectories: [], allow: t.allow, deny: t.deny, retired: t.retired };
}

/** 装了、但权限没接的各家，逐家一行为什么 */
function gapLines(ctx: Ctx): Line[] {
  const out: Line[] = [];
  for (const [id, why] of Object.entries(PERMISSION_GAPS) as [keyof typeof AGENTS, string][]) {
    if (ctx.installed.has(id)) out.push(line('skip', `${AGENTS[id].name} 的权限`, why));
  }
  return out;
}

const SECTION_KEY = '其他几家 AI 的权限';

/**
 * 查（apply 是 false）或写（true）其他几家的权限。skip 是这次整段不写的原因（--user 替别的用户写时给）。
 * 仓里的源文件读不到、翻译后自相矛盾：装了的各家都报没查成 / 没做成，不当成没事。
 */
function run(ctx: Ctx, src: Sources, apply: Backups | null, skip?: PermSkip): Line[] {
  if (skip) return [line('skip', SECTION_KEY, skip)];
  const spec = permissionSource(ctx, src);
  const out: Line[] = [];
  const bad = (name: string, why: string, file: Place): Line =>
    line(
      apply ? 'failed' : 'unknown',
      `${relOf(ctx, file).key}#permission`,
      `${apply ? '没做成' : '没查成'}——${name}：${why}`,
    );
  const targets = [
    ...TEXT_VENDORS.map((v) => ({ id: v.id, name: v.name, file: v.target.file, readers: v.target.readers })),
    { id: 'devin', name: 'Devin', file: DEVIN_PERMISSIONS.file, readers: DEVIN_PERMISSIONS.readers },
  ];
  for (const t of targets) {
    if (!t.readers.some((r) => ctx.installed.has(r))) {
      out.push(
        line('skip', `${relOf(ctx, t.file).key}#permission`, `没装（${agentNames(t.readers)}），跳过`),
      );
      continue;
    }
    if (!spec.ok) {
      out.push(bad(t.name, `仓里的 agents/config/claude-permissions.json：${spec.why}`, t.file));
      continue;
    }
    const map: Mapper = t.id === 'kimi' ? toKimi : t.id === 'codex' ? toCodex : toDevin;
    const tr = translate(spec.value, map);
    if (typeof tr === 'string') {
      out.push(bad(t.name, tr, t.file));
      continue;
    }
    if (t.id === 'devin') {
      const { abs, key: file } = relOf(ctx, DEVIN_PERMISSIONS.file);
      const key = `${file}#permissions`;
      out.push(
        ...(apply
          ? applyJson(ctx, DEVIN_PERMISSIONS.file, key, devinSpec(tr), apply)
          : checkJson(abs, key, devinSpec(tr), 'Devin 的权限（allow、deny）没装')),
      );
      continue;
    }
    const v = t.id === 'kimi' ? KIMI : CODEX;
    out.push(...(apply ? applyText(ctx, v, tr, apply) : checkText(ctx, v, tr)));
  }
  return [...out, ...gapLines(ctx)];
}

export function checkOtherPermissions(ctx: Ctx, src: Sources, skip?: PermSkip): Line[] {
  return run(ctx, src, null, skip);
}

export function applyOtherPermissions(ctx: Ctx, src: Sources, backups: Backups, skip?: PermSkip): Line[] {
  return run(ctx, src, backups, skip);
}
