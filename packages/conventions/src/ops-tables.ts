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

// 目录表（#140 第五片）：从三个部署脚本里的 `ensure_dir <路径> <属主:组> <权限>` 生成 dirs 区块。
// 做法同用户表：本片只提供纯函数，区块还不进 docs/ops.md、不接命令行、不接 CI。

/** 收 ensure_dir 的脚本。读的顺序不影响输出：读完按路径、再按来源脚本排。 */
const DIR_SCRIPTS = ['deploy/france.sh', 'deploy/hk.sh', 'deploy/lib/human-tier.sh'] as const;

/** 行首（允许缩进）的 ensure_dir 调用，捕获它后面的参数串。 */
const ENSURE_DIR_LINE = /^[ \t]*ensure_dir[ \t]+(.*)$/;

/** 允许缩进的字面赋值，可带 readonly / export。 */
const ASSIGN_LINE = /^[ \t]*(?:(?:readonly|export)[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** 变量引用：`$NAME` 或 `${NAME}`。 */
const VAR_REF = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/** shell 循环变量：循环体里的目录通常是一人一份，不进固定目录表。 */
const FOR_VAR_LINE = /^[ \t]*for[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+(?:in\b|;)/;

/** 表里一行：| 路径 | 属主:组 | 权限 | 来源脚本 |。从文档区块里回读数据行用。 */
const DIR_ROW = /^\| ([^|\s]+) \| ([^|\s]+) \| ([^|\s]+) \| (deploy\/[A-Za-z0-9_./-]+\.sh) \|$/;

const DIRS_NAME = 'dirs';
/** 目录区块名字的对外写法（和端口、用户的区块名同一路，不各写各的字符串）。 */
export const BLOCK_NAME_DIRS = DIRS_NAME;

export interface DirEntry {
  /** 路径，变量已展开成字面路径。 */
  path: string;
  /** 属主:组，如 root:fleet。 */
  owner: string;
  /** 权限，如 750。 */
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

/** 把一行 ensure_dir 后面的参数串切成词：双引号、单引号包起来的算一个词（带引号的标出来），其余按空白切。
 *  遇到词首的 `#` 就收尾（行尾注释）。 */
function splitShellWords(rest: string): { text: string; quote: '' | '"' | "'" }[] {
  const words: { text: string; quote: '' | '"' | "'" }[] = [];
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i] ?? '';
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === '#') break;
    if (ch === '"' || ch === "'") {
      const close = rest.indexOf(ch, i + 1);
      if (close === -1) return words;
      words.push({ text: rest.slice(i + 1, close), quote: ch });
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < rest.length && rest[j] !== ' ' && rest[j] !== '\t') j++;
    words.push({ text: rest.slice(i, j), quote: '' });
    i = j;
  }
  return words;
}

/** 赋值号右边的字面值；带 `$(`、反引号的是命令替换，不是字面路径，返回 undefined。 */
function literalAssignValue(raw: string): string | undefined {
  const words = splitShellWords(raw);
  const first = words[0];
  if (!first) return '';
  if (first.quote === "'") return first.text;
  if (first.text.includes('$(') || first.text.includes('`')) return undefined;
  return first.text;
}

interface AssignIndex {
  /** 脚本路径 → 变量名 → 该脚本里行首赋值的字面值（去重）。 */
  byScript: Map<string, Map<string, string[]>>;
  /** deploy/lib/ 下的脚本路径，按名字排。 */
  libScripts: string[];
  /** 脚本路径 → 该脚本 shell 循环里的变量名；这些变量随循环中的用户变化。 */
  perUserVars: Map<string, Set<string>>;
}

function buildAssignIndex(repo: RepoView): AssignIndex {
  const libScripts = (repo.list('deploy/lib') ?? [])
    .filter((n) => n.endsWith('.sh'))
    .map((n) => `deploy/lib/${n}`)
    .sort(byCodeUnit);
  const byScript = new Map<string, Map<string, string[]>>();
  const perUserVars = new Map<string, Set<string>>();
  for (const script of new Set<string>([...DIR_SCRIPTS, ...libScripts])) {
    const text = repo.read(script);
    if (text === undefined) continue;
    const vars = new Map<string, string[]>();
    const userVars = new Set<string>();
    for (const line of text.split('\n')) {
      const loop = FOR_VAR_LINE.exec(line);
      if (loop?.[1]) userVars.add(loop[1]);
      const m = ASSIGN_LINE.exec(line);
      if (!m) continue;
      const value = literalAssignValue(m[2] ?? '');
      if (value === undefined) continue;
      const name = m[1] ?? '';
      const list = vars.get(name) ?? [];
      if (!list.includes(value)) list.push(value);
      vars.set(name, list);
    }
    byScript.set(script, vars);
    perUserVars.set(script, userVars);
  }
  return { byScript, libScripts, perUserVars };
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 找变量 name 的字面赋值：先同一脚本，再 deploy/lib/ 下别的脚本；
 *  来源脚本本身在 deploy/lib/ 下（france.sh 和 hk.sh 共用的库，常量写在入口脚本里）时，最后再看 france.sh、hk.sh。
 *  同一档里值不止一个，抛带调用处（where = 脚本名:行号）的错，不挑一个。找不到返回 undefined。 */
function lookupAssign(index: AssignIndex, script: string, name: string, where: string): string | undefined {
  const tiers: string[][] = [[script], index.libScripts.filter((s) => s !== script)];
  if (script.startsWith('deploy/lib/')) tiers.push(['deploy/france.sh', 'deploy/hk.sh']);
  for (const tier of tiers) {
    const hits: { script: string; value: string }[] = [];
    for (const s of tier) {
      for (const value of index.byScript.get(s)?.get(name) ?? []) hits.push({ script: s, value });
    }
    const distinct = new Set(hits.map((h) => h.value));
    if (distinct.size > 1) {
      throw new Error(
        `${where} 用到的变量 $${name} 有几个不同的赋值（${hits.map((h) => `${h.script}: ${h.value}`).join('；')}），挑不出一个`,
      );
    }
    if (hits[0]) return hits[0].value;
  }
  return undefined;
}

/** 展开文本里的 `$NAME`、`${NAME}`（赋值的右边带变量也递归展开）。
 *  碰到按用户变化的变量返回 undefined（整行不进表）；展开不了的变量、`$(…)`、`${X:-y}` 这类写法抛错。 */
function expandVars(
  index: AssignIndex,
  script: string,
  where: string,
  text: string,
  seen: readonly string[],
  perUserVars: ReadonlySet<string>,
): string | undefined {
  let perUser = false;
  let bad: string | undefined;
  const out = text.replace(VAR_REF, (_all, braced: string | undefined, plain: string | undefined) => {
    const name = braced ?? plain ?? '';
    if (perUserVars.has(name)) {
      perUser = true;
      return '';
    }
    if (seen.includes(name))
      throw new Error(`${where} 的变量 $${name} 赋值绕成了圈（${[...seen, name].join(' → ')}）`);
    const raw = lookupAssign(index, script, name, where);
    if (raw === undefined) {
      bad ??= `${where} 的变量 $${name} 展开不了（同一脚本和 deploy/lib/ 下没有 ${name}=字面路径 的行首赋值）`;
      return '';
    }
    const inner = expandVars(index, script, where, raw, [...seen, name], perUserVars);
    if (inner === undefined) {
      perUser = true;
      return '';
    }
    return inner;
  });
  if (bad !== undefined) throw new Error(bad);
  if (perUser) return undefined;
  if (out.includes('$')) throw new Error(`${where} 的参数「${text}」里有展开不了的 $ 写法`);
  return out;
}

/** 读三个脚本里的 `ensure_dir <路径> <属主:组> <权限>`。
 *  路径写成 `$NAME`、`"$NAME"`（或带变量的 `"$NAME/bin"`）的，用同一脚本、deploy/lib/ 下 `NAME=字面路径` 的赋值展开
 *  （库脚本里的变量常写在 france.sh、hk.sh 里，最后也看这两个）；
 *  路径里带按用户变化的变量（如 `/home/$u`、`"$home"`）的行不进表，因为那是一个用户一份，不是固定目录；
 *  展开不了的其他变量抛带脚本名和行号的错，不静默跳过。
 *  读不到脚本、哪个脚本里一个 ensure_dir 都没有、一行不足三个参数，也抛错（调用方落成「没查成」）。 */
export function readDirEntries(repo: RepoView): DirEntry[] {
  const index = buildAssignIndex(repo);
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
      const words = splitShellWords(m[1] ?? '');
      if (words.length < 3)
        throw new Error(`${where} 的 ensure_dir 不足三个参数（路径 属主:组 权限）：${line.trim()}`);
      const values: string[] = [];
      let perUser = false;
      const perUserVars = index.perUserVars.get(script) ?? new Set<string>();
      for (const w of words.slice(0, 3)) {
        const v = w.quote === "'" ? w.text : expandVars(index, script, where, w.text, [], perUserVars);
        if (v === undefined) perUser = true;
        else values.push(v);
      }
      if (perUser) continue;
      entries.push({
        path: values[0] ?? '',
        owner: values[1] ?? '',
        mode: values[2] ?? '',
        script,
        line: i + 1,
      });
    }
    if (found === 0) throw new Error(`${script} 里一个 ensure_dir 都没读到`);
  }
  // 同一脚本里同样的一行写了两遍，表里只留一行（表里没有行号，两行一样没意义）。
  const seen = new Set<string>();
  const unique = entries.filter((e) => {
    const key = dirRowKey(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort(compareDirRows);
}

function dirRowKey(row: DirRow): string {
  return `${row.path}\0${row.owner}\0${row.mode}\0${row.script}`;
}

/** 按路径、再按来源脚本排；后面两个只为同一个仓怎么读输出都一样。 */
function compareDirRows(a: DirRow, b: DirRow): number {
  return (
    byCodeUnit(a.path, b.path) ||
    byCodeUnit(a.script, b.script) ||
    byCodeUnit(a.owner, b.owner) ||
    byCodeUnit(a.mode, b.mode)
  );
}

/** 区块标记之间那一段：前后各一个空行、中间一张四列表。 */
export function dirsTableInner(repo: RepoView): string {
  const lines = ['| 路径 | 属主:组 | 权限 | 来源脚本 |', '|---|---|---|---|'];
  for (const e of readDirEntries(repo)) lines.push(`| ${e.path} | ${e.owner} | ${e.mode} | ${e.script} |`);
  return `\n\n${lines.join('\n')}\n\n`;
}

/** 整个区块（含两个标记行）：开头 `<!-- fleet:dirs:start -->`，一张四列表（路径、属主:组、权限、来源脚本），
 *  结尾 `<!-- fleet:dirs:end -->`。行按路径、再按来源脚本排。同一个仓两次调用逐字相同。 */
export function renderDirsBlock(repo: RepoView): string {
  return `${blockMarker(DIRS_NAME, 'start')}${dirsTableInner(repo)}${blockMarker(DIRS_NAME, 'end')}`;
}

function parseDirRows(text: string): DirRow[] {
  const rows: DirRow[] = [];
  for (const line of text.split('\n')) {
    const m = DIR_ROW.exec(line.trimEnd());
    if (!m) continue;
    rows.push({ path: m[1] ?? '', owner: m[2] ?? '', mode: m[3] ?? '', script: m[4] ?? '' });
  }
  return rows;
}

function sameDirRows(want: DirRow[], got: DirRow[]): boolean {
  if (want.length !== got.length) return false;
  const count = new Map<string, number>();
  for (const row of want) count.set(dirRowKey(row), (count.get(dirRowKey(row)) ?? 0) + 1);
  for (const row of got) {
    const n = count.get(dirRowKey(row)) ?? 0;
    if (n === 0) return false;
    count.set(dirRowKey(row), n - 1);
  }
  return true;
}

function dirChangeText(w: DirRow, g: DirRow): string {
  const parts: string[] = [];
  if (g.owner !== w.owner) parts.push(`属主:组文档区块里是 ${g.owner}，脚本里是 ${w.owner}`);
  if (g.mode !== w.mode) parts.push(`权限文档区块里是 ${g.mode}，脚本里是 ${w.mode}`);
  return `目录 ${w.path} 变了（${w.script}）：${parts.join('；')}。`;
}

function dirRowProblems(actual: string, expected: string): OpsTableProblem[] {
  const wantRows = parseDirRows(expected);
  const gotRows = parseDirRows(actual);
  // 行的集合一样、只是顺序或空白变了：交给调用方报「不是逐字一致」，不把换序说成目录变了。
  if (sameDirRows(wantRows, gotRows)) return [];
  const group = (rows: DirRow[]) => {
    const groups = new Map<string, DirRow[]>();
    for (const row of rows) {
      const key = `${row.path}\0${row.script}`;
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
    return groups;
  };
  const want = group(wantRows);
  const got = group(gotRows);
  const problems: OpsTableProblem[] = [];
  for (const key of new Set([...want.keys(), ...got.keys()])) {
    // 先对上整行相同的；剩下同一路径同一脚本的按位置配成「变了」，再多出来的是少了或多了。
    const unmatchedGot = [...(got.get(key) ?? [])];
    const unmatchedWant: DirRow[] = [];
    for (const w of want.get(key) ?? []) {
      const at = unmatchedGot.findIndex((g) => dirRowKey(g) === dirRowKey(w));
      if (at === -1) unmatchedWant.push(w);
      else unmatchedGot.splice(at, 1);
    }
    const n = Math.min(unmatchedWant.length, unmatchedGot.length);
    for (let i = 0; i < n; i++) {
      const w = unmatchedWant[i];
      const g = unmatchedGot[i];
      if (w && g) problems.push({ notQueried: false, text: dirChangeText(w, g) });
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
  }
  return problems;
}

/** 读 docPath，取目录区块，和 renderDirsBlock 逐字比。一致返回空数组；
 *  不一致返回点出哪个目录多了、少了、变了（属主:组或权限写错）的问题；
 *  读不到文档、读不到脚本、变量展开不了、脚本里一个 ensure_dir 都没读到，返回「没查成」问题，不当成通过。 */
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
    // 区块缺失时也点出路径：脚本里有、文档区块里一个都没有的目录，逐条列出来。
    const missing = [...new Set(parseDirRows(expected).map((r) => r.path))];
    const hint = missing.length > 0 ? `脚本里的目录（${missing.join('、')}）在文档区块里都没有。` : '';
    return [{ notQueried: false, text: `目录区块对不上：${reason}。${hint}` }];
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
