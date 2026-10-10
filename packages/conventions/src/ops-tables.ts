// ops 的表格由 deploy/ 的配置生成（决定 0001 第七节第 10 条，#140 第一片）：
// 端口表从 deploy/france.sh、deploy/hk.sh 里 `^[A-Z_]*PORT=[0-9]+` 的行生成
// （和 deploy/test/run.sh 的 check_ports 同一条正则），放进「自动生成、别手改」的区块。
// 本片只提供纯函数和命令行（bin/ops-tables.ts）：区块还不进 docs/ops.md、不接 pnpm check，
// 接 CI 是 #140 后面片的事。真跑时读盘（fsRepo），测试用内存假仓（memRepo）。
import type { RepoView } from './repo.ts';

/** 收端口常量的脚本，表里按这个顺序排。 */
const PORT_SCRIPTS = ['deploy/france.sh', 'deploy/hk.sh'] as const;

/** 和 deploy/test/run.sh 的 check_ports 同一条正则：行首就是变量名、值以数字开头。 */
const PORT_LINE = /^([A-Z_]*PORT)=([0-9]+)/;

/** 表里一行的样子：| 变量名 | 端口号 | 来源脚本 |。从文档区块里回读数据行用。 */
const PORT_ROW = /^\| ([A-Z_]*PORT) \| ([0-9]+) \| (deploy\/[a-z]+\.sh) \|$/;

const BLOCK_NAME = 'ports';
/** 区块名字的对外写法（bin 和后面的片用同一份，不各写各的字符串）。 */
export const BLOCK_NAME_PORTS = BLOCK_NAME;

/** 区块标记：`<!-- fleet:<name>:start -->` 到 `<!-- fleet:<name>:end -->` 之间是机器生成的、别手改。 */
function blockMarker(name: string, edge: 'start' | 'end'): string {
  return `<!-- fleet:${name}:${edge} -->`;
}

export interface PortEntry {
  /** 变量名，如 PG_PORT。 */
  name: string;
  /** 端口号，生成时原样抄，不做数字变换。 */
  port: string;
  /** 来源脚本，仓内路径。 */
  script: string;
  /** 脚本里的行号，1 起。 */
  line: number;
}

/** 读脚本里的端口常量。读不到脚本、或哪个脚本里一个端口都没有，抛错（调用方落成「没查成」，不当成通过）。 */
export function readPortEntries(repo: RepoView): PortEntry[] {
  const entries: PortEntry[] = [];
  for (const script of PORT_SCRIPTS) {
    const text = repo.read(script);
    if (text === undefined) throw new Error(`读不到 ${script}`);
    let found = 0;
    for (const [i, line] of text.split('\n').entries()) {
      const m = PORT_LINE.exec(line);
      if (!m) continue;
      found++;
      entries.push({ name: m[1] ?? '', port: m[2] ?? '', script, line: i + 1 });
    }
    if (found === 0) throw new Error(`${script} 里一个端口常量都没读到`);
  }
  // 先按脚本（PORT_SCRIPTS 的顺序）、再按行号排：同一个仓怎么读输出都一样。
  return entries.sort((a, b) => a.script.localeCompare(b.script) || a.line - b.line);
}

/** 区块标记之间那一段：前后各一个空行、中间一张三列表。--write 只替换这一段。 */
export function portsTableInner(repo: RepoView): string {
  const lines = ['| 变量名 | 端口号 | 来源脚本 |', '|---|---|---|'];
  for (const e of readPortEntries(repo)) lines.push(`| ${e.name} | ${e.port} | ${e.script} |`);
  return `\n\n${lines.join('\n')}\n\n`;
}

/** 整个区块（含两个标记行）：开头 `<!-- fleet:ports:start -->`，一张三列表（变量名、端口号、来源脚本），
 *  结尾 `<!-- fleet:ports:end -->`。同一个仓两次调用逐字相同。 */
export function renderPortsBlock(repo: RepoView): string {
  return `${blockMarker(BLOCK_NAME, 'start')}${portsTableInner(repo)}${blockMarker(BLOCK_NAME, 'end')}`;
}

interface BlockSpan {
  /** 开始标记行的行首到结束标记行的行尾（不含换行）：逐字比用这一段。 */
  from: number;
  to: number;
  /** 两个标记之间的内容：--write 只动这一段。 */
  innerFrom: number;
  innerTo: number;
}

function occurrences(text: string, marker: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(marker); i !== -1; i = text.indexOf(marker, i + 1)) at.push(i);
  return at;
}

function lineStart(text: string, at: number): number {
  return text.lastIndexOf('\n', at - 1) + 1;
}

function lineEnd(text: string, at: number): number {
  const nl = text.indexOf('\n', at);
  return nl === -1 ? text.length : nl;
}

function findBlock(text: string, name: string): BlockSpan {
  const startMarker = blockMarker(name, 'start');
  const endMarker = blockMarker(name, 'end');
  const starts = occurrences(text, startMarker);
  const ends = occurrences(text, endMarker);
  if (starts.length === 0) throw new Error(`区块「${name}」缺开始标记 ${startMarker}`);
  if (ends.length === 0) throw new Error(`区块「${name}」缺结束标记 ${endMarker}`);
  if (starts.length > 1)
    throw new Error(`区块「${name}」的开始标记 ${startMarker} 出现了 ${starts.length} 次`);
  if (ends.length > 1) throw new Error(`区块「${name}」的结束标记 ${endMarker} 出现了 ${ends.length} 次`);
  const start = starts[0] ?? 0;
  const end = ends[0] ?? 0;
  if (end < start) throw new Error(`区块「${name}」的结束标记在开始标记之前`);
  return {
    from: lineStart(text, start),
    to: lineEnd(text, end + endMarker.length),
    innerFrom: start + startMarker.length,
    innerTo: end,
  };
}

/** 在文档文本里找该名字的区块，返回两个标记之间的内容（原样，不去空白）。
 *  标记缺一个、重复、先结束后开始，都抛带原因的错，不返回空串冒充没事。 */
export function extractBlock(text: string, name: string): string {
  const span = findBlock(text, name);
  return text.slice(span.innerFrom, span.innerTo);
}

/** 把该名字区块标记之间的内容换成 inner，标记和区块外的字一个不动。 */
export function replaceBlock(text: string, name: string, inner: string): string {
  const span = findBlock(text, name);
  return text.slice(0, span.innerFrom) + inner + text.slice(span.innerTo);
}

export interface OpsTableProblem {
  /** true = 没查成（读不到文档或脚本、脚本里没端口），不能当成通过；false = 生成内容和文档区块不一致。 */
  notQueried: boolean;
  text: string;
}

/** 读 docPath，取端口区块，和 renderPortsBlock 逐字比。一致返回空数组；
 *  不一致返回点出哪个端口变量多了、少了、变了的问题；
 *  读不到文档、读不到脚本、脚本里一个端口都没读到，返回「没查成」问题，不当成通过。 */
export function checkPortsBlock(repo: RepoView, docPath: string): OpsTableProblem[] {
  const doc = repo.read(docPath);
  if (doc === undefined) return [{ notQueried: true, text: `没查成：读不到 ${docPath}` }];
  let expected: string;
  try {
    expected = renderPortsBlock(repo);
  } catch (e) {
    return [{ notQueried: true, text: `没查成：${e instanceof Error ? e.message : String(e)}` }];
  }
  let span: BlockSpan;
  try {
    span = findBlock(doc, BLOCK_NAME);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return [{ notQueried: false, text: `端口区块对不上：${reason}。` }];
  }
  const actual = doc.slice(span.from, span.to);
  if (actual === expected) return [];
  const problems = portRowProblems(actual, expected);
  if (problems.length > 0) return problems;
  // 端口行都对得上但区块不逐字一致：排序、空白或表头格式被手改了，也不能当成通过。
  return [
    {
      notQueried: false,
      text: '端口区块对不上：端口行都对，但区块和生成的内容不是逐字一致（排序、空白或表头格式被改过）。重新生成：node packages/conventions/src/bin/ops-tables.ts --write。',
    },
  ];
}

function parsePortRows(text: string): Map<string, { port: string; script: string }> {
  const rows = new Map<string, { port: string; script: string }>();
  for (const line of text.split('\n')) {
    const m = PORT_ROW.exec(line.trimEnd());
    if (m) rows.set(m[1] ?? '', { port: m[2] ?? '', script: m[3] ?? '' });
  }
  return rows;
}

function portRowProblems(actual: string, expected: string): OpsTableProblem[] {
  const want = parsePortRows(expected);
  const got = parsePortRows(actual);
  const problems: OpsTableProblem[] = [];
  for (const [name, w] of want) {
    const g = got.get(name);
    if (g === undefined) {
      problems.push({
        notQueried: false,
        text: `端口变量 ${name} 少了：脚本里是 ${w.port}（${w.script}），文档区块里没有。`,
      });
    } else if (g.port !== w.port || g.script !== w.script) {
      problems.push({
        notQueried: false,
        text: `端口变量 ${name} 变了：文档区块里是 ${g.port}（${g.script}），脚本里是 ${w.port}（${w.script}）。`,
      });
    }
  }
  for (const [name, g] of got) {
    if (!want.has(name)) {
      problems.push({
        notQueried: false,
        text: `端口变量 ${name} 多了：文档区块里有 ${g.port}（${g.script}），脚本里没有。`,
      });
    }
  }
  return problems;
}

// 用户表（#140 第三片）：从四个部署脚本读系统用户，放进 users 区块。
// france.sh 行首 PILOT_USER=、lib/session-user.sh 行首 SESSION_USER=、
// hk.sh 和 lib/human-tier.sh 里写死名字的 ensure_service_user（`$u`、`"$u"` 这类不读）。
// 读不到脚本、或哪个脚本里一个用户都没有，抛错。本片不进文档、不接命令行、不接 CI。

/** 读的顺序不影响输出：读完按脚本路径、再按行号排。 */
const USER_SCRIPTS = [
  'deploy/france.sh',
  'deploy/lib/session-user.sh',
  'deploy/hk.sh',
  'deploy/lib/human-tier.sh',
] as const;

/** 行首赋值。名字写到第一个不是用户名的字符为止，注释和缩进对不上。 */
const PILOT_USER_LINE = /^PILOT_USER=([A-Za-z_][A-Za-z0-9_-]*)(?![A-Za-z0-9_-])/;
const SESSION_USER_LINE = /^SESSION_USER=([A-Za-z_][A-Za-z0-9_-]*)(?![A-Za-z0-9_-])/;
/** 允许行首缩进。第一参必须是写死的名字，`$u`、`"$u"` 对不上。 */
const ENSURE_USER_LINE = /^[ \t]*ensure_service_user[ \t]+([A-Za-z_][A-Za-z0-9_-]*)(?=[ \t]|$)/;

/** 表里一行：| 用户 | 来源常量 | 来源脚本 |。从文档区块里回读数据行用。 */
const USER_ROW = /^\| ([A-Za-z_][A-Za-z0-9_-]*) \| ([A-Za-z_]+) \| (deploy\/[A-Za-z0-9_./-]+\.sh) \|$/;

const USERS_NAME = 'users';
/** 用户区块名字的对外写法（和端口的 BLOCK_NAME_PORTS 同一路，不各写各的字符串）。 */
export const BLOCK_NAME_USERS = USERS_NAME;

interface UserEntry {
  /** 用户名，如 pilot。 */
  user: string;
  /** 来源常量：PILOT_USER、SESSION_USER，或写死名字的 ensure_service_user。 */
  source: string;
  /** 来源脚本，仓内路径。 */
  script: string;
  /** 脚本里的行号，1 起。 */
  line: number;
}

interface UserRow {
  user: string;
  source: string;
  script: string;
}

function readUserLine(script: string, line: string): { user: string; source: string } | undefined {
  if (script === 'deploy/france.sh') {
    const m = PILOT_USER_LINE.exec(line);
    return m ? { user: m[1] ?? '', source: 'PILOT_USER' } : undefined;
  }
  if (script === 'deploy/lib/session-user.sh') {
    const m = SESSION_USER_LINE.exec(line);
    return m ? { user: m[1] ?? '', source: 'SESSION_USER' } : undefined;
  }
  const m = ENSURE_USER_LINE.exec(line);
  return m ? { user: m[1] ?? '', source: 'ensure_service_user' } : undefined;
}

/** 读四个脚本里的系统用户。读不到脚本、或哪个脚本里一个用户都没有，抛带脚本名的错
 *  （调用方落成「没查成」，不当成通过，也不静默给空表）。 */
export function readUserEntries(repo: RepoView): UserEntry[] {
  const entries: UserEntry[] = [];
  for (const script of USER_SCRIPTS) {
    const text = repo.read(script);
    if (text === undefined) throw new Error(`读不到 ${script}`);
    let found = 0;
    for (const [i, line] of text.split('\n').entries()) {
      const hit = readUserLine(script, line);
      if (!hit || hit.user === '') continue;
      found++;
      entries.push({ user: hit.user, source: hit.source, script, line: i + 1 });
    }
    if (found === 0) throw new Error(`${script} 里一个用户都没读到`);
  }
  // 先按脚本路径、再按行号排：同一个仓怎么读输出都一样。
  return entries.sort((a, b) => a.script.localeCompare(b.script) || a.line - b.line);
}

/** 区块标记之间那一段：前后各一个空行、中间一张三列表。 */
export function usersTableInner(repo: RepoView): string {
  const lines = ['| 用户 | 来源常量 | 来源脚本 |', '|---|---|---|'];
  for (const e of readUserEntries(repo)) lines.push(`| ${e.user} | ${e.source} | ${e.script} |`);
  return `\n\n${lines.join('\n')}\n\n`;
}

/** 整个区块（含两个标记行）：开头 `<!-- fleet:users:start -->`，一张三列表（用户、来源常量、来源脚本），
 *  结尾 `<!-- fleet:users:end -->`。同一个仓两次调用逐字相同。 */
export function renderUsersBlock(repo: RepoView): string {
  return `${blockMarker(USERS_NAME, 'start')}${usersTableInner(repo)}${blockMarker(USERS_NAME, 'end')}`;
}

function parseUserRows(text: string): UserRow[] {
  const rows: UserRow[] = [];
  for (const line of text.split('\n')) {
    const m = USER_ROW.exec(line.trimEnd());
    if (!m) continue;
    rows.push({ user: m[1] ?? '', source: m[2] ?? '', script: m[3] ?? '' });
  }
  return rows;
}

function userRowKey(row: UserRow): string {
  return `${row.user}\0${row.source}\0${row.script}`;
}

function sameUserRows(want: UserRow[], got: UserRow[]): boolean {
  if (want.length !== got.length) return false;
  const count = new Map<string, number>();
  for (const row of want) count.set(userRowKey(row), (count.get(userRowKey(row)) ?? 0) + 1);
  for (const row of got) {
    const n = count.get(userRowKey(row)) ?? 0;
    if (n === 0) return false;
    count.set(userRowKey(row), n - 1);
  }
  return true;
}

function groupUserRows(rows: UserRow[]): Map<string, UserRow[]> {
  const groups = new Map<string, UserRow[]>();
  for (const row of rows) {
    const key = `${row.source}\0${row.script}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function diffUserGroup(want: UserRow[], got: UserRow[]): OpsTableProblem[] {
  // 先对上用户名相同的行。按位置配对会把仍在文档里的下一行说成变了（删掉 zoo 时 ant 还在）。
  const unmatchedGot = [...got];
  const unmatchedWant: UserRow[] = [];
  for (const w of want) {
    const at = unmatchedGot.findIndex((g) => g.user === w.user);
    if (at === -1) unmatchedWant.push(w);
    else unmatchedGot.splice(at, 1);
  }
  const problems: OpsTableProblem[] = [];
  const n = Math.min(unmatchedWant.length, unmatchedGot.length);
  for (let i = 0; i < n; i++) {
    const w = unmatchedWant[i];
    const g = unmatchedGot[i];
    if (!w || !g) continue;
    problems.push({
      notQueried: false,
      text: `用户 ${g.user} 变了：来源常量 ${w.source}（${w.script}），文档区块里是 ${g.user}，脚本里是 ${w.user}。`,
    });
  }
  for (const w of unmatchedWant.slice(n)) {
    problems.push({
      notQueried: false,
      text: `用户 ${w.user} 少了：来源常量 ${w.source}（${w.script}），脚本里是 ${w.user}，文档区块里没有。`,
    });
  }
  for (const g of unmatchedGot.slice(n)) {
    problems.push({
      notQueried: false,
      text: `用户 ${g.user} 多了：来源常量 ${g.source}（${g.script}），文档区块里有 ${g.user}，脚本里没有。`,
    });
  }
  return problems;
}

function userRowProblems(actual: string, expected: string): OpsTableProblem[] {
  const wantRows = parseUserRows(expected);
  const gotRows = parseUserRows(actual);
  // 用户行的集合一样、只是顺序或空白变了：交给调用方报「不是逐字一致」，不把换序说成用户变了。
  if (sameUserRows(wantRows, gotRows)) return [];
  const want = groupUserRows(wantRows);
  const got = groupUserRows(gotRows);
  const problems: OpsTableProblem[] = [];
  const seen = new Set<string>();
  for (const [key, wRows] of want) {
    seen.add(key);
    problems.push(...diffUserGroup(wRows, got.get(key) ?? []));
  }
  for (const [key, gRows] of got) {
    if (seen.has(key)) continue;
    problems.push(...diffUserGroup([], gRows));
  }
  return problems;
}

/** 读 docPath，取用户区块，和 renderUsersBlock 逐字比。一致返回空数组；
 *  不一致返回点出哪个用户多了、少了、变了的问题；
 *  读不到文档、读不到脚本、脚本里一个用户都没读到，返回「没查成」问题，不当成通过。 */
export function checkUsersBlock(repo: RepoView, docPath: string): OpsTableProblem[] {
  const doc = repo.read(docPath);
  if (doc === undefined) return [{ notQueried: true, text: `没查成：读不到 ${docPath}` }];
  let expected: string;
  try {
    expected = renderUsersBlock(repo);
  } catch (e) {
    return [{ notQueried: true, text: `没查成：${e instanceof Error ? e.message : String(e)}` }];
  }
  let span: BlockSpan;
  try {
    span = findBlock(doc, USERS_NAME);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return [{ notQueried: false, text: `用户区块对不上：${reason}。` }];
  }
  const actual = doc.slice(span.from, span.to);
  if (actual === expected) return [];
  const problems = userRowProblems(actual, expected);
  if (problems.length > 0) return problems;
  return [
    {
      notQueried: false,
      text: '用户区块对不上：用户行都对，但区块和生成的内容不是逐字一致（排序、空白或表头格式被改过）。',
    },
  ];
}

// 目录表（#140 第五片）：从三个部署脚本里行首（允许缩进）的 `ensure_dir <路径> <属主:组> <权限>` 读目录，放进 dirs 区块。
// 路径里的 `$NAME`、`${NAME}` 按「同一脚本 → deploy/lib/*.sh → deploy/france.sh → deploy/hk.sh」的先后，
// 找行首（允许缩进）的 `NAME=值` 赋值，取第一处；值里再有变量照同样规则递归展开。
// 本片不进文档、不接命令行、不接 CI。

const DIR_SCRIPTS = ['deploy/france.sh', 'deploy/hk.sh', 'deploy/lib/human-tier.sh'] as const;
/** 找赋值时 deploy/lib/*.sh 之后的两个脚本，按这个顺序。 */
const ASSIGN_TAIL = ['deploy/france.sh', 'deploy/hk.sh'] as const;

const ENSURE_DIR_LINE = /^[ \t]*ensure_dir[ \t]+(.*)$/;
const ASSIGN_LINE = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const FOR_LINE = /^[ \t]*for[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+in(?![A-Za-z0-9_])/;
const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** 表里一行：| 路径 | 属主:组 | 权限 | 来源脚本 |。从文档区块里回读数据行用。 */
const DIR_ROW = /^\| (.+?) \| ([^ |]+) \| ([^ |]+) \| (deploy\/[A-Za-z0-9_./-]+\.sh) \|$/;

const DIRS_NAME = 'dirs';
/** 目录区块名字的对外写法（和端口、用户的同一路，不各写各的字符串）。 */
export const BLOCK_NAME_DIRS = DIRS_NAME;

export interface DirEntry {
  /** 展开变量之后的路径。 */
  path: string;
  /** 属主:组，如 root:fleet。 */
  owner: string;
  /** 权限，如 750，原样抄。 */
  mode: string;
  /** 来源脚本，仓内路径。 */
  script: string;
  /** 脚本里的行号，1 起。 */
  line: number;
}

interface DirRow {
  path: string;
  owner: string;
  mode: string;
  script: string;
}

interface WordPart {
  text: string;
  /** 单引号里的字原样，不展开变量。 */
  literal: boolean;
}

/** 从 s[at] 起读一个 shell 词：双引号、单引号、反斜杠转义、裸字可以连着写。裸字到空白或 `;` 为止。 */
function readWord(s: string, at: number): { parts: WordPart[]; end: number } {
  const parts: WordPart[] = [];
  let i = at;
  while (i < s.length) {
    const c = s[i] ?? '';
    if (c === '"') {
      let buf = '';
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"$\\`'.includes(s[i + 1] ?? '')) {
          parts.push({ text: buf, literal: false }, { text: s[i + 1] ?? '', literal: true });
          buf = '';
          i += 2;
        } else buf += s[i++];
      }
      parts.push({ text: buf, literal: false });
      i++;
    } else if (c === "'") {
      const close = s.indexOf("'", i + 1);
      const stop = close === -1 ? s.length : close;
      parts.push({ text: s.slice(i + 1, stop), literal: true });
      i = stop + 1;
    } else if (c === '\\' && i + 1 < s.length) {
      parts.push({ text: s[i + 1] ?? '', literal: true });
      i += 2;
    } else if (/[ \t;]/.test(c)) {
      break;
    } else {
      let j = i;
      while (j < s.length && !/[ \t;"'\\]/.test(s[j] ?? '')) j++;
      parts.push({ text: s.slice(i, j), literal: false });
      i = j;
    }
  }
  return { parts, end: i };
}

interface ScriptIndex {
  assigns: Map<string, { line: number; rest: string }>;
  loopVars: Set<string>;
}

/** 整次读目录共用的脚本索引：每个脚本只读、只扫一遍。 */
class DirReader {
  private readonly cache = new Map<string, ScriptIndex | null>();
  private libScripts: string[] | undefined;

  private readonly repo: RepoView;

  constructor(repo: RepoView) {
    this.repo = repo;
  }

  index(script: string): ScriptIndex | undefined {
    const hit = this.cache.get(script);
    if (hit !== undefined) return hit ?? undefined;
    const text = this.repo.read(script);
    if (text === undefined) {
      this.cache.set(script, null);
      return undefined;
    }
    const idx: ScriptIndex = { assigns: new Map(), loopVars: new Set() };
    for (const [i, line] of text.split('\n').entries()) {
      const a = ASSIGN_LINE.exec(line);
      if (a && !idx.assigns.has(a[1] ?? '')) idx.assigns.set(a[1] ?? '', { line: i + 1, rest: a[2] ?? '' });
      const f = FOR_LINE.exec(line);
      if (f) idx.loopVars.add(f[1] ?? '');
    }
    this.cache.set(script, idx);
    return idx;
  }

  /** 找赋值的先后：同一脚本 → deploy/lib/*.sh → france.sh → hk.sh，同一个脚本只看一次。 */
  searchOrder(script: string): string[] {
    this.libScripts ??= (this.repo.list('deploy/lib') ?? [])
      .filter((n) => n.endsWith('.sh'))
      .sort()
      .map((n) => `deploy/lib/${n}`);
    return [...new Set([script, ...this.libScripts, ...ASSIGN_TAIL])];
  }
}

interface ExpandCtx {
  /** ensure_dir 所在的脚本和行号：报错、找赋值、判循环变量都以它为准。 */
  script: string;
  line: number;
  reader: DirReader;
  /** 只在展开路径时为 true：只有路径里的循环变量才算「按用户变化」。 */
  inPath: boolean;
  /** 展开路径时碰到了循环变量。 */
  varies: boolean;
}

function expandText(text: string, ctx: ExpandCtx, chain: string[]): string {
  const where = `${ctx.script}:${ctx.line}`;
  if (text.includes('$(') || text.includes('`')) {
    throw new Error(`${where} 的目录写法里有命令替换，生成不了：${text}`);
  }
  const out = text.replace(VAR_REF, (_m, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? '';
    return expandVar(name, ctx, chain);
  });
  if (out.includes('$')) throw new Error(`${where} 的目录写法里有认不出的变量写法：${text}`);
  return out;
}

function expandVar(name: string, ctx: ExpandCtx, chain: string[]): string {
  const where = `${ctx.script}:${ctx.line}`;
  if (ctx.inPath && ctx.reader.index(ctx.script)?.loopVars.has(name)) {
    ctx.varies = true;
    return '';
  }
  if (chain.includes(name)) {
    throw new Error(`${where} 的变量 ${name} 展开时绕成了圈：${[...chain, name].join(' -> ')}`);
  }
  for (const script of ctx.reader.searchOrder(ctx.script)) {
    const hit = ctx.reader.index(script)?.assigns.get(name);
    if (!hit) continue;
    const at = `${script}:${hit.line}`;
    if (hit.rest.trimStart().startsWith('(')) {
      throw new Error(`${at} 的 ${name} 是数组赋值，${where} 的目录路径展开不了`);
    }
    const word = readWord(hit.rest, 0);
    const value = word.parts
      .map((p) => {
        if (p.literal) return p.text;
        if (p.text.includes('$(') || p.text.includes('`')) {
          throw new Error(`${at} 的 ${name} 赋值里有命令替换，${where} 的目录路径展开不了`);
        }
        return expandText(p.text, ctx, [...chain, name]);
      })
      .join('');
    return value;
  }
  throw new Error(
    `${where} 的变量 $${name} 找不到赋值（找过：${ctx.reader.searchOrder(ctx.script).join('、')}），目录路径展开不了`,
  );
}

function expandWord(parts: WordPart[], ctx: ExpandCtx): string {
  return parts.map((p) => (p.literal ? p.text : expandText(p.text, ctx, []))).join('');
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 读三个脚本里的 `ensure_dir <路径> <属主:组> <权限>`，路径、属主、权限里的变量按上面的规则展开。
 *  「按用户变化」的判法不写死变量名，只看路径：路径里用到的变量是同一脚本里某个 `for NAME in` 循环的循环变量
 *  （例如 human-tier.sh 的 `for u in "${SESSION_USERS[@]}"` 里的 `u`），每个用户一份、不是固定目录，这一行不进表。
 *  属主、权限里的循环变量不算：路径固定的行照样进表，属主、权限里的循环变量按普通变量找赋值，找不到就抛错。
 *  其余找不到赋值、赋值值里有 `$(` 命令替换、少于三个词的，抛带脚本名和行号的错，不静默跳过。
 *  读不到脚本、或哪个脚本里一个目录都没读到，也抛错（调用方落成「没查成」）。 */
export function readDirEntries(repo: RepoView): DirEntry[] {
  const reader = new DirReader(repo);
  const entries: DirEntry[] = [];
  for (const script of DIR_SCRIPTS) {
    const text = repo.read(script);
    if (text === undefined) throw new Error(`读不到 ${script}`);
    let found = 0;
    for (const [i, line] of text.split('\n').entries()) {
      const m = ENSURE_DIR_LINE.exec(line);
      if (!m) continue;
      found++;
      const where = `${script}:${i + 1}`;
      const args = m[1] ?? '';
      const words: WordPart[][] = [];
      let at = 0;
      while (words.length < 3) {
        while (at < args.length && /[ \t]/.test(args[at] ?? '')) at++;
        if (at >= args.length || args[at] === '#' || args[at] === ';') break;
        const w = readWord(args, at);
        words.push(w.parts);
        at = w.end;
      }
      if (words.length < 3)
        throw new Error(`${where} 的 ensure_dir 不足三个参数（路径 属主:组 权限）：${line.trim()}`);
      const ctx: ExpandCtx = { script, line: i + 1, reader, inPath: true, varies: false };
      const path = expandWord(words[0] ?? [], ctx);
      if (ctx.varies) continue;
      ctx.inPath = false;
      const owner = expandWord(words[1] ?? [], ctx);
      const mode = expandWord(words[2] ?? [], ctx);
      entries.push({ path, owner, mode, script, line: i + 1 });
    }
    if (found === 0) throw new Error(`${script} 里一个目录都没读到`);
  }
  return entries.sort(
    (a, b) =>
      compareText(a.path, b.path) ||
      compareText(a.script, b.script) ||
      compareText(a.owner, b.owner) ||
      compareText(a.mode, b.mode) ||
      a.line - b.line,
  );
}

function dirRows(repo: RepoView): DirRow[] {
  const rows: DirRow[] = [];
  const seen = new Set<string>();
  for (const e of readDirEntries(repo)) {
    const key = dirRowKey(e);
    // 同一脚本里同一条（路径、属主、权限都一样）写了两遍，表里只留一行。
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ path: e.path, owner: e.owner, mode: e.mode, script: e.script });
  }
  return rows;
}

function dirRowKey(row: DirRow): string {
  return `${row.path}\0${row.owner}\0${row.mode}\0${row.script}`;
}

/** 区块标记之间那一段：前后各一个空行、中间一张四列表，行按路径、再按来源脚本排。 */
export function dirsTableInner(repo: RepoView): string {
  const lines = ['| 路径 | 属主:组 | 权限 | 来源脚本 |', '|---|---|---|---|'];
  for (const r of dirRows(repo)) lines.push(`| ${r.path} | ${r.owner} | ${r.mode} | ${r.script} |`);
  return `\n\n${lines.join('\n')}\n\n`;
}

/** 整个区块（含两个标记行）：开头 `<!-- fleet:dirs:start -->`，一张四列表（路径、属主:组、权限、来源脚本），
 *  结尾 `<!-- fleet:dirs:end -->`。同一个仓两次调用逐字相同。 */
export function renderDirsBlock(repo: RepoView): string {
  return `${blockMarker(DIRS_NAME, 'start')}${dirsTableInner(repo)}${blockMarker(DIRS_NAME, 'end')}`;
}

function parseDirRows(text: string): DirRow[] {
  const rows: DirRow[] = [];
  for (const line of text.split('\n')) {
    const m = DIR_ROW.exec(line.trimEnd());
    if (m) rows.push({ path: m[1] ?? '', owner: m[2] ?? '', mode: m[3] ?? '', script: m[4] ?? '' });
  }
  return rows;
}

function groupDirRows(rows: DirRow[]): Map<string, DirRow[]> {
  const groups = new Map<string, DirRow[]>();
  for (const row of rows) {
    const key = `${row.path}\0${row.script}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function diffDirGroup(want: DirRow[], got: DirRow[]): OpsTableProblem[] {
  const unmatchedGot = [...got];
  const unmatchedWant: DirRow[] = [];
  for (const w of want) {
    const at = unmatchedGot.findIndex((g) => g.owner === w.owner && g.mode === w.mode);
    if (at === -1) unmatchedWant.push(w);
    else unmatchedGot.splice(at, 1);
  }
  const problems: OpsTableProblem[] = [];
  const n = Math.min(unmatchedWant.length, unmatchedGot.length);
  for (let i = 0; i < n; i++) {
    const w = unmatchedWant[i];
    const g = unmatchedGot[i];
    if (!w || !g) continue;
    problems.push({
      notQueried: false,
      text: `目录 ${w.path} 变了：文档区块里是 ${g.owner} ${g.mode}（${g.script}），脚本里是 ${w.owner} ${w.mode}。`,
    });
  }
  for (const w of unmatchedWant.slice(n)) {
    problems.push({
      notQueried: false,
      text: `目录 ${w.path} 少了：脚本里是 ${w.owner} ${w.mode}（${w.script}），文档区块里没有。`,
    });
  }
  for (const g of unmatchedGot.slice(n)) {
    problems.push({
      notQueried: false,
      text: `目录 ${g.path} 多了：文档区块里有 ${g.owner} ${g.mode}（${g.script}），脚本里没有。`,
    });
  }
  return problems;
}

function dirRowProblems(actual: string, expected: string): OpsTableProblem[] {
  const want = groupDirRows(parseDirRows(expected));
  const got = groupDirRows(parseDirRows(actual));
  const problems: OpsTableProblem[] = [];
  for (const [key, wRows] of want) problems.push(...diffDirGroup(wRows, got.get(key) ?? []));
  for (const [key, gRows] of got) if (!want.has(key)) problems.push(...diffDirGroup([], gRows));
  return problems;
}

/** 读 docPath，取目录区块，和 renderDirsBlock 逐字比。一致返回空数组；
 *  不一致返回点出哪个路径多了、少了、变了的问题；
 *  读不到文档、读不到脚本、变量展开不了、脚本里一个目录都没读到，返回「没查成」问题，不当成通过。 */
export function checkDirsBlock(repo: RepoView, docPath: string): OpsTableProblem[] {
  const doc = repo.read(docPath);
  if (doc === undefined) return [{ notQueried: true, text: `没查成：读不到 ${docPath}` }];
  let expected: string;
  try {
    expected = renderDirsBlock(repo);
  } catch (e) {
    return [{ notQueried: true, text: `没查成：${e instanceof Error ? e.message : String(e)}` }];
  }
  let span: BlockSpan;
  try {
    span = findBlock(doc, DIRS_NAME);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return [{ notQueried: false, text: `目录区块对不上（${docPath}）：${reason}。` }];
  }
  const actual = doc.slice(span.from, span.to);
  if (actual === expected) return [];
  const problems = dirRowProblems(actual, expected);
  if (problems.length > 0) return problems;
  return [
    {
      notQueried: false,
      text: '目录区块对不上：目录行都对，但区块和生成的内容不是逐字一致（排序、空白或表头格式被改过）。',
    },
  ];
}

// systemd 单元表（#140 第七片）：deploy/france/ 和 deploy/hk/ 下的单元文件才是单元的事实，
// 从文件里 `Description=` 那一行读说明，放进 units 区块。本片不进文档、不接命令行、不接 CI。

/** 机器和它的单元目录、认哪些后缀。表里按这个顺序排（法国在前、香港在后）。 */
const UNIT_SOURCES = [
  {
    machine: '法国',
    dir: 'deploy/france',
    suffixes: ['.service', '.socket', '.timer', '.path', '.slice'],
  },
  { machine: '香港', dir: 'deploy/hk', suffixes: ['.service'] },
] as const;

const DESCRIPTION_LINE = /^[ \t]*Description=(.*)$/;

/** 表里一行：| 单元文件 | 机器 | 说明 |。从文档区块里回读数据行用。 */
const UNIT_ROW = /^\| (\S+) \| (法国|香港) \| (.*) \|$/;

const UNITS_NAME = 'units';
/** 单元区块名字的对外写法（和端口、用户、目录的同一路，不各写各的字符串）。 */
export const BLOCK_NAME_UNITS = UNITS_NAME;

export interface UnitEntry {
  /** 单元文件名，如 fleet-api.service。 */
  file: string;
  /** 法国或香港。 */
  machine: string;
  /** `Description=` 的值，原样（`@@SESSION_USER@@` 这类占位符不替换）。 */
  description: string;
}

/** 读两个目录下的单元文件。有文件没有 Description 行抛带文件名的错；值原样返回（空值、含 `|` 也不拦）；
 *  两个目录都列不出来、或一个单元文件都没读到，也抛错（调用方落成「没查成」，不当成空表）。 */
export function readUnitEntries(repo: RepoView): UnitEntry[] {
  const entries: UnitEntry[] = [];
  let listed = 0;
  for (const src of UNIT_SOURCES) {
    const names = repo.list(src.dir);
    if (names === undefined) continue;
    listed++;
    for (const name of names) {
      if (!src.suffixes.some((s) => name.endsWith(s))) continue;
      const path = `${src.dir}/${name}`;
      const text = repo.read(path);
      if (text === undefined) throw new Error(`读不到 ${path}`);
      let description: string | undefined;
      for (const line of text.split('\n')) {
        const m = DESCRIPTION_LINE.exec(line.replace(/\r$/, ''));
        if (m) {
          description = m[1] ?? '';
          break;
        }
      }
      if (description === undefined) throw new Error(`${path} 里没有 Description= 这一行`);
      entries.push({ file: name, machine: src.machine, description });
    }
  }
  if (listed === 0) {
    throw new Error(`列不出 ${UNIT_SOURCES.map((s) => s.dir).join('、')} 下的文件`);
  }
  if (entries.length === 0) throw new Error('deploy/ 下一个单元文件都没读到');
  const rank = (machine: string) => UNIT_SOURCES.findIndex((s) => s.machine === machine);
  return entries.sort((a, b) => rank(a.machine) - rank(b.machine) || compareText(a.file, b.file));
}

/** 区块标记之间那一段：前后各一个空行、中间一张三列表，行按机器（法国、香港）、再按文件名排。 */
export function unitsTableInner(repo: RepoView): string {
  const lines = ['| 单元文件 | 机器 | 说明 |', '|---|---|---|'];
  for (const e of readUnitEntries(repo)) lines.push(`| ${e.file} | ${e.machine} | ${e.description} |`);
  return `\n\n${lines.join('\n')}\n\n`;
}

/** 整个区块（含两个标记行）：开头 `<!-- fleet:units:start -->`，一张三列表（单元文件、机器、说明），
 *  结尾 `<!-- fleet:units:end -->`。同一个仓两次调用逐字相同。 */
export function renderUnitsBlock(repo: RepoView): string {
  return `${blockMarker(UNITS_NAME, 'start')}${unitsTableInner(repo)}${blockMarker(UNITS_NAME, 'end')}`;
}

function parseUnitRows(text: string): Map<string, UnitEntry> {
  const rows = new Map<string, UnitEntry>();
  for (const line of text.split('\n')) {
    const m = UNIT_ROW.exec(line.trimEnd());
    if (!m) continue;
    const entry = { file: m[1] ?? '', machine: m[2] ?? '', description: m[3] ?? '' };
    rows.set(`${entry.machine}\0${entry.file}`, entry);
  }
  return rows;
}

function unitRowProblems(actual: string, expected: string): OpsTableProblem[] {
  const want = parseUnitRows(expected);
  const got = parseUnitRows(actual);
  const problems: OpsTableProblem[] = [];
  for (const [key, w] of want) {
    const g = got.get(key);
    if (g === undefined) {
      problems.push({
        notQueried: false,
        text: `单元 ${w.file} 少了：${w.machine}的 deploy/ 里有（${w.description}），文档区块里没有。`,
      });
    } else if (g.description !== w.description) {
      problems.push({
        notQueried: false,
        text: `单元 ${w.file} 的说明变了：文档区块里是「${g.description}」，${w.machine}的单元文件里是「${w.description}」。`,
      });
    }
  }
  for (const [key, g] of got) {
    if (!want.has(key)) {
      problems.push({
        notQueried: false,
        text: `单元 ${g.file} 多了：文档区块里有（${g.machine}，${g.description}），deploy/ 里没有这个单元文件。`,
      });
    }
  }
  return problems;
}

/** 读 docPath，取单元区块，和 renderUnitsBlock 逐字比。一致返回空数组；
 *  不一致返回点出哪个单元文件多了、少了、说明变了的问题；
 *  读不到文档、列不出单元目录、单元文件缺 Description 行，返回「没查成」问题，不当成通过。 */
export function checkUnitsBlock(repo: RepoView, docPath: string): OpsTableProblem[] {
  const doc = repo.read(docPath);
  if (doc === undefined) return [{ notQueried: true, text: `没查成：读不到 ${docPath}` }];
  let expected: string;
  try {
    expected = renderUnitsBlock(repo);
  } catch (e) {
    return [{ notQueried: true, text: `没查成：${e instanceof Error ? e.message : String(e)}` }];
  }
  let span: BlockSpan;
  try {
    span = findBlock(doc, UNITS_NAME);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return [{ notQueried: false, text: `单元区块对不上（${docPath}）：${reason}。` }];
  }
  const actual = doc.slice(span.from, span.to);
  if (actual === expected) return [];
  const problems = unitRowProblems(actual, expected);
  if (problems.length > 0) return problems;
  return [
    {
      notQueried: false,
      text: '单元区块对不上：单元行都对，但区块和生成的内容不是逐字一致（排序、空白或表头格式被改过）。',
    },
  ];
}
