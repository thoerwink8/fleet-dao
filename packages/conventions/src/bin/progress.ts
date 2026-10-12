// 进度单入口：pnpm progress:note / progress:directive / progress:claim / progress:done / progress:read（见 ../progress.ts）。
// 退出码 0 = 成了；1 = 拒绝（参数不对、评论不是该办的那种、已归别的会话）；2 = 没查成、没写成（gh 报错、读回来认不出、认不出本会话的主）。
// `read --pending` 给开会话钩子用：只列没处理的引导，一条一行（编号<TAB>第一行<TAB>正文压成一行<TAB>主人）。
// directive、claim 的主人＝本会话的血缘：CLAUDE_CODE_SESSION_ID 所属的 Mirasim 会话目录名（agents/hooks/founder-inbox.mjs 的 lineageOf）。

import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ghRunner } from '../issue-new.ts';
import {
  NO_OWNER,
  PROGRESS_ISSUE,
  PROGRESS_USAGE,
  ProgressRefused,
  ProgressUnchecked,
  progressClaim,
  progressDirective,
  progressDone,
  progressNote,
  progressRead,
  textOf,
} from '../progress.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const gh = ghRunner(root);

type Lineage = { status: 'found'; dir: string } | { status: 'none' | 'unchecked'; why: string };

/** 本会话的血缘（钩子家的脚本，按路径动态加载：同步专用检出里也是这样排的） */
async function myLineage(): Promise<Lineage> {
  const mod = (await import(pathToFileURL(join(root, 'agents', 'hooks', 'founder-inbox.mjs')).href)) as {
    lineageOf(o: { home: string; sessionId: unknown }): Lineage;
  };
  return mod.lineageOf({ home: homedir(), sessionId: process.env.CLAUDE_CODE_SESSION_ID });
}

try {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      at: { type: 'string' },
      note: { type: 'string' },
      limit: { type: 'string' },
      pending: { type: 'boolean' },
      force: { type: 'boolean' },
      why: { type: 'string' },
    },
  });
  if (cmd === 'note') {
    const c = await progressNote(positionals.join(' '), { gh });
    console.log(`贴到 #${PROGRESS_ISSUE} 了：${c.url}`);
  } else if (cmd === 'directive') {
    const line = await myLineage();
    // 认不出主不挡记引导（引导先落盘要紧），记成无主，说一句为什么
    if (line.status !== 'found') console.error(`本会话的主认不出（${line.why}），这条记成「${NO_OWNER}」。`);
    const owner = line.status === 'found' ? line.dir : NO_OWNER;
    const c = await progressDirective(positionals.join(' '), values.at ?? '', owner, { gh });
    console.log(
      `记下创始人引导（待处理，主：${c.owner}）：${c.url}（评论号 ${c.id}；办完 pnpm progress:done ${c.id}）`,
    );
  } else if (cmd === 'claim') {
    const line = await myLineage();
    if (line.status === 'unchecked') throw new ProgressUnchecked(`本会话的主没查成（${line.why}），没认领。`);
    const owner = line.status === 'found' ? line.dir : NO_OWNER;
    const c = await progressClaim(
      Number(positionals[0]),
      owner,
      { force: values.force, why: values.why },
      { gh },
    );
    console.log(`认领了：评论 ${c.id} 归本会话（主：${c.owner}）：${c.url}`);
  } else if (cmd === 'done') {
    const c = await progressDone(Number(positionals[0]), values.note, { gh });
    console.log(`标成已处理：${c.url}`);
  } else if (cmd === 'read') {
    const limit = values.limit === undefined ? 10 : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 0)
      throw new ProgressRefused(`--limit ${values.limit} 不对，要非负整数。`);
    const view = await progressRead(values.pending ? 0 : limit, { gh });
    if (values.pending) {
      for (const c of view.pending)
        console.log(`${c.id}\t${c.head}\t${textOf(c).replace(/\s+/g, ' ')}\t${c.owner}`);
    } else {
      console.log(`#${PROGRESS_ISSUE} 最近 ${view.recent.length} 条（旧到新）：`);
      for (const c of view.recent) console.log(`\n[${c.id}] ${c.body.trim()}`);
      console.log(
        `\n没处理的创始人引导：${view.pending.length} 条${view.pending.map((c) => `（${c.id}，主：${c.owner}）`).join('')}`,
      );
    }
  } else {
    throw new ProgressRefused(PROGRESS_USAGE);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = e instanceof ProgressRefused ? 1 : 2;
}
