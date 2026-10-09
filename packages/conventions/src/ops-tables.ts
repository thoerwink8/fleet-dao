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
  return portRowProblems(actual, expected);
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
