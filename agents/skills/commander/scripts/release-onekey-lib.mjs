// 发版一键命令的薄封装：预检自己做、只读；真发版交给 release-train-lib.mjs 的 runTrain
// （往法国递请求、跟着进度，九步在法国接活脚本里）。
// 这里做两件事——
// 1. preflight 只读：主线 CI、挂了自动合并的 PR、法国在跑的会话、法国现状（france.mjs）。
//    不调用 runTrain，不写发布请求，不关法国引擎。主线 CI 不是绿的、法国现状读不到，回 2，输出里有「预检没过」。
//    本机还留着旧的发版车状态文件时不碰，回 1。
// 2. start 先用中文拦用法（sha 必填且是完整 40 位、founder-ok 必填），过了照原样进 runTrain。
//    status / abort 也是透传。
// 改这里之前必须知道：
// - 这份文件里没有任何真的起进程、连网、睡觉的代码：一切经 io 进来，
//   agents/test/release-onekey.test.ts 换假 ssh、假 gh、假时钟。
// - 预检不许再借 runTrain start：那条路会往法国写请求。只读查完就停。
// - 退出码：0 做完了（预检过了，或 status 没有一趟）；1 用法不对或被拒；2 没做成（预检没过也是 2，不算卡住）；3 卡住（runTrain 跟到法国卡住）。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { scrubText } from './france-lib.mjs';
import { runTrain, STATE_REL } from './release-train-lib.mjs';

export const ONEKEY_USAGE = `用法：node release-onekey.mjs <命令>（在项目仓的检出里跑；start 会等很久，用 run_in_background 起）
  preflight [--sha <提交>]
        只读预检，什么都不改：主线 CI 绿不绿、法国读不读得到、有没有别的发布在跑、
        列出挂了自动合并的 PR 和法国在跑的会话数，前面带一段中文摘要。不给 --sha 就只查环境。
  start --sha <40位提交> --founder-ok "<创始人原话>" [--restore]
        一键发版：用法过了就交给 release-train，往法国递一份发布请求并跟着进度。
        --restore 用不上（法国那趟自己核对开关），给了也忽略。
  status          读一次法国上的进度（同 release-train.mjs status）
  abort           往法国递撤掉暂停的请求（同 release-train.mjs abort）
退出码：0 做完了；1 用法不对或被拒；2 没做成（预检没过也是 2）；3 卡住。`;

const USAGE_HINT = '（node release-onekey.mjs 不带参数看用法）';

/** 参数的面：{cmd, sha?, founderOk?, restore}，认不出回 {error}。 */
export function parseOnekey(argv) {
  if (argv.length === 0) return { cmd: null };
  if (argv.includes('--help') || argv.includes('-h')) return { cmd: 'help' };
  const [cmd, ...rest] = argv;
  if (cmd !== 'preflight' && cmd !== 'start' && cmd !== 'status' && cmd !== 'abort')
    return { error: `没有「${scrubText(cmd)}」这个命令${USAGE_HINT}` };
  const out = { cmd, restore: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--restore') {
      out.restore = true;
      continue;
    }
    if (arg === '--tag')
      return {
        error: `--tag 已经没有了（决定 0032：发版的单位是主线上的一个提交），改用 --sha <提交>${USAGE_HINT}`,
      };
    if (arg === '--sha' || arg === '--founder-ok') {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) return { error: `${arg} 后面要跟值` };
      const key = arg === '--founder-ok' ? 'founderOk' : arg.slice(2);
      if (out[key] !== undefined) return { error: `${arg} 只能给一次` };
      out[key] = v;
      i++;
      continue;
    }
    return { error: `不认识的参数「${scrubText(arg)}」${USAGE_HINT}` };
  }
  return out;
}

const stateFile = (home) => join(home, STATE_REL);

const say = (io, text) => io.out(scrubText(text));
const warn = (io, text) => io.err(scrubText(text));

/** start/preflight 公用的 sha 面检查：法国只认完整 40 位；runTrain 还会再查一遍。 */
function checkTargetFormat(io, p) {
  if (p.sha !== undefined && !/^[0-9a-f]{40}$/.test(p.sha)) {
    warn(io, `--sha 要是完整的 40 位小写十六进制，给的是「${p.sha}」`);
    return 1;
  }
  return null;
}

// —— 预检（只读，不调用 runTrain）——

/**
 * 只读预检。不写发布请求、不关引擎。
 * 返回 { code, lines }：lines 是摘要，加上过了或「预检没过」。
 */
export async function runPreflight(io, target) {
  // 本机还留着旧发版车的状态文件：不碰，拒（新的一趟记在法国，这份只是旧现场）
  if (existsSync(stateFile(io.home))) {
    return {
      code: 1,
      lines: [
        '已经有一趟发版的记录（在走、卡住或没成）：先看 status，了结它（接着 start 或 abort）再做预检，预检不碰它',
      ],
    };
  }

  const summary = await buildSummary(io, target);
  const ci = await readMainCi(io);
  if (ci !== '绿') {
    return { code: 2, lines: [...summary, `预检没过：主线 CI 不是绿的（${ci}），什么都没改`] };
  }
  const health = await readFranceHealth(io);
  if (!health.ok) {
    return { code: 2, lines: [...summary, `预检没过：${health.why}，什么都没改`] };
  }
  return {
    code: 0,
    lines: [
      ...summary,
      `预检：法国现状 ${health.bad} 处异常、${health.note} 处留意（只读，不发版）`,
      '预检过了：主线 CI 绿、法国读得到（开关、发版什么都没动）',
    ],
  };
}

/** france.mjs --json：读得到就数异常和留意；读不到是 { ok: false, why }，不当成没有异常。 */
async function readFranceHealth(io) {
  const r = io.run(io.nodePath, [join(io.scriptsDir, 'france.mjs'), '--json'], {
    cwd: io.cwd(),
    timeoutMs: 120_000,
  });
  if (r.error || r.status === null || (r.status !== 0 && r.status !== 1))
    return { ok: false, why: '法国现状读不到' };
  try {
    const view = JSON.parse(String(r.stdout));
    if (!view || !Array.isArray(view.anomalies)) return { ok: false, why: '法国现状认不出' };
    return {
      ok: true,
      bad: view.anomalies.filter((a) => a.level === 'bad').length,
      note: view.anomalies.filter((a) => a.level === 'note').length,
    };
  } catch {
    return { ok: false, why: '法国现状不是 JSON' };
  }
}

/** 摘要段：和 phasePreflight 用的同一批只读接口，把现状说成三行中文。读不到的写「读不到」，不拦预检。 */
async function buildSummary(io, target) {
  const t = target.value ? `提交 ${String(target.value).slice(0, 12)}` : '（只说环境，没指定目标）';
  const lines = [`—— 预检摘要（目标 ${t}；只读，什么都没改）——`];
  lines.push(`主线 CI：${await readMainCi(io)}`);
  lines.push(`挂了自动合并的 PR：${await readAutoMergePrs(io)}`);
  const s = await io.runningSessions();
  lines.push(`法国在跑的会话：${s.ok ? `${s.running} 个` : `读不到（${s.kind}）：${s.why}`}`);
  lines.push('—— 只读预检（不递发布请求）——');
  return lines;
}

async function readMainCi(io) {
  const r = io.run('gh', [
    'api',
    // 按名字过滤：提交上检查多到一页装不下时，不过滤会把 check 挤出第一页（同发版车那处）
    'repos/{owner}/{repo}/commits/main/check-runs?check_name=check&per_page=100',
    '--jq',
    '{total: .total_count, runs: [.check_runs[] | select(.name=="check") | {status,conclusion}]}',
  ]);
  if (r.error || r.status === null || r.status !== 0) return '读不到';
  try {
    const body = JSON.parse(String(r.stdout).trim() || 'null');
    if (!body || !Array.isArray(body.runs) || body.runs.length < body.total) return '读不到（回话不全）';
    const runs = body.runs;
    if (runs.length === 0) return '还没有结果（还没跑）';
    if (runs.some((x) => x.status !== 'completed')) return '还在跑';
    return runs.every((x) => x.conclusion === 'success') ? '绿' : '红';
  } catch {
    return '读不到（回话不是 JSON）';
  }
}

async function readAutoMergePrs(io) {
  const r = io.run('gh', [
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    'number,title,autoMergeRequest',
  ]);
  if (r.error || r.status === null || r.status !== 0) return '读不到';
  try {
    const rows = JSON.parse(String(r.stdout).trim() || '[]');
    const mine = rows.filter((p) => p.autoMergeRequest);
    return mine.length === 0 ? '没有' : `${mine.length} 个（${mine.map((p) => `#${p.number}`).join(' ')}）`;
  } catch {
    return '读不到（回话不是 JSON）';
  }
}

/** start/status/abort 的参数行翻回 release-train 的参数行。 */
function toTrainArgv(p) {
  if (p.cmd === 'start') {
    const argv = ['start'];
    if (p.sha !== undefined) argv.push('--sha', p.sha);
    argv.push('--founder-ok', p.founderOk);
    return argv;
  }
  return [p.cmd]; // status / abort：release-train 不收参数
}

/**
 * 一键发版入口。io 同 release-train-lib 的 io。返回退出码（同 runTrain）。
 */
export async function runOnekey(argv, io) {
  const p = parseOnekey(argv);
  if (p.error) {
    warn(io, p.error);
    return 1;
  }
  if (p.cmd === null || p.cmd === 'help') {
    io.out(ONEKEY_USAGE);
    return p.cmd === null ? 1 : 0;
  }
  if (p.cmd === 'preflight') {
    if (p.founderOk !== undefined) warn(io, 'preflight 是只读的，--founder-ok 用不上（发版才要），这次忽略');
    if (p.restore) warn(io, 'preflight 是只读的，--restore 用不上（发版才要），这次忽略');
    const bad = checkTargetFormat(io, p);
    if (bad !== null) return bad;
    const target = { kind: 'sha', value: p.sha ?? null };
    const r = await runPreflight(io, target);
    for (const line of r.lines) io.out(scrubText(line));
    return r.code;
  }
  if (p.cmd === 'start') {
    if (p.sha === undefined) {
      warn(io, '发哪个没说：补 --sha <提交>（发版的单位是主线上的一个提交，ssh 到法国跑 release.sh）');
      return 1;
    }
    const bad = checkTargetFormat(io, p);
    if (bad !== null) return bad;
    if (p.founderOk === undefined || p.founderOk.trim() === '') {
      warn(io, '发版是对外发布，必须带 --founder-ok "<创始人原话>"：没带就什么都不做');
      return 1;
    }
    if (p.restore) warn(io, '--restore 用不上：法国那趟自己核对开关，这次忽略');
    say(
      io,
      `一键发版：目标提交 ${String(p.sha).slice(0, 12)}。下面交给 release-train，往法国递发布请求并跟着进度：`,
    );
    return runTrain(toTrainArgv(p), io);
  }
  // status / abort：透传
  return runTrain(toTrainArgv(p), io);
}
