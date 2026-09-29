// 单上的「在做」评论（帅位技能「座位规矩」第 1、2 条）：认领、改一句进度、做完、放下、看谁在做。doing.mjs 是它的外壳。
// 改这里之前必须知道：
// - 评论第一行的标记 <!-- fleet:<状态> machine=<机器名> --> 是给程序认的（以后驾驶舱「在做的活」也读它）：改格式要连读它的地方一起改。
// - 谁先谁后按评论编号比（GitHub 的评论编号只增不减），不按时间：时间只精确到秒，同一秒两台机器都留了就分不出先后。
// - 各台机器的 gh 可能登的是同一个账号，所以按评论里写的机器名认是谁的，不按作者。
// - 查不成（gh 报错、读回失败、输出认不出）一律退出码 2，绝不当成「没人在做」。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 别的机器的「在做」多久没动静算「可能断了」（只提示，不自动接手）。 */
export const STALE_HOURS = 2;
const MARK = /^<!-- fleet:(doing|done|dropped) machine=([^\s>]+) -->/;
const LINE = /^\*\*.+? (?:在做|做完了|放下了)\*\*：(.*)$/m;
const MACHINE = /^[\p{L}\p{N}_.-]{1,32}$/u;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const WORD = { doing: '在做', done: '做完了', dropped: '放下了' };

export function machineProblem(name) {
  return typeof name === 'string' && MACHINE.test(name)
    ? null
    : `机器名「${name ?? ''}」不行：32 字以内的一段字母、汉字、数字、点、横线、下划线`;
}

/** 一条「在做」评论的正文。text 压成一行；机器名先用 machineProblem 查过。 */
export function renderClaim(state, machine, text) {
  const line =
    String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim() || '（没写）';
  const body = [`<!-- fleet:${state} machine=${machine} -->`, `**${machine} ${WORD[state]}**：${line}`];
  if (state === 'doing') body.push('', '<sub>帅位认领：别的机器先别动这张；要接手得创始人说。</sub>');
  return body.join('\n');
}

/** 认出一条评论是不是「在做」类的；不是返回 null。 */
export function parseClaim(comment) {
  const m = MARK.exec(comment?.body ?? '');
  if (!m) return null;
  const t = LINE.exec(comment.body);
  return {
    id: comment.id,
    state: m[1],
    machine: m[2],
    text: t?.[1]?.trim() ?? '',
    url: comment.html_url,
    updatedAt: comment.updated_at,
  };
}

const byId = (a, b) => a.id - b.id;
const doingOf = (claims, keep) => claims.filter((c) => c.state === 'doing' && keep(c)).sort(byId);

function ago(iso, now) {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return { text: '不知道多久以前', stale: false };
  const min = Math.max(0, Math.round(ms / 60000));
  const text = min < 60 ? `${min} 分钟前` : `${Math.floor(min / 60)} 小时 ${min % 60} 分钟前`;
  return { text, stale: min >= STALE_HOURS * 60 };
}

function describe(c, now) {
  const a = ago(c.updatedAt, now);
  return `${c.machine} 在做：${c.text}（最后动静 ${a.text}${a.stale ? '，可能断了；要接手得创始人说' : ''}）${c.url ?? ''}`;
}

/** 这台机器叫什么：环境变量 FLEET_MACHINE，其次 ~/.fleet-dao/machine-name。都没有、不合规就说清楚，不猜。 */
export function resolveMachine(env, home) {
  if (env.FLEET_MACHINE) {
    const why = machineProblem(env.FLEET_MACHINE);
    return why
      ? { ok: false, why: `环境变量 FLEET_MACHINE：${why}` }
      : { ok: true, name: env.FLEET_MACHINE, from: '（环境变量 FLEET_MACHINE）' };
  }
  const file = machineFile(home);
  let name;
  try {
    name = readFileSync(file, 'utf8').trim();
  } catch (e) {
    if (e.code === 'ENOENT')
      return {
        ok: false,
        why: '不知道这台机器叫什么：先 node doing.mjs machine <名字>（本机、法国、笔记本……一台一个，会公开写在单上）',
      };
    return { ok: false, why: `机器名文件 ${file} 读不了（${e.code ?? e.message}）` };
  }
  const why = machineProblem(name);
  return why ? { ok: false, why: `${file}：${why}` } : { ok: true, name, from: `（${file}）` };
}

const machineFile = (home) => join(home, '.fleet-dao', 'machine-name');

export const USAGE = `用法：node doing.mjs <命令> …（在项目仓的检出里跑；在别处跑加 --repo <owner/repo>）
  machine [名字]                                  看或设这台机器的名字（会公开写在单上：本机、法国、笔记本……）
  claim <单号> [一句话] [--takeover <创始人原话>]  认领；别的机器在做就不碰
  say <单号> <一句话>                             改自己那条「在做」的一句话进度
  done <单号> [一句话]                            做完了
  drop <单号> [一句话]                            放下（不做了、交出去）
  show <单号…>                                    看这几张单谁在做
退出码：0 好了；1 用法不对；2 没查成、没做成（别当成没人在做）；3 别的机器在做，或这张已经不归你。`;

class UsageError extends Error {}

function takeOption(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return { rest: args, value: undefined };
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} 后面要跟值`);
  return { rest: [...args.slice(0, i), ...args.slice(i + 2)], value };
}

function issueNumber(raw) {
  const m = /^#?(\d+)$/.exec(raw ?? '');
  if (!m) throw new UsageError(`单号写数字（比如 169 或 #169），「${raw ?? ''}」不行`);
  return Number(m[1]);
}

/**
 * doing.mjs 的全部逻辑。io：{ gh(args, input?) → 标准输出（失败就抛）, env, home, now(), sleep(ms), out(text), err(text) }。
 * 返回退出码（见 USAGE）。
 */
export async function runDoing(argv, io) {
  try {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      io.out(USAGE);
      return argv.length === 0 ? 1 : 0;
    }
    const repoOpt = takeOption(argv, '--repo');
    const takeoverOpt = takeOption(repoOpt.rest, '--takeover');
    if (repoOpt.value !== undefined && !REPO.test(repoOpt.value))
      throw new UsageError(`--repo 写 owner/repo，「${repoOpt.value}」不行`);
    const [cmd = '', ...args] = takeoverOpt.rest;
    if (takeoverOpt.value !== undefined && cmd !== 'claim') throw new UsageError('--takeover 只跟 claim 用');
    const R = repoOpt.value ?? '{owner}/{repo}';

    if (cmd === 'machine') return setOrShowMachine(args[0], io);
    if (cmd === 'show') {
      if (args.length === 0) throw new UsageError('用法：show <单号…>');
      const numbers = args.map(issueNumber);
      let code = 0;
      for (const n of numbers) {
        try {
          const doing = doingOf(claimsOf(io, R, n), () => true);
          if (doing.length === 0) io.out(`#${n} 没人在做`);
          for (const c of doing) io.out(`#${n} ${describe(c, io.now())}`);
        } catch (e) {
          io.out(`#${n} 没查成：${e.message}`);
          code = 2;
        }
      }
      return code;
    }
    if (!['claim', 'say', 'done', 'drop'].includes(cmd))
      throw new UsageError(`没有「${cmd}」这个命令\n${USAGE}`);
    const [num, ...words] = args;
    const n = issueNumber(num);
    const text = words.join(' ').trim();
    if (cmd === 'say' && text === '') throw new UsageError('用法：say <单号> <一句话>');
    const me = resolveMachine(io.env, io.home);
    if (!me.ok) {
      io.err(me.why);
      return 2;
    }
    return cmd === 'claim'
      ? await claim(io, R, n, me.name, text, takeoverOpt.value)
      : update(io, R, n, me.name, cmd, text);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      return 1;
    }
    io.err(`没查成、没做成：${e.message}（别当成没人在做）`);
    return 2;
  }
}

function setOrShowMachine(name, io) {
  if (name === undefined) {
    const r = resolveMachine(io.env, io.home);
    if (!r.ok) {
      io.err(r.why);
      return 2;
    }
    io.out(`这台机器叫「${r.name}」${r.from}`);
    return 0;
  }
  const why = machineProblem(name);
  if (why) throw new UsageError(why);
  const file = machineFile(io.home);
  mkdirSync(join(io.home, '.fleet-dao'), { recursive: true });
  writeFileSync(file, `${name}\n`);
  io.out(`记好了：这台机器叫「${name}」（${file}）`);
  if (io.env.FLEET_MACHINE && io.env.FLEET_MACHINE !== name)
    io.err(`注意：环境变量 FLEET_MACHINE=${io.env.FLEET_MACHINE} 比这个文件优先`);
  return 0;
}

function listComments(io, R, n) {
  const out = io.gh([
    'api',
    '--paginate',
    `repos/${R}/issues/${n}/comments`,
    '--jq',
    '.[] | {id, body, created_at, updated_at, html_url}',
  ]);
  return out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      let c;
      try {
        c = JSON.parse(line);
      } catch {
        throw new Error(`gh 给的评论认不出：${line.slice(0, 80)}`);
      }
      if (!Number.isInteger(c?.id)) throw new Error(`gh 给的评论没有编号：${line.slice(0, 80)}`);
      return c;
    });
}

const claimsOf = (io, R, n) =>
  listComments(io, R, n)
    .map(parseClaim)
    .filter((c) => c !== null);
const patch = (io, R, id, body) =>
  io.gh(['api', '-X', 'PATCH', `repos/${R}/issues/comments/${id}`, '--input', '-'], JSON.stringify({ body }));

async function claim(io, R, n, machine, text, takeover) {
  const before = claimsOf(io, R, n);
  const others = doingOf(before, (c) => c.machine !== machine);
  const mine = doingOf(before, (c) => c.machine === machine);
  // 自己的比别人的早：撞车时晚到的那台没撤干净，这张还是归自己
  if (others.length > 0 && !(mine.length > 0 && mine[0].id < others[0].id)) {
    if (takeover === undefined) {
      // 这台留过、但比别人晚（上回撞车没撤干净）：照规矩退，把自己那条删掉
      for (const m of mine) {
        try {
          io.gh(['api', '-X', 'DELETE', `repos/${R}/issues/comments/${m.id}`]);
        } catch (e) {
          io.err(
            `#${n} 这台留的「在做」比 ${others[0].machine} 晚，该删却没删掉（${e.message}），手动删：${m.url}`,
          );
          return 2;
        }
      }
      io.out(
        `#${n} ${describe(others[0], io.now())}${mine.length > 0 ? '\n这台留的那条比它晚，已经删了。' : ''}\n不碰这张。`,
      );
      return 3;
    }
    for (const o of others) {
      patch(
        io,
        R,
        o.id,
        renderClaim(
          'dropped',
          o.machine,
          `创始人让 ${machine} 接手（原话：${takeover}）；原来在做：${o.text}`,
        ),
      );
    }
    io.out(
      `#${n} 原来 ${[...new Set(others.map((o) => o.machine))].join('、')} 在做，照创始人的话改成了放下`,
    );
  }
  if (mine.length > 0) {
    if (text) patch(io, R, mine[0].id, renderClaim('doing', machine, text));
    io.out(`#${n} 本来就是 ${machine} 在做，接着用这条：${mine[0].url}`);
    return 0;
  }
  const raw = io.gh(
    ['api', '-X', 'POST', `repos/${R}/issues/${n}/comments`, '--input', '-'],
    JSON.stringify({ body: renderClaim('doing', machine, text || '开工') }),
  );
  let posted;
  try {
    posted = JSON.parse(raw);
  } catch {
    posted = null;
  }
  if (!Number.isInteger(posted?.id)) {
    io.err(`#${n} 的「在做」可能已经留上了，但 gh 回的内容认不出；去单上看一眼，是自己的就删掉`);
    return 2;
  }
  const withdraw = (why, code) => {
    try {
      io.gh(['api', '-X', 'DELETE', `repos/${R}/issues/comments/${posted.id}`]);
    } catch (e) {
      io.err(`#${n} ${why}；我这条没删掉（${e.message}），手动删：${posted.html_url}`);
      return 2;
    }
    (code === 3 ? io.out : io.err)(`#${n} ${why}；我这条已经删了，不碰这张。`);
    return code;
  };
  // 读回之前等一下：两台机器几乎同时留言时，给对方的那条一点时间出现在列表里
  await io.sleep(1500);
  let after;
  try {
    after = claimsOf(io, R, n);
  } catch (e) {
    return withdraw(`读回没查成（${e.message}）`, 2);
  }
  if (!after.some((c) => c.id === posted.id)) return withdraw('读回来找不到自己刚留的那条', 2);
  const earlier = doingOf(after, (c) => c.machine !== machine && c.id < posted.id);
  if (earlier.length > 0)
    return withdraw(`撞了：${earlier[0].machine} 先留的「在做」（${earlier[0].url}）`, 3);
  io.out(`认领了 #${n}：${posted.html_url}`);
  return 0;
}

function update(io, R, n, machine, cmd, text) {
  const all = claimsOf(io, R, n);
  const mine = all.filter((c) => c.machine === machine).sort(byId);
  const doing = mine.find((c) => c.state === 'doing');
  const first = doingOf(all, (c) => c.machine !== machine)[0];
  if (doing && first && first.id < doing.id) {
    io.out(`#${n} 撞了：${first.machine} 先认领的（${first.url}），这张不归你；这台那条该删：${doing.url}`);
    return 3;
  }
  if (!doing) {
    const last = mine.at(-1);
    if (last?.state === 'dropped') {
      io.out(
        `#${n} 上 ${machine} 的「在做」已经是放下了：${last.text}\n这张已经不归你，别再动（要接回来得创始人说）。`,
      );
      return 3;
    }
    io.err(
      last?.state === 'done'
        ? `#${n} 上 ${machine} 已经标了做完了；要接着做先重新 claim`
        : `#${n} 上没有 ${machine} 的「在做」：先 claim`,
    );
    return 2;
  }
  const state = cmd === 'say' ? 'doing' : cmd === 'done' ? 'done' : 'dropped';
  patch(io, R, doing.id, renderClaim(state, machine, text || doing.text));
  io.out(`#${n}：${machine} ${WORD[state]}（${doing.url}）`);
  return 0;
}
