// 认领账（#299，specs/299-帅位只一个/方案.md；帅位座位整张删掉，见 #531）：本机的帅位、工人经 ssh 调法国的 fleet-api claim。
// claim.mjs 是外壳；推前钩子（.githooks/pre-push）调 claim.mjs prepush。
// 改这里之前必须知道：
// - 真相在法国的库里（每张单一个认领，时间用库的钟）。本机的 ~/.fleet-dao/seat/ 只记「我是谁、第几任、上次续约成功是什么时候」：
//   离上次续约成功超过租期，现查直接判不是帅位，不等法国回话。这里认的是认领着 / 还归不归你，不是「还是不是帅位」。
// - 没有登法国的钥匙（~/.fleet-dao/france-ssh 不在）、ssh 连不上、回的东西认不出，一律「没查成」（退出码 2）。
//   推前钩子例外：连不上法国只警告、照推（早提醒；真正的边界是合并闸），认领对不上才拦。
// - ssh 的标准错误交原字节（Windows 上是 GBK，或被 ssh 打成 \NNN）。先 readableStderr 还原再抹字；认不出的照原样留着。
//   外壳不要用 encoding:'utf8' 解标准错误，解过一遍原字节就丢了。
// - 单上的「在做」评论只是库的镜子（doing-lib.mjs）：库里成了才改它；改不成照实报，库里那份算数。演练座位不改镜子。
import { readFileSync } from 'node:fs';
import { readTarget, scrubText } from './france-lib.mjs';

/** 法国上的管理命令（ops 第九节「帅位和认领」）：以 root 经 ssh 调。 */
export const FLEET_API = 'bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api';
const _SCOPE = /^(main|drill:[\p{L}\p{N}_.-]{1,32})$/u;
const _SESSION = /^[\p{L}\p{N}_.:-]{1,64}$/u;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZERO = /^0+$/;
const _MAX_NOTE = 500;

export const CLAIM_USAGE = `用法：node claim.mjs <命令> …（经 ssh 调法国的 fleet-api claim；在项目仓的检出里跑，别处加 --repo <owner/仓名>）
  show [<单号>…] [--all]                                              看认领
  prepush                                                             推前钩子调：分支带着认领的，查认领还归不归你
退出码：0 好了；1 用法不对（prepush：拦下这次推送）；2 没查成、没做成；3 不是你的（不是帅位、别人拿着、认领号对不上）。
take/step/done/release/reassign 随帅位座位整张删掉（#531）：本机不再新认领。`;

class UsageError extends Error {}

/** ssh 打出来的连续 \200–\377。ASCII 范围的反斜杠（C:\Users 这类）不认，免得把路径拆开。 */
const HIGH_OCTAL = /\\[23][0-7]{2}(?:\\[23][0-7]{2})*/g;

/** 严格解。编码名不存在、字节对不上，都是 null，不抛。 */
function tryDecode(bytes, label) {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** 先 UTF-8，再 GB18030（GBK 的超集）。UTF-8 对了就不能再按 GBK 解，两边都合法的字节意思不一样。 */
function decodeKnown(bytes) {
  return tryDecode(bytes, 'utf-8') ?? tryDecode(bytes, 'gb18030');
}

/** 认不出的字节：非 ASCII 写成和 ssh 一样的 \NNN，ASCII 照原样。 */
function bytesAsOctal(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += b >= 0x80 ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b);
  }
  return out;
}

/**
 * ssh 的标准错误还原成能读的字。字符串或原字节 Buffer 都收。
 * 认不出的照原样留着：坏字节写成 \NNN，解不开的 \NNN 段保留原文。不吞、不出 �、不抛。
 */
export function readableStderr(raw) {
  if (Buffer.isBuffer(raw)) {
    const text = decodeKnown(raw);
    return text === null ? bytesAsOctal(raw) : text;
  }
  return String(raw ?? '').replace(HIGH_OCTAL, (run) => {
    const bytes = [];
    for (let i = 0; i < run.length; i += 4) bytes.push(Number.parseInt(run.slice(i + 1, i + 4), 8));
    return decodeKnown(Uint8Array.from(bytes)) ?? run;
  });
}

/** 空 Buffer 长度是 0 但是真值，不能用 || 当成「这段有字」。 */
function hasBody(v) {
  if (v == null || v === '') return false;
  if (Buffer.isBuffer(v)) return v.length > 0;
  return true;
}

/** 法国、ssh 回的话取第一行，抹掉像 IP、令牌、邮箱的（和「法国引擎」页同一个抹法）。先还原再取行再抹。 */
const firstLine = (text) =>
  scrubText(
    readableStderr(text ?? '')
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
      why: `法国上的 fleet-api 退出码 ${r.status}（不是它会给的）：${firstLine(hasBody(r.stderr) ? r.stderr : r.stdout) || '没有输出'}`,
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

function issueOf(raw) {
  const m = /^#?(\d{1,9})$/.exec(raw ?? '');
  const n = m ? Number(m[1]) : 0;
  if (n <= 0) throw new UsageError(`单号写正整数（比如 299 或 #299），「${raw ?? ''}」不行`);
  return n;
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

// —— claim ——

/**
 * claim.mjs 的全部逻辑。io：{ ssh, git(args) → { status, stdout, stderr }, gh（doing-lib 用，改「在做」镜子）, env, home, now(),
 * sleep(ms), readStdin(), out, err }。
 * #531：take、step、done、release、reassign 都不再在本机起（帅位座位整张删掉）——
 * 只剩 show 看现状、prepush 推前钩子还归不归你这两条。
 */
export async function runClaim(argv, io) {
  try {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      io.out(CLAIM_USAGE);
      return argv.length === 0 ? 1 : 0;
    }
    const [cmd, ...rest] = argv;
    if (cmd === 'take' || cmd === 'step' || cmd === 'done' || cmd === 'release' || cmd === 'reassign') {
      throw new UsageError(
        `claim ${cmd} 随帅位座位整张删掉（#531）：本机不再新认领、报一步、做完、放下或改派。\n${CLAIM_USAGE}`,
      );
    }
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
    if (cmd === 'prepush') return await prePush(await io.readStdin(), io);
    throw new UsageError(`没有「${cmd}」这个命令\n${CLAIM_USAGE}`);
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

// —— 推前钩子 ——

/**
 * git pre-push 给的每一行：<本地引用> <本地提交> <远端引用> <远端提交>。推的分支带着认领（branch.<分支>.fleetClaim）的，
 * 经 ssh 查一次认领还归不归你：对不上就拦（退出码 1），连不上法国只警告、照推；没带认领的分支不查。
 */
export async function prePush(stdin, io) {
  let blocked = 0;
  for (const line of String(stdin).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) continue;
    const [localRef, localSha] = parts;
    if (!localRef.startsWith('refs/heads/') || ZERO.test(localSha)) continue;
    const branch = localRef.slice('refs/heads/'.length);
    const got = io.git(['config', '--get', `branch.${branch}.fleetClaim`]);
    if (got.status === 1) continue;
    if (got.status !== 0) {
      io.err(
        `推前查认领：读分支 ${branch} 的 git 配置没成（${firstLine(got.stderr)}），拦下这次推送；修好 git 再推`,
      );
      blocked += 1;
      continue;
    }
    const value = got.stdout.trim();
    const m = /^([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)#(\d{1,9}):([0-9a-f-]{36})$/.exec(value);
    if (!m || !UUID.test(m[3])) {
      io.err(
        `推前查认领：分支 ${branch} 的 fleetClaim「${value.slice(0, 80)}」认不出，拦下这次推送。改成 <owner/仓名>#<单号>:<认领号>，或不要了就 git config --unset branch.${branch}.fleetClaim`,
      );
      blocked += 1;
      continue;
    }
    const [, repo, num, id] = m;
    const host = franceHost(io);
    if (!host.ok) {
      io.err(`推前查认领：${host.why}；这次没查 ${repo}#${num} 的认领，照推（合并闸那一侧照样查）`);
      continue;
    }
    const r = callFrance(io, host.host, ['claim', 'show', repo, num, '--all']);
    if (r.kind !== 'done' || r.code !== 0 || !Array.isArray(r.json.claims)) {
      io.err(
        `推前查认领：没查成（${r.kind === 'done' ? whyOf(r.json, `法国回的退出码 ${r.code}`) : r.why}）；这次没查 ${repo}#${num} 的认领，照推（合并闸那一侧照样查）`,
      );
      continue;
    }
    const cur = r.json.claims.find((c) => c.issue === Number(num));
    if (cur && cur.claimId === id && cur.active === true) {
      io.out(`推前查认领：${repo}#${num} 还归你（认领 ${id.slice(0, 8)}）`);
      continue;
    }
    const now = !cur
      ? '库里没有这张单的认领'
      : cur.claimId !== id
        ? `现在归 ${cur.owner?.kind === 'engine' ? '引擎' : `${cur.owner?.machine}/${cur.owner?.label}`}（认领 ${String(cur.claimId).slice(0, 8)}，${cur.active ? '还活着' : '已经结束'}）`
        : `你的认领已经结束（${cur.state}：${cur.endReason ?? '没写原因'}）`;
    io.err(
      `推前查认领：分支 ${branch} 带的是 ${repo}#${num} 的认领 ${id.slice(0, 8)}，${now}。这张已经不归你：别再推（合并闸也不会放行），把手上的东西交给现在的主；分支留着给新主用`,
    );
    blocked += 1;
  }
  return blocked > 0 ? 1 : 0;
}
