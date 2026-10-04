// 无人值守「不中断这一轮」（创始人 2026-10-03「无人值守是让这一轮一直不结束……」「选 a」）。
// 三处用它：命令行（AI 按创始人的话开关）、Stop 钩子（stop.mjs：开着就把「结束这一轮」挡回去）、PreToolUse 钩子
// （pretool.mjs：调了工具就记一笔「这一轮在干活」）。开会话钩子也读它，上下文被总结、会话重启之后还知道开着。
//
// 用法（AI 在创始人说「进入无人值守」时跑 on，说「停」时跑 off）：
//   node ~/.fleet-dao/hooks/unattended.mjs on [--hours 8]      开（最长 24 小时，默认 8）
//   node ~/.fleet-dao/hooks/unattended.mjs done "做完了什么"    全做完了：放行收尾
//   node ~/.fleet-dao/hooks/unattended.mjs needs-you "要他拍什么"  碰人闸：放行收尾，把问题放最后一条等他
//   node ~/.fleet-dao/hooks/unattended.mjs off                  关
//   node ~/.fleet-dao/hooks/unattended.mjs status
//
// 改这里之前必须知道（规矩由 agents/test/rules/stop.rules.test.ts 钉住）：
// - 状态按会话号存（~/.fleet-dao/unattended/<会话号>.json，会话号来自环境变量 CLAUDE_CODE_SESSION_ID，Stop、PreToolUse 的输入里
//   同一个号）：同时开着的几个会话、几个仓互不串。会话号拿不到，on 明确失败，不装作开成了。
// - 只有两种放行带着「没查成」的话：状态读不了 / 写不了（放行是为了不把人困住，但要说清楚是故障，不是正常收尾）。
// - 防空转：被挡回去之后，两次挡之间一个工具都没调（PreToolUse 没记到）算「没干活」；连着 3 次就放行并转成 paused，
//   另有总次数上限；过期时间到了自动关。这几个数不要凭感觉改大——改大等于允许多烧额度。
// - 钩子里任何一步出错一律放行（只提示），绝不抛、不拦：这里是兜底，不是新的故障点。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_HOURS = 8;
export const MAX_HOURS = 24;
/** 被挡回去后连着这么多次没调过工具，就放行。 */
export const MAX_IDLE_BLOCKS = 3;
/** 一次无人值守最多挡这么多次，防别的原因造成的无限循环。 */
export const MAX_TOTAL_BLOCKS = 80;

const SCRIPT = '~/.fleet-dao/hooks/unattended.mjs';

export function stateDir(env = process.env, home = homedir()) {
  const o = env.FLEET_UNATTENDED_DIR;
  return typeof o === 'string' && o ? o : join(home, '.fleet-dao', 'unattended');
}

/** 会话号只许字母数字和 - _：它要拼进文件名，别的字符一律当没有。 */
export function cleanId(id) {
  return typeof id === 'string' && /^[\w-]{4,128}$/.test(id) ? id : null;
}

function fileFor(dir, id) {
  return join(dir, `${cleanId(id)}.json`);
}

/** { ok: true, state: 对象 | null（没开） } 或 { ok: false, why }；读不了、认不出都是 ok:false，不当成没开。 */
export function readState(dir, id) {
  if (!cleanId(id)) return { ok: true, state: null };
  let text;
  try {
    text = readFileSync(fileFor(dir, id), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, state: null };
    return { ok: false, why: `读不了状态文件（${err?.code ?? err}）` };
  }
  try {
    const s = JSON.parse(text);
    const good =
      s &&
      typeof s === 'object' &&
      ['on', 'paused', 'done'].includes(s.state) &&
      Number.isFinite(Date.parse(s.expiresAt)) &&
      Number.isInteger(s.idle) &&
      Number.isInteger(s.totalBlocks);
    if (!good) return { ok: false, why: '状态文件的内容认不出' };
    return { ok: true, state: s };
  } catch {
    return { ok: false, why: '状态文件不是合法的 JSON' };
  }
}

function writeState(dir, id, state) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileFor(dir, id), `${JSON.stringify(state, null, 2)}\n`);
}

function removeState(dir, id) {
  rmSync(fileFor(dir, id), { force: true });
}

const fmt = (iso) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16);

export function blockReason(state, now) {
  const left = Math.max(0, Math.round((Date.parse(state.expiresAt) - now) / 60_000));
  if (state.auto === true) {
    return (
      `你起了后台活（子代理、监视、后台命令），这一轮结束它们会跟着会话进程一起被杀、没有谁会被完成通知叫醒，所以先别结束这一轮（自动挡 ${left} 分钟）。` +
      `继续等它们的结果、接着干；全收口了：node ${SCRIPT} done "做完了什么"；碰到要创始人拍的：node ${SCRIPT} needs-you "要他拍什么"。`
    );
  }
  return (
    `无人值守开着（还剩约 ${left} 分钟）：不要结束这一轮。还有没做完的事就接着干——先短报一行进度，然后继续调工具；` +
    `全做完了：node ${SCRIPT} done "做完了什么"；碰到要创始人拍的（对外发布、花钱、删数据、改标准）：` +
    `node ${SCRIPT} needs-you "要他拍什么"，再把问题放在最后一条。`
  );
}

/**
 * Stop 钩子要不要挡。返回 { block: true, reason } 或 { block: false, notice? }（notice 给 systemMessage，只在要说话时有）。
 * 不抛：任何一步出错都放行并写明。
 */
export function decideStop({ dir, sessionId, now = Date.now() }) {
  try {
    if (!cleanId(sessionId)) return { block: false };
    const r = readState(dir, sessionId);
    if (!r.ok) {
      return {
        block: false,
        notice: `无人值守状态${r.why}：这一轮不拦（不能把人困住）；开着的话要重新跑 node ${SCRIPT} on。`,
      };
    }
    const s = r.state;
    if (s === null || s.state !== 'on') return { block: false };
    if (now > Date.parse(s.expiresAt)) {
      removeState(dir, sessionId);
      return { block: false, notice: `无人值守过期了（到 ${fmt(s.expiresAt)}），已关。` };
    }
    // 上一次挡过之后，到这一次之间没调过任何工具：没干活，只回了文字
    const idle = s.totalBlocks > 0 && !s.toolSinceBlock ? s.idle + 1 : 0;
    if (idle >= MAX_IDLE_BLOCKS || s.totalBlocks >= MAX_TOTAL_BLOCKS) {
      const why =
        idle >= MAX_IDLE_BLOCKS
          ? `被挡回去 ${MAX_IDLE_BLOCKS} 次都没再干活（没调工具）`
          : `已经挡了 ${MAX_TOTAL_BLOCKS} 次，到上限`;
      writeState(dir, sessionId, { ...s, state: 'paused', note: why, idle });
      return {
        block: false,
        notice: `无人值守自动暂停：${why}。有话要创始人定就放最后一条；要接着干请重新跑 node ${SCRIPT} on。`,
      };
    }
    writeState(dir, sessionId, {
      ...s,
      idle,
      totalBlocks: s.totalBlocks + 1,
      toolSinceBlock: false,
      lastBlockAt: new Date(now).toISOString(),
    });
    return { block: true, reason: blockReason(s, now) };
  } catch (err) {
    return {
      block: false,
      notice: `无人值守的判断自己出错了（${err?.message ?? err}）：这一轮不拦（不能把人困住）。`,
    };
  }
}

/** PreToolUse 调用：开着就记一笔「调了工具」。只在需要改的时候才写；任何错误都吞掉。 */
export function touchTool({ dir, sessionId }) {
  try {
    const r = readState(dir, sessionId);
    if (!r.ok || r.state === null || r.state.state !== 'on' || r.state.toolSinceBlock === true) return;
    writeState(dir, sessionId, { ...r.state, toolSinceBlock: true });
  } catch {
    // 记不上最多让这一轮早点被放行，不影响调用
  }
}

/** 起了后台活自动开的无人值守开多久（创始人 2026-10-04「选 1」）；再起一个后台活就续到再过这么久。 */
export const AUTO_ARM_MINUTES = 30;

/**
 * 这次工具调用是不是起了一件在后台跑的活。后台活是挂在这个会话进程上的：一轮结束、进程一重开它就被杀，
 * 也就没有谁会被它的完成通知叫醒（2026-10-04 上午、下午各丢过一回：#754 的测试和三个监视任务跟着一轮结束一起没了）。
 * Agent（子代理）默认在后台，只有显式 run_in_background:false 才是前台；Monitor、Workflow 本来就是后台；Bash、PowerShell 要显式 true。
 */
export function startsBackground(toolName, toolInput) {
  const bg = toolInput && typeof toolInput === 'object' ? toolInput.run_in_background : undefined;
  if (toolName === 'Monitor' || toolName === 'Workflow') return true;
  if (toolName === 'Agent' || toolName === 'Task') return bg !== false;
  if (toolName === 'Bash' || toolName === 'PowerShell') return bg === true;
  return false;
}

/**
 * 起了后台活：没开无人值守（或已收尾、暂停、过期）就自动开一个 AUTO_ARM_MINUTES 分钟的，这一轮结束会被挡回来；
 * 已经开着的：自动开的续期，创始人手动开的（通常更长）一个字不动。状态读不了就不写（不覆盖认不出的东西），返回为什么。
 * 活全收口了跑 done 放行；忘了跑也不会困住人：到期自动关、连着 3 次挡回去没调工具就暂停（decideStop）。
 * 返回 { armed, kept?, why? }；不抛。
 */
export function armForBackground({ dir, sessionId, now = Date.now(), minutes = AUTO_ARM_MINUTES }) {
  try {
    if (!cleanId(sessionId)) return { armed: false, why: '拿不到会话号' };
    const r = readState(dir, sessionId);
    if (!r.ok) return { armed: false, why: r.why };
    const s = r.state;
    const until = new Date(now + minutes * 60_000).toISOString();
    if (s !== null && s.state === 'on' && now <= Date.parse(s.expiresAt)) {
      if (s.auto === true && Date.parse(s.expiresAt) < Date.parse(until)) {
        writeState(dir, sessionId, { ...s, expiresAt: until });
        return { armed: false, kept: true };
      }
      return { armed: false, kept: true };
    }
    writeState(dir, sessionId, {
      state: 'on',
      auto: true,
      since: new Date(now).toISOString(),
      expiresAt: until,
      idle: 0,
      totalBlocks: 0,
      toolSinceBlock: true,
      note: '起了后台活，自动开的',
    });
    return { armed: true };
  } catch (err) {
    return { armed: false, why: err?.message ?? String(err) };
  }
}

/** 开会话钩子读的那一句：这个会话的无人值守开着（上下文被总结、重启之后还知道）；没开、读不了都是空数组。 */
export function sessionLines({ dir, sessionId, now = Date.now() }) {
  const r = readState(dir, sessionId);
  if (!r.ok) return [`无人值守状态${r.why}：开着的话要重新跑 node ${SCRIPT} on。`];
  const s = r.state;
  if (s === null || now > Date.parse(s.expiresAt)) return [];
  if (s.state === 'on') {
    return [
      `无人值守开着（到 ${fmt(s.expiresAt)}）：这一轮不要结束，接着干；全做完 node ${SCRIPT} done "…"，要创始人拍板 node ${SCRIPT} needs-you "…"。`,
    ];
  }
  if (s.state === 'paused') {
    return [`无人值守暂停着（${s.note || '没写原因'}）：创始人要接着干就重新跑 node ${SCRIPT} on。`];
  }
  return [];
}

const USAGE = `用法：node ${SCRIPT} on [--hours N] | done "做完了什么" | needs-you "要他拍什么" | off | status`;

/** 命令行；返回退出码。io = { out, err, env, now }。 */
export function main(argv, io) {
  const env = io.env ?? process.env;
  const now = io.now ?? Date.now();
  const dir = stateDir(env);
  const [cmd, ...rest] = argv;
  const id = cleanId(env.CLAUDE_CODE_SESSION_ID);
  if (!['on', 'done', 'needs-you', 'off', 'status'].includes(cmd ?? '')) {
    io.err(`没做成：${cmd ? `不认识的命令 ${cmd}` : '没给命令'}。${USAGE}`);
    return 2;
  }
  if (!id) {
    io.err(
      '没做成：拿不到会话号（环境变量 CLAUDE_CODE_SESSION_ID 没有或不合法），不知道这个状态该记在哪个会话上。',
    );
    return 2;
  }
  try {
    if (cmd === 'status') {
      const r = readState(dir, id);
      if (!r.ok) {
        io.err(`没查成：无人值守状态${r.why}`);
        return 1;
      }
      if (r.state === null) io.out('无人值守：没开');
      else {
        const s = r.state;
        io.out(
          `无人值守：${s.state}，到 ${fmt(s.expiresAt)}，已挡 ${s.totalBlocks} 次（连着没干活 ${s.idle} 次）${s.note ? `，${s.note}` : ''}`,
        );
      }
      return 0;
    }
    if (cmd === 'off') {
      removeState(dir, id);
      io.out('无人值守已关。');
      return 0;
    }
    if (cmd === 'on') {
      let hours = DEFAULT_HOURS;
      const i = rest.indexOf('--hours');
      if (i >= 0) hours = Number(rest[i + 1]);
      if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) {
        io.err(`没做成：--hours 要是 0 到 ${MAX_HOURS} 之间的数，给的是「${rest[i + 1] ?? ''}」。`);
        return 2;
      }
      const expiresAt = new Date(now + hours * 3_600_000).toISOString();
      writeState(dir, id, {
        state: 'on',
        since: new Date(now).toISOString(),
        expiresAt,
        idle: 0,
        totalBlocks: 0,
        toolSinceBlock: true,
        note: '',
      });
      io.out(
        `无人值守已开，到 ${fmt(expiresAt)}。这一轮想结束会被挡回来；做完 done、要他拍板 needs-you、他说停就 off。`,
      );
      return 0;
    }
    // done / needs-you：必须写一句话，逼着说清楚为什么放行
    const note = rest.join(' ').trim();
    if (!note) {
      io.err(`没做成：${cmd} 要写一句话（${cmd === 'done' ? '做完了什么' : '要他拍什么'}）。`);
      return 2;
    }
    const r = readState(dir, id);
    if (!r.ok || r.state === null) {
      io.err(r.ok ? '没做成：这个会话没开无人值守，没有要改的。' : `没做成：无人值守状态${r.why}。`);
      return 1;
    }
    writeState(dir, id, { ...r.state, state: cmd === 'done' ? 'done' : 'paused', note });
    io.out(`无人值守${cmd === 'done' ? '收尾' : '暂停'}：${note}。这一轮现在可以结束了。`);
    return 0;
  } catch (err) {
    io.err(`没做成：${err?.message ?? err}`);
    return 1;
  }
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  process.exit(
    main(process.argv.slice(2), {
      out: (s) => process.stdout.write(`${s}\n`),
      err: (s) => process.stderr.write(`${s}\n`),
    }),
  );
}
