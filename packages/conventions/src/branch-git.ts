// 分支体检（#769）要的「内容」那几样从本地 git 读：分支比主线多出来的改动、这些改动主线历史上有没有过、最后一次提交、提交作者。
// Actions 里检出全部历史（fetch-depth: 0）。只认 GitHub 读回来的 40 位提交号，不认本地的分支名（本地的 origin/<分支> 可能是
// 旧的）；本地缺这个提交（本机没 fetch、Actions 检出之后主线又合了新的）由 gitFacts 先 git fetch origin 一次再判。
// 改这里之前必须知道：
// - 「没产出」是机器不经人自己删分支的依据：只有确定分支上没有主线历史以外的东西才回 none。git 跑不成、读回来认不出一律抛
//   BranchGitError（调用方记「没查成」、不删），不拿空冒充「没改动」。故意造出的失败在 test/branch-git.test.ts。
// - 路径一律走 -z：仓里有中文路径，不带 -z 时 git 会把它们转义、加引号，按路径比对就全错了。

export type GitExec = (
  args: readonly string[],
  input?: string,
) => { status: number | null; stdout: string; stderr: string; error?: Error | undefined };

export class BranchGitError extends Error {}

const SHA = /^[0-9a-f]{40}$/;
const ZERO = '0'.repeat(40);

/** 主线的索引：一轮建一次，各分支共用。 */
export interface MainIndex {
  sha: string;
  /** 主线现在的每个文件：路径 → 对象号。 */
  current: Map<string, string>;
  /** 主线历史上出现过的「路径 + 对象号」（键是 `路径\0对象号`）。 */
  history: Set<string>;
}

/** 分支自己的改动里，主线历史上没有的那些（有产出）；或分支和主线没有共同祖先（判不了）。 */
export type Output =
  | { kind: 'none'; changed: number }
  | { kind: 'some'; changed: number; files: string[] }
  | { kind: 'unrelated' };

export interface ContentFacts {
  /** 分支头那个提交的提交时间（ISO）。 */
  headDate: string;
  headSubject: string;
  /** 分支上有、主线上没有的提交数。 */
  ahead: number;
  /** 主线上有、分支上没有的提交数。 */
  behind: number;
  /** 分支上（主线没有的）提交的作者，去重。 */
  authors: string[];
  /** 这些提交 Co-Authored-By 里的名字（去掉邮箱），去重。 */
  coAuthors: string[];
  output: Output;
}

function run(git: GitExec, args: readonly string[], what: string, input?: string): string {
  const r = git(args, input);
  if (r.error) throw new BranchGitError(`${what}：git 跑不起来（${r.error.message}）`);
  if (r.status !== 0) {
    const why = r.stderr.trim().split('\n')[0] || `退出码 ${r.status ?? '（被信号杀掉）'}`;
    throw new BranchGitError(`${what}：git ${args[0]} 没成（${why}）`);
  }
  return r.stdout;
}

/** 本地有没有这个提交；git 跑不起来照抛。 */
function hasCommit(git: GitExec, sha: string): boolean {
  if (!SHA.test(sha)) throw new BranchGitError(`提交号认不出：${sha}`);
  const r = git(['cat-file', '-e', `${sha}^{commit}`]);
  if (r.error) throw new BranchGitError(`查提交 ${sha.slice(0, 9)}：git 跑不起来（${r.error.message}）`);
  return r.status === 0;
}

function needCommit(git: GitExec, sha: string): void {
  if (!hasCommit(git, sha)) {
    throw new BranchGitError(
      `本地没有提交 ${sha.slice(0, 9)}：先 git fetch origin（Actions 里要检出全部历史）`,
    );
  }
}

/** 内容那几样的读法（分支体检整轮用一份）。 */
export interface FactsReader {
  index(mainSha: string): MainIndex;
  content(index: MainIndex, headSha: string): ContentFacts;
}

/**
 * 默认的读法：要用的提交本地没有，就 git fetch origin（全部分支）一次再看；fetch 没成、fetch 完还没有（分支刚被强推、
 * 旧头没了）都抛，说清是哪样。一整轮最多 fetch 一次：GitHub 那边已经先读完了，fetch 拿到的只会更新。
 */
export function gitFacts(git: GitExec): FactsReader {
  let fetched: { ok: true } | { ok: false; why: string } | undefined;
  const ensure = (sha: string) => {
    if (hasCommit(git, sha)) return;
    if (fetched === undefined) {
      const r = git(['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
      fetched = r.error
        ? { ok: false, why: `git 跑不起来（${r.error.message}）` }
        : r.status !== 0
          ? { ok: false, why: r.stderr.trim().split('\n')[0] || `退出码 ${r.status ?? '（被信号杀掉）'}` }
          : { ok: true };
    }
    if (!fetched.ok) {
      throw new BranchGitError(`本地没有提交 ${sha.slice(0, 9)}，git fetch origin 也没成（${fetched.why}）`);
    }
    if (!hasCommit(git, sha)) {
      throw new BranchGitError(
        `本地没有提交 ${sha.slice(0, 9)}，git fetch origin 之后也没有（分支可能刚被强推过，下一轮再判）`,
      );
    }
  };
  return {
    index(mainSha) {
      ensure(mainSha);
      return mainIndex(git, mainSha);
    },
    content(index, headSha) {
      ensure(headSha);
      return contentFacts(git, index, headSha);
    },
  };
}

/** 一条 --raw -z 的改动：状态（A、D、M、T…）、改完的对象号（删掉的是全 0）、路径。 */
interface RawChange {
  status: string;
  blob: string;
  path: string;
}

/**
 * 解析 `--raw -z --no-renames --no-abbrev` 的输出：`:旧模式 新模式 旧号 新号 状态\0路径\0` 一条接一条，
 * 几个提交之间可能夹着换行。认不出的一段就抛（不跳过：跳过会把一条改动漏掉，漏掉的可能正是产出）。
 */
export function parseRaw(out: string): RawChange[] {
  const tokens = out.split('\0');
  const changes: RawChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const meta = (tokens[i] ?? '').replace(/^\n+/, '');
    if (meta === '' || meta === '\n') continue;
    const m = /^:\d{6} \d{6} ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/.exec(meta);
    const path = tokens[i + 1];
    if (!m || path === undefined || path === '') {
      throw new BranchGitError(`git 的改动清单认不出（${JSON.stringify(meta.slice(0, 80))}）`);
    }
    changes.push({ status: m[3] ?? '', blob: m[2] ?? '', path });
    i++;
  }
  return changes;
}

/** 建主线的索引：现在的每个文件，和历史上每个提交改出来的「路径 + 对象号」。 */
export function mainIndex(git: GitExec, mainSha: string): MainIndex {
  needCommit(git, mainSha);
  const current = new Map<string, string>();
  const tree = run(git, ['ls-tree', '-r', '-z', '--full-tree', mainSha], '列主线的文件');
  for (const entry of tree.split('\0')) {
    if (entry === '') continue;
    const m = /^\d{6} (?:blob|commit|tree) ([0-9a-f]{40})\t(.+)$/s.exec(entry);
    if (!m?.[1] || m[2] === undefined)
      throw new BranchGitError(`主线的文件清单认不出（${JSON.stringify(entry.slice(0, 80))}）`);
    current.set(m[2], m[1]);
  }
  if (current.size === 0) throw new BranchGitError('主线上一个文件都没列出来，不当成空仓');
  const history = new Set<string>();
  const log = run(
    git,
    ['log', '--format=', '--raw', '-z', '--no-renames', '--no-abbrev', '--root', mainSha],
    '读主线的历史',
  );
  for (const c of parseRaw(log)) if (c.blob !== ZERO) history.add(`${c.path}\0${c.blob}`);
  return { sha: mainSha, current, history };
}

/** 这条分支的内容那几样。主线索引由调用方建一次传进来。 */
export function contentFacts(git: GitExec, main: MainIndex, headSha: string): ContentFacts {
  needCommit(git, headSha);
  const head = run(git, ['log', '-1', '--format=%cI%x00%s', headSha], '读分支头的提交').replace(/\n$/, '');
  const [headDate, headSubject] = head.split('\0');
  if (!headDate || Number.isNaN(Date.parse(headDate)) || headSubject === undefined) {
    throw new BranchGitError(`读分支头的提交，认不出（${JSON.stringify(head.slice(0, 80))}）`);
  }
  const counts = run(git, ['rev-list', '--left-right', '--count', `${main.sha}...${headSha}`], '数领先落后')
    .trim()
    .split(/\s+/);
  const behind = Number(counts[0]);
  const ahead = Number(counts[1]);
  if (counts.length !== 2 || !Number.isInteger(behind) || !Number.isInteger(ahead)) {
    throw new BranchGitError(`数领先落后，认不出（${counts.join(' ')}）`);
  }
  const people = run(
    git,
    [
      'log',
      '--format=%an%x00%(trailers:key=Co-Authored-By,valueonly,separator=%x1f)%x1e',
      `${main.sha}..${headSha}`,
    ],
    '读分支上的提交',
  );
  const authors = new Set<string>();
  const coAuthors = new Set<string>();
  for (const rec of people.split('\x1e')) {
    const r = rec.replace(/^\n+/, '');
    if (r === '') continue;
    const [author, trailers = ''] = r.split('\0');
    if (author) authors.add(author);
    for (const t of trailers.split('\x1f')) {
      const name = t.replace(/<[^>]*>/, '').trim();
      if (name) coAuthors.add(name);
    }
  }
  const facts = {
    headDate,
    headSubject,
    ahead,
    behind,
    authors: [...authors].sort(),
    coAuthors: [...coAuthors].sort(),
  };

  const mb = git(['merge-base', main.sha, headSha]);
  if (mb.error) throw new BranchGitError(`找分叉点：git 跑不起来（${mb.error.message}）`);
  // 退出码 1 且什么都没打 = 两边没有共同祖先（git 的约定）；别的非 0 是真没跑成
  if (mb.status === 1 && mb.stdout.trim() === '') return { ...facts, output: { kind: 'unrelated' } };
  if (mb.status !== 0)
    throw new BranchGitError(`找分叉点：git merge-base 没成（${mb.stderr.trim() || mb.status}）`);
  const base = mb.stdout.trim();
  if (!SHA.test(base)) throw new BranchGitError(`找分叉点，认不出（${base.slice(0, 80)}）`);

  const changes = parseRaw(
    run(git, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', base, headSha], '算分支自己的改动'),
  );
  const uncovered = changes
    .filter((c) =>
      c.blob === ZERO
        ? main.current.has(c.path) // 分支删了它、主线上现在还在：删这件事主线上没有
        : main.current.get(c.path) !== c.blob && !main.history.has(`${c.path}\0${c.blob}`),
    )
    .map((c) => c.path)
    .sort();
  return {
    ...facts,
    output:
      uncovered.length === 0
        ? { kind: 'none', changed: changes.length }
        : { kind: 'some', changed: changes.length, files: uncovered },
  };
}
