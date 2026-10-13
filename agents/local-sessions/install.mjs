#!/usr/bin/env node
// 本机会话心跳的装和卸（#1991）：一条命令装、一条命令卸，不用手改散落的文件。
//
//   FLEET_NODE_TOKEN=<通行证> pnpm local-sessions:install --url https://<法国驾驶舱地址> [--machine 创始人的电脑]
//   pnpm local-sessions:uninstall
//   pnpm local-sessions:status
//
// 装做四件事：① 把 lib.mjs、heartbeat.mjs、push.mjs 拷进 ~/.fleet-dao/local-sessions/bin/；② 写 config.json（地址、通行证、机器名，
// 通行证只从环境变量 FLEET_NODE_TOKEN 读，不进命令行历史；已经有 config.json 又没给新的就留着旧的）；③ 在 ~/.claude/settings.json
// 的 SessionStart / PreToolUse / Stop / SubagentStop / SessionEnd 各登记一条 node 跑 heartbeat.mjs（只动指向
// ~/.fleet-dao/local-sessions/bin/ 的那几条，别人的钩子原样留着；重装不重复）；④ 建 Windows 计划任务 fleet-local-sessions，
// 每 2 分钟经 wscript 静默跑一次 push.mjs（不闪黑窗口），装完当场推一次、把结果打出来。
// 卸做相反的三件：摘掉那几条钩子、删计划任务、删整个 ~/.fleet-dao/local-sessions/。
//
// 改这里之前必须知道：
// - settings.json 读不出（坏 JSON）就停、不覆盖：那是创始人的设置，写坏了所有会话都受影响。改之前留一份 settings.json.local-sessions.bak。
// - 每一步成没成都打出来；有一步没成退出码非 0，不说「装好了」。
// - 只支持 Windows 计划任务（创始人的电脑）；别的系统明说没装定时推送，给出要自己加的 crontab 那一行。
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  baseDir,
  binDir,
  configPath,
  HOOK_EVENTS,
  messageOf,
  pushOnce,
  statusPath,
  TASK_NAME,
  writeAtomic,
} from './lib.mjs';

const SCRIPTS = ['lib.mjs', 'heartbeat.mjs', 'push.mjs'];
const OURS = /[\\/]\.fleet-dao[\\/]local-sessions[\\/]bin[\\/]/;

/** @typedef {Record<string, unknown>} Obj */
/** @typedef {(cmd: string, args: string[]) => { status: number | null, stdout: string, stderr: string }} Run */
/** @typedef {{ ok: boolean, step: string, detail: string }} Step */

/** @param {unknown} v @returns {v is Obj} */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** @type {Run} */
const realRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? (r.error ? messageOf(r.error) : ''),
  };
};

/**
 * 钩子登记的那条命令。
 * @param {string} home
 */
export const heartbeatCommand = (home) =>
  `node "${join(binDir(home), 'heartbeat.mjs').replaceAll('\\', '/')}"`;

/**
 * 摘掉 settings 里指向 ~/.fleet-dao/local-sessions/bin/ 的钩子；摘空了的组、事件一起去掉。返回新的 settings 和摘了几条。
 * @param {Obj} settings
 * @returns {{ settings: Obj, removed: number }}
 */
export function removeHooks(settings) {
  let removed = 0;
  if (!isObj(settings.hooks)) return { settings, removed };
  /** @type {Obj} */
  const hooks = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = [];
    for (const group of groups) {
      if (!isObj(group) || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const left = group.hooks.filter((h) => {
        const ours = isObj(h) && typeof h.command === 'string' && OURS.test(h.command);
        if (ours) removed += 1;
        return !ours;
      });
      if (left.length > 0) kept.push({ ...group, hooks: left });
    }
    if (kept.length > 0) hooks[event] = kept;
  }
  const { hooks: _old, ...rest } = settings;
  return { settings: Object.keys(hooks).length === 0 ? rest : { ...rest, hooks }, removed };
}

/**
 * 登记心跳钩子（先摘旧的再加，重装不重复）。
 * @param {Obj} settings
 * @param {string} command
 * @returns {Obj}
 */
export function addHooks(settings, command) {
  const base = removeHooks(settings).settings;
  /** @type {Obj} */
  const hooks = isObj(base.hooks) ? { ...base.hooks } : {};
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    groups.push({
      ...(event === 'PreToolUse' ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command, timeout: 5 }],
    });
    hooks[event] = groups;
  }
  return { ...base, hooks };
}

/**
 * 读 settings.json；没有算空的，坏了抛错（不覆盖）。
 * @param {string} path
 * @returns {Obj}
 */
function readSettings(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  /** @type {unknown} */
  let v;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} 不是 JSON（${messageOf(e)}），不敢改，先修好它再装`);
  }
  if (!isObj(v)) throw new Error(`${path} 顶层不是对象，不敢改`);
  return v;
}

/**
 * @param {string} path
 * @param {Obj} next
 */
function writeSettings(path, next) {
  if (existsSync(path)) copyFileSync(path, `${path}.local-sessions.bak`);
  writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * 计划任务跑的 .vbs：wscript 是不带控制台的程序，经它起 node 不闪黑窗口。
 * @param {string} nodePath
 * @param {string} pushPath
 */
export const vbsOf = (nodePath, pushPath) =>
  `CreateObject("WScript.Shell").Run """${nodePath}"" ""${pushPath}""", 0, False\r\n`;

/**
 * @param {{ home: string, srcDir: string, url?: string, token?: string, machine?: string, platform?: NodeJS.Platform, run?: Run, nodePath?: string, fetchImpl?: typeof fetch, now?: () => Date }} o
 * @returns {Promise<Step[]>}
 */
export async function install(o) {
  const platform = o.platform ?? process.platform;
  const run = o.run ?? realRun;
  /** @type {Step[]} */
  const steps = [];
  const fail = (/** @type {string} */ step, /** @type {string} */ detail) => {
    steps.push({ ok: false, step, detail });
    return steps;
  };

  // ① 配置：先核，缺了就不往下装（装了钩子却推不出去，只会让看板一直写没上报）
  const cfgPath = configPath(o.home);
  if (o.url !== undefined || o.token !== undefined) {
    if (!o.url || !/^https?:\/\//.test(o.url))
      return fail('配置', '--url 要是 http(s):// 开头的法国驾驶舱地址');
    if (!o.token)
      return fail('配置', '通行证放环境变量 FLEET_NODE_TOKEN（fleet-api node-key new <编号> 打印的明文）');
    writeAtomic(
      cfgPath,
      `${JSON.stringify({ url: o.url, token: o.token, ...(o.machine ? { machine: o.machine } : {}) }, null, 2)}\n`,
    );
    steps.push({ ok: true, step: '配置', detail: `写了 ${cfgPath}（推到 ${o.url}）` });
  } else if (existsSync(cfgPath)) {
    steps.push({ ok: true, step: '配置', detail: `留着已有的 ${cfgPath}` });
  } else {
    return fail('配置', `没有 ${cfgPath}：第一次装要带 --url，通行证放环境变量 FLEET_NODE_TOKEN`);
  }

  // ② 拷脚本
  try {
    mkdirSync(binDir(o.home), { recursive: true });
    for (const s of SCRIPTS) copyFileSync(join(o.srcDir, s), join(binDir(o.home), s));
    steps.push({ ok: true, step: '脚本', detail: `拷进 ${binDir(o.home)}` });
  } catch (e) {
    return fail('脚本', `拷不进 ${binDir(o.home)}：${messageOf(e)}`);
  }

  // ③ 钩子
  const settingsPath = join(o.home, '.claude', 'settings.json');
  try {
    writeSettings(settingsPath, addHooks(readSettings(settingsPath), heartbeatCommand(o.home)));
    steps.push({
      ok: true,
      step: '钩子',
      detail: `${settingsPath} 登记了 ${HOOK_EVENTS.join('、')}（新开的会话才生效）`,
    });
  } catch (e) {
    return fail('钩子', messageOf(e));
  }

  // ④ 定时推送
  const pushPath = join(binDir(o.home), 'push.mjs');
  const nodePath = o.nodePath ?? process.execPath;
  if (platform === 'win32') {
    const vbs = join(binDir(o.home), 'run-push.vbs');
    try {
      writeAtomic(vbs, vbsOf(nodePath, pushPath));
    } catch (e) {
      return fail('定时推送', `写不了 ${vbs}：${messageOf(e)}`);
    }
    const r = run('schtasks', [
      '/Create',
      '/F',
      '/TN',
      TASK_NAME,
      '/SC',
      'MINUTE',
      '/MO',
      '2',
      '/TR',
      `wscript.exe "${vbs}"`,
    ]);
    if (r.status !== 0)
      return fail('定时推送', `schtasks 没建成（${r.status}）：${(r.stderr || r.stdout).trim()}`);
    steps.push({ ok: true, step: '定时推送', detail: `计划任务 ${TASK_NAME} 每 2 分钟推一次` });
  } else {
    return fail(
      '定时推送',
      `这台不是 Windows，没装定时推送：自己加一行 crontab「*/2 * * * * ${nodePath} ${pushPath}」`,
    );
  }

  // 当场推一次
  const now = o.now ?? (() => new Date());
  const pushed = await pushOnce({
    home: o.home,
    now: now(),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
  steps.push(
    pushed.ok
      ? { ok: true, step: '试推', detail: `法国收下了（${pushed.sessions ?? 0} 个会话）` }
      : { ok: false, step: '试推', detail: `没推成：${pushed.why}` },
  );
  return steps;
}

/**
 * @param {{ home: string, platform?: NodeJS.Platform, run?: Run }} o
 * @returns {Step[]}
 */
export function uninstall(o) {
  const platform = o.platform ?? process.platform;
  const run = o.run ?? realRun;
  /** @type {Step[]} */
  const steps = [];
  const settingsPath = join(o.home, '.claude', 'settings.json');
  try {
    const { settings, removed } = removeHooks(readSettings(settingsPath));
    if (removed > 0) writeSettings(settingsPath, settings);
    steps.push({ ok: true, step: '钩子', detail: `摘了 ${removed} 条` });
  } catch (e) {
    steps.push({ ok: false, step: '钩子', detail: messageOf(e) });
  }
  if (platform === 'win32') {
    const q = run('schtasks', ['/Query', '/TN', TASK_NAME]);
    if (q.status !== 0) steps.push({ ok: true, step: '定时推送', detail: `没有计划任务 ${TASK_NAME}` });
    else {
      const r = run('schtasks', ['/Delete', '/F', '/TN', TASK_NAME]);
      steps.push(
        r.status === 0
          ? { ok: true, step: '定时推送', detail: `删了计划任务 ${TASK_NAME}` }
          : { ok: false, step: '定时推送', detail: `schtasks 没删成：${(r.stderr || r.stdout).trim()}` },
      );
    }
  }
  try {
    rmSync(baseDir(o.home), { recursive: true, force: true });
    steps.push({ ok: true, step: '文件', detail: `删了 ${baseDir(o.home)}` });
  } catch (e) {
    steps.push({ ok: false, step: '文件', detail: `${baseDir(o.home)} 没删掉：${messageOf(e)}` });
  }
  return steps;
}

/**
 * 现在装没装、上次推得怎样（不打印通行证）。
 * @param {string} home
 * @returns {string[]}
 */
export function status(home) {
  const lines = [];
  const settingsPath = join(home, '.claude', 'settings.json');
  try {
    const s = readSettings(settingsPath);
    const n = JSON.stringify(s.hooks ?? {}).match(/local-sessions\/bin\/heartbeat\.mjs/g)?.length ?? 0;
    lines.push(`钩子：${n === 0 ? '没登记' : `登记了 ${n} 条`}`);
  } catch (e) {
    lines.push(`钩子：没查成（${messageOf(e)}）`);
  }
  try {
    const c = JSON.parse(readFileSync(configPath(home), 'utf8'));
    lines.push(`推到：${isObj(c) && typeof c.url === 'string' ? c.url : '认不出'}`);
  } catch {
    lines.push('推到：没配（没有 config.json）');
  }
  try {
    lines.push(`上次推：${readFileSync(statusPath(home), 'utf8').trim()}`);
  } catch {
    lines.push('上次推：还没推过');
  }
  return lines;
}

/** @param {string[]} argv */
function flag(argv, /** @type {string} */ name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const home = homedir();
  /** @type {Step[]} */
  let steps;
  if (cmd === 'install') {
    const url = flag(rest, '--url');
    const machine = flag(rest, '--machine');
    const token = process.env.FLEET_NODE_TOKEN;
    steps = await install({
      home,
      srcDir: dirname(fileURLToPath(import.meta.url)),
      ...(url !== undefined || token ? { url: url ?? '', token: token ?? '' } : {}),
      ...(machine ? { machine } : {}),
    });
  } else if (cmd === 'uninstall') {
    steps = uninstall({ home });
  } else if (cmd === 'status') {
    for (const l of status(home)) process.stdout.write(`${l}\n`);
    return 0;
  } else {
    process.stderr.write(
      '用法：install --url <法国地址> [--machine 名字]（通行证放 FLEET_NODE_TOKEN）| uninstall | status\n',
    );
    return 2;
  }
  for (const s of steps) process.stdout.write(`${s.ok ? '成' : '没成'}  ${s.step}：${s.detail}\n`);
  return steps.every((s) => s.ok) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
