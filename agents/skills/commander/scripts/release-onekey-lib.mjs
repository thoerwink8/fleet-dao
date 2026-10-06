// 发版一键命令的薄封装（只到预检，真发版不在这里做）：把 release-train 包成更直观的命令。
// 逻辑一点不重写：真正干活的还是 release-train-lib.mjs 的 runTrain，这里只做三件事——
// 1. 多一个只读的 preflight 命令：借 runTrain 跑「start」，但在它刚开始第 1 步
//    （release-train-lib 的 runFrom 打印「—— 第 1 步「暂停本机」——」那一行，即预检已通过、
//    马上就要写暂停标记）那一刻从 io.out 里抛一个哨兵错误打断它，再把临时状态文件删掉。
//    从头到尾 pause marker 都没写过（phase 1 的 writeMarker 在那一行打印之后才执行），
//    什么都没暂停过；预检没过时 runTrain 自己停在 phase 0 的 failed，我们照旧删状态。
// 2. preflight 命令前面带一段中文摘要（主线 CI 怎么样、挂了自动合并的 PR 有哪几个、法国在跑几个会话）。
// 3. start 命令在透传 runTrain 之前，用更直白的中文先拦一遍用法错误（sha/tag 互斥、founder-ok 必填）。
//    过了这层照原样进 runTrain：参数、暂停、状态、退出码全一样，行为一字不改。
// 改这里之前必须知道：
// - 和 release-train-lib 一样，这份文件里没有任何真的起进程、连网、睡觉的代码：一切经 io 进来，
//   agents/test/release-onekey.test.ts 换假 ssh、假 gh、假时钟。
// - 打断预检靠的是 release-train-lib 里 runFrom 打出来的固定字样「—— 第 1 步」（PHASES[1]＝「暂停本机」）。
//   它要是改了，这里就拦不住，预检过后会真的写暂停标记——agents/test/release-onekey.test.ts 里
//   有一条盯住「拦截生效、且没写暂停标记」，字样改动会当场红。
// - start/status/abort 全是透传 runTrain：这里不加新行为，不替它把关（它在 founder-ok、restore 授权
//   上各有一道槛；这里先拦只为更早给中文说法，双保险而不是替代）。
// - 退出码照 runTrain：0 做完了；1 用法不对或被拒；2 没做成；3 卡住。preflight 没过回 2
//   （什么都没改，不算卡住，回 2 不回 3）。
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { scrubText } from './france-lib.mjs';
import { runTrain, STATE_REL } from './release-train-lib.mjs';

export const ONEKEY_USAGE = `用法：node release-onekey.mjs <命令>（在项目仓的检出里跑；start 会等很久，用 run_in_background 起）
  preflight [--sha <提交> | --tag vN]
        只读预检，什么都不改：主线 CI 绿不绿、法国读不读得到、有没有别的发布在跑、
        列出挂了自动合并的 PR 和法国在跑的会话数，前面带一段中文摘要。不给 --sha/--tag 就只查环境。
  start --sha <提交> --founder-ok "<创始人原话>" [--restore]
  start --tag vN    --founder-ok "<创始人原话>" [--restore]
        一键发版：暂停手头的活（本机＋法国）→ 等收尾 → 发版 → 验证 → 恢复 → 打印清单。
        和 node release-train.mjs start 是同一条路：参数、暂停、状态、退出码全一样。
  status          看这一趟走到哪、暂停标记在不在（同 release-train.mjs status）
  abort           撤暂停、恢复原状（同 release-train.mjs abort）
退出码：0 做完了；1 用法不对或被拒；2 没做成；3 卡住（到点还有拖后腿的，名单已列出）。`;

const USAGE_HINT = '（node release-onekey.mjs 不带参数看用法）';

/** 参数的面：{cmd, sha?, tag?, founderOk?, restore}，认不出回 {error}。 */
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
    if (arg === '--sha' || arg === '--tag' || arg === '--founder-ok') {
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

/** start/preflight 公用的 sha/tag 面检查：只为更早给出中文说法；runTrain 自己还会再查一遍。 */
function checkTargetFormat(io, p) {
  if (p.sha !== undefined && !/^[0-9a-f]{7,40}$/.test(p.sha)) {
    warn(io, `--sha 要是十六进制的提交号（7–40 位），给的是「${p.sha}」`);
    return 1;
  }
  if (p.tag !== undefined && !/^v\d+$/.test(p.tag)) {
    warn(io, `--tag 要写成 v<数字>（比如 v12），给的是「${p.tag}」`);
    return 1;
  }
  return null;
}

// —— 预检 ——

const SENTINEL_MSG = '__onekey_preflight_done__';
class StopAfterPreflight extends Error {
  constructor() {
    super(SENTINEL_MSG);
  }
}

/**
 * 只读预检：借 runTrain 跑 start，用一只包过的 io.out 在「—— 第 1 步」字样上抛哨兵。
 * runTrain 的最外层 catch 会把哨兵当成一般错误（「没做成：…」回 2）——所以不靠异常穿透判断，
 * 用闭包变量 hit 记「哨兵是不是真的被触发了」。预检没过时 runTrain 自己停在 phase 0 的 failed，
 * 打出的行里含「预检没过」，hit 是 false。两种都删状态文件。
 * 返回 { code, lines }：lines 是摘要 + runTrain 打出来的全部行。
 */
export async function runPreflight(io, target) {
  // 已有一趟在走/卡住/没成的：不碰，拒
  if (existsSync(stateFile(io.home))) {
    return {
      code: 1,
      lines: [
        '已经有一趟发版的记录（在走、卡住或没成）：先看 status，了结它（接着 start 或 abort）再做预检，预检不碰它',
      ],
    };
  }

  const lines = [];
  const errLines = [];
  let hit = false;
  const LEAK_MSG = '__onekey_preflight_leaked__';
  const ioWrapped = {
    ...io,
    out: (t) => {
      const s = String(t);
      if (s.includes('—— 第 1 步')) {
        hit = true;
        throw new StopAfterPreflight();
      }
      // 「—— 第 0 步」是预检本身，放心放过去；「—— 第 2 步」往后只可能是第 1 步的哨兵字样变了没拦住，拦下来由 code 兜成「拦漏了」
      if (/—— 第 [2-9] 步/.test(s)) throw new Error(LEAK_MSG);
      lines.push(s);
    },
    // 哨兵被 runTrain 最外层 catch 吞成「没做成：__onekey_preflight_done__」时走 err：那行是拦出来的噪声，吃掉；
    // 预检真没过时的「第 0 步「预检」没成：…」也是走 err，留着，等下并进输出；拦漏了（leak 哨兵）也吃掉，
    // 由 code 判断走到「拦漏了」那条报错。
    err: (t) => {
      const s = String(t);
      if (s.includes(SENTINEL_MSG) || s.includes(LEAK_MSG)) return;
      errLines.push(s);
    },
    // 预检里 runTrain 只在 phase 3（等收尾）之后才睡；预检过不去到不了那。保险起见还是换成不等。
    sleep: async () => {},
  };
  const trainArgv =
    target.value === null
      ? ['start', '--sha', '0'.repeat(40), '--founder-ok', '（只读预检，到不了发版那一步）']
      : [
          'start',
          target.kind === 'tag' ? '--tag' : '--sha',
          target.value,
          '--founder-ok',
          '（只读预检，到不了发版那一步）',
        ];
  const code = await runTrain(trainArgv, ioWrapped);
  // 预检是只读的：过没过都把临时状态删掉（pause marker 根本没写过，不用碰）
  rmSync(stateFile(io.home), { force: true });

  const summary = await buildSummary(io, target);
  const all = [...summary, ...lines.map((l) => scrubText(l)), ...errLines.map((l) => scrubText(l))];
  if (hit) {
    all.push('预检过了：主线 CI 绿、法国读得到、没有别的发布在跑（暂停、发版什么都没做）');
    return { code: 0, lines: all };
  }
  if (code === 2) return { code: 2, lines: all }; // 「预检没过」那句 runTrain 已打进 errLines；拦漏的哨兵行也在这
  // code 0 且 hit 为假：哨兵字样变了、release-train 一路跑完了。这条命令不能再用，写清楚让盯哨兵的测试红。
  all.push('预检的拦截没生效（哨兵「—— 第 1 步」没在输出里出现）：这条命令不能再用，去改回拦得住');
  return { code: 2, lines: all };
}

/** 摘要段：和 phasePreflight 用的同一批只读接口，把现状说成三行中文。读不到的写「读不到」，不拦预检。 */
async function buildSummary(io, target) {
  const t =
    target.kind === 'tag'
      ? target.value
      : target.value
        ? `提交 ${String(target.value).slice(0, 12)}`
        : '（只说环境，没指定目标）';
  const lines = [`—— 预检摘要（目标 ${t}；只读，什么都没改）——`];
  lines.push(`主线 CI：${await readMainCi(io)}`);
  lines.push(`挂了自动合并的 PR：${await readAutoMergePrs(io)}`);
  const s = await io.runningSessions();
  lines.push(`法国在跑的会话：${s.ok ? `${s.running} 个` : `读不到（${s.kind}）：${s.why}`}`);
  lines.push('—— 下面是 release-train 自己的预检输出 ——');
  return lines;
}

async function readMainCi(io) {
  const r = io.run('gh', [
    'api',
    'repos/{owner}/{repo}/commits/main/check-runs?per_page=100',
    '--jq',
    '[.check_runs[] | select(.name=="check") | {status,conclusion}]',
  ]);
  if (r.error || r.status === null || r.status !== 0) return '读不到';
  try {
    const runs = JSON.parse(String(r.stdout).trim() || '[]');
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
    if (p.tag !== undefined) argv.push('--tag', p.tag);
    argv.push('--founder-ok', p.founderOk);
    if (p.restore) argv.push('--restore');
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
    const hasSha = p.sha !== undefined;
    const hasTag = p.tag !== undefined;
    if (hasSha && hasTag) {
      warn(io, '--sha 和 --tag 只能给一个');
      return 1;
    }
    const bad = checkTargetFormat(io, p);
    if (bad !== null) return bad;
    const target = hasTag
      ? { kind: 'tag', value: p.tag }
      : hasSha
        ? { kind: 'sha', value: p.sha }
        : { kind: 'sha', value: null };
    const r = await runPreflight(io, target);
    for (const line of r.lines) io.out(line);
    return r.code;
  }
  if (p.cmd === 'start') {
    if (p.sha === undefined && p.tag === undefined) {
      warn(
        io,
        '发哪个没说：补 --sha <提交> 或 --tag vN（按提交发版 ssh 到法国跑 release.sh；按标记发走 pnpm publish:pr）',
      );
      return 1;
    }
    if (p.sha !== undefined && p.tag !== undefined) {
      warn(
        io,
        '--sha 和 --tag 只能给一个：按提交发就用 --sha <提交>，按版本标记发就用 --tag vN，两个一起给认不出你想发哪个',
      );
      return 1;
    }
    const bad = checkTargetFormat(io, p);
    if (bad !== null) return bad;
    if (p.founderOk === undefined || p.founderOk.trim() === '') {
      warn(io, '发版是对外发布，必须带 --founder-ok "<创始人原话>"：没带就什么都不做（连暂停都不暂停）');
      return 1;
    }
    say(
      io,
      `一键发版：目标 ${p.tag ?? `提交 ${String(p.sha).slice(0, 12)}`}，先把本机和法国手头的活暂停，收尾后${p.restore ? '发版并按授权恢复' : '发版（法国发完保持关，开不开页面上说了算）'}。下面接入 release-train：`,
    );
    return runTrain(toTrainArgv(p), io);
  }
  // status / abort：透传
  return runTrain(toTrainArgv(p), io);
}
