// 各家配置文件里本脚本管的开关（targets.ts 的 CONFIG_KEY_TARGETS）：TOML 里 [table] 下的一个 key = value。
// 只动列出来的那几项，文件里别的内容一行不碰。不引 TOML 库整份解析再写回（会把注释、顺序、格式全丢掉），逐行认：
// 认得准的形状（普通表头、表下一行一个 key）才改；多行字符串、表重复、同一项写了两遍、用点号或内联表写在别处，
// 一律当读不懂——查的时候报没查成，写的时候不动、报没做成，不猜着改。
import { mkdirSync, readFileSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import type { Backups } from './backup.ts';
import { type Line, line } from './report.ts';
import { type Ctx, code, lstatOrNull, relOf, writeAtomic } from './sync.ts';
import { agentNames, CONFIG_KEY_TARGETS, type ConfigKey, slashed } from './targets.ts';
import { linkTarget } from './tree.ts';

export type Located =
  | { kind: 'unreadable'; why: string }
  | { kind: 'no-table' }
  | { kind: 'no-key'; header: number }
  | { kind: 'has'; line: number; value: string };

const HEADER = /^\[\s*([A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*)\s*\]\s*(?:#.*)?$/;
const ARRAY_HEADER = /^\[\[/;
const KEY_LINE = /^([A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*)\s*=\s*(.*)$/;

const dotted = (s: string): string => s.replace(/\s+/g, '');

/** 一行里 = 后面的值，去掉行尾注释（值里带 # 的字符串会被截错，截错了只会判成「不一样」、再写成该有的样子） */
function tomlValue(rest: string): string {
  return rest.replace(/\s+#.*$/, '').trim();
}

/** 在 TOML 文本里找 [table] 下的 key：行号从 0 数 */
export function locate(text: string, table: string, key: string): Located {
  if (text.includes('"""') || text.includes("'''"))
    return { kind: 'unreadable', why: '有多行字符串，逐行认不准哪行是表头' };
  const lines = text.split(/\r?\n/);
  const full = `${table}.${key}`;
  let current = '';
  const headers: number[] = [];
  const keys: { line: number; value: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] ?? '').trim();
    if (t === '' || t.startsWith('#')) continue;
    if (ARRAY_HEADER.test(t)) {
      current = '[[]]';
      continue;
    }
    if (t.startsWith('[')) {
      const h = HEADER.exec(t);
      if (!h?.[1]) return { kind: 'unreadable', why: `第 ${i + 1} 行的表头认不出` };
      current = dotted(h[1]);
      if (current === table) headers.push(i);
      continue;
    }
    if (current === '[[]]') continue;
    const k = KEY_LINE.exec(t);
    if (!k?.[1]) continue; // 多行数组的续行这类，不是 key
    const path = current ? `${current}.${dotted(k[1])}` : dotted(k[1]);
    const inside = current === table || current.startsWith(`${table}.`);
    if (path === full && current === table) {
      keys.push({ line: i, value: tomlValue(k[2] ?? '') });
    } else if (!inside && (path === table || path.startsWith(`${table}.`))) {
      // 在 [table] 外面用点号或内联表定义了它：再加一个 [table] 表头就是重复定义
      return { kind: 'unreadable', why: `第 ${i + 1} 行用点号或内联表写了 ${table}，本脚本不改这种写法` };
    }
  }
  if (headers.length > 1) return { kind: 'unreadable', why: `[${table}] 出现了 ${headers.length} 次` };
  if (keys.length > 1) return { kind: 'unreadable', why: `${full} 写了 ${keys.length} 遍` };
  const found = keys[0];
  if (found) return { kind: 'has', line: found.line, value: found.value };
  const header = headers[0];
  return header === undefined ? { kind: 'no-table' } : { kind: 'no-key', header };
}

const COMMENT = (k: ConfigKey): string =>
  `# fleet-dao 同步脚本管（改它改 packages/agents-sync/src/targets.ts）：${k.why}`;

/** 把一项改成该有的样子；返回新文本（已经对了返回 null），读不懂返回原因 */
export function setKey(
  text: string,
  k: ConfigKey,
): { ok: true; text: string | null } | { ok: false; why: string } {
  const at = locate(text, k.table, k.key);
  if (at.kind === 'unreadable') return { ok: false, why: at.why };
  if (at.kind === 'has' && at.value === k.value) return { ok: true, text: null };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const entry = [COMMENT(k), `${k.key} = ${k.value}`];
  if (at.kind === 'has') {
    const old = lines[at.line] ?? '';
    const indent = /^\s*/.exec(old)?.[0] ?? '';
    lines[at.line] = `${indent}${k.key} = ${k.value}`;
  } else if (at.kind === 'no-key') {
    lines.splice(at.header + 1, 0, ...entry);
  } else {
    // 文件末尾是空行（以换行结尾）时 split 出来最后一个是 ''，新表插在它前面，末尾照旧只一个换行
    const tail = lines.length > 0 && lines[lines.length - 1] === '' ? lines.pop() : undefined;
    if (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() !== '') lines.push('');
    lines.push(`[${k.table}]`, ...entry);
    lines.push(tail ?? '');
  }
  return { ok: true, text: lines.join(eol) };
}

type FileRead =
  | { kind: 'absent' }
  | { kind: 'text'; text: string; st: Stats }
  | { kind: 'bad'; why: string; link?: boolean };

function readConfig(abs: string): FileRead {
  const st = lstatOrNull(abs);
  if (st === null) return { kind: 'absent' };
  if (st.isSymbolicLink())
    return { kind: 'bad', why: `这是个链接（→ ${linkTarget(abs)}），不是本脚本改的文件`, link: true };
  if (!st.isFile()) return { kind: 'bad', why: '这里不是文件' };
  return { kind: 'text', text: readFileSync(abs, 'utf8'), st };
}

const keyOf = (file: string, k: ConfigKey): string => `${file}#${k.table}.${k.key}`;

export function checkToolConfig(ctx: Ctx): Line[] {
  const out: Line[] = [];
  for (const t of CONFIG_KEY_TARGETS) {
    const { abs, key: file } = relOf(ctx, t.file);
    if (!t.readers.some((r) => ctx.installed.has(r))) {
      out.push(line('skip', file, `没装（${agentNames(t.readers)}），跳过`));
      continue;
    }
    let read: FileRead;
    try {
      read = readConfig(abs);
    } catch (err) {
      out.push(line('unknown', file, `没查成——读不了（${code(err)}）`));
      continue;
    }
    if (read.kind === 'bad') {
      out.push(line('drift', file, `漂移——${read.why}`));
      continue;
    }
    for (const k of t.keys) {
      const kk = keyOf(file, k);
      const want = `${k.key} = ${k.value}`;
      if (read.kind === 'absent') {
        out.push(line('missing', kk, `缺失——没有这个文件，该有 [${k.table}] ${want}（${k.why}）`));
        continue;
      }
      const at = locate(read.text, k.table, k.key);
      if (at.kind === 'unreadable') out.push(line('unknown', kk, `没查成——${at.why}`));
      else if (at.kind === 'has' && at.value === k.value) out.push(line('ok', kk, `一致（${want}）`));
      else if (at.kind === 'has')
        out.push(line('drift', kk, `漂移——是 ${at.value}，该是 ${k.value}（${k.why}）`));
      else out.push(line('missing', kk, `缺失——没有这一项，该有 [${k.table}] ${want}（${k.why}）`));
    }
  }
  return out;
}

export function applyToolConfig(ctx: Ctx, backups: Backups): Line[] {
  const out: Line[] = [];
  for (const t of CONFIG_KEY_TARGETS) {
    const { rel, abs, key: file } = relOf(ctx, t.file);
    if (!t.readers.some((r) => ctx.installed.has(r))) {
      out.push(line('skip', file, `没装（${agentNames(t.readers)}），跳过`));
      continue;
    }
    let read: FileRead;
    try {
      read = readConfig(abs);
    } catch (err) {
      out.push(line('failed', file, `没做成——读不了（${code(err)}）`));
      continue;
    }
    if (read.kind === 'bad') {
      out.push(line('failed', file, `没动——${read.why}${read.link ? '；要接管先把链接换成文件' : ''}`));
      continue;
    }
    const before = read.kind === 'text' ? read.text : '';
    let text = before;
    const changed: Line[] = [];
    let broken = false;
    for (const k of t.keys) {
      const kk = keyOf(file, k);
      const r = setKey(text, k);
      if (!r.ok) {
        out.push(line('failed', kk, `没动——${r.why}；手工在 [${k.table}] 下写 ${k.key} = ${k.value}`));
        broken = true;
      } else if (r.text === null) {
        out.push(line('ok', kk, `一致（${k.key} = ${k.value}）`));
      } else {
        text = r.text;
        changed.push(line('changed', kk, `改成了 ${k.key} = ${k.value}（文件里别的没动）`));
      }
    }
    // 有一项读不懂就整份不写：读不懂说明逐行认的前提不成立，别的项改出来也未必对
    if (broken) {
      for (const c of changed)
        out.push(line('failed', c.key, '没动——同一个文件里有读不懂的地方，这份整份没写'));
      continue;
    }
    if (changed.length === 0) continue;
    try {
      if (read.kind === 'absent') {
        mkdirSync(dirname(abs), { recursive: true });
        writeAtomic(abs, text.startsWith('\n') ? text.slice(1) : text, undefined);
      } else {
        backups.saveFile(abs, slashed(rel));
        writeAtomic(abs, text, ctx.platform === 'linux' ? read.st.mode & 0o777 : undefined);
      }
      out.push(...changed);
    } catch (err) {
      for (const c of changed) out.push(line('failed', c.key, `没做成——${code(err)}`));
    }
  }
  return out;
}
