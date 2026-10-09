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
  const problems: OpsTableProblem[] = [];
  const n = Math.min(want.length, got.length);
  for (let i = 0; i < n; i++) {
    const w = want[i];
    const g = got[i];
    if (!w || !g || w.user === g.user) continue;
    problems.push({
      notQueried: false,
      text: `用户 ${g.user} 变了：来源常量 ${w.source}（${w.script}），文档区块里是 ${g.user}，脚本里是 ${w.user}。`,
    });
  }
  for (const w of want.slice(n)) {
    problems.push({
      notQueried: false,
      text: `用户 ${w.user} 少了：来源常量 ${w.source}（${w.script}），脚本里是 ${w.user}，文档区块里没有。`,
    });
  }
  for (const g of got.slice(n)) {
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
