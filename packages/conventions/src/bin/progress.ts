// 进度和创始人引导的入口：pnpm progress note / progress directive / progress claim / progress done / progress read。
// 引导记在仓里 docs/directives/（../directives.ts），进度流水和驾驶舱来的引导收件箱在置顶单 #1055（../progress.ts）。
// 退出码 0 = 成了；1 = 拒绝（参数不对、这条不是该办的那种、已归别的会话、取不到原话要手填）；2 = 没查成、没写成。
// `read --pending` 给开会话钩子用：只列没处理的引导，一条一行（编号<TAB>第一行<TAB>原话压成一行<TAB>主人<TAB>记下的时刻 ISO）；
// 读的是本地 origin/main（钩子后台刚 fetch 过）加 #1055 收件箱最近 30 天。
// 主人＝本会话的血缘：CLAUDE_CODE_SESSION_ID 所属的 Mirasim 会话目录名（agents/hooks/founder-inbox.mjs 的 lineageOf）。
// `claim <编号> --auto --expect-owner <原主>`：开会话钩子替指挥官会话自动认领主人已不在的引导——这里再核一遍「本会话是指挥官会话、
// 原主确定已不在（ownerPresence 判 gone）、主人还是原主」，哪条不满足都不认。

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  claimDirective,
  type Directive,
  DirectiveRefused,
  DONE,
  DROPPED,
  directiveFromComment,
  doneContent,
  findById,
  type Git,
  type LineageInfo,
  listPaths,
  listPending,
  MAIN,
  mergeLogs,
  parseDirective,
  proposeFile,
  readPromptLog,
  recordDirective,
  resolveDirective,
  stamp,
  withChange,
} from '../directives.ts';
import { gitRunner } from '../git-runner.ts';
import { ghRunner } from '../issue-new.ts';
import {
  inboxPending,
  markMigrated,
  PENDING_TAG,
  PROGRESS_ISSUE,
  PROGRESS_USAGE,
  ProgressRefused,
  ProgressUnchecked,
  progressNote,
  readInboxComment,
  recentComments,
  textOf,
} from '../progress.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
/** 敲命令的地方（pnpm 把 cwd 换成仓根，原来的在 INIT_CWD）：done 在工作树里时改那里的文件 */
const here = process.env.INIT_CWD ?? process.cwd();
const gh = ghRunner(root);
const git: Git = gitRunner(root);
const gitHere: Git = (args) =>
  new Promise((done) =>
    execFile('git', args, { cwd: here, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) =>
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }),
    ),
  );

interface Hooks {
  lineageOf(o: { home: string; sessionId: unknown }): LineageInfo;
  ownerPresence(o: { home: string; owner: string }): { state: 'gone' | 'here' | 'unknown'; why: string };
  sentByFounder(o: {
    home: string;
    only: string;
  }):
    | { absent: true }
    | { absent: false; entries: Array<{ at: number; text: string; sessionId: string | null }> };
}
/** 钩子家的脚本，按路径动态加载（同步专用检出里也是这样排的） */
const hooks = async (): Promise<Hooks> =>
  (await import(pathToFileURL(join(root, 'agents', 'hooks', 'founder-inbox.mjs')).href)) as Hooks;
const sessionId = (): string | null => {
  const s = process.env.CLAUDE_CODE_SESSION_ID;
  return typeof s === 'string' && s ? s : null;
};
async function myLineage(): Promise<LineageInfo> {
  return (await hooks()).lineageOf({ home: homedir(), sessionId: sessionId() });
}
async function myOwner(): Promise<string> {
  const line = await myLineage();
  if (line.status !== 'found') throw new ProgressUnchecked(`本会话的主认不出（${line.why}），没改。`);
  return line.dir;
}
const promptLogDir = () => process.env.FLEET_PROMPT_LOG_DIR || join(homedir(), '.fleet-dao', 'prompt-log');
const deps = { git, gh };

/** 收件箱里的一条搬进仓：content 由调用方给（认领的、办完的），开 PR，再把原评论改成「已迁」 */
async function importFromInbox(id: number, change: (d: Directive) => string, what: string): Promise<string> {
  const c = await readInboxComment(id, { gh });
  const d = directiveFromComment({ ...c, text: textOf(c) });
  const url = await proposeFile(deps, {
    id: d.id,
    path: d.path,
    content: change(d),
    title: `${what}创始人引导 ${d.id}（从 #1055 搬进仓）`,
    did: `${what}，从 #${PROGRESS_ISSUE} 收件箱搬到 ${d.path}`,
  });
  await markMigrated(c, `${d.path}（${url}）`, { gh });
  return url;
}

/** 本检出（不是主线分支）里有这条引导的文件：办完那一笔就写在这里，随这个 PR 合进去 */
async function worktreeFile(path: string): Promise<string | null> {
  const branch = await gitHere(['rev-parse', '--abbrev-ref', 'HEAD']);
  const top = await gitHere(['rev-parse', '--show-toplevel']);
  if (branch.code !== 0 || top.code !== 0) return null;
  const b = branch.stdout.trim();
  if (b === 'main' || b === 'HEAD') return null;
  const file = join(top.stdout.trim(), path);
  return existsSync(file) ? file : null;
}

async function done(id: string, note: string | undefined, drop: boolean): Promise<void> {
  const status = drop ? DROPPED : DONE;
  const now = new Date();
  await git(['fetch', '-q', 'origin', 'main']);
  const d = await findById(git, MAIN, id);
  if (d) {
    const file = await worktreeFile(d.path);
    if (file !== null) {
      const local = parseDirective(readFileSync(file, 'utf8'), d.path);
      writeFileSync(file, doneContent(local, note, now, status), 'utf8');
      console.log(`标成${status}：改在当前检出的 ${d.path}，随这个 PR 提交，合进主线就算办完。`);
      return;
    }
    const url = await proposeFile(deps, {
      id,
      path: d.path,
      content: doneContent(d, note, now, status),
      title: `创始人引导 ${id} 标${status}`,
      did: `引导 ${id} 标${status}${note?.trim() ? `：${note.trim()}` : ''}`,
    });
    console.log(`标成${status}，开了 PR 已挂自动合并：${url}`);
    return;
  }
  const url = await importFromInbox(Number(id), (x) => doneContent(x, note, now, status), `标${status}`);
  console.log(`标成${status}（从 #${PROGRESS_ISSUE} 收件箱搬进仓），PR 已挂自动合并：${url}`);
}

async function claim(
  id: string,
  values: { force?: boolean; why?: string; auto?: boolean; 'expect-owner'?: string },
) {
  const owner = await myOwner();
  let why = values.why;
  if (values.auto) {
    if (process.env.FLEET_WORKER === '1')
      throw new ProgressRefused('机器派的会话不自动认领引导（只有指挥官会话认）。没改。');
    const was = values['expect-owner'];
    if (!was) throw new ProgressRefused('--auto 要带 --expect-owner <判断时看到的主人>。没改。');
    const p = (await hooks()).ownerPresence({ home: homedir(), owner: was });
    if (p.state !== 'gone')
      throw new ProgressRefused(`原主 ${was} 不能确定已不在（${p.why}），不自动认领。没改。`);
    why = `自动认领：${p.why}`;
  }
  const inMain = await (async () => {
    await git(['fetch', '-q', 'origin', 'main']);
    return (await listPaths(git, MAIN)).some((p) => p.endsWith(`/${id}.md`));
  })();
  if (inMain) {
    const r = await claimDirective(
      id,
      owner,
      { force: values.force || values.auto, why, expectOwner: values['expect-owner'] },
      deps,
    );
    console.log(
      r === null
        ? `引导 ${id} 本来就归本会话（${owner}）。`
        : `认领了引导 ${id}（主：${owner}），PR 已挂自动合并：${r.url}`,
    );
    return;
  }
  const c = await readInboxComment(Number(id), { gh });
  if (values['expect-owner'] !== undefined && c.owner !== values['expect-owner'])
    throw new ProgressRefused(`评论 ${id} 的主人已不是 ${values['expect-owner']}，没改。`);
  if (c.owner !== '无主' && c.owner !== owner && !(values.force || values.auto))
    throw new ProgressRefused(
      `评论 ${id} 已归别的会话（${c.owner}），没改。原会话确实没了才 --force --why。`,
    );
  const log = `${stamp(new Date())} 改主：${c.owner} → ${owner}${why?.trim() ? `（${why.trim()}）` : ''}`;
  const url = await importFromInbox(Number(id), (d) => withChange(d, { owner, log }), '认领');
  console.log(
    `认领了引导 ${id}（主：${owner}，从 #${PROGRESS_ISSUE} 收件箱搬进仓），PR 已挂自动合并：${url}`,
  );
}

/** 待处理的：仓里主线上的，加收件箱里还没搬进仓的 */
async function pendingRows(): Promise<
  Array<{ id: string; head: string; text: string; owner: string; created: string }>
> {
  const repo = await listPending(git, MAIN);
  const known = new Set((await listPaths(git, MAIN)).map((p) => p.replace(/^.*\//, '').replace(/\.md$/, '')));
  const rows = repo.map((d) => ({
    id: d.id,
    head: `${PENDING_TAG}${d.at}`,
    text: d.text,
    owner: d.owner,
    created: (() => {
      const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/.exec(d.at);
      return m ? new Date(`${m[1]}T${m[2]}:00+08:00`).toISOString() : '';
    })(),
  }));
  for (const c of await inboxPending({ gh })) {
    if (known.has(String(c.id))) continue;
    rows.push({ id: String(c.id), head: c.head, text: textOf(c), owner: c.owner, created: c.createdAt });
  }
  return rows;
}

try {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      at: { type: 'string' },
      owner: { type: 'string' },
      note: { type: 'string' },
      drop: { type: 'boolean' },
      limit: { type: 'string' },
      pending: { type: 'boolean' },
      force: { type: 'boolean' },
      why: { type: 'string' },
      auto: { type: 'boolean' },
      'expect-owner': { type: 'string' },
    },
  });
  if (cmd === 'note') {
    const c = await progressNote(positionals.join(' '), { gh });
    console.log(`贴到 #${PROGRESS_ISSUE} 了：${c.url}`);
  } else if (cmd === 'directive') {
    const text = positionals.join(' ');
    const line = await myLineage();
    const sent =
      line.status === 'found'
        ? (await hooks()).sentByFounder({ home: homedir(), only: line.dir })
        : { absent: true as const };
    const fallbackId = line.status === 'found' ? (line.sessionIds[0] ?? null) : null;
    const mirasim =
      'entries' in sent
        ? sent.entries.map((e) => ({
            at: new Date(e.at),
            sessionId: e.sessionId ?? fallbackId,
            prompt: e.text,
            source: 'Mirasim 会话记录',
          }))
        : [];
    const r = resolveDirective(
      { text: text || undefined, at: values.at, owner: values.owner },
      line,
      mergeLogs(readPromptLog(promptLogDir(), new Date()), mirasim),
      sessionId(),
    );
    const made = await recordDirective(r, deps);
    console.log(
      `记下创始人引导 ${made.id}（待处理，主：${r.owner}，时间 ${r.at}，来源 ${r.source}）：${made.path}，PR 已挂自动合并 ${made.url}\n` +
        `原话：${r.text.replace(/\s+/g, ' ').slice(0, 200)}\n办完在干活的工作树里 pnpm progress done ${made.id}（随那个 PR 合进去），PR 正文写「引导 ${made.id}」。`,
    );
  } else if (cmd === 'claim') {
    await claim(String(positionals[0] ?? ''), values);
  } else if (cmd === 'done') {
    await done(String(positionals[0] ?? ''), values.note, values.drop === true);
  } else if (cmd === 'read') {
    const limit = values.limit === undefined ? 10 : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 0)
      throw new ProgressRefused(`--limit ${values.limit} 不对，要非负整数。`);
    if (!values.pending) await git(['fetch', '-q', 'origin', 'main']);
    const rows = await pendingRows();
    if (values.pending) {
      for (const r of rows)
        console.log(`${r.id}\t${r.head}\t${r.text.replace(/\s+/g, ' ')}\t${r.owner}\t${r.created}`);
    } else {
      const recent = await recentComments(limit, { gh });
      console.log(`#${PROGRESS_ISSUE} 最近 ${recent.length} 条（旧到新）：`);
      for (const c of recent) console.log(`\n[${c.id}] ${c.body.trim()}`);
      console.log(`\n没处理的创始人引导 ${rows.length} 条（docs/directives 和 #${PROGRESS_ISSUE} 收件箱）：`);
      for (const r of rows)
        console.log(`\n[${r.id}]（${r.head.replace(/^【[^】]*】/, '')}，主：${r.owner}）${r.text}`);
    }
  } else {
    throw new ProgressRefused(PROGRESS_USAGE);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = e instanceof ProgressRefused || e instanceof DirectiveRefused ? 1 : 2;
}
