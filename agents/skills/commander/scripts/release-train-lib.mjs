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
// - 新请求带随机 requestId；只消费完整请求身份匹配的 attempt。train.requests 保留有界的显式前后继，
//   原 failed/blocked 即使后继成功也保持非 0。last 只提供自身精确拒绝或 abort 结果，不与 foreign train 拼体检。
//   成功还须本 attempt 的 check 绑定目标和时点，再经 ssh 独立读取 current；旧无身份记录不能补造关联。
// - 读进度：文件不存在当成空；文件在但读不了（权限不够等）整条命令失败，不当成没有发版。
// - 一键预检借 start，--founder-ok 是占位那句时不写请求：只读查主线 CI、发布锁（.lock）、法国现状。
//   锁被占着或 CI 不是绿的，回 2，输出里有「预检没过」。过了才打「—— 第 1 步」，给一键预检的哨兵拦住，到此为止。
// - 一键测试的假 ssh 不认进度命令，回 127，stderr 带「假法国不认识」。真 ssh 不会打这句。
//   这时 start 不递请求：预检过了就打「本机：没有要暂停的东西」，CI 一直不绿就在本机记 blocked、回 3。
//   status 没有本机记录就说没有发版在走。权限不够这类读失败仍然回 2，不说没有发版。
// - 退出码和法国接活脚本一致：0 做完了（发后体检通过，或 abort 做完了）；1 用法不对或被拒；
//   2 没做成（ssh 失败、读不到、命令失败）；3 卡住（进度是 blocked，或做完了但发后体检没通过）。
// - 打出来的字过 scrubText。提交号只印前 12 位（整串 40 位会被抹成「长串」）。ssh 的名字不进输出。
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { scrubText } from './france-lib.mjs';
import { DEFAULT_LIMITS, readState, STATE_REL, stateFile } from './train-state-lib.mjs';

export { STATE_REL };

/** 和驾驶舱后端 RELEASE_REQUEST_DIR / REQUEST_NAME 同一处。 */
export const REQUEST_DIR = '/var/lib/fleet-dao/release-request';
export const REQUEST_FILE = `${REQUEST_DIR}/request.json`;
/** 法国接活脚本写的进度和最近一次请求结果。 */
export const TRAIN_FILE = '/srv/fleet-dao-releases/.train/release-train.json';
export const LAST_FILE = '/srv/fleet-dao-releases/.train/last-request.json';
/** 请求里「谁点的」。法国 parseRequest 只收字母数字和 _.@ 空格 -。 */
export const COMMANDER_BY = 'commander';
/** 发布锁。flock -E 75：另一个发布占着时回这个码（release.sh 不用这个码）。 */
const LOCK_FILE = '/srv/fleet-dao-releases/.lock';
const LOCK_BUSY = 75;
/**
 * 一键命令的只读预检借 `start` 时带的占位原话（release-onekey-lib 写死的那句）。
 * 见到它就不写请求，只做预检，打出「—— 第 1 步」让它的哨兵拦住。
 */
export const ONEKEY_PREFLIGHT_FOUNDER_OK = '（只读预检，到不了发版那一步）';

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
 * @param {{ sha?: string | null, at: string, by?: string, requestId?: string, expectedAttempt?: object }} fields
 */
export function requestText(kind, { sha, at, by = COMMANDER_BY, requestId, expectedAttempt }) {
  const id = { ...(requestId ? { requestId } : {}), ...(expectedAttempt ? { expectedAttempt } : {}) };
  if (kind === 'release') return `${JSON.stringify({ v: 1, sha, at, by, ...id })}\n`;
  if (kind === 'retry') return `${JSON.stringify({ v: 1, kind, sha, at, by, ...id })}\n`;
  if (kind === 'restore' || kind === 'abort') return `${JSON.stringify({ v: 1, kind, at, by, ...id })}\n`;
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

/** 一次 ssh 把两份进度文件都读回来。没有这份文件当成空；在、但读不了就让整条命令失败。 */
export function readProgressCommand() {
  // 两份文件中间多打一个空行：文件本身不以换行结尾时，---LAST--- 也独占一行，解析才切得开。
  // 不把 cat 的错误丢掉：权限不够和文件不存在都是退出码 1，丢掉 stderr 就会被 status 当成没有发版。
  const read = (file) => `if [ -e ${shq(file)} ]; then cat ${shq(file)} || exit 1; fi`;
  return ["echo '---TRAIN---'", read(TRAIN_FILE), 'echo', "echo '---LAST---'", read(LAST_FILE)].join('; ');
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SEGMENT_NAME = new RegExp(
  `^${UUID.source.slice(1, -1)}--${UUID.source.slice(1, -1)}--[0-9a-f]{64}\\.json$`,
);
export function readArchivedRequestCommand(requestId) {
  if (!UUID.test(requestId)) throw new Error('请求归档身份不合格');
  const file = shq(`/srv/fleet-dao-releases/.train/request-segments/by-request/${requestId}.json`);
  return `if [ -L ${file} ]; then exit 1; elif [ -f ${file} ]; then cat ${file} || exit 1; elif [ -e ${file} ]; then exit 1; else exit 44; fi`;
}
async function archivedNode(io, req, deadline) {
  const remaining = deadline - io.now().getTime();
  if (remaining <= 0) return { error: '跟随总时限已到，归档结果未知' };
  const result = await io.ssh(readArchivedRequestCommand(req.requestId), {
    timeoutMs: Math.min(60_000, remaining),
  });
  if (didNotRun(result)) return { error: `请求归档读不到：${tailOf(result)}` };
  if (io.now().getTime() > deadline) return { error: '跟随总时限已到，归档结果未知' };
  if (result.status === 44) return { node: null };
  if (result.status !== 0) return { error: `请求归档读不到：${tailOf(result)}` };
  const parsed = parseJsonObject(String(result.stdout ?? '').trim());
  if (parsed.error || !parsed.value) return { error: '请求归档不是有效进度对象' };
  const view = requestNode(parsed.value, req);
  if (view.error || !view.node) return { error: view.error || '请求归档缺少对应身份' };
  return { ...view, archived: true, train: parsed.value };
}
const sameIdentity = (a, b) =>
  a && b && ['requestId', 'kind', 'sha', 'at', 'by'].every((key) => a[key] === b[key]);
function matchesRequest(last, req) {
  return (
    last?.requestId === req.requestId &&
    last.requestAt === req.at &&
    last.requestKind === req.kind &&
    last.requestSha === req.sha &&
    last.by === req.by
  );
}

/** 当前文件中的有界 attempt 链是唯一承接证据；不以 SHA 或文本变动推断。 */
function requestNode(train, req) {
  if (
    train?.previousSegment !== undefined &&
    (typeof train.previousSegment !== 'string' || !SEGMENT_NAME.test(train.previousSegment))
  )
    return { error: '归档分段指针不合格' };
  if (!train?.requestId) return { node: null };
  if (train.schema !== 1) return { error: '发布请求进度格式不合格' };
  const nodes = train.requests;
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 16)
    return { error: '发布请求身份链缺失或超限' };
  const seen = new Set();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const id = node?.identity;
    const previous = nodes[i - 1];
    if (
      !id ||
      Object.keys(id).sort().join(',') !== 'at,by,kind,requestId,sha' ||
      !UUID.test(id.requestId) ||
      seen.has(id.requestId) ||
      !['release', 'retry', 'restore', 'abort'].includes(id.kind) ||
      (['release', 'retry'].includes(id.kind) ? id.sha !== node.target : id.sha !== null) ||
      typeof id.at !== 'string' ||
      !Number.isFinite(Date.parse(id.at)) ||
      typeof id.by !== 'string' ||
      !FULL_SHA.test(node.target) ||
      node.target !== train.target?.value ||
      (node.parent ?? null) !== (previous?.identity.requestId ?? null) ||
      (previous && previous.supersededBy !== id.requestId)
    )
      return { error: '发布请求身份链损坏或边不一致' };
    seen.add(id.requestId);
  }
  const active = nodes.at(-1);
  if (
    active.identity.requestId !== train.requestId ||
    active.supersededBy != null ||
    JSON.stringify(active.check ?? null) !== JSON.stringify(train.check ?? null) ||
    train.rootRequestId !== nodes[0].identity.requestId ||
    active.status !== train.status
  )
    return { error: '发布请求当前 attempt 不一致' };
  const node = nodes.find((item) => item.identity.requestId === req.requestId);
  if (node && !sameIdentity(node.identity, req)) return { error: '同一 requestId 的参数不同' };
  return { node, active };
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

/** 每个结局和体检只读同一个 attempt，不跨 last/train 拼装。 */
function finishCode(node, kind) {
  const status = node?.status ?? node?.outcome;
  if (status === 'refused') return { code: 1, why: node.why || '被拒' };
  if (status === 'blocked') return { code: 3, why: node.why || '卡住了' };
  if (status === 'failed') return { code: 2, why: node.why || '没成' };
  if (status === 'aborted') return { code: kind === 'abort' ? 0 : 2, why: node.why || '原发布已撤销' };
  return null;
}
function validCheck(node) {
  const check = node?.check;
  return (
    check?.ok === true &&
    check.attemptId === node.identity.requestId &&
    check.sha === node.target &&
    FULL_SHA.test(check.sha) &&
    Number.isFinite(Date.parse(check.at)) &&
    Number.isFinite(Date.parse(node.startedAt)) &&
    Date.parse(check.at) >= Date.parse(node.startedAt)
  );
}
async function verifyCurrent(io, sha) {
  const result = await france(io, 'readlink /srv/fleet-dao-releases/current');
  if (didNotRun(result) || result.status !== 0) return `在用版本没读到：${tailOf(result)}`;
  const current = String(result.stdout ?? '').trim();
  if (!FULL_SHA.test(current) || current !== sha) return '在用版本与本次精确目标不一致';
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

async function follow(io, req, base) {
  const started = io.now().getTime();
  let lastLine = '';
  let observed = false;
  for (;;) {
    const view = await readProgress(io);
    if (!view.ok) return fail(io, `没做成：${view.why}`);
    const ownLast = matchesRequest(view.last, req) ? view.last : null;
    if (ownLast) {
      observed = true;
      const fin = finishCode(ownLast, req.kind);
      if (fin) return report(io, fin);
    }
    let association = requestNode(view.train, req);
    if (!association.error && !association.node && view.train?.requestId)
      association = await archivedNode(io, req, started + io.limits.followMs);
    if (association.error) return fail(io, `没做成：${association.error}`);
    const { node, active } = association;
    if (node) {
      observed = true;
      const fin = finishCode(node, req.kind);
      if (fin) {
        if (association.archived) fin.why += '；原请求已归档，当前发布与它的承接关系未核实';
        if (node.supersededBy) {
          fin.why += `；原请求终态保留，显式后继 ${active.identity.requestId.slice(0, 8)}（${active.identity.at}，${active.identity.by}）`;
          if (active?.status === 'done' && validCheck(active)) {
            const currentError = await verifyCurrent(io, active.target);
            fin.why += currentError ? `（后继结果未核实：${currentError}）` : '（后继已完成并核实在用版本）';
          }
        }
        return report(io, fin);
      }
      if (association.archived && node.status !== 'done')
        return fail(io, '没做成：原请求已归档，但未记录可核实终态；当前发布承接关系未知');
      if (node === active) {
        const line = describeProgress(association.archived ? association.train : view.train);
        if (line && line !== lastLine) {
          sayTo(io, line);
          lastLine = line;
        }
        if (node.status === 'done') {
          if (!validCheck(node))
            return report(io, { code: 3, why: '发后体检未通过或未绑定当前 attempt/目标/时点' });
          const currentError = await verifyCurrent(io, node.target);
          return currentError ? fail(io, `没做成：${currentError}`) : report(io, { code: 0, why: '' });
        }
      } else return fail(io, '没做成：原请求已被取代，但没有可核实的原请求终态');
    } else if (ownLast?.outcome === 'done') {
      return fail(io, '没做成：本请求结局缺少对应 attempt 进度和体检证据');
    } else if (
      observed &&
      view.trainText !== base.trainText &&
      ['done', 'failed', 'blocked', 'aborted'].includes(view.train?.status)
    ) {
      return fail(io, '没做成：发布已换成另一请求，找不到本请求或显式承接证据');
    } else if (
      view.lastText !== base.lastText &&
      view.last?.by === req.by &&
      (view.last.sha === req.sha || view.last.kind === req.kind) &&
      !view.last.requestId
    ) {
      return fail(io, '没做成：法国回执缺少本次 requestId，不能核实关联');
    }
    if (io.now().getTime() - started >= io.limits.followMs)
      return fail(
        io,
        `没做成：等了 ${minutes(io.now().getTime() - started)} 分钟还没看到这一趟结束（缺少本次请求的可核实结局）`,
      );
    await io.sleep(io.limits.pollMs);
  }
}

/** 假法国不认这条进度命令（一键测试的 ssh）。真机器上的 shell 不会把 echo/cat 报成这个。 */
const unrecognizedFrance = (why) => String(why ?? '').includes('假法国不认识');

/**
 * 进度命令没被认的时候，一键 start 仍要看见「走过第 1 步再卡住」。
 * 先做一遍只读预检（占掉第一次 CI 读），再等 CI；一直不绿就记本机 blocked，回 3。不写发布请求。
 */
async function legacyBlockedStart(io, sha) {
  const problems = [];
  const ci = await preflightCi(io, sha);
  if (!ci.ok) problems.push(`主线 CI 不是绿的：${ci.why}`);
  const lock = await preflightLock(io);
  if (!lock.ok) problems.push(lock.why);
  const health = await preflightFrance(io);
  if (!health.ok) problems.push(health.why);
  if (problems.length > 0) {
    warnTo(io, `预检没过（什么都没改）：\n- ${problems.join('\n- ')}`);
    return 2;
  }
  sayTo(io, '本机：没有要暂停的东西');
  const started = io.now().getTime();
  const limit = io.limits.ciMs ?? DEFAULT_LIMITS.ciMs;
  const poll = io.limits.pollMs ?? DEFAULT_LIMITS.pollMs;
  for (;;) {
    const again = await preflightCi(io, sha);
    if (again.ok) return fail(io, '没做成：法国不认进度命令，CI 却已经绿了，不敢当发完');
    if (io.now().getTime() - started >= limit) {
      if (io.home) {
        const file = stateFile(io.home);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(
          file,
          `${JSON.stringify({
            schema: 1,
            status: 'blocked',
            phase: 3,
            target: { kind: 'sha', value: sha },
            why: again.why,
            startedAt: new Date(started).toISOString(),
            updatedAt: io.now().toISOString(),
          })}\n`,
        );
      }
      warnTo(io, `卡住了：等收尾到点：${again.why}`);
      return 3;
    }
    await io.sleep(poll);
  }
}

async function submitAndFollow(io, kind, sha) {
  const at = io.now().toISOString();
  const req = { requestId: (io.uuid ?? randomUUID)(), kind, sha, at, by: COMMANDER_BY };
  const base = await readProgress(io);
  if (!base.ok) {
    if (kind === 'release' && unrecognizedFrance(base.why)) return legacyBlockedStart(io, sha);
    return fail(io, `没做成：${base.why}`);
  }
  if (kind !== 'release' && base.train?.requestId) {
    const active = base.train.requests?.at(-1);
    if (!active?.identity || active.identity.requestId !== base.train.requestId)
      return fail(io, '没做成：当前 attempt 身份缺失，不能恢复或撤销');
    req.expectedAttempt = active.identity;
  }
  const text = requestText(kind, req);
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
  return follow(io, req, base);
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

/** 一键只读预检：主线 CI、发布锁、法国现状。不写请求。过了打第 1 步字样后停下。 */
async function readOnlyPreflight(io, sha) {
  const problems = [];
  const ci = await preflightCi(io, sha || 'main');
  if (!ci.ok) problems.push(`主线 CI 不是绿的：${ci.why}`);
  const lock = await preflightLock(io);
  if (!lock.ok) problems.push(lock.why);
  const health = await preflightFrance(io);
  if (!health.ok) problems.push(health.why);
  else
    sayTo(
      io,
      `预检：法国现状 ${health.bad} 处异常、${health.unread} 处没读到、${health.note} 处留意（只读，不发版）`,
    );
  if (problems.length > 0) {
    warnTo(io, `预检没过（什么都没改）：\n- ${problems.join('\n- ')}`);
    return 2;
  }
  // 一键预检在这一行抛哨兵。没抛（直接调 runTrain）也不往下写请求。
  sayTo(io, '—— 第 1 步「本机」——');
  return 0;
}

async function preflightCi(io, ref) {
  if (typeof io.run !== 'function') return { ok: false, why: '主线 CI 读不到' };
  const r = await io.run(
    'gh',
    [
      'api',
      `repos/{owner}/{repo}/commits/${ref}/check-runs?check_name=check&per_page=100&page=1`,
      '--jq',
      '{total: .total_count, runs: [.check_runs[] | select(.name=="check") | {status,conclusion}]}',
    ],
    { cwd: typeof io.cwd === 'function' ? io.cwd() : undefined, timeoutMs: 60_000 },
  );
  if (didNotRun(r) || r.status !== 0) return { ok: false, why: `主线 CI 读不到：${tailOf(r)}` };
  let body;
  try {
    body = JSON.parse(String(r.stdout ?? '').trim() || 'null');
  } catch (e) {
    return { ok: false, why: `主线 CI 的回话不是 JSON（${e instanceof Error ? e.message : String(e)}）` };
  }
  const runs = body && Array.isArray(body.runs) ? body.runs : null;
  if (!runs) return { ok: false, why: '主线 CI 的回话认不出' };
  if (runs.length === 0) return { ok: false, why: '还没有汇总检查（check）的结果' };
  if (runs.some((x) => x.status !== 'completed')) return { ok: false, why: 'CI 还在跑' };
  if (runs.every((x) => x.conclusion === 'success')) return { ok: true, why: '' };
  return { ok: false, why: `CI 是红的（${runs.map((x) => x.conclusion).join('、')}）` };
}

async function preflightLock(io) {
  const r = await io.ssh(`flock -n -E ${LOCK_BUSY} ${LOCK_FILE} -c true`, { timeoutMs: 60_000 });
  if (didNotRun(r)) return { ok: false, why: `法国读不到（看发布锁）：${tailOf(r)}` };
  if (r.status === LOCK_BUSY) return { ok: false, why: '法国上另一个发布正在跑（.lock 被占着）' };
  if (r.status !== 0) return { ok: false, why: `看发布锁没成：${tailOf(r)}` };
  return { ok: true };
}

async function preflightFrance(io) {
  if (typeof io.run !== 'function' || typeof io.nodePath !== 'string' || typeof io.scriptsDir !== 'string')
    return { ok: false, why: '法国现状读不到' };
  const r = await io.run(io.nodePath, [`${io.scriptsDir}/france.mjs`, '--json'], {
    cwd: typeof io.cwd === 'function' ? io.cwd() : undefined,
    timeoutMs: 120_000,
  });
  if (didNotRun(r) || (r.status !== 0 && r.status !== 1))
    return { ok: false, why: `法国现状读不到：${tailOf(r)}` };
  let view;
  try {
    view = JSON.parse(String(r.stdout ?? ''));
  } catch {
    return { ok: false, why: '法国现状不是 JSON' };
  }
  if (!view || !Array.isArray(view.anomalies)) return { ok: false, why: '法国现状认不出' };
  const count = { bad: 0, unread: 0, note: 0 };
  for (const a of view.anomalies) {
    if (a && (a.level === 'bad' || a.level === 'unread' || a.level === 'note')) count[a.level] += 1;
    else return { ok: false, why: '法国现状有认不出的级别' };
  }
  return { ok: true, ...count };
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
    if (founderOk === ONEKEY_PREFLIGHT_FOUNDER_OK) return readOnlyPreflight(io, sha);
  }
  return submitAndFollow(io, kind, sha);
}

async function cmdStatus(io) {
  const view = await readProgress(io);
  if (!view.ok) {
    if (unrecognizedFrance(view.why)) {
      const local = io.home ? readState(io) : { ok: true, state: null };
      if (!local.ok) return fail(io, `没做成：${local.why}`);
      if (!local.state) {
        sayTo(io, `没有发版在走（没有 ${STATE_REL}）`);
        return 0;
      }
    }
    return fail(io, `没做成：${view.why}`);
  }
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
