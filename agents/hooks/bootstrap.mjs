// 引导钩子：登记在**仓里的** .claude/settings.json（项目级 SessionStart），在 fleet-dao 检出里开会话时跑。
// 起因（创始人 2026-10-04：「我另一台机器也有 fleet-dao 仓库，大概率挂的是旧钩子；怎么才能在一开始对话的时候就发现是旧钩子，
// 并且主动清理换新」）：用户级的开会话钩子（~/.fleet-dao/hooks/session-start.mjs）自己会同步，可它得先是新的才会；老机器上
// 挂的是更老的一代（以前手装在 fleet-guard 目录的、同步专用检出出现之前的），它们自己不会升级，也就永远没人替它们换。
// 项目级钩子不一样：它跟着仓走，这台机器只要把检出拉到有这个文件的提交，之后每次在检出里开会话就先过这一关。
//
// 做什么：先离线核一遍这台的用户级钩子是不是现在这一代（healthReasons）；是就一个字都不说；不是就说「发现旧钩子：为什么」，
// 再跑一遍和开会话钩子同一条同步路径（session-start.mjs 的 syncFleet，强制、种子是这个检出），把旧的换成新的，报结果。
// 改这里之前必须知道：
// - 只在「这台装过完整同步」的机器上动手：~/.fleet-dao/synced.json 在（新办法同步过），或者还挂着以前手装的 fleet-guard（更老的一代）。
//   法国的会话用户（agents-sync --user）两样都没有——它们的开会话钩子是故意不登记的，引擎起的会话又读项目级设置，
//   这里要是见到「没登记」就去同步，等于绕过那条故意的安排。FLEET_BOOTSTRAP=off 也直接不动。
// - 判得出「旧」才动手，判不出（读不了设置文件）也要明说，不装作没事，也不拿它当「旧」去覆盖。
// - 一律退出 0、不抛：这是开会话时的兜底，不是新的故障点。
// 规矩由 agents/test/bootstrap.test.ts 钉住（含故意造出的失败）。
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SYNC_DIR as SYNC_REL } from './sync-source.mjs';

const HOOKS_REL = join('.fleet-dao', 'hooks');
const SESSION_SCRIPT = 'session-start.mjs';

const NOW_STYLE = /\/\.fleet-dao\/hooks\/([\w.-]+\.mjs)(?![\w.-])/;
const LEGACY_STYLE = /\/fleet-guard\/(?:session-start|pretool)\.mjs(?![\w.-])/;

/** 一个目录里所有文件（相对路径 → 内容）；目录不在返回 null，读不了抛 */
function readFlat(dir, base = dir, out = new Map()) {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) readFlat(p, base, out);
    else
      out.set(p.slice(base.length + 1).replaceAll('\\', '/'), readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
  }
  return out;
}

/** 设置文件里所有钩子命令：{ event, command }[]；读不了、认不出返回 { ok:false, why } */
function settingsCommands(file) {
  let root;
  try {
    root = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, missing: true, cmds: [] };
    return { ok: false, why: err?.code ?? '内容不是合法的 JSON' };
  }
  const cmds = [];
  const hooks = root && typeof root === 'object' ? root.hooks : undefined;
  if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups)
        for (const h of Array.isArray(g?.hooks) ? g.hooks : [])
          if (typeof h?.command === 'string') cmds.push({ event, command: h.command.replaceAll('\\', '/') });
    }
  }
  return { ok: true, missing: false, cmds };
}

const unreadableLine = (why) =>
  `引导钩子没核成：${why}；这台的钩子是不是最新判不了，先不动，修好设置文件再开会话，或手动跑 pnpm agents:sync。`;

/** 这台该不该由引导钩子管：{ manage: true } 或 { manage: false, why } 或 { manage: false, unreadable }（读不了，要明说） */
export function shouldManage({ home, env = process.env }) {
  if (env.FLEET_BOOTSTRAP === 'off') return { manage: false, why: 'FLEET_BOOTSTRAP=off' };
  const synced = existsSync(join(home, '.fleet-dao', 'synced.json'));
  const s = settingsCommands(join(home, '.claude', 'settings.json'));
  const legacy = s.ok && s.cmds.some((c) => LEGACY_STYLE.test(c.command));
  if (synced || legacy) return { manage: true };
  // 设置文件读不了（不是没有）：判不出这台有没有挂旧钩子，不能当成「没有」静默退出——
  // 没有 synced.json 的老机器恰恰是这一关要管的那类（#829 合并后补审挑出来的）
  if (!s.ok) return { manage: false, unreadable: `~/.claude/settings.json 读不了（${s.why}）` };
  return {
    manage: false,
    why: '这台没做过完整同步、也没挂以前手装的钩子（法国会话用户、第一次装机都在这一类）',
  };
}

/**
 * 用户级钩子为什么算旧：一条一句话；空数组 = 是现在这一代。离线、只读。
 * 读不了设置文件返回 { unreadable }，让调用方明说，不当成旧也不当成新。
 */
export function healthReasons({ home }) {
  const reasons = [];
  const s = settingsCommands(join(home, '.claude', 'settings.json'));
  if (!s.ok) return { unreadable: `~/.claude/settings.json 读不了（${s.why}）` };
  const legacy = s.cmds.filter((c) => LEGACY_STYLE.test(c.command));
  if (legacy.length > 0) reasons.push(`还挂着以前手装在 fleet-guard 目录的钩子（${legacy.length} 条）`);
  const start = s.cmds.some(
    (c) => c.event === 'SessionStart' && NOW_STYLE.exec(c.command)?.[1] === SESSION_SCRIPT,
  );
  if (!start) reasons.push('开会话钩子没登记到 ~/.fleet-dao/hooks/session-start.mjs（旧的位置，或者没有）');

  const installed = readFlat(join(home, HOOKS_REL));
  if (installed === null) reasons.push('~/.fleet-dao/hooks/ 目录不存在');
  else if (!installed.has(SESSION_SCRIPT)) reasons.push('~/.fleet-dao/hooks/ 里没有 session-start.mjs');

  const source = readFlat(join(home, SYNC_REL, 'agents', 'hooks'));
  if (source === null) {
    reasons.push('没有同步专用检出（~/.fleet-dao/origin-main，新办法才有），说明钩子是老办法装的');
  } else if (installed !== null) {
    const names = new Set([...source.keys(), ...installed.keys()]);
    const diff = [...names].filter((n) => source.get(n) !== installed.get(n)).sort();
    if (diff.length > 0)
      reasons.push(
        `装着的钩子脚本和主线不一样（${diff.slice(0, 3).join('、')}${diff.length > 3 ? ` 等 ${diff.length} 个` : ''}）`,
      );
  }
  return { reasons };
}

/**
 * 引导：返回要打给会话的话（空数组 = 一个字都不说）。deps 全可注入，测试用假的。
 * deps = { home, projectDir, env, syncFleet, git, sync, now }
 */
export function bootstrap(deps) {
  const { home, projectDir, env = process.env, now = Date.now() } = deps;
  const m = shouldManage({ home, env });
  if (!m.manage) return m.unreadable ? [unreadableLine(m.unreadable)] : [];
  const h = healthReasons({ home });
  if (h.unreadable) return [unreadableLine(h.unreadable)];
  if (h.reasons.length === 0) return [];
  const said = `发现旧钩子：${h.reasons.join('；')}。正在换成主线最新的。`;
  // 强制跑一遍，别被「3 分钟内刚同步成功过」的静默期挡掉：旧钩子的同步成功过不代表装对了
  try {
    rmSync(join(home, '.fleet-dao', 'session-sync.ok'), { force: true });
  } catch {
    // 删不掉最多被静默期挡一次，force 另有保险
  }
  let result;
  try {
    result = deps.syncFleet({ home, git: deps.git, sync: deps.sync, now, seed: projectDir, force: true });
  } catch (err) {
    result = `换新没做成：引导钩子自己出错了（${err?.message ?? err}）；手动跑 pnpm agents:sync。`;
  }
  const after = healthReasons({ home });
  const still = after.reasons?.length
    ? `；但核回来还有 ${after.reasons.length} 处没换好（${after.reasons[0]}）`
    : '';
  return [said, `${result}${still}`];
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  let lines;
  try {
    // 只在要动手的时候才加载 session-start.mjs（它顶层会动态加载同步专用检出那一段）
    const home = homedir();
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const m = shouldManage({ home });
    if (!m.manage) lines = m.unreadable ? [unreadableLine(m.unreadable)] : [];
    else {
      const ss = await import(
        pathToFileURL(join(fileURLToPath(new URL('.', import.meta.url)), SESSION_SCRIPT)).href
      );
      lines = bootstrap({
        home,
        projectDir,
        syncFleet: ss.syncFleet,
        git: ss.gitRunner(),
        sync: ss.syncRunner(),
      });
    }
  } catch (err) {
    lines = [
      `引导钩子自己出错了（${err?.message ?? err}）；这台的钩子是不是最新没核成，手动跑 pnpm agents:sync。`,
    ];
  }
  if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
}
