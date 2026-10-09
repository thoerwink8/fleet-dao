// Codex 的钩子要信任了才跑（learn.chatgpt.com/docs/hooks「Trust & review」）。
// 非托管的每条钩子，Codex 按它规整后的定义算一个 sha256，和 ~/.codex/config.toml 里
// [hooks.state."<hooks.json 绝对路径>:<蛇形事件名>:<组序号>:<条序号>"] 的 trusted_hash 比：对不上（没信任、改过）就跳过不跑。
// 本脚本替自己登记的那几条记上信任，和人在 Codex 里 /hooks 点「信任」写的是同一个值。
// 为什么不等人点：法国会话用户、无人值守的会话没人去点，不记上拦命令那条就从来不跑（Claude 那份不用信任）。
// 信任的来源和 Claude 那份一样，是仓里 origin/main 的钩子；Codex 自己装插件时也替插件的钩子记信任
// （codex-rs/app-server/src/effective_plugin_change.rs 的 hook_trusted_hash_edit）。
// 只信任本脚本登记的那几条，别的钩子一条不碰。人在 /hooks 里关掉的（enabled = false）不替人打开，报出来。
// 哈希的算法照 codex-rs/hooks/src/engine/discovery.rs 的 hook_hash 和 codex-rs/config/src/fingerprint.rs 的 version_for_toml：
// { event_name, matcher?, hooks: [{ type, command, timeout, async }] } 的键按字母排好，紧凑 JSON 的 sha256。
// 2026-10-09 用本机 codex 0.162 的 app-server hooks/list 核过两条（有 matcher 的、没 matcher 的），算得和它报的 currentHash 一样。
// config.toml 只逐行认这几样：表头、键值、多行字符串和跨行数组（跳过）。认不准的（数组表、内联表、用点号写在别处的）就不动，
// 报出来，不猜。新记的信任写在文件末尾一块托管块里（两行注释圈起来），块外的只改本脚本那几条的 trusted_hash 一行。
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Backups } from './backup.ts';
import { type Line, line } from './report.ts';
import { type Ctx, code, lstatOrNull, relOf, writeAtomic } from './sync.ts';
import { CODEX_CONFIG, type HookSpec, slashed } from './targets.ts';
import { linkTarget } from './tree.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Codex 记信任时用的蛇形事件名（codex-rs/hooks/src/lib.rs 的 hook_event_key_label） */
const EVENT_LABEL: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'stop',
  Interrupt: 'interrupt',
};

/** 这几个事件 Codex 不看 matcher，算哈希时也不带（codex-rs/hooks/src/events/common.rs 的 matcher_pattern_for_event） */
const NO_MATCHER = new Set(['UserPromptSubmit', 'Stop', 'Interrupt']);

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (isObj(v))
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortDeep(v[k])]),
    );
  return v;
}

/** 一条命令钩子在 Codex 眼里的哈希（本脚本登记的只有 type、command、timeout 三个字段，async 恒为 false） */
export function codexHookHash(
  event: string,
  matcher: string | undefined,
  command: string,
  timeout: number,
): string {
  const identity = {
    event_name: EVENT_LABEL[event] ?? event,
    ...(matcher === undefined || NO_MATCHER.has(event) ? {} : { matcher }),
    hooks: [{ type: 'command', command, timeout, async: false }],
  };
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortDeep(identity)))
    .digest('hex')}`;
}

/**
 * 键里那段 hooks.json 路径。Codex 把它规整成真实路径：Windows 上 8.3 短名（ADMINI~1）展开成长名、链接解开
 * （2026-10-09 本机核过：家目录给短名时 Codex 报的键是长名）。本脚本跟着规整；文件、目录都还没有就原样用。
 */
export function codexSourcePath(abs: string): string {
  try {
    return realpathSync.native(abs);
  } catch {
    try {
      return join(realpathSync.native(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

/** 本脚本登记的一条要信任的钩子 */
export interface TrustNeed {
  /** [hooks.state."…"] 里的那个键 */
  key: string;
  hash: string;
  /** 给人看：事件（脚本） */
  name: string;
}

/**
 * hooks.json 里本脚本登记的每条，在 Codex 眼里的键和哈希。键里的路径照 Codex 显示的（Windows 上是反斜杠），
 * 组序号、条序号按文件里的实际位置数（别人的钩子在前面，序号就跟着变）。没登记上的那几条放进 absent。
 */
export function trustNeeds(
  hooksJsonAbs: string,
  root: unknown,
  specs: readonly HookSpec[],
  commandOf: (script: string) => string,
): { needs: TrustNeed[]; absent: string[] } {
  const needs: TrustNeed[] = [];
  const absent: string[] = [];
  const source = codexSourcePath(hooksJsonAbs);
  const hooks = isObj(root) && isObj(root.hooks) ? root.hooks : {};
  for (const spec of specs) {
    const name = `${spec.event}（${spec.script}）`;
    const command = commandOf(spec.script);
    const groups = Array.isArray(hooks[spec.event]) ? (hooks[spec.event] as unknown[]) : [];
    let at: { g: number; h: number } | null = null;
    for (let g = 0; g < groups.length && at === null; g++) {
      const group = groups[g];
      if (!isObj(group) || !Array.isArray(group.hooks)) continue;
      if (group.matcher !== spec.matcher) continue;
      const h = group.hooks.findIndex(
        (x: unknown) => isObj(x) && x.command === command && x.timeout === spec.timeout,
      );
      if (h !== -1) at = { g, h };
    }
    if (!at) {
      absent.push(name);
      continue;
    }
    needs.push({
      key: `${source}:${EVENT_LABEL[spec.event] ?? spec.event}:${at.g}:${at.h}`,
      hash: codexHookHash(spec.event, spec.matcher, command, spec.timeout),
      name,
    });
  }
  return { needs, absent };
}

// ───────────────────────── config.toml 逐行认 ─────────────────────────

const BEGIN =
  '# >>> fleet-dao 钩子信任（同步脚本管：替它登记在 hooks.json 的几条钩子记信任，和 /hooks 里点信任一样；块里手改的下次会被覆盖，块外不碰）';
const END = '# <<< fleet-dao 钩子信任';
const isBegin = (l: string): boolean => l.trim().startsWith('# >>> fleet-dao 钩子信任');
const isEnd = (l: string): boolean => l.trim().startsWith('# <<< fleet-dao 钩子信任');

interface Value {
  /** 字符串、布尔认得出来的值；别的类型是 undefined */
  value: string | boolean | undefined;
  line: number;
}

interface StateEntry {
  /** [hooks.state."K"] 表头在第几行（没有就是用点号写在别处的） */
  header?: number;
  trustedHash?: Value;
  enabled?: Value;
  /** 这一项的哪一行在托管块里 */
  inBlock: boolean;
}

interface Scanned {
  entries: Map<string, StateEntry>;
  /** [features] hooks = false：Codex 的钩子整个关了 */
  hooksOff: boolean;
  block: { start: number; end: number } | null;
}

type ScanResult = { ok: true; value: Scanned } | { ok: false; why: string };

/** 从 s[i] 起读一个键（裸键或带引号的），返回键和读到哪 */
function readKeyPart(s: string, i: number): { key: string; next: number } | null {
  const c = s[i];
  if (c === '"') {
    let out = '';
    let j = i + 1;
    while (j < s.length) {
      const ch = s[j] as string;
      if (ch === '"') return { key: out, next: j + 1 };
      if (ch === '\\') {
        const e = s[j + 1];
        const simple: Record<string, string> = {
          '"': '"',
          '\\': '\\',
          n: '\n',
          t: '\t',
          r: '\r',
          b: '\b',
          f: '\f',
        };
        if (e !== undefined && simple[e] !== undefined) {
          out += simple[e];
          j += 2;
          continue;
        }
        const u = e === 'u' ? 4 : e === 'U' ? 8 : 0;
        if (u === 0) return null;
        const hex = s.slice(j + 2, j + 2 + u);
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== u) return null;
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        j += 2 + u;
        continue;
      }
      out += ch;
      j++;
    }
    return null;
  }
  if (c === "'") {
    const end = s.indexOf("'", i + 1);
    return end === -1 ? null : { key: s.slice(i + 1, end), next: end + 1 };
  }
  const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
  return m ? { key: m[0], next: i + m[0].length } : null;
}

/** 读一串点号连起来的键，读到 stop 里的字符为止；认不出返回 null */
function readKeyPath(s: string, i: number, stop: string): { path: string[]; next: number } | null {
  const path: string[] = [];
  let j = i;
  for (;;) {
    while (s[j] === ' ' || s[j] === '\t') j++;
    const part = readKeyPart(s, j);
    if (!part) return null;
    path.push(part.key);
    j = part.next;
    while (s[j] === ' ' || s[j] === '\t') j++;
    if (s[j] === '.') {
      j++;
      continue;
    }
    if (j < s.length && stop.includes(s[j] as string)) return { path, next: j };
    return null;
  }
}

/** 一个值从这一行开始：读出字符串、布尔；跨行的（多行字符串、数组、内联表）告诉调用方要跳到哪种结尾 */
type ValueStart =
  | { kind: 'done'; value: string | boolean | undefined; inline: boolean }
  | { kind: 'multi'; close: string }
  | { kind: 'open'; depth: number };

function readValue(s: string): ValueStart | null {
  const t = s.trimStart();
  for (const q of ['"""', "'''"]) {
    if (t.startsWith(q)) {
      const rest = t.slice(3);
      return rest.includes(q)
        ? { kind: 'done', value: undefined, inline: false }
        : { kind: 'multi', close: q };
    }
  }
  if (t.startsWith('"') || t.startsWith("'")) {
    const k = readKeyPart(t, 0);
    return k ? { kind: 'done', value: k.key, inline: false } : null;
  }
  if (/^true\b/.test(t)) return { kind: 'done', value: true, inline: false };
  if (/^false\b/.test(t)) return { kind: 'done', value: false, inline: false };
  if (t.startsWith('[') || t.startsWith('{')) {
    const depth = bracketDepth(t, 0);
    if (depth === null) return null;
    return depth === 0
      ? { kind: 'done', value: undefined, inline: t.startsWith('{') }
      : { kind: 'open', depth };
  }
  return { kind: 'done', value: undefined, inline: false };
}

/** 数一行里 [ ] { } 的深度（跳过字符串和注释），从 start 的深度接着数；字符串没收尾返回 null */
function bracketDepth(s: string, start: number): number | null {
  let depth = start;
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === '#') break;
    if (c === '"' || c === "'") {
      const k = readKeyPart(s, i);
      if (!k) return null;
      i = k.next;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    i++;
  }
  return depth;
}

const isStatePath = (p: string[]): boolean => p[0] === 'hooks' && p[1] === 'state';

/** 逐行认 config.toml 里和钩子信任有关的几处 */
export function scanCodexConfig(text: string): ScanResult {
  const lines = text.split(/\r?\n/);
  const entries = new Map<string, StateEntry>();
  const entry = (k: string): StateEntry => {
    let e = entries.get(k);
    if (!e) {
      e = { inBlock: false };
      entries.set(k, e);
    }
    return e;
  };
  const begins = lines.flatMap((l, i) => (isBegin(l) ? [i] : []));
  const ends = lines.flatMap((l, i) => (isEnd(l) ? [i] : []));
  let block: { start: number; end: number } | null = null;
  if (begins.length > 0 || ends.length > 0) {
    const [start] = begins;
    const [end] = ends;
    if (begins.length !== 1 || ends.length !== 1 || start === undefined || end === undefined || end < start)
      return { ok: false, why: '钩子信任那块托管块的开头、结尾两行标记缺一行、重复或颠倒了' };
    block = { start, end };
  }
  const inBlock = (i: number): boolean => block !== null && i > block.start && i < block.end;
  let table: string[] = [];
  let hooksOff = false;
  let multi: string | null = null;
  let open = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    if (multi !== null) {
      if (raw.includes(multi)) multi = null;
      continue;
    }
    if (open > 0) {
      const d = bracketDepth(raw, open);
      if (d === null) return { ok: false, why: `第 ${i + 1} 行的字符串没收尾` };
      open = d;
      continue;
    }
    const s = raw.trim();
    if (s === '' || s.startsWith('#')) continue;
    if (s.startsWith('[[')) {
      const p = readKeyPath(s, 2, ']');
      if (!p) return { ok: false, why: `第 ${i + 1} 行的表头认不出` };
      if (isStatePath(p.path)) return { ok: false, why: `第 ${i + 1} 行把 hooks.state 写成了数组表` };
      table = p.path;
      continue;
    }
    if (s.startsWith('[')) {
      const p = readKeyPath(s, 1, ']');
      if (!p) return { ok: false, why: `第 ${i + 1} 行的表头认不出` };
      table = p.path;
      if (isStatePath(table) && table.length === 3) {
        const e = entry(table[2] as string);
        if (e.header !== undefined) return { ok: false, why: `[hooks.state."${table[2]}"] 写了两遍` };
        e.header = i;
        if (inBlock(i)) e.inBlock = true;
      }
      continue;
    }
    const kv = readKeyPath(s, 0, '=');
    if (!kv) return { ok: false, why: `第 ${i + 1} 行认不出是什么` };
    const full = [...table, ...kv.path];
    const v = readValue(s.slice(kv.next + 1));
    if (!v) return { ok: false, why: `第 ${i + 1} 行的值认不出` };
    if (v.kind === 'multi') multi = v.close;
    if (v.kind === 'open') open = v.depth;
    const touchesState =
      full[0] === 'hooks' && (full.length === 1 || (full[1] === 'state' && full.length <= 3));
    if (touchesState && (v.kind !== 'done' || v.inline))
      return { ok: false, why: `第 ${i + 1} 行用内联表写了 ${full.join('.')}，逐行认不准` };
    if (full[0] === 'features' && full[1] === 'hooks' && full.length === 2 && v.kind === 'done')
      hooksOff = v.value === false;
    if (isStatePath(full) && full.length === 4 && v.kind === 'done') {
      const e = entry(full[2] as string);
      const field = full[3];
      if (field === 'trusted_hash') e.trustedHash = { value: v.value, line: i };
      if (field === 'enabled') e.enabled = { value: v.value, line: i };
      if (inBlock(i)) e.inBlock = true;
    }
  }
  if (multi !== null || open > 0) return { ok: false, why: '文件末尾还有没收尾的多行字符串或数组' };
  return { ok: true, value: { entries, hooksOff, block } };
}

/** TOML 基本字符串（带双引号）：反斜杠、双引号、控制字符转义 */
function tomlString(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === '\\' || ch === '"') out += `\\${ch}`;
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `"${out}"`;
}

type State = 'trusted' | 'untrusted' | 'modified' | 'disabled';

function stateOf(e: StateEntry | undefined, hash: string): State {
  if (e?.enabled?.value === false) return 'disabled';
  if (e?.trustedHash === undefined) return 'untrusted';
  return e.trustedHash.value === hash ? 'trusted' : 'modified';
}

type Planned =
  | { ok: false; why: string }
  | { ok: true; text: string | null; states: Map<TrustNeed, State>; hooksOff: boolean };

/** 记上信任后的全文（已经都信任了是 null）；人关掉的、用点号写在块外的不动 */
export function planTrust(text: string, needs: readonly TrustNeed[]): Planned {
  const scanned = scanCodexConfig(text);
  if (!scanned.ok) return scanned;
  const { entries, hooksOff, block } = scanned.value;
  const states = new Map<TrustNeed, State>();
  for (const n of needs) states.set(n, stateOf(entries.get(n.key), n.hash));
  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body: string[] = [];
  for (const n of needs) {
    const e = entries.get(n.key);
    const state = states.get(n) as State;
    if (e === undefined || e.inBlock) {
      // 块里的（或还没有的）整块重写；人在 /hooks 里关掉的照抄 enabled = false
      body.push(`[hooks.state.${tomlString(n.key)}]`);
      if (e?.enabled?.value === false) body.push('enabled = false');
      body.push(`trusted_hash = ${tomlString(n.hash)}`, '');
      continue;
    }
    if (state === 'trusted' || state === 'disabled') continue;
    if (e.header === undefined)
      return { ok: false, why: `[hooks.state."${n.key}"] 是用点号写在别处的，逐行改不准；要人看` };
    if (e.trustedHash !== undefined) {
      const at = e.trustedHash.line;
      const indent = /^\s*/.exec(lines[at] ?? '')?.[0] ?? '';
      lines[at] = `${indent}trusted_hash = ${tomlString(n.hash)}`;
    } else {
      lines.splice(e.header + 1, 0, `trusted_hash = ${tomlString(n.hash)}`);
      // 插了一行，后面记的行号都要挪；块的位置也跟着挪
      for (const other of entries.values()) {
        for (const v of [other.trustedHash, other.enabled]) if (v && v.line > e.header) v.line++;
        if (other.header !== undefined && other.header > e.header) other.header++;
      }
      if (block && block.start > e.header) {
        block.start++;
        block.end++;
      }
    }
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const wantBlock = body.length > 0 ? [BEGIN, ...body, END] : [];
  if (block) {
    lines.splice(block.start, block.end - block.start + 1, ...wantBlock);
  } else if (wantBlock.length > 0) {
    const tail = lines.length > 0 && lines[lines.length - 1] === '' ? lines.pop() : undefined;
    if (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() !== '') lines.push('');
    lines.push(...wantBlock, tail ?? '');
  }
  const next = lines.join(eol);
  return { ok: true, text: next === text ? null : next, states, hooksOff };
}

// ───────────────────────── 查和写 ─────────────────────────

const names = (needs: TrustNeed[]): string => needs.map((n) => n.name).join('、');

type ReadConfig =
  | { kind: 'absent' }
  | { kind: 'text'; text: string; mode: number }
  | { kind: 'bad'; why: string };

function readConfig(abs: string): ReadConfig {
  const st = lstatOrNull(abs);
  if (st === null) return { kind: 'absent' };
  if (st.isSymbolicLink())
    return { kind: 'bad', why: `这是个链接（→ ${linkTarget(abs)}），不是本脚本能改的文件` };
  if (!st.isFile()) return { kind: 'bad', why: '这里不是文件' };
  return {
    kind: 'text',
    text: readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''),
    mode: statSync(abs).mode & 0o777,
  };
}

function summarize(
  states: Map<TrustNeed, State>,
  hooksOff: boolean,
): { kind: 'ok' | 'missing' | 'drift'; text: string } {
  const by = (s: State): TrustNeed[] => [...states].filter(([, v]) => v === s).map(([k]) => k);
  const problems: string[] = [];
  let kind: 'ok' | 'missing' | 'drift' = 'ok';
  if (hooksOff) {
    kind = 'drift';
    problems.push('[features] hooks = false：Codex 的钩子整个关了，一条都不跑（不是本脚本关的，没动它）');
  }
  const disabled = by('disabled');
  if (disabled.length) {
    kind = 'drift';
    problems.push(`${names(disabled)} 在 Codex 的 /hooks 里被关掉了（enabled = false），本脚本不替人打开`);
  }
  const modified = by('modified');
  if (modified.length) {
    kind = 'drift';
    problems.push(`${names(modified)} 信任的是旧版本（Codex 判它改过、跳过不跑）`);
  }
  const untrusted = by('untrusted');
  if (untrusted.length) {
    if (kind === 'ok') kind = 'missing';
    problems.push(`${names(untrusted)} 还没信任（Codex 跳过不跑）`);
  }
  if (kind === 'ok')
    return { kind, text: `Codex 信任了本脚本登记的 ${states.size} 条钩子（${names([...states.keys()])}）` };
  return {
    kind,
    text: `${kind === 'missing' ? '缺失' : '漂移'}——${problems.join('；')}；跑 pnpm agents:sync 记上信任，或在 Codex 里输入 /hooks 逐条审过点信任`,
  };
}

export function trustKey(ctx: Ctx): string {
  return `${relOf(ctx, CODEX_CONFIG).key}#hooks.state`;
}

/** 查：本脚本登记在 hooks.json 的那几条，Codex 信没信任 */
export function checkCodexTrust(ctx: Ctx, needs: TrustNeed[], absent: string[]): Line {
  const { abs } = relOf(ctx, CODEX_CONFIG);
  const key = trustKey(ctx);
  const tail = absent.length ? `；${absent.join('、')} 没登记，谈不上信任` : '';
  let read: ReadConfig;
  try {
    read = readConfig(abs);
  } catch (err) {
    return line('unknown', key, `没查成——读不了（${code(err)}）`);
  }
  if (read.kind === 'bad') return line('unknown', key, `没查成——${read.why}`);
  const p = planTrust(read.kind === 'text' ? read.text : '', needs);
  if (!p.ok) return line('unknown', key, `没查成——${p.why}`);
  const s = summarize(p.states, p.hooksOff);
  if (s.kind === 'ok' && absent.length) return line('missing', key, `缺失——${s.text}${tail}`);
  return line(s.kind, key, `${s.text}${tail}`);
}

/** 写：给没信任、信任了旧版本的记上；人关掉的、整个关了的不动、报出来 */
export function applyCodexTrust(ctx: Ctx, needs: TrustNeed[], backups: Backups): Line {
  const { rel, abs } = relOf(ctx, CODEX_CONFIG);
  const key = trustKey(ctx);
  try {
    const read = readConfig(abs);
    if (read.kind === 'bad') return line('failed', key, `没动——${read.why}；要人看`);
    const before = read.kind === 'text' ? read.text : '';
    const p = planTrust(before, needs);
    if (!p.ok) return line('failed', key, `没动——${p.why}`);
    const fresh = [...p.states].filter(([, s]) => s === 'untrusted' || s === 'modified').map(([n]) => n);
    if (p.text !== null) {
      const saved = read.kind === 'text' ? backups.saveFile(abs, slashed(rel)) : undefined;
      mkdirSync(dirname(abs), { recursive: true });
      writeAtomic(abs, p.text, read.kind === 'text' ? read.mode : undefined);
      for (const n of fresh) p.states.set(n, 'trusted');
      const after = summarize(p.states, p.hooksOff);
      const done = [
        read.kind === 'absent' ? '新建' : '改了',
        fresh.length
          ? `记上了对 ${names(fresh)} 的信任（和在 Codex 的 /hooks 里点信任一样，只信任本脚本登记的）`
          : '托管块整理成仓里的样子',
        ...(saved ? [`原文件备份在 ${saved}`] : []),
      ].join('，');
      if (after.kind !== 'ok')
        return line('failed', key, `${done}；可${after.text.replace(/^(缺失|漂移)——/, '')}`);
      return line('changed', key, done);
    }
    const s = summarize(p.states, p.hooksOff);
    return line(
      s.kind === 'ok' ? 'ok' : 'failed',
      key,
      s.kind === 'ok' ? s.text : `没动——${s.text.replace(/^(缺失|漂移)——/, '')}`,
    );
  } catch (err) {
    return line('failed', key, `没做成——${code(err)}`);
  }
}
