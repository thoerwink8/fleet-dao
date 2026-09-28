// 帅位记「现在是谁」（#446，specs/446-帅位认领简化/需求.md）：本机的帅位、工人经 ssh 调法国的 fleet-api seat / claim。
// seat.mjs、claim.mjs 是外壳。
// 改这里之前必须知道：
// - 真相在法国的库里（每张单一个认领、每个座位一个帅位）。本机的 ~/.fleet-dao/seat/ 只是本地缓存「我是谁、第几任」，
//   免得每条命令都要重新给 --machine --session；不是锁，#446 起没有续约、没有现查，不因为放久了就失效。
// - 没有登法国的钥匙（~/.fleet-dao/france-ssh 不在）、ssh 连不上、回的东西认不出，一律「没查成」（退出码 2），不当成没事。
// - 单上的「在做」评论只是库的镜子（doing-lib.mjs）：库里成了才改它；改不成照实报，库里那份算数。演练座位不改镜子。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { machineProblem, resolveMachine, runDoing } from './doing-lib.mjs';
import { readTarget, scrubText } from './france-lib.mjs';

/** 法国上的管理命令（ops 第九节「帅位和认领」）：以 root 经 ssh 调。 */
export const FLEET_API = 'bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api';
const SCOPE = /^(main|drill:[\p{L}\p{N}_.-]{1,32})$/u;
const SESSION = /^[\p{L}\p{N}_.:-]{1,64}$/u;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_NOTE = 500;

export const SEAT_USAGE = `用法：node seat.mjs <命令> …（经 ssh 调法国的 fleet-api seat；法国的 ssh 主机名写在 ~/.fleet-dao/france-ssh）
  take --session <会话号> [--scope main|drill:<名字>] [--machine <机器名>]   接班（永远成功，后说的算；不是锁）
  show [--scope …]                                                          看现状：现在是谁、最后活动多久前、在做的认领、引擎在跑的单
  handoff --session <会话号> [--scope …]                                    存交接说明（从标准输入读；座位上没人时存不进）
机器名不给就用 doing.mjs 记的那个。handoff 是身份判断，--session 必须带、不猜：这台上可能不止一个会话
take 过（真出过事：一个会话没带 --session，把这台上另一个会话的帅位记录当成了自己的，以为自己是帅位）。
退出码：0 好了；1 用法不对（含没带 --session）；2 没查成、没做成。`;

export const CLAIM_USAGE = `用法：node claim.mjs <命令> …（经 ssh 调法国的 fleet-api claim；在项目仓的检出里跑，别处加 --repo <owner/仓名>）
  take <单号> --label <工人名> --session <会话号> [--owner worker|seat] [--note "<一句话>"] [--branch <分支>] [--scope …]
                     认领一张单（派给工人或自己做）；别人还活着拿着的拒绝（3），要抢用 reassign
  step <单号> --claim <认领号> [--note "<一句话>"] [--pr <PR 号>]   工人报一步、登记 PR（纯记录）
  done <单号> --claim <认领号> --note "<一句话>"                      做完了
  release <单号> --claim <认领号> --note "<一句话>"                   放下（不做了、交出去）
  show [<单号>…] [--all]                                              看认领
  reassign <单号> --to worker|seat --label <工人名> --session <会话号> [--note "<一句话>"] [--founder "<有的话>"]
  reassign <单号> --to engine --reason "<为什么>" --session <会话号> [--founder "<有的话>"]
                     改派：原来的还活着（引擎、别的工人）当场作废、换给这次的、叫停引擎（#446 起不用创始人原话，写 --note 记一句为什么）
take、reassign 都是身份判断，--session 必须带、不猜是这台唯一的一份（同一个道理，见 seat.mjs 的用法）。
退出码：0 好了；1 用法不对（含没带 --session）；2 没查成、没做成；3 不是你的（别人拿着、认领号对不上）。`;

class UsageError extends Error {}

/** 法国、ssh 回的话取第一行，抹掉像 IP、令牌、邮箱的（和「法国引擎」页同一个抹法）。 */
const firstLine = (text) =>
  scrubText(
    String(text ?? '')
      .trim()
      .split('\n')[0] ?? '',
  );

// —— 法国 ——

/**
 * 登法国的 ssh 名字：和「法国引擎」页（france-lib.mjs）同一个放法——环境变量 FLEET_FRANCE_SSH，其次 ~/.fleet-dao/france-ssh
 * 里第一行不以 # 开头的。没有就是这台没有登法国的钥匙（手机、网页会话）。原因里不带名字本身（可能写的是 IP）。
 */
export function franceHost(io) {
  const t = readTarget({ env: io.env, home: io.home, readText: (file) => readFileSync(file, 'utf8') });
  if (t.ok) return t;
  return { ok: false, why: t.kind === 'not-configured' ? `这台没有登法国的钥匙：${t.why}` : t.why };
}

/** 给远端 shell 的一个参数：单引号包起来，里面的单引号拆开转义。 */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * 经 ssh 调一次法国的 fleet-api。json 为真时带 --json、认标准输出最后一行 JSON。
 * 回 { kind: 'done', code, json, text }（code 是法国那边的退出码：0 好了、3 不是你的、1 没做成、2 参数不对），
 * 或 { kind: 'unreachable' | 'garbled', why }：没连上、回的东西认不出。
 */
export function callFrance(io, host, argv, options = {}) {
  const json = options.json !== false;
  const command = [FLEET_API, ...[...argv, ...(json ? ['--json'] : [])].map(shellQuote)].join(' ');
  const r = io.ssh(
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'Compression=yes',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ServerAliveInterval=10',
      '-o',
      'ServerAliveCountMax=3',
      host,
      command,
    ],
    options.input,
  );
  if (r.error) return { kind: 'unreachable', why: `ssh 没跑起来（${r.error}）` };
  if (r.status === 255)
    return { kind: 'unreachable', why: `ssh 连不上法国：${firstLine(r.stderr) || '没说原因'}` };
  if (![0, 1, 2, 3].includes(r.status))
    return {
      kind: 'garbled',
      why: `法国上的 fleet-api 退出码 ${r.status}（不是它会给的）：${firstLine(r.stderr || r.stdout) || '没有输出'}`,
    };
  if (!json) return { kind: 'done', code: r.status, json: null, text: String(r.stdout ?? '').trimEnd() };
  const last =
    String(r.stdout ?? '')
      .trim()
      .split('\n')
      .at(-1) ?? '';
  let parsed;
  try {
    parsed = JSON.parse(last);
  } catch {
    return { kind: 'garbled', why: `法国回的不是一行 JSON：${last.slice(0, 120) || '（空的）'}` };
  }
  if (parsed === null || typeof parsed !== 'object')
    return { kind: 'garbled', why: `法国回的 JSON 不是一个对象：${last.slice(0, 120)}` };
  return { kind: 'done', code: r.status, json: parsed, text: '' };
}

// —— 本机的帅位记录（~/.fleet-dao/seat/）——

const stateDir = (home) => join(home, '.fleet-dao', 'seat');
const stateFile = (home, scope, session) =>
  join(stateDir(home), `${encodeURIComponent(`${scope}__${session}`)}.json`);

function stateProblem(s) {
  if (!s || typeof s !== 'object') return '不是一个对象';
  if (typeof s.scope !== 'string' || !SCOPE.test(s.scope)) return 'scope 认不出';
  if (typeof s.machine !== 'string' || machineProblem(s.machine)) return 'machine 认不出';
  if (typeof s.session !== 'string' || !SESSION.test(s.session)) return 'session 认不出';
  if (!Number.isInteger(s.term) || s.term < 1) return 'term 认不出';
  if (!Number.isFinite(Date.parse(s.takenAt))) return 'takenAt 认不出';
  return null;
}

/**
 * 这台机器上这个座位的帅位记录：scope 必给。认不出的明说，不当成没有。
 * session 不给时按「这个座位只有一份」猜——只给 p.mjs 报进度这类非身份判断的场景用；
 * 身份判断（seat handoff、claim take/reassign、p.mjs handoff）一律要求调用方带 --session、
 * 不许猜：这台可能不止一个会话 take 过，「只有一份」不代表那一份就是问的这个会话（真出过事：
 * 会话 A 没带 --session 去查，机器上只有会话 B 的记录，A 被当成了 B）。
 */
export function pickState(home, scope, session) {
  let names;
  try {
    names = readdirSync(stateDir(home)).filter((n) => n.endsWith('.json'));
  } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, why: `${stateDir(home)} 读不了（${e.code ?? e.message}）` };
    names = [];
  }
  const found = [];
  for (const name of names) {
    const file = join(stateDir(home), name);
    let s;
    try {
      s = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      return { ok: false, why: `帅位记录 ${file} 认不出（${e.message}）：删掉它、重新接班` };
    }
    const why = stateProblem(s);
    if (why) return { ok: false, why: `帅位记录 ${file} 认不出（${why}）：删掉它、重新接班` };
    if (s.scope === scope && (session === undefined || s.session === session)) found.push({ file, state: s });
  }
  if (found.length === 0)
    return {
      ok: false,
      why: `这台没有 ${scope}${session ? ` 会话 ${session}` : ''} 的帅位记录：先 node seat.mjs take 接班`,
    };
  if (found.length > 1)
    return {
      ok: false,
      why: `这台有好几份 ${scope} 的帅位记录（会话 ${found.map((f) => f.state.session).join('、')}）：带 --session 说是哪个`,
    };
  return { ok: true, ...found[0] };
}

function saveState(home, state) {
  mkdirSync(stateDir(home), { recursive: true });
  const file = stateFile(home, state.scope, state.session);
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  return file;
}

// —— 参数 ——

function parseArgs(argv, allowed, flags = []) {
  const positional = [];
  const options = new Map();
  const set = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (flags.includes(name)) {
      if (eq >= 0) throw new UsageError(`--${name} 不带值`);
      set.add(name);
      continue;
    }
    if (!allowed.includes(name)) throw new UsageError(`认不出参数 --${name}`);
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || (eq < 0 && value.startsWith('--')))
      throw new UsageError(`--${name} 后面要跟值`);
    if (options.has(name)) throw new UsageError(`--${name} 给了两次`);
    options.set(name, value);
  }
  return { positional, options, flags: set };
}

function scopeOf(p) {
  const scope = p.options.get('scope')?.trim() || 'main';
  if (!SCOPE.test(scope)) throw new UsageError(`座位「${scope}」不行：真帅位是 main，演练写 drill:<名字>`);
  return scope;
}

function sessionOf(p, required) {
  const s = p.options.get('session')?.trim();
  if (s === undefined || s === '') {
    if (required) throw new UsageError('要带 --session <会话号>');
    return undefined;
  }
  if (!SESSION.test(s))
    throw new UsageError(`会话号「${s}」不行：64 字以内的一段字母、汉字、数字、点、冒号、横线、下划线`);
  return s;
}

function issueOf(raw) {
  const m = /^#?(\d{1,9})$/.exec(raw ?? '');
  const n = m ? Number(m[1]) : 0;
  if (n <= 0) throw new UsageError(`单号写正整数（比如 299 或 #299），「${raw ?? ''}」不行`);
  return n;
}

function noteOf(p, required) {
  const note = p.options.get('note')?.trim();
  if (!note) {
    if (required) throw new UsageError('要带 --note：一句话写做到哪了、为什么');
    return undefined;
  }
  if ([...note].length > MAX_NOTE) throw new UsageError(`--note 太长（最多 ${MAX_NOTE} 个字）`);
  return note;
}

/** 这个检出对应 GitHub 上哪个仓：--repo，其次 origin 的网址。认不出就说，不猜。 */
function repoOf(p, io) {
  const given = p.options.get('repo');
  if (given !== undefined) {
    if (!REPO.test(given)) throw new UsageError(`--repo 写 owner/仓名，「${given}」不行`);
    return given;
  }
  const r = io.git(['config', '--get', 'remote.origin.url']);
  const url = r.status === 0 ? r.stdout.trim() : '';
  const m = /github\.com[:/]([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url);
  if (!m)
    throw new UsageError(`认不出这个检出是哪个仓（origin 是「${url || '没有'}」）：带 --repo <owner/仓名>`);
  return `${m[1]}/${m[2]}`;
}

/** 法国那边回的「没做成」「参数不对」：一句话。 */
const whyOf = (json, fallback) => (typeof json?.why === 'string' && json.why ? json.why : fallback);

// —— seat ——

/** seat.mjs 的全部逻辑。io：{ ssh(args, input?) → { status, stdout, stderr, error? }, env, home, now(), readStdin(), out, err }。 */
export async function runSeat(argv, io) {
  try {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      io.out(SEAT_USAGE);
      return argv.length === 0 ? 1 : 0;
    }
    const [cmd, ...rest] = argv;
    if (cmd === 'take') return seatTake(parseArgs(rest, ['session', 'scope', 'machine']), io);
    if (cmd === 'show') {
      const p = parseArgs(rest, ['scope']);
      if (p.positional.length > 0) throw new UsageError('seat show 不收位置参数');
      const host = franceHost(io);
      if (!host.ok) return fail(io, host.why);
      const r = callFrance(io, host.host, ['seat', 'show', '--scope', scopeOf(p)], { json: false });
      if (r.kind !== 'done') return fail(io, `没查成：${r.why}`);
      if (r.code !== 0) return fail(io, `没查成：法国回的退出码 ${r.code}：${firstLine(r.text)}`);
      io.out(r.text);
      return 0;
    }
    if (cmd === 'handoff') return await seatHandoff(parseArgs(rest, ['session', 'scope']), io);
    throw new UsageError(`没有「${cmd}」这个命令\n${SEAT_USAGE}`);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      return 1;
    }
    return fail(io, `没查成、没做成：${e.message}`);
  }
}

function fail(io, why) {
  io.err(why);
  return 2;
}

function seatTake(p, io) {
  if (p.positional.length > 0) throw new UsageError('seat take 不收位置参数');
  const scope = scopeOf(p);
  const session = sessionOf(p, true);
  let machine = p.options.get('machine');
  if (machine === undefined) {
    const me = resolveMachine(io.env, io.home);
    if (!me.ok) return fail(io, me.why);
    machine = me.name;
  } else if (machineProblem(machine)) throw new UsageError(machineProblem(machine));
  const host = franceHost(io);
  if (!host.ok) return fail(io, host.why);
  const r = callFrance(io, host.host, [
    'seat',
    'take',
    '--machine',
    machine,
    '--session',
    session,
    '--scope',
    scope,
  ]);
  if (r.kind !== 'done') return fail(io, `没接上班：${r.why}`);
  if (r.code !== 0 || r.json.ok !== true)
    return fail(io, `没接上班：${whyOf(r.json, `法国回的退出码 ${r.code}`)}`);
  const seat = r.json.seat;
  if (
    !Number.isInteger(seat?.term) ||
    seat.holder?.machine !== machine ||
    seat.holder?.session !== session ||
    seat.scope !== scope
  )
    return fail(io, `没查成：法国回的接班结果对不上（${JSON.stringify(seat).slice(0, 160)}）`);
  const file = saveState(io.home, {
    scope,
    machine,
    session,
    term: seat.term,
    takenAt: io.now().toISOString(),
  });
  const prev = seat.previous
    ? `上一任是 ${seat.previous.machine}/${seat.previous.session}（第 ${seat.term - 1} 任），它下次 seat show 看一眼就知道该退了`
    : '座位原来没人';
  io.out(`接班了：${scope} 第 ${seat.term} 任是 ${machine}/${session}；${prev}（记在 ${file}）`);
  return 0;
}

async function seatHandoff(p, io) {
  if (p.positional.length > 0) throw new UsageError('seat handoff 不收位置参数：交接说明从标准输入读');
  const scope = scopeOf(p);
  const picked = pickState(io.home, scope, sessionOf(p, true));
  if (!picked.ok) return fail(io, picked.why);
  const s = picked.state;
  const text = String(await io.readStdin()).trim();
  if (!text)
    throw new UsageError('交接说明是空的：从标准输入给（在做什么、等谁拍什么、开着的 PR 和工人、下一步）');
  const host = franceHost(io);
  if (!host.ok) return fail(io, host.why);
  const r = callFrance(
    io,
    host.host,
    ['seat', 'handoff', '--machine', s.machine, '--session', s.session, '--scope', scope],
    { input: text },
  );
  if (r.kind !== 'done') return fail(io, `交接说明没存上：${r.why}`);
  if (r.code === 0 && r.json.ok === true) {
    io.out(`交接说明存上了（${[...text].length} 字）`);
    return 0;
  }
  if (r.code === 3) {
    io.err('交接说明没存上：座位上没人（还没接过班），没什么可交接的');
    return 3;
  }
  return fail(io, `交接说明没存上：${whyOf(r.json, `法国回的退出码 ${r.code}`)}`);
}

// —— claim ——

/**
 * claim.mjs 的全部逻辑。io：{ ssh, git(args) → { status, stdout, stderr }, gh（doing-lib 用，改「在做」镜子）, env, home, now(),
 * sleep(ms), readStdin(), out, err }。
 */
export async function runClaim(argv, io) {
  try {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      io.out(CLAIM_USAGE);
      return argv.length === 0 ? 1 : 0;
    }
    const [cmd, ...rest] = argv;
    if (cmd === 'take')
      return await claimTake(
        parseArgs(rest, ['label', 'owner', 'grace-minutes', 'note', 'branch', 'scope', 'session', 'repo']),
        io,
      );
    if (cmd === 'step' || cmd === 'done' || cmd === 'release')
      return await claimUpdate(
        cmd,
        parseArgs(rest, cmd === 'step' ? ['claim', 'note', 'pr', 'repo'] : ['claim', 'note', 'repo']),
        io,
      );
    if (cmd === 'show') {
      const p = parseArgs(rest, ['repo'], ['all']);
      const repo = repoOf(p, io);
      const numbers = p.positional.map(issueOf);
      const host = franceHost(io);
      if (!host.ok) return fail(io, host.why);
      const r = callFrance(
        io,
        host.host,
        ['claim', 'show', repo, ...numbers.map(String), ...(p.flags.has('all') ? ['--all'] : [])],
        { json: false },
      );
      if (r.kind !== 'done') return fail(io, `没查成：${r.why}`);
      if (r.code !== 0) return fail(io, `没查成：法国回的退出码 ${r.code}：${firstLine(r.text)}`);
      io.out(r.text);
      return 0;
    }
    if (cmd === 'reassign')
      return await claimReassign(
        parseArgs(rest, [
          'to',
          'label',
          'founder',
          'note',
          'reason',
          'grace-minutes',
          'scope',
          'session',
          'repo',
        ]),
        io,
      );
    throw new UsageError(`没有「${cmd}」这个命令\n${CLAIM_USAGE}`);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      return 1;
    }
    return fail(io, `没查成、没做成：${e.message}`);
  }
}

/** 改单上的「在做」镜子；改不成照实报（库里的认领算数，不回滚）。演练座位不改。 */
async function mirror(io, repo, n, argv) {
  const lines = [];
  const code = await runDoing([...argv.slice(0, 1), String(n), ...argv.slice(1), '--repo', repo], {
    ...io,
    out: (t) => lines.push(t),
    err: (t) => lines.push(t),
  });
  if (code !== 0)
    io.err(
      `库里记上了；单上的「在做」镜子没改上（doing.mjs 退出码 ${code}：${lines.join(' ').slice(0, 200)}），稍后用 doing.mjs 补`,
    );
}

const isDrill = (scope) => typeof scope === 'string' && scope.startsWith('drill:');

async function claimTake(p, io) {
  if (p.positional.length !== 1) throw new UsageError('claim take 要一个位置参数：单号');
  const n = issueOf(p.positional[0]);
  const label = p.options.get('label')?.trim();
  if (!label) throw new UsageError('要带 --label <工人名>（帅位自己做写 --owner seat --label 帅位）');
  if (!SESSION.test(label))
    throw new UsageError(`工人名「${label}」不行：64 字以内的一段字母、汉字、数字、点、冒号、横线、下划线`);
  const owner = p.options.get('owner') ?? 'worker';
  if (owner !== 'worker' && owner !== 'seat')
    throw new UsageError(`--owner 只收 worker、seat，没有「${owner}」`);
  const grace = p.options.get('grace-minutes');
  if (grace !== undefined && !/^[1-9]\d{0,5}$/.test(grace))
    throw new UsageError(`--grace-minutes 写正整数（分钟），「${grace}」不行`);
  const note = noteOf(p, false);
  const branch = p.options.get('branch');
  if (branch !== undefined && !/^[A-Za-z0-9._/-]{1,200}$/.test(branch))
    throw new UsageError(`分支名「${branch}」认不出`);
  const repo = repoOf(p, io);
  const scope = scopeOf(p);
  const picked = pickState(io.home, scope, sessionOf(p, true));
  if (!picked.ok) return fail(io, picked.why);
  const s = picked.state;
  const host = franceHost(io);
  if (!host.ok) return fail(io, host.why);
  const r = callFrance(io, host.host, [
    'claim',
    'take',
    repo,
    String(n),
    '--machine',
    s.machine,
    '--session',
    s.session,
    '--term',
    String(s.term),
    '--scope',
    scope,
    '--label',
    label,
    '--owner',
    owner,
    ...(grace === undefined ? [] : ['--grace-minutes', grace]),
    ...(note === undefined ? [] : ['--note', note]),
  ]);
  if (r.kind !== 'done') return fail(io, `没认领上：${r.why}`);
  const claim = r.json.claim;
  if (r.code === 0 && r.json.ok === true && typeof claim?.claimId === 'string' && UUID.test(claim.claimId)) {
    if (branch !== undefined) {
      const g = io.git(['config', `branch.${branch}.fleetClaim`, `${repo}#${n}:${claim.claimId}`]);
      if (g.status !== 0)
        io.err(
          `认领上了，但认领号没记进分支 ${branch} 的 git 配置（${firstLine(g.stderr)}）：纯记录用、不影响推送（#446 起推前钩子不查这个了），手动 git config branch.${branch}.fleetClaim ${repo}#${n}:${claim.claimId}`,
        );
    }
    io.out(
      `认领了 ${repo}#${n}：归 ${s.machine}/${label}${owner === 'seat' ? '（帅位自己）' : ''}，认领号 ${claim.claimId}（开 PR 时正文「认领」栏写它）`,
    );
    if (!isDrill(scope))
      await mirror(io, repo, n, ['claim', note ?? `${label} 在做（认领 ${claim.claimId.slice(0, 8)}）`]);
    return 0;
  }
  if (r.code === 3) {
    io.err(
      `没认领上：${whyOf(r.json, claim ? `${repo}#${n} 归 ${claim.owner?.kind === 'engine' ? '引擎' : `${claim.owner?.machine}/${claim.owner?.label}`}（${claim.state}）` : '不是你的')}`,
    );
    return 3;
  }
  return fail(io, `没认领上：${whyOf(r.json, `法国回的退出码 ${r.code}`)}`);
}

async function claimUpdate(cmd, p, io) {
  if (p.positional.length !== 1) throw new UsageError(`claim ${cmd} 要一个位置参数：单号`);
  const n = issueOf(p.positional[0]);
  const id = p.options.get('claim')?.trim().toLowerCase();
  if (!id || !UUID.test(id)) throw new UsageError('要带 --claim <认领号>（认领时打印的那一串）');
  const note = noteOf(p, cmd !== 'step');
  const pr = p.options.get('pr');
  if (pr !== undefined && !/^#?[1-9]\d{0,8}$/.test(pr)) throw new UsageError(`PR 号写正整数，「${pr}」不行`);
  const repo = repoOf(p, io);
  const host = franceHost(io);
  if (!host.ok) return fail(io, host.why);
  const r = callFrance(io, host.host, [
    'claim',
    cmd,
    repo,
    String(n),
    '--claim',
    id,
    ...(note === undefined ? [] : ['--note', note]),
    ...(pr === undefined ? [] : ['--pr', pr.replace('#', '')]),
  ]);
  if (r.kind !== 'done') return fail(io, `没记上：${r.why}`);
  const claim = r.json.claim;
  if (r.code === 0 && r.json.ok === true) {
    io.out(
      `${repo}#${n}：${cmd === 'step' ? `报上了${pr ? `，登记了 PR #${pr.replace('#', '')}` : ''}` : cmd === 'done' ? '做完了' : '放下了'}`,
    );
    if (!isDrill(claim?.seat?.scope)) {
      if (cmd === 'step' && note) await mirror(io, repo, n, ['say', note]);
      if (cmd === 'done') await mirror(io, repo, n, ['done', note]);
      if (cmd === 'release') await mirror(io, repo, n, ['drop', note]);
    }
    return 0;
  }
  if (r.code === 3) {
    const now = claim
      ? `现在归 ${claim.owner?.kind === 'engine' ? '引擎' : `${claim.owner?.machine}/${claim.owner?.label}`}（${claim.state}${claim.endReason ? `：${claim.endReason}` : ''}，认领 ${String(claim.claimId).slice(0, 8)}）`
      : '这张单没有认领';
    io.err(
      `没记上：${repo}#${n} ${now}；你的认领号 ${id.slice(0, 8)} 对不上或已经结束。这张已经不归你，别再动（推不上、合不进）`,
    );
    return 3;
  }
  return fail(io, `没记上：${whyOf(r.json, `法国回的退出码 ${r.code}`)}`);
}

async function claimReassign(p, io) {
  if (p.positional.length !== 1) throw new UsageError('claim reassign 要一个位置参数：单号');
  const n = issueOf(p.positional[0]);
  const to = p.options.get('to');
  if (to !== 'worker' && to !== 'seat' && to !== 'engine')
    throw new UsageError(`要带 --to worker|seat|engine${to === undefined ? '' : `，没有「${to}」`}`);
  const founder = p.options.get('founder')?.trim() || undefined;
  const repo = repoOf(p, io);
  const scope = scopeOf(p);
  const extra = [];
  if (to === 'engine') {
    const reason = p.options.get('reason')?.trim();
    if (!reason) throw new UsageError('--to engine 要带 --reason "<为什么>"（写进交单的操作记录）');
    for (const k of ['label', 'note', 'grace-minutes'])
      if (p.options.has(k)) throw new UsageError(`--to engine 不带 --${k}`);
    extra.push('--reason', reason);
  } else {
    const label = p.options.get('label')?.trim();
    if (!label) throw new UsageError('要带 --label <工人名>');
    if (!SESSION.test(label))
      throw new UsageError(`工人名「${label}」不行：64 字以内的一段字母、汉字、数字、点、冒号、横线、下划线`);
    if (p.options.has('reason')) throw new UsageError(`--to ${to} 不带 --reason（写 --note）`);
    const grace = p.options.get('grace-minutes');
    if (grace !== undefined && !/^[1-9]\d{0,5}$/.test(grace))
      throw new UsageError(`--grace-minutes 写正整数（分钟），「${grace}」不行`);
    const note = noteOf(p, false);
    extra.push(
      '--label',
      label,
      ...(grace === undefined ? [] : ['--grace-minutes', grace]),
      ...(note === undefined ? [] : ['--note', note]),
    );
  }
  const picked = pickState(io.home, scope, sessionOf(p, true));
  if (!picked.ok) return fail(io, picked.why);
  const s = picked.state;
  const host = franceHost(io);
  if (!host.ok) return fail(io, host.why);
  const r = callFrance(
    io,
    host.host,
    [
      'claim',
      'reassign',
      repo,
      String(n),
      '--to',
      to,
      '--machine',
      s.machine,
      '--session',
      s.session,
      '--term',
      String(s.term),
      '--scope',
      scope,
      ...extra,
      ...(founder === undefined ? [] : ['--founder', founder]),
    ],
    { json: false },
  );
  if (r.kind !== 'done')
    return fail(io, `没改派（不知道法国那边做没做，先 claim.mjs show ${n} 看）：${r.why}`);
  // 法国打的是给人看的话：改派了什么、叫停了没有、旧 PR 关了哪几个、哪几样没做成要人补
  if (r.code === 0) {
    io.out(r.text);
    const id = /认领号 ([0-9a-f-]{36})/.exec(r.text)?.[1];
    if (to !== 'engine' && id && !isDrill(scope))
      await mirror(io, repo, n, [
        'claim',
        `改派给 ${s.machine}/${p.options.get('label')}（认领 ${id.slice(0, 8)}）`,
      ]);
    return 0;
  }
  if (r.code === 3) {
    io.err(r.text || '没改派：法国说不是你的（#446 起 reassign 永远 force，理论上不该发生，把这行报给帅位）');
    return 3;
  }
  if (r.code === 1 && r.text) {
    // 改派本身成了、后面几样（叫停、关旧 PR）有没做成的：法国照实写在正文里，退出码 1
    io.err(r.text);
    return 2;
  }
  return fail(io, `没改派：法国回的退出码 ${r.code}${r.text ? `：${firstLine(r.text)}` : ''}`);
}
