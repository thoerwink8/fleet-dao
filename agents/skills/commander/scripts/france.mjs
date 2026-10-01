// 法国引擎的断链排查，命令行版（#328）：node france.mjs [--json]。和本机页面 /france 同一套判法（france-lib.mjs），
// 经 ssh 在法国跑一遍只读查询，打出断链排查和几行现状；帅位的心跳用它，替掉会话里那份临时的「法国巡查」。
// 退出码：0 没有异常；1 有异常或有没读到的块；2 整个没读到（没配 ssh 名字、连不上、回来的认不出）。
// 用 exitCode 不用 process.exit：输出接到管道上时，exit 可能把没写完的截掉。
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildView, franceFetcher, STAGE_NAMES } from './france-lib.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'france-query.mjs');
const USAGE = `用法：node france.mjs [--json]
经 ssh 在法国跑一遍只读查询，打出断链排查（异常在前）和现状；--json 打整理好的全部数据。
登法国的 ssh 名字：环境变量 FLEET_FRANCE_SSH，或 ~/.fleet-dao/france-ssh 的第一行。
退出码：0 没有异常；1 有异常或有没读到的块；2 整个没读到。`;

const clock = (iso) => new Date(iso).toLocaleString('zh-CN', { hour12: false });
const dur = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
};
const usd = (n) => `$${n.toFixed(2)}`;

function text(view, tookMs) {
  const lines = [`法国引擎 · ${clock(view.at)} 的数据（这次读用了 ${dur(tookMs)}）`];
  const { bad, unread, note } = view.counts;
  lines.push(`断链排查：${bad} 处异常、${unread} 处没读到、${note} 处留意`);
  for (const a of view.anomalies) {
    lines.push(`${a.level === 'note' ? '· 留意：' : '⚠ '}${a.what}`);
    if (a.level !== 'note') lines.push(`    去看：${a.where}`);
  }
  if (view.tasks.ok) {
    lines.push(`在跑的单 ${view.tasks.active.length} 张、排队的 ${view.tasks.queued.length} 张：`);
    for (const t of view.tasks.active) {
      const u = t.usage?.total;
      const spent = u ? `；会话 ${u.runs + u.running} 次，干活 ${dur(u.runMs)}，花费 ${usd(u.costUsd)}` : '';
      lines.push(
        `  #${t.n} ${t.repoName} ${t.stateName}${t.phase ? ` · ${t.phase}` : ''}${t.doing ? ` · ${t.doing}` : ''}${spent}`,
      );
    }
  } else lines.push(`单子没读到：${view.tasks.why}`);
  const rel = view.health.release;
  if (rel.ok) {
    const lag =
      rel.behind === 0
        ? '跟上主线了'
        : rel.behind > 0
          ? `落后主线 ${rel.behind} 个${rel.waiting ? `（${rel.waiting}）` : ''}`
          : rel.inRecent === false
            ? '不在主线最近的提交里'
            : '和主线比不了（在用的版本没读到）';
    const detail = (rel.last?.detail ?? '').trim();
    const said = !rel.last
      ? ''
      : !detail
        ? rel.last.actionName
        : detail.startsWith(rel.last.actionName)
          ? detail
          : `${rel.last.actionName}：${detail}`;
    const last = rel.last ? `${clock(rel.last.at)} ${said}` : '没有记录';
    lines.push(`版本：在用 ${rel.current ?? '（没读到）'}，${lag}；自动发布最近一轮 ${last}`);
  } else lines.push(`版本没读到：${rel.why}`);
  if (view.usage24h.ok) {
    const u = view.usage24h.total;
    const stages = view.usage24h.byStage
      .map((s) => `${STAGE_NAMES[s.stage] ?? s.stage} ${s.runs + s.running}`)
      .join('、');
    lines.push(
      `近 24 小时：会话 ${u.runs + u.running} 次（在跑 ${u.running}、没成 ${view.usage24h.failed}；${stages || '没有'}），干活 ${dur(u.runMs)}，花费 ${usd(u.costUsd)}${u.missingCost ? `（${u.missingCost} 次没报花费）` : ''}`,
    );
  } else lines.push(`会话没读到：${view.usage24h.why}`);
  return lines.join('\n');
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const started = Date.now();
  const r = await franceFetcher({ home: homedir(), env: process.env, scriptFile: SCRIPT })();
  if (!r.ok) {
    console.error(`没读到法国（${r.kind}）：${r.why}`);
    return 2;
  }
  const view = buildView(r.data);
  console.log(argv.includes('--json') ? JSON.stringify(view, null, 2) : text(view, Date.now() - started));
  return view.counts.bad + view.counts.unread > 0 ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
