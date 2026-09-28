// 帅位进度报到法国库（#199）。不写本机 progress.json。经 ssh 调 fleet-api seat board，和 claim.mjs 同一条路。
import { callFrance, franceHost, pickState } from './seat-lib.mjs';

const USAGE = `用法：node p.mjs <项目> <命令> …
  head "<一句话现状>"
  add <id> <序号> <标题> [说明]
  step <id> <done|doing|waiting|needs|blocked> [说明]
  log "<动态>"
  link <id> <名字> <http(s) 网址>
  needs add <id> --issue <号> --repo <owner/仓> --recommend <选项> <问题> <选项…>
  needs clear
  show
  pending
  record
  handoff <文件>
没配法国、连不上：退出码 2，不写本地文件。这台没有本地帅位记录（没 seat.mjs take 过）：退出码 3——
#446 起帅位不是锁，写板子不核是不是现任，只要这台曾经接过班就能写。`;

function fail(io, code, msg) {
  io.err(msg);
  return code;
}

function seatOf(io) {
  const picked = pickState(io.home, 'main');
  if (!picked.ok) return picked;
  return { ok: true, state: picked.state };
}

/**
 * io：{ home, env, now(), ssh(args, input), gh(args), out(text), err(text) }。
 * 返回退出码。法国回的 code 原样交出去（0 成了，3 不是现任，1 没做成，2 参数）。
 */
export async function runBoardCli(argv, io) {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0)
    return fail(io, argv.length === 0 ? 1 : 0, USAGE);
  const [project, cmd, ...rest] = argv;
  if (!project || !cmd) return fail(io, 1, USAGE);
  const host = franceHost({ env: io.env, home: io.home });
  if (!host.ok) return fail(io, 2, host.why);
  const seat = seatOf(io);
  if (!seat.ok) return fail(io, 3, seat.why);
  const ident = [
    '--machine',
    seat.state.machine,
    '--session',
    seat.state.session,
    '--term',
    String(seat.state.term),
  ];
  if (cmd === 'needs') return needs(io, host.host, project, ident, rest);
  if (cmd === 'pending') return call(io, host.host, ['seat', 'board', 'pending', project, ...ident]);
  if (cmd === 'record') return record(io, host.host, project, ident);
  if (cmd === 'show') return call(io, host.host, ['seat', 'board', 'show', project, ...ident]);
  if (cmd === 'handoff') return handoff(io, host.host, project, ident, rest);
  if (cmd === 'init') {
    const text = rest.filter((a) => a !== '--repo').join(' ') || '刚接手，还没写现状';
    return call(io, host.host, ['seat', 'board', 'head', project, ...ident, '--text', text]);
  }
  const built = build(cmd, project, ident, rest);
  if (built.why) return fail(io, 1, built.why);
  return call(io, host.host, built.argv);
}

function build(cmd, project, ident, rest) {
  const base = ['seat', 'board', cmd === 'head' ? 'head' : cmd, project, ...ident];
  if (cmd === 'head') {
    if (rest.length === 0) return { why: '用法：head <一句话现状>' };
    return { argv: [...base, '--text', rest.join(' ')] };
  }
  if (cmd === 'add') {
    const [id, order, title, ...detail] = rest;
    if (!id || order === undefined || !title) return { why: '用法：add <id> <序号> <标题> [说明]' };
    return {
      argv: [
        ...base,
        '--id',
        id,
        '--order',
        order,
        '--title',
        title,
        ...(detail.length ? ['--detail', detail.join(' ')] : []),
      ],
    };
  }
  if (cmd === 'step') {
    const [id, status, ...detail] = rest;
    if (!id || !status) return { why: '用法：step <id> <状态> [说明]' };
    return {
      argv: [
        ...base,
        '--id',
        id,
        '--status',
        status,
        ...(detail.length ? ['--detail', detail.join(' ')] : []),
      ],
    };
  }
  if (cmd === 'log') {
    if (rest.length === 0) return { why: '用法：log <动态>' };
    return { argv: [...base, '--text', rest.join(' ')] };
  }
  if (cmd === 'link') {
    const [id, label, url] = rest;
    if (!id || !label || !url) return { why: '用法：link <id> <名字> <http(s) 网址>' };
    return { argv: [...base, '--id', id, '--label', label, '--url', url] };
  }
  return { why: `没有「${cmd}」这个命令\n${USAGE}` };
}

function needs(io, host, project, ident, rest) {
  const [sub, ...args] = rest;
  if (sub === 'clear') {
    return call(io, host, ['seat', 'board', 'clear-needs', project, ...ident]);
  }
  if (sub !== 'add')
    return fail(
      io,
      1,
      '用法：needs add <id> --issue <号> --repo <owner/仓> --recommend <选项> <问题> <选项…>',
    );
  const opts = new Map();
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--issue' || a === '--repo' || a === '--recommend') {
      opts.set(a.slice(2), args[++i]);
      continue;
    }
    positional.push(a);
  }
  const [id, question, ...options] = positional;
  if (
    !id ||
    !question ||
    options.length < 2 ||
    !opts.get('issue') ||
    !opts.get('repo') ||
    !opts.get('recommend')
  ) {
    return fail(
      io,
      1,
      '用法：needs add <id> --issue <号> --repo <owner/仓> --recommend <选项> <问题> <选项…>',
    );
  }
  return call(io, host, [
    'seat',
    'board',
    'need',
    project,
    ...ident,
    '--id',
    id,
    '--issue',
    opts.get('issue'),
    '--repo',
    opts.get('repo'),
    '--recommend',
    opts.get('recommend'),
    question,
    ...options,
  ]);
}

function showText(json) {
  const boards = Array.isArray(json?.boards) ? json.boards : [];
  if (boards.length === 0) return '没有这块板';
  return boards
    .map((b) => {
      const steps = [...(b.steps ?? [])].sort((a, c) => a.order - c.order);
      const needs = b.needs ?? [];
      const log = b.log ?? [];
      return [
        `${b.project}（${b.updatedAt ?? '—'}）`,
        `现状：${b.headline || '（没写）'}`,
        needs.length ? `要你定的：\n${needs.map((n) => `  ${n.question}`).join('\n')}` : '要你定的：没有',
        steps.length
          ? `步骤：\n${steps.map((s) => `  ${s.id} [${s.status}] ${s.title}（${s.updatedAt}）`).join('\n')}`
          : '步骤：还没有',
        log.length ? `最近动态：\n${log.map((e) => `  ${e.at} ${e.text}`).join('\n')}` : '最近动态：没有',
      ].join('\n');
    })
    .join('\n\n');
}

async function call(io, host, argv) {
  const r = callFrance({ ...io, env: io.env }, host, argv);
  if (r.kind !== 'done') return fail(io, 2, r.why);
  if (r.code !== 0) {
    const why = r.json && typeof r.json.why === 'string' ? r.json.why : '没做成';
    return fail(io, r.code, why);
  }
  if (argv[2] === 'show') io.out(showText(r.json));
  else if (argv[2] === 'pending') io.out(JSON.stringify(r.json));
  else io.out('改好了');
  return 0;
}

async function handoff(io, host, project, ident, rest) {
  const [file] = rest;
  if (!file) return fail(io, 1, '用法：handoff <文件>');
  let text;
  try {
    text = io.readText(file);
  } catch (e) {
    return fail(io, 2, `交接说明 ${file} 读不到（${e.code ?? e.message}）`);
  }
  if (!String(text).trim()) return fail(io, 1, `交接说明 ${file} 是空的`);
  const sent = callFrance({ ...io, env: io.env }, host, ['seat', 'handoff', ...ident], { input: text });
  if (sent.kind !== 'done') return fail(io, 2, `交接说明没存上：${sent.why}`);
  if (sent.code !== 0) {
    const why = sent.json && typeof sent.json.why === 'string' ? sent.json.why : '交接说明没存上';
    return fail(io, sent.code, why);
  }
  const logged = callFrance({ ...io, env: io.env }, host, [
    'seat',
    'board',
    'log',
    project,
    ...ident,
    '--text',
    '写了交接说明',
  ]);
  if (logged.kind !== 'done') return fail(io, 2, `交接说明存上了，帅位栏没记上：${logged.why}`);
  if (logged.code !== 0) {
    const why = logged.json && typeof logged.json.why === 'string' ? logged.json.why : '没记上';
    return fail(io, logged.code, `交接说明存上了，帅位栏没记上：${why}`);
  }
  io.out('交接说明存上了');
  return 0;
}

async function record(io, host, project, ident) {
  const listed = callFrance({ ...io, env: io.env }, host, ['seat', 'board', 'pending', project, ...ident]);
  if (listed.kind !== 'done') return fail(io, 2, listed.why);
  if (listed.code !== 0) return fail(io, listed.code, listed.json?.why ?? '没读到待记账的');
  const pending = Array.isArray(listed.json?.pending) ? listed.json.pending : null;
  if (!pending) return fail(io, 2, '法国回的待记账名单认不出');
  if (pending.length === 0) {
    io.out('没有已拍还没记账的');
    return 0;
  }
  for (const item of pending) {
    const body = `创始人拍了：${item.question} → ${item.option}`;
    const gh = io.gh(['issue', 'comment', String(item.issue), '--repo', item.repo, '--body', body]);
    if (gh.error || gh.status !== 0) {
      return fail(
        io,
        2,
        `评论没写进 ${item.repo}#${item.issue}：${gh.error ?? gh.stderr ?? gh.stdout ?? '没说原因'}。还没记账`,
      );
    }
    const acked = callFrance({ ...io, env: io.env }, host, [
      'seat',
      'board',
      'ack',
      item.project ?? project,
      ...ident,
      '--id',
      item.id,
    ]);
    if (acked.kind !== 'done') return fail(io, 2, `评论写了，记账没成：${acked.why}`);
    if (acked.code !== 0) return fail(io, acked.code, `评论写了，记账没成：${acked.json?.why ?? ''}`);
  }
  io.out(`记进单子了（${pending.length} 条）`);
  return 0;
}
