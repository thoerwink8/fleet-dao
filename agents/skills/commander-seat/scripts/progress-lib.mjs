// 帅位本机进度页的共用部分：数据放哪、怎么读、怎么改、怎么给页面。p.mjs（改进度）和 server.mjs（起页面）只是它的外壳。
// 改这里之前必须知道：
// - 数据放家目录（~/.local/share/fleet-progress/<项目>/），不放技能目录：agents-sync 见技能目录里多了文件，会把整个目录换回仓里的样子，数据就没了。
// - 读不到、不是 JSON、形状不对，一律返回失败和原因，不拿空的顶上；坏了的文件不改写（改写就把现场盖掉了）。
// - 一台机器可以同时坐几个项目的帅位：每个项目一个目录，一个页面服务全看得到。
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 1127;
export const STATUSES = ['done', 'doing', 'waiting', 'needs', 'blocked'];
/** /api/ping 回这个，起服务时用它认「端口上已经是我们自己的进度页」。 */
export const APP_ID = 'fleet-progress';
const LOG_KEEP = 60;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REPO_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** 所有项目的数据根目录。 */
export function dataRoot(home = homedir()) {
  return join(home, '.local', 'share', 'fleet-progress');
}

/** 项目名（就是仓名）合不合规，不合规返回原因。只许一段名字：挡住 ../ 这类跳出数据目录的写法。 */
export function projectProblem(name) {
  return typeof name === 'string' && PROJECT_NAME.test(name)
    ? null
    : `项目名写仓名（字母、数字、点、横线、下划线，比如 fleet-dao），「${name ?? ''}」不行`;
}

export function projectPaths(project, home = homedir()) {
  const dir = join(dataRoot(home), project);
  return {
    dir,
    progress: join(dir, 'progress.json'),
    handoff: join(dir, 'handoff.md'),
    handoffs: join(dir, 'handoffs'),
  };
}

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const optStr = (v) => v === undefined || isStr(v);
const isIssue = (v) => Number.isInteger(v) && v > 0;
/** 页面只把 http(s) 地址做成链接：别的（javascript: 这类）一律当坏数据。 */
export const isWebUrl = (v) => isStr(v) && /^https?:\/\/[^\s]+$/i.test(v);

/** 进度数据哪里不对（空列表 = 没毛病）。字段多了不管，缺了、类型不对都报。 */
export function validateProgress(data) {
  if (!isObj(data)) return ['整份不是一个对象'];
  const bad = [];
  const { meta, steps, log, structure } = data;
  if (!isObj(meta)) bad.push('meta 不是对象');
  else {
    for (const k of ['project', 'headline', 'updatedAt'])
      if (!optStr(meta[k])) bad.push(`meta.${k} 不是字符串`);
    if (meta.repo !== undefined && !isWebUrl(meta.repo)) bad.push('meta.repo 不是网址');
    if (meta.needsYou !== undefined && !(Array.isArray(meta.needsYou) && meta.needsYou.every(isStr)))
      bad.push('meta.needsYou 不是一串文字');
  }
  if (!Array.isArray(steps)) bad.push('steps 不是列表');
  else {
    const seen = new Set();
    for (const [i, s] of steps.entries()) {
      const at = `steps[${i}]`;
      if (!isObj(s)) {
        bad.push(`${at} 不是对象`);
        continue;
      }
      if (!isStr(s.id) || s.id === '') bad.push(`${at}.id 缺了`);
      else if (seen.has(s.id)) bad.push(`${at}.id「${s.id}」重复了`);
      else seen.add(s.id);
      if (typeof s.order !== 'number' || !Number.isFinite(s.order)) bad.push(`${at}.order 不是数`);
      if (!isStr(s.title)) bad.push(`${at}.title 不是字符串`);
      if (!STATUSES.includes(s.status))
        bad.push(`${at}.status 是「${s.status}」，只能是 ${STATUSES.join('、')}`);
      if (!optStr(s.detail)) bad.push(`${at}.detail 不是字符串`);
      if (
        s.links !== undefined &&
        !(Array.isArray(s.links) && s.links.every((l) => isObj(l) && isWebUrl(l.url) && optStr(l.label)))
      )
        bad.push(`${at}.links 每项要有网址 url`);
    }
  }
  if (!Array.isArray(log)) bad.push('log 不是列表');
  else
    for (const [i, e] of log.entries())
      if (!(isObj(e) && isStr(e.t) && isStr(e.text))) bad.push(`log[${i}] 要有 t 和 text`);
  if (structure !== undefined && structure !== null) bad.push(...structureProblems(structure));
  return bad;
}

function structureProblems(s) {
  if (!isObj(s) || !Array.isArray(s.groups)) return ['structure 要有 groups 列表'];
  const bad = [];
  if (!optStr(s.note)) bad.push('structure.note 不是字符串');
  for (const [i, g] of s.groups.entries()) {
    const at = `structure.groups[${i}]`;
    if (!isObj(g) || !isStr(g.title)) {
      bad.push(`${at} 要有 title`);
      continue;
    }
    if (g.url !== undefined && !isWebUrl(g.url)) bad.push(`${at}.url 不是网址`);
    if (!optStr(g.note)) bad.push(`${at}.note 不是字符串`);
    if (g.items !== undefined && !Array.isArray(g.items)) {
      bad.push(`${at}.items 不是列表`);
      continue;
    }
    for (const [j, it] of (g.items ?? []).entries()) {
      const ai = `${at}.items[${j}]`;
      if (!isObj(it) || !isIssue(it.n)) {
        bad.push(`${ai}.n 不是单号`);
        continue;
      }
      if (!optStr(it.title)) bad.push(`${ai}.title 不是字符串`);
      if (
        it.children !== undefined &&
        !(Array.isArray(it.children) && it.children.every((c) => isObj(c) && isIssue(c.n) && optStr(c.title)))
      )
        bad.push(`${ai}.children 每项要有单号 n`);
    }
  }
  return bad;
}

/**
 * 读一个进度文件。成功 { ok: true, data }；失败 { ok: false, kind, why }，kind 分得开四种：
 * missing（没有这个文件）、unreadable（有但读不了）、bad-json（不是 JSON）、bad-shape（形状不对）。
 */
export function readProgress(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, kind: 'missing', why: `没有进度文件（${file}）` };
    return { ok: false, kind: 'unreadable', why: `进度文件读不了（${e.code ?? e.message}）` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, kind: 'bad-json', why: `进度文件不是 JSON（${e.message}）` };
  }
  const problems = validateProgress(data);
  if (problems.length > 0)
    return { ok: false, kind: 'bad-shape', why: `进度文件形状不对：${problems.slice(0, 5).join('；')}` };
  return { ok: true, data };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 先写临时文件再换名：页面不会读到写了一半的。Windows 上页面服务正好在读时换名偶尔报 EPERM/EBUSY，等一下再换。 */
export function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        rmSync(tmp, { force: true });
        throw e;
      }
      sleepSync(40);
    }
  }
}

/** 写之前再校验一遍：形状不对的绝不落盘。 */
export function writeProgress(file, data) {
  const problems = validateProgress(data);
  if (problems.length > 0) throw new Error(`要写的进度形状不对：${problems.join('；')}`);
  writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * 同一个项目同一时间只让一条命令改（会话常常并行跑两条 p.mjs，不锁会丢一条）。
 * 锁是目录里的 .lock 文件；超过 staleMs 没放开的当成上次崩了留下的，删掉重来。
 */
export function withLock(dir, fn, { waitMs = 3000, staleMs = 30000 } = {}) {
  const lock = join(dir, '.lock');
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // 刚好被放开了
      }
      if (Date.now() > until)
        throw new Error(
          `进度被别的命令占着（${lock} 在，${waitMs / 1000} 秒没放开）；确认没有别的 p.mjs 在跑，再删掉它`,
        );
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

class UsageError extends Error {}

export const USAGE = `用法：node p.mjs <项目> <命令> [参数…]（项目就是仓名，比如 fleet-dao）
  init [--repo <owner/repo>] [一句话现状]      第一次坐这个项目：建进度文件
  head <一句话现状>
  add <id> <序号> <标题> [说明]                  加一步（排着）
  step <id> <${STATUSES.join('|')}> [说明]
  log <动态>                                     加一条最近动态（留最近 ${LOG_KEEP} 条）
  needs [要你定的 …]                             整个换掉「要你定的」，一件一个参数；不给就是清空
  link <id> <名字> <网址>                        给一步加链接
  structure <json 文件>                          换掉「版本和母单」
  handoff <文件>                                 存交接说明（旧的归档到 handoffs/）
  show                                           打出现状和交接说明（读回核对用）
数据在 ~/.local/share/fleet-progress/<项目>/。`;

function repoUrl(value) {
  if (isWebUrl(value)) return value.replace(/\/+$/, '');
  if (REPO_NAME.test(value ?? '')) return `https://github.com/${value}`;
  throw new UsageError(`--repo 写 owner/repo 或仓的网址，「${value ?? ''}」认不出`);
}

function stepById(data, id) {
  const s = data.steps.find((x) => x.id === id);
  if (!s)
    throw new UsageError(
      `没有这一步：${id}（现有 ${data.steps.map((x) => x.id).join('、') || '一步都没有'}）`,
    );
  return s;
}

/** 在内存里改一份进度；用法不对抛 UsageError。io.readText 读 structure 要的文件。 */
export function applyCommand(data, cmd, args, now, io) {
  switch (cmd) {
    case 'head':
      if (args.length === 0) throw new UsageError('用法：head <一句话现状>');
      data.meta.headline = args.join(' ');
      return;
    case 'add': {
      const [id, order, title, ...detail] = args;
      if (!id || !Number.isFinite(Number(order)) || order === '' || !title)
        throw new UsageError('用法：add <id> <序号> <标题> [说明]');
      if (data.steps.some((s) => s.id === id)) throw new UsageError(`已经有 ${id} 这一步`);
      data.steps.push({ id, order: Number(order), title, status: 'waiting', detail: detail.join(' ') });
      return;
    }
    case 'step': {
      const [id, status, ...detail] = args;
      if (!STATUSES.includes(status)) throw new UsageError(`用法：step <id> <${STATUSES.join('|')}> [说明]`);
      const s = stepById(data, id);
      s.status = status;
      if (detail.length > 0) s.detail = detail.join(' ');
      return;
    }
    case 'log':
      if (args.length === 0) throw new UsageError('用法：log <动态>');
      data.log = [...data.log, { t: now.toISOString(), text: args.join(' ') }].slice(-LOG_KEEP);
      return;
    case 'needs':
      data.meta.needsYou = args.filter((a) => a.trim() !== '');
      return;
    case 'link': {
      const [id, label, url] = args;
      if (!label || !isWebUrl(url)) throw new UsageError('用法：link <id> <名字> <http(s) 网址>');
      const s = stepById(data, id);
      s.links = [...(s.links ?? []).filter((l) => l.url !== url), { label, url }];
      return;
    }
    case 'structure': {
      const [file] = args;
      if (!file) throw new UsageError('用法：structure <json 文件>');
      let s;
      try {
        s = JSON.parse(io.readText(file));
      } catch (e) {
        throw new UsageError(`${file} 读不到或不是 JSON：${e.message}`);
      }
      const problems = structureProblems(s);
      if (problems.length > 0) throw new UsageError(`${file} 形状不对：${problems.slice(0, 5).join('；')}`);
      data.structure = s;
      return;
    }
    default:
      throw new UsageError(`没有「${cmd}」这个命令\n${USAGE}`);
  }
}

const LABEL = { done: '做完了', doing: '在做', waiting: '排着', needs: '等你拍', blocked: '卡住了' };

function showText(project, data, paths) {
  const m = data.meta;
  const lines = [`${project}（最后更新 ${m.updatedAt ?? '—'}）`, `现状：${m.headline ?? '（没写）'}`];
  const needs = m.needsYou ?? [];
  lines.push(
    needs.length ? `要你定的：\n${needs.map((n, i) => `  ${i + 1}. ${n}`).join('\n')}` : '要你定的：没有',
  );
  const steps = [...data.steps].sort((a, b) => a.order - b.order);
  lines.push(steps.length ? '步骤：' : '步骤：还没有');
  for (const s of steps)
    lines.push(`  ${s.id} [${LABEL[s.status]}] ${s.title}${s.detail ? ` —— ${s.detail}` : ''}`);
  const recent = data.log.slice(-5);
  if (recent.length) lines.push('最近动态：', ...recent.map((e) => `  ${e.t} ${e.text}`));
  if (existsSync(paths.handoff)) {
    lines.push(`交接说明（${paths.handoff}，${statSync(paths.handoff).mtime.toISOString()}）：`);
    lines.push(readFileSync(paths.handoff, 'utf8').trimEnd());
  } else {
    lines.push('交接说明：本机没有');
  }
  return lines.join('\n');
}

/** p.mjs 的全部逻辑。io：{ home, now(), readText(file), out(text), err(text) }。返回退出码：0 好了，1 用法不对，2 没做成。 */
export function runProgressCli(argv, io) {
  const fail = (code, msg) => {
    io.err(msg);
    return code;
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out(USAGE);
    return 0;
  }
  const [project, cmd, ...args] = argv;
  if (!project || !cmd) return fail(1, USAGE);
  const why = projectProblem(project);
  if (why) return fail(1, why);
  const paths = projectPaths(project, io.home);
  const now = io.now();
  try {
    if (cmd === 'init') {
      if (existsSync(paths.progress))
        return fail(1, `${project} 已经有进度文件（${paths.progress}），接着用就行；要重来先把它挪走`);
      let rest = args;
      let repo;
      if (args[0] === '--repo') {
        repo = repoUrl(args[1]);
        rest = args.slice(2);
      }
      const data = {
        meta: {
          project,
          ...(repo ? { repo } : {}),
          headline: rest.join(' ') || '刚接手，还没写现状',
          needsYou: [],
          updatedAt: now.toISOString(),
        },
        steps: [],
        log: [{ t: now.toISOString(), text: '开了进度页' }],
        structure: null,
      };
      mkdirSync(paths.dir, { recursive: true });
      writeProgress(paths.progress, data);
      io.out(`建好了：${paths.progress}`);
      return 0;
    }
    const read = readProgress(paths.progress);
    if (!read.ok && read.kind === 'missing')
      return fail(2, `还没有 ${project} 的进度（${paths.progress}）：先 node p.mjs ${project} init`);
    if (cmd === 'show') {
      if (!read.ok) return fail(2, read.why);
      io.out(showText(project, read.data, paths));
      return 0;
    }
    return withLock(paths.dir, () => {
      // 拿到锁之后重读：等锁的时候别的命令可能刚改过
      const fresh = readProgress(paths.progress);
      if (!fresh.ok) return fail(2, `${fresh.why}\n没改：坏了的文件不盖掉。修好它，或挪走后重新 init。`);
      const data = fresh.data;
      if (cmd === 'handoff') {
        const [file] = args;
        if (!file) throw new UsageError('用法：handoff <文件>');
        let text;
        try {
          text = io.readText(file);
        } catch (e) {
          return fail(2, `交接说明 ${file} 读不到（${e.code ?? e.message}）`);
        }
        if (text.trim() === '') throw new UsageError(`交接说明 ${file} 是空的`);
        if (existsSync(paths.handoff)) {
          mkdirSync(paths.handoffs, { recursive: true });
          const stamp = statSync(paths.handoff).mtime.toISOString().replace(/[:.]/g, '-');
          renameSync(paths.handoff, join(paths.handoffs, `${stamp}.md`));
        }
        writeAtomic(paths.handoff, text.endsWith('\n') ? text : `${text}\n`);
        data.log = [...data.log, { t: now.toISOString(), text: '写了交接说明' }].slice(-LOG_KEEP);
      } else {
        applyCommand(data, cmd, args, now, io);
      }
      data.meta.updatedAt = now.toISOString();
      writeProgress(paths.progress, data);
      io.out(`改好了（${project} ${cmd}）`);
      return 0;
    });
  } catch (e) {
    if (e instanceof UsageError) return fail(1, e.message);
    return fail(2, `没做成：${e.message}`);
  }
}

/** 本机有哪些项目的进度。根目录还没建 = 一个都没有（明说）；别的读不了 = 抛出去，由调用方报 500。 */
export function listProjects(home = homedir()) {
  let entries;
  try {
    entries = readdirSync(dataRoot(home), { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return entries
    .filter((e) => e.isDirectory() && projectProblem(e.name) === null)
    .map((e) => e.name)
    .sort()
    .map((name) => {
      const r = readProgress(projectPaths(name, home).progress);
      if (!r.ok) return { name, ok: false, why: r.why };
      const m = r.data.meta;
      return {
        name,
        ok: true,
        headline: m.headline ?? '',
        updatedAt: m.updatedAt ?? null,
        needs: (m.needsYou ?? []).length,
      };
    });
}

/** 页面服务：/ 给页面，/api/projects 列项目，/api/p/<项目> 给一个项目的数据，/api/ping 认自己。每次现读，不缓存。 */
export function createProgressServer({ home = homedir(), htmlFile }) {
  return createServer((req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const json = (code, value) => send(code, 'application/json; charset=utf-8', JSON.stringify(value));
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: '只能读' });
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/' || path === '/index.html') {
      try {
        return send(200, 'text/html; charset=utf-8', readFileSync(htmlFile));
      } catch (e) {
        return send(500, 'text/plain; charset=utf-8', `页面文件读不到（${e.code ?? e.message}）`);
      }
    }
    if (path === '/api/ping') return json(200, { app: APP_ID });
    if (path === '/api/projects') {
      try {
        return json(200, { root: dataRoot(home), projects: listProjects(home) });
      } catch (e) {
        return json(500, { error: `数据目录读不了（${e.code ?? e.message}）` });
      }
    }
    const m = /^\/api\/p\/([^/]+)$/.exec(path);
    if (m) {
      let name;
      try {
        name = decodeURIComponent(m[1]);
      } catch {
        name = '';
      }
      const why = projectProblem(name);
      if (why) return json(400, { error: why });
      const r = readProgress(projectPaths(name, home).progress);
      if (r.ok) return json(200, r.data);
      return json(r.kind === 'missing' ? 404 : 500, { error: r.why });
    }
    return json(404, { error: '没有这个地址' });
  });
}

/** 端口：--port <n>，其次环境变量 FLEET_PROGRESS_PORT，都没有用 1127。认不出返回原因（字符串）。 */
export function parsePort(argv, env) {
  const i = argv.indexOf('--port');
  const raw = i >= 0 ? argv[i + 1] : env.FLEET_PROGRESS_PORT;
  if (raw === undefined || raw === '') return i >= 0 ? '用法：--port <端口>' : DEFAULT_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : `端口要是 0–65535 的整数，「${raw}」不行`;
}

export async function isOurs(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(2000) });
    return r.ok && (await r.json()).app === APP_ID;
  } catch {
    return false;
  }
}

/**
 * 写完进度顺手看页面还在不在：不在就拉起来（2026-09-27 查断链：页面进程退出后没人拉，数据照写、页面打不开，
 * 创始人看不到也没人知道）。isUp(port) 查是不是我们的页面在听，launch() 起一个脱离的服务进程。
 * 返回 { state: 'up' | 'started' } 或 { state: 'failed', why }：拉不起来要明说，不当没事。
 */
export async function ensureServer({ port, isUp = isOurs, launch, waitMs = 3000, stepMs = 200 }) {
  if (await isUp(port)) return { state: 'up' };
  try {
    launch();
  } catch (e) {
    return { state: 'failed', why: `起服务进程没成：${e instanceof Error ? e.message : String(e)}` };
  }
  for (let waited = 0; waited < waitMs; waited += stepMs) {
    await new Promise((r) => setTimeout(r, stepMs));
    if (await isUp(port)) return { state: 'started' };
  }
  return { state: 'failed', why: `起了服务进程，等了 ${waitMs / 1000} 秒端口 ${port} 上还不是进度页` };
}

/**
 * 起页面服务，只听 127.0.0.1。端口上已经是我们的进度页：说一声、退出码 0（开场可以放心重复跑）；
 * 被别的程序占着：退出码 1。返回 { code, server?, port? }。
 */
export function startServer({ port, home = homedir(), htmlFile, out, err }) {
  return new Promise((resolve) => {
    const server = createProgressServer({ home, htmlFile });
    server.once('error', async (e) => {
      if (e.code === 'EADDRINUSE') {
        if (await isOurs(port)) {
          out(`进度页已经在跑：http://127.0.0.1:${port}`);
          return resolve({ code: 0 });
        }
        err(`端口 ${port} 被别的程序占着（不是帅位进度页）：换一个，--port <端口> 或 FLEET_PROGRESS_PORT`);
        return resolve({ code: 1 });
      }
      err(`进度页起不来：${e.message}`);
      resolve({ code: 1 });
    });
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      out(`帅位进度页：http://127.0.0.1:${actual}（数据在 ${dataRoot(home)}）`);
      resolve({ code: 0, server, port: actual });
    });
  });
}
