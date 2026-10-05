// 进度单入口：pnpm progress:note / progress:directive / progress:done / progress:read（见 ../progress.ts）。
// 退出码 0 = 成了；1 = 拒绝（参数不对、评论不是该办的那种）；2 = 没查成、没写成（gh 报错、读回来认不出）。
// `read --pending` 给开会话钩子用：只列没处理的引导，一条一行（编号<TAB>第一行<TAB>正文压成一行）。

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ghRunner } from '../issue-new.ts';
import {
  PROGRESS_ISSUE,
  PROGRESS_USAGE,
  ProgressRefused,
  progressDirective,
  progressDone,
  progressNote,
  progressRead,
} from '../progress.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const gh = ghRunner(root);

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
    },
  });
  if (cmd === 'note') {
    const c = await progressNote(positionals.join(' '), { gh });
    console.log(`贴到 #${PROGRESS_ISSUE} 了：${c.url}`);
  } else if (cmd === 'directive') {
    const c = await progressDirective(positionals.join(' '), values.at ?? '', { gh });
    console.log(`记下创始人引导（待处理）：${c.url}（评论号 ${c.id}；办完 pnpm progress:done ${c.id}）`);
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
        console.log(`${c.id}\t${c.head}\t${c.body.slice(c.head.length).trim().replace(/\s+/g, ' ')}`);
    } else {
      console.log(`#${PROGRESS_ISSUE} 最近 ${view.recent.length} 条（旧到新）：`);
      for (const c of view.recent) console.log(`\n[${c.id}] ${c.body.trim()}`);
      console.log(
        `\n没处理的创始人引导：${view.pending.length} 条${view.pending.map((c) => `（${c.id}）`).join('')}`,
      );
    }
  } else {
    throw new ProgressRefused(PROGRESS_USAGE);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = e instanceof ProgressRefused ? 1 : 2;
}
