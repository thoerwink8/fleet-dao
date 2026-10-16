// 发版一条龙的命令行薄壳（#2025 拆出来的这一片）：九步只留在法国
// deploy/france/release-request/lib.mjs。这里经 io.ssh 往法国写一份和驾驶舱后端
// （packages/api/src/release-request.ts 的 requestText / recoverRequestText）同格式的请求，
// 再读 /srv/fleet-dao-releases/.train/release-train.json 和 last-request.json，把进度打出来，直到这一趟结束。
// release-train.mjs 是外壳（真的 ssh、睡眠）。这份文件里没有真的起进程、连网、睡觉：一切经 io，
// agents/test/release-train.test.ts 换成假 ssh、假时钟。
// 改这里之前必须知道：
// - 请求文件归法国上的接活单元（fleet-release-request.path 盯着 request.json）。键和样子跟驾驶舱后端一致，
//   法国 parseRequest 才认：发布不带 kind（缺省就是 release），retry 带提交号，restore / abort 不带。
//   by 固定写 commander。先写临时文件再 ln 到 request.json，已经有一份就失败，不盖掉。
// - 进度以法国那两份文件为准，不在本机记一趟。上一份还在文件里时，要看到 last-request.json 变了、
//   而且对得上这一次的种类和提交，才算这一趟；release-train.json 也得变过，才信里面的状态
//   （刚写上 accepted、进度文件还是上一趟时，不把上一趟的「做完了」当成这次的）。
// - 退出码和法国接活脚本一致：0 做完了（发后体检通过，或 abort 做完了）；1 用法不对或被拒；
//   2 没做成（ssh 失败、读不到、命令失败）；3 卡住（进度是 blocked，或做完了但发后体检没通过）。
// - 打出来的字过 scrubText。提交号只印前 12 位（整串 40 位会被抹成「长串」）。ssh 的名字不进输出。
import { scrubText } from './france-lib.mjs';

export { STATE_REL } from './train-state-lib.mjs';

/** 和驾驶舱后端 RELEASE_REQUEST_DIR / REQUEST_NAME 同一处。 */
export const REQUEST_DIR = '/var/lib/fleet-dao/release-request';
export const REQUEST_FILE = `${REQUEST_DIR}/request.json`;
/** 法国接活脚本写的进度和最近一次请求结果。 */
export const TRAIN_FILE = '/srv/fleet-dao-releases/.train/release-train.json';
export const LAST_FILE = '/srv/fleet-dao-releases/.train/last-request.json';
/** 请求里「谁点的」。法国 parseRequest 只收字母数字和 _.@ 空格 -。 */
export const COMMANDER_BY = 'commander';

/**
 * 法国接活脚本的九步名字（deploy/france/release-request/lib.mjs 的 PHASES）。
 * 进度文件里的 phase 是下标，印出来用这套名字。
 */
const FRANCE_PHASES = ['预检', '暂停本机', '暂停法国', '等收尾', '发版', '等部署', '验证', '恢复', '派清单'];

/** 跟着法国进度的上限：接活脚本各步加起来约 69 分钟，这里留余量。测试里换小。 */
const FOLLOW_MS = 75 * 60_000;
const POLL_MS = 30_000;

export const USAGE = `用法：node release-train.mjs <命令>（在项目仓的检出里跑；发版会等很久，用 run_in_background 起）
  start --sha <40位提交> --founder-ok "<创始人原话>"
        经 ssh 在法国写一份和驾驶舱后端同格式的发布请求（kind 为 release，by 写 commander），
        再读 ${TRAIN_FILE} 和 last-request.json，打印进度直到结束。九步在法国接活脚本里跑。
        --founder-ok：发版是对外发布，必须带创始人原话，没带就拒（什么都不做；原话不写进请求文件，请求里没有这一栏）
  retry --sha <40位提交>
        同样递一份请求，kind 为 retry（从卡住的那一趟接着走）
  restore
        同样递一份请求，kind 为 restore（恢复引擎开关）
  abort
        同样递一份请求，kind 为 abort（撤掉暂停）
  status          读一次法国上的进度，不等
退出码：0 做完了；1 用法不对或被拒；2 没做成（ssh 失败、读不到、命令失败）；3 卡住（到点还有拖后腿的，或发完了但发后体检没通过）。`;

class UsageError extends Error {}

const sayTo = (io, text) => io.out(scrubText(text));
const warnTo = (io, text) => io.err(scrubText(text));
const minutes = (ms) => Math.round(ms / 60_000);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const tailOf = (r) =>
  scrubText(
    String(r.stderr || r.stdout || r.error || `退出码 ${r.status}`)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-3)
      .join(' / '),
  );
/** ssh 没跑成：起不来、被超时杀、连不上。 */
const didNotRun = (r) => !r || r.error || r.status === null || r.status === 255;

const fail = (io, why) => {
  warnTo(io, why);
  return 2;
};

/**
 * 请求文件的正文。键的先后和驾驶舱后端一致：发布不带 kind（法国按缺省认成 release）；
 * retry 带提交号；restore、abort 不带。末尾一个换行，同 requestText / recoverRequestText。
 * @param {'release' | 'retry' | 'restore' | 'abort'} kind
 * @param {{ sha?: string | null, at: string, by?: string }} fields
 */
export function requestText(kind, { sha, at, by = COMMANDER_BY }) {
  if (kind === 'release') return `${JSON.stringify({ v: 1, sha, at, by })}\n`;
  if (kind === 'retry') return `${JSON.stringify({ v: 1, kind, sha, at, by })}\n`;
  if (kind === 'restore' || kind === 'abort') return `${JSON.stringify({ v: 1, kind, at, by })}\n`;
  throw new Error(`不认识的请求种类：${kind}`);
}

/** 在法国写请求：先独占创建临时文件，再 ln 成 request.json（已有就失败，不盖），最后删掉临时文件。 */
export function writeRequestCommand(text) {
  return [
    `d=${shq(REQUEST_DIR)}`,
    'tmp="$d/.request.$$.tmp"',
    'umask 077',
    `printf %s ${shq(text)} > "$tmp" || exit 1`,
    `ln "$tmp" ${shq(REQUEST_FILE)}`,
    'rc=$?',
    'rm -f "$tmp"',
    'exit $rc',
  ].join('; ');
}

/** 一次 ssh 把两份进度文件都读回来。缺文件当成空，不当成失败。 */
export function readProgressCommand() {
  // 两份文件中间多打一个空行：文件本身不以换行结尾时，---LAST--- 也独占一行，解析才切得开。
  return [
    "echo '---TRAIN---'",
    `cat ${shq(TRAIN_FILE)} 2>/dev/null || true`,
    'echo',
    "echo '---LAST---'",
    `cat ${shq(LAST_FILE)} 2>/dev/null || true`,
  ].join('; ');
}

function parseJsonObject(text) {
  if (text === '') return { value: null };
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: '不是一个对象' };
    return { value };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * readProgressCommand 的回话 → { ok: true, train, last, trainText, lastText } 或 { ok: false, why }。
 * 文件空着是 null，不是失败；认不出的 JSON 是失败（不拿空顶）。
 */
export function parseProgressReply(stdout) {
  const text = String(stdout ?? '').replace(/\r\n/g, '\n');
  const m = /---TRAIN---\n([\s\S]*?)\n---LAST---\n([\s\S]*)$/.exec(text);
  if (!m) return { ok: false, why: '法国进度回话认不出（缺 ---TRAIN--- / ---LAST---）' };
  const trainText = m[1].trim();
  const lastText = m[2].trim();
  const train = parseJsonObject(trainText);
  const last = parseJsonObject(lastText);
  if (train.error) return { ok: false, why: `进度记录不是 JSON（${train.error}）` };
  if (last.error) return { ok: false, why: `最近一次请求不是 JSON（${last.error}）` };
  return { ok: true, train: train.value, last: last.value, trainText, lastText };
}

const france = (io, command) => io.ssh(command, { timeoutMs: 60_000 });

async function readProgress(io) {
  const r = await france(io, readProgressCommand());
  if (didNotRun(r)) return { ok: false, why: `ssh 没连上：${tailOf(r)}` };
  if (r.status !== 0) return { ok: false, why: `进度没读到：${tailOf(r)}` };
  return parseProgressReply(r.stdout);
}

/** 这份 last-request 是不是我们刚递的这一次。发布请求法国不写 kind。 */
function matchesRequest(last, kind, sha) {
  if (!last || typeof last !== 'object') return false;
  if (last.by !== COMMANDER_BY) return false;
  if (kind === 'restore' || kind === 'abort') return last.kind === kind;
  if (typeof last.sha !== 'string' || last.sha !== sha) return false;
  if (kind === 'retry') return last.kind === 'retry';
  return last.kind === undefined || last.kind === 'release';
}

const STATUS_WORD = {
  running: '在走',
  blocked: '卡住了',
  failed: '没成',
  done: '做完了',
  aborted: '已撤销',
};

function describeProgress(train) {
  if (!train || typeof train !== 'object' || !Number.isInteger(train.phase)) return null;
  const name = FRANCE_PHASES[train.phase] ?? '?';
  const word = STATUS_WORD[train.status] ?? String(train.status ?? '?');
  const bits = [`进度：第 ${train.phase} 步「${name}」，${word}`];
  if (typeof train.waiting === 'string' && train.waiting !== '') bits.push(`在等：${train.waiting}`);
  if (
    typeof train.why === 'string' &&
    train.why !== '' &&
    train.status !== 'running' &&
    train.status !== 'done'
  )
    bits.push(train.why);
  return bits.join('，');
}

/** 这一趟见到结局了就回退出码；还在走回 null。体检没过算卡住（退出码 3，同法国 EXIT.blocked）。 */
function finishCode(train, last) {
  const outcome = last?.outcome;
  if (outcome === 'refused') return { code: 1, why: last.why || '被拒' };
  const status = train?.status;
  if (status === 'blocked' || outcome === 'blocked')
    return { code: 3, why: train?.why || last?.why || '卡住了' };
  if (status === 'failed' || outcome === 'failed') return { code: 2, why: train?.why || last?.why || '没成' };
  if (status === 'aborted' || outcome === 'aborted')
    return { code: 0, why: train?.why || last?.why || '已撤销' };
  if (status === 'done' || outcome === 'done') {
    const check = train?.check ?? last?.check;
    if (check?.ok === true) return { code: 0, why: '' };
    const bad = Array.isArray(check?.items)
      ? check.items.filter((x) => x && x.ok === false && x.name).map((x) => x.name)
      : [];
    return { code: 3, why: bad.length > 0 ? `发后体检没通过：${bad.join('、')}` : '发后体检没通过' };
  }
  return null;
}

function report(io, fin) {
  if (fin.code === 0) {
    sayTo(io, fin.why ? `这一趟做完了：${fin.why}` : '这一趟做完了，发后体检通过。');
    return 0;
  }
  if (fin.code === 3) {
    warnTo(io, `卡住了：${fin.why}`);
    return 3;
  }
  if (fin.code === 1) {
    warnTo(io, `被拒：${fin.why}`);
    return 1;
  }
  warnTo(io, `没成：${fin.why}`);
  return 2;
}

async function follow(io, kind, sha, base) {
  const started = io.now().getTime();
  let lastLine = '';
  for (;;) {
    const view = await readProgress(io);
    if (!view.ok) return fail(io, `没做成：${view.why}`);
    const lastChanged = view.lastText !== base.lastText;
    const trainChanged = view.trainText !== base.trainText;
    if (lastChanged && matchesRequest(view.last, kind, sha)) {
      if (view.last.outcome === 'refused') return report(io, { code: 1, why: view.last.why || '被拒' });
      // 进度文件还是上一趟的：先不信。等法国把这一趟写进去。
      if (trainChanged) {
        const line = describeProgress(view.train);
        if (line && line !== lastLine) {
          sayTo(io, line);
          lastLine = line;
        }
        const fin = finishCode(view.train, view.last);
        if (fin) return report(io, fin);
      }
    }
    if (io.now().getTime() - started >= io.limits.followMs)
      return fail(io, `没做成：等了 ${minutes(io.now().getTime() - started)} 分钟还没看到这一趟结束`);
    await io.sleep(io.limits.pollMs);
  }
}

async function submitAndFollow(io, kind, sha) {
  const at = io.now().toISOString();
  const text = requestText(kind, { sha, at, by: COMMANDER_BY });
  const base = await readProgress(io);
  if (!base.ok) return fail(io, `没做成：${base.why}`);
  const short = sha ? sha.slice(0, 12) : '';
  sayTo(io, `递请求：kind ${kind}${short ? `，提交 ${short}` : ''}，by ${COMMANDER_BY}`);
  const wr = await france(io, writeRequestCommand(text));
  if (didNotRun(wr)) return fail(io, `没做成：请求没写到法国：${tailOf(wr)}`);
  if (wr.status !== 0) {
    const why = tailOf(wr);
    if (/File exists|already exists/i.test(`${wr.stderr ?? ''}\n${wr.stdout ?? ''}`)) {
      warnTo(io, '被拒：上一份发布请求还没被法国接走，等它接了再递');
      return 1;
    }
    return fail(io, `没做成：请求没写到法国：${why}`);
  }
  sayTo(io, `已写到法国 ${REQUEST_FILE}，跟着进度`);
  return follow(io, kind, sha, base);
}

function parseArgs(argv, valueOptions, flagNames = []) {
  const options = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new UsageError(`多出来的参数「${arg}」\n${USAGE}`);
    const name = arg.slice(2);
    if (flagNames.includes(name)) flags.add(name);
    else if (valueOptions.includes(name)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`--${name} 后面要跟值`);
      if (options.has(name)) throw new UsageError(`--${name} 只能给一次`);
      options.set(name, v);
      i++;
    } else throw new UsageError(`不认识的参数 --${name}\n${USAGE}`);
  }
  return { options, flags };
}

async function cmdSubmit(p, io, kind) {
  let sha = null;
  if (kind === 'release' || kind === 'retry') {
    sha = p.options.get('sha');
    if (sha === undefined) throw new UsageError('要给 --sha <提交>（完整 40 位小写十六进制）');
    if (!/^[0-9a-f]{40}$/.test(sha))
      throw new UsageError(`--sha 要是完整的 40 位小写十六进制，给的是「${scrubText(sha)}」`);
  }
  if (kind === 'release') {
    const founderOk = p.options.get('founder-ok');
    if (founderOk === undefined || founderOk.trim() === '') {
      warnTo(io, '发版是对外发布，必须带 --founder-ok "<创始人原话>"：没带，什么都没做');
      return 1;
    }
  }
  return submitAndFollow(io, kind, sha);
}

async function cmdStatus(io) {
  const view = await readProgress(io);
  if (!view.ok) return fail(io, `没做成：${view.why}`);
  if (!view.train && !view.last) {
    sayTo(io, '没有发版在走');
    return 0;
  }
  const line = describeProgress(view.train);
  if (line) sayTo(io, line);
  else sayTo(io, '进度记录还没有这一趟的步数');
  if (view.last?.outcome)
    sayTo(io, `最近一次请求：${view.last.outcome}${view.last.why ? `，${view.last.why}` : ''}`);
  return 0;
}

/**
 * 入口。io = {
 *   now(), sleep(ms), out(text), err(text),
 *   limits（可省：followMs、pollMs）,
 *   ssh(remoteCommand, {timeoutMs}) → {status, stdout, stderr, error} 或 Promise。
 * }。返回退出码。
 */
export async function runTrain(argv, io) {
  io = { ...io, limits: { followMs: FOLLOW_MS, pollMs: POLL_MS, ...(io.limits ?? {}) } };
  try {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      io.out(USAGE);
      return argv.length === 0 ? 1 : 0;
    }
    const [cmd, ...rest] = argv;
    if (cmd === 'start') return await cmdSubmit(parseArgs(rest, ['sha', 'founder-ok']), io, 'release');
    if (cmd === 'retry') return await cmdSubmit(parseArgs(rest, ['sha']), io, 'retry');
    if (cmd === 'restore') return await cmdSubmit(parseArgs(rest, []), io, 'restore');
    if (cmd === 'abort') return await cmdSubmit(parseArgs(rest, []), io, 'abort');
    if (cmd === 'status') {
      parseArgs(rest, []);
      return await cmdStatus(io);
    }
    throw new UsageError(`没有「${cmd}」这个命令\n${USAGE}`);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      return 1;
    }
    return fail(io, `没做成：${e instanceof Error ? e.message : String(e)}`);
  }
}
