// 逐个提交扫：推上去的是整段提交历史，不只是最后的样子——先加后删的密钥、写进提交说明的组织编号，照样留在远端历史里。
// 三次 git log 取这段提交各自的东西：新增的行（合并提交只看它自己改的：两边重新合一遍、和实际结果的差），新增、改动、
// 改名的文件名，提交说明和作者、提交者。和全仓扫同一套规则、名单、白名单。推送前的钩子（prepush.ts）和会话外推分支
// （packages/github 的 push.ts）共用。git 的输出认不出就抛错，调用方按「没扫成」拒推，不当成扫过没事。
import { ALLOWLIST, type Allow } from './allowlist.ts';
import { addedHunks, scanAdded, unquotePath } from './diff.ts';
import { findHits } from './rules.ts';
import { applyAllowlist, type Finding } from './scan.ts';
import { valueMatcher } from './values.ts';

export interface CommitFinding extends Finding {
  /** 出在哪个提交里（完整提交号）。 */
  commit: string;
}

export interface HistoryScan {
  /** 扫了的提交，从旧到新。 */
  commits: string[];
  /** 各个提交新增的行数加起来（不算下面跳过的那些段）。 */
  addedLines: number;
  /** 带 NUL 的新增段（二进制文件）：内容没看，只按文件名判。单列出来，免得「没看」混进「看了没事」。 */
  binaryHunks: number;
  findings: CommitFinding[];
}

export interface HistoryOutput {
  patch: string;
  names: string;
  messages: string;
}

/** 查出东西以后怎么改：东西在提交历史里，只在后面补一个删掉它的提交不算。 */
export const REWRITE_HINT =
  '这些在提交历史里：改写出问题的那几个提交把东西拿掉（最新的一个 git commit --amend，更早的 git rebase -i 里 edit 或 fixup）。' +
  '只在后面补一个删掉它的提交不算——前面那个提交照样会推上去。';

/** 每个提交那一段输出的第一行。\x01 开头的行不会是 diff：内容行都以 +、-、空格开头，头部行都是固定的英文词。 */
const COMMIT_MARK = '\x01fleet-commit ';
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * 取一段提交逐个的内容要跑的三条 git 命令。revs 是 git log 的范围，例如 [<头>, '--not', '--remotes']。
 * 会改输出格式的配置（颜色、外部 diff、textconv、路径前缀、签名显示）都钉死，不受本机 git 配置影响。
 * --text：.gitattributes 标了 -diff / binary、或 core.bigFileThreshold 调低时，git 会把文本文件当二进制只说一句
 * 「Binary files differ」，内容就漏了；强制出文本差异，真二进制（带 NUL 的段）由 scanHistory 跳过、单独计数。
 */
export function historyArgs(revs: readonly string[]): {
  patch: string[];
  names: string[];
  messages: string[];
} {
  const log = [
    '-c',
    'core.quotePath=false',
    '-c',
    'log.showRoot=true',
    '-c',
    'log.showSignature=false',
    'log',
    '--reverse',
    '--no-color',
  ];
  const diff = [
    '--no-ext-diff',
    '--no-textconv',
    '--text',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '-M',
    '--diff-filter=ACMRT',
    '--diff-merges=remerge',
    '--format=%x01fleet-commit %H',
  ];
  return {
    patch: [...log, ...diff, '-p', '-U0', ...revs, '--'],
    names: [...log, ...diff, '--name-only', ...revs, '--'],
    messages: [...log, '--format=%x00%H%x01%an <%ae>%x01%cn <%ce>%x01%B', ...revs, '--'],
  };
}

/** 按提交标记切开 git log 的输出：提交号 → 这个提交那一段。有内容却一个标记都没有、标记后面不是提交号，就是认不出。 */
function byCommit(what: string, out: string): Map<string, string> {
  const parts = new Map<string, string>();
  let commit: string | undefined;
  let lines: string[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith(COMMIT_MARK)) {
      if (commit !== undefined) parts.set(commit, lines.join('\n'));
      commit = line.slice(COMMIT_MARK.length).trim();
      if (!SHA.test(commit)) throw new Error(`${what}的输出认不出：提交标记后面不是提交号`);
      lines = [];
    } else if (commit !== undefined) lines.push(line);
    else if (line.trim() !== '') throw new Error(`${what}的输出认不出：第一个提交标记之前就有内容`);
  }
  if (commit !== undefined) parts.set(commit, lines.join('\n'));
  return parts;
}

/**
 * 逐个提交扫：每个提交新增的行和文件名、提交说明、作者和提交者。三份输出要对得上（新增行、文件名里出现的提交
 * 都得在提交清单里），对不上、认不出就抛错。
 */
export function scanHistory(
  out: HistoryOutput,
  options: { values: readonly string[]; allowlist?: readonly Allow[] },
): HistoryScan {
  const allowlist = options.allowlist ?? ALLOWLIST;
  const matcher = valueMatcher(options.values);
  const used = new Set<Allow>();
  const order = new Map<string, number>();
  const inMessages: CommitFinding[] = [];
  const inContent: CommitFinding[] = [];

  const blocks = out.messages.split('\0');
  if ((blocks[0] ?? '').trim() !== '') throw new Error('提交说明的输出认不出：开头不是提交分隔符');
  for (const block of blocks.slice(1)) {
    const [raw = '', author = '', committer = '', ...body] = block.split('\x01');
    const commit = raw.trim();
    if (!SHA.test(commit) || body.length === 0) throw new Error('提交说明的输出认不出：缺提交号或段落');
    order.set(commit, order.size);
    const found: Finding[] = [];
    const texts: [path: string, text: string][] = [
      ['提交说明', body.join('\x01')],
      ['提交作者', author],
      ['提交者', committer],
    ];
    for (const [path, text] of texts) {
      for (const hit of [...findHits(text), ...matcher.find(text)])
        found.push({ ...hit, path, line: path === '提交说明' ? hit.line : 0 });
    }
    for (const f of applyAllowlist(found, allowlist, used)) inMessages.push({ ...f, commit });
  }

  const patches = byCommit('逐个提交的差异', out.patch);
  const names = byCommit('逐个提交的文件名', out.names);
  let addedLines = 0;
  let binaryHunks = 0;
  for (const commit of new Set([...patches.keys(), ...names.keys()])) {
    if (!order.has(commit))
      throw new Error(`逐个提交的差异和提交清单对不上：${commit.slice(0, 7)} 不在清单里`);
    // 带 NUL 的段是二进制文件（--text 硬出的），和全仓扫一样不看内容、只按文件名判。
    const hunks = addedHunks(patches.get(commit) ?? '').filter((h) => {
      if (!h.text.includes('\0')) return true;
      binaryHunks += 1;
      return false;
    });
    addedLines += hunks.reduce((n, h) => n + h.text.split('\n').length, 0);
    const paths = (names.get(commit) ?? '')
      .split('\n')
      .map((p) => p.replace(/\r$/, ''))
      .filter(Boolean)
      .map(unquotePath);
    for (const f of scanAdded(hunks, paths, { values: options.values, allowlist }))
      inContent.push({ ...f, commit });
  }

  // 按提交从旧到新排，同一个提交里先内容、后说明和作者（sort 是稳定的）。
  const findings = [...inContent, ...inMessages].sort(
    (a, b) => (order.get(a.commit) ?? 0) - (order.get(b.commit) ?? 0),
  );
  return { commits: [...order.keys()], addedLines, binaryHunks, findings };
}
