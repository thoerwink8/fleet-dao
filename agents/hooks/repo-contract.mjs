// 仓合同：每个仓（含以后新开的）都该满足的几项写成数据
// （agents/repo-contract.json），这里是查、补和开会话钩子用的提醒。和别的钩子一样被 agents-sync 整份拷进 ~/.fleet-dao/hooks/，
// 所以只用 node 自带的模块和同目录的钩子脚本，不依赖仓里的 TS。
// - 合同文件：在仓里是 agents/repo-contract.json（本文件的上一层）；装到机器上之后从同步专用检出 ~/.fleet-dao/origin-main 读
//   （永远停在 origin/main，开会话钩子每次都把它切到最新），所以合同一合进主线，各台机器下次开会话就按新的查。
// - 只管自用仓（repo-kind.mjs 判，决定 0107）：对外仓照它自己的规矩走，开会话不提醒，check 说一句不管、退出 0，init 拒绝、不写。
//   init --self 先在仓根 AGENTS.md 打上自用仓标记再补（没有 AGENTS.md 的由 agents-md 那项新建，模板里带标记）。
// - 命令行：node repo-contract.mjs check [仓路径]｜init [仓路径] [--self] [--dry-run]（fleet-dao 里是 pnpm repo:check / repo:init）。
//   不给路径就是当前目录；pnpm 跑的时候工作目录被换成 fleet-dao，认 INIT_CWD。check 退出码：全过 0、有缺 1、读不了或认不出 2。
//   init 只补缺的、绝不覆盖已有内容；入口脚本放占位（一跑就报 TODO、退出 1），占位不算 entry 通过。
// - 开会话（session-start.mjs）：contractLines，每个仓每天（北京时间）最多说一次缺项，全过一个字不说；读不了说一句没查成。
// 只读本地文件，不取远端、不问 GitHub；出错一律不抛给钩子。

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBroken, gitOk as ok } from './git-run.mjs';
import { hasSelfMark, repoKind, repoKindInfo, SELF_MARK } from './repo-kind.mjs';

/** 按 git 公共目录分仓的记号名：和 fresh-main.mjs 的 repoStampKey 同一种算法（测试钉着两边一致） */
export function stampKeyOf(commonDir) {
  const p = resolve(commonDir);
  const norm = process.platform === 'win32' ? p.toLowerCase() : p;
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url).replaceAll('\\', '/');
export const CONTRACT_FILE = 'repo-contract.json';
/** 同步专用检出（和 sync-source.mjs 的 syncDirIn 同一个，测试钉着） */
export const ORIGIN_MAIN_DIR = join('.fleet-dao', 'origin-main');
const SKIP_MARK = /<!--\s*repo-contract:skip\s+([\w-]+)([^>]*?)-->/g;
const CHECK_TYPES = new Set(['file', 'scripts', 'lines']);
const FIX_FOR = { file: 'create', scripts: 'placeholder-scripts', lines: 'append' };

/** 合同文件的候选位置：仓里（本文件上一层）、装到机器上之后的同步专用检出 */
export function contractPaths(home = homedir(), hookDir = HERE) {
  return [join(hookDir, '..', CONTRACT_FILE), join(home, ORIGIN_MAIN_DIR, 'agents', CONTRACT_FILE)];
}

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s);

/** 合同正文 → 各项；认不出的明确失败（哪一项、哪里不对），不跳过 */
export function parseContract(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { ok: false, why: `不是合法的 JSON（${e instanceof Error ? e.message : e}）` };
  }
  if (!isObj(obj) || !Array.isArray(obj.items) || obj.items.length === 0)
    return { ok: false, why: '认不出：要有非空的 items 数组' };
  const ids = new Set();
  for (const [k, it] of obj.items.entries()) {
    const at = `第 ${k + 1} 项`;
    if (!isObj(it) || typeof it.id !== 'string' || !/^[\w-]+$/.test(it.id))
      return { ok: false, why: `${at}认不出：缺 id` };
    if (ids.has(it.id)) return { ok: false, why: `${at}认不出：id ${it.id} 重复` };
    ids.add(it.id);
    if (typeof it.说明 !== 'string' || !it.说明) return { ok: false, why: `${it.id} 认不出：缺「说明」` };
    const c = it.检查;
    if (!isObj(c) || !CHECK_TYPES.has(c.type) || typeof c.path !== 'string' || !c.path)
      return { ok: false, why: `${it.id} 的「检查」认不出（类型只认 file、scripts、lines，要有 path）` };
    if (c.type === 'scripts' && (!strs(c.scripts) || typeof c.占位记号 !== 'string' || !c.占位记号))
      return { ok: false, why: `${it.id} 的 scripts 检查认不出：要有 scripts 和「占位记号」` };
    if (
      c.type === 'lines' &&
      !(
        Array.isArray(c.行) &&
        c.行.length > 0 &&
        c.行.every((l) => isObj(l) && strs(l.认) && typeof l.补 === 'string')
      )
    )
      return { ok: false, why: `${it.id} 的 lines 检查认不出：「行」每一组要有「认」和「补」` };
    const f = it.补法;
    if (!isObj(f) || f.type !== FIX_FOR[c.type])
      return { ok: false, why: `${it.id} 的「补法」认不出（${c.type} 配 ${FIX_FOR[c.type]}）` };
    if (f.type === 'create' && typeof f.text !== 'string')
      return { ok: false, why: `${it.id} 的「补法」缺 text` };
    if (
      f.type === 'placeholder-scripts' &&
      (typeof f.占位 !== 'string' || !f.占位.includes(c.占位记号 ?? '\0'))
    )
      return { ok: false, why: `${it.id} 的「补法」占位要带上占位记号` };
    if (f.type === 'append' && typeof f.开头 !== 'string')
      return { ok: false, why: `${it.id} 的「补法」缺「开头」` };
  }
  return { ok: true, items: obj.items };
}

/** 按候选位置读合同：第一个读得到的为准；都读不到、读到了认不出，明确失败 */
export function loadContract(paths, readText = (p) => readFileSync(p, 'utf8')) {
  const tried = [];
  for (const p of paths) {
    let text;
    try {
      text = readText(p);
    } catch (e) {
      tried.push(`${p}（${e?.code ?? e?.message ?? e}）`);
      continue;
    }
    const parsed = parseContract(text);
    if (!parsed.ok) return { ok: false, why: `${p} ${parsed.why}` };
    return { ok: true, items: parsed.items, path: p };
  }
  return { ok: false, why: `读不到合同：${tried.join('；')}` };
}

/** 真文件：读不到（不存在）给 null，别的错照抛（调用方报成认不出） */
export const realFs = {
  read(p) {
    try {
      return readFileSync(p, 'utf8');
    } catch (e) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  },
  write(p, text) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  },
};

const errText = (e) => e?.code ?? e?.message ?? String(e);

/** 仓根 AGENTS.md 里的豁免：id → 理由（没写理由是空字符串） */
function skipsOf(root, fs) {
  let text = null;
  try {
    text = fs.read(join(root, 'AGENTS.md'));
  } catch {
    // 读不了 AGENTS.md：agents-md 那一项自己会报认不出，这里当没有豁免
  }
  const out = new Map();
  for (const m of String(text ?? '').matchAll(SKIP_MARK)) out.set(m[1], m[2].trim());
  return out;
}

const trimLines = (text) => text.split(/\r?\n/).map((l) => l.trim());

/** 一项的真实状态（不看豁免） */
function judge(root, item, fs) {
  const c = item.检查;
  const file = join(root, c.path);
  let text;
  try {
    text = fs.read(file);
  } catch (e) {
    return { status: 'unknown', why: `读不了 ${c.path}（${errText(e)}）` };
  }
  if (text === null) return { status: 'missing', why: `没有 ${c.path}` };
  if (c.type === 'file') return { status: 'ok', why: '' };
  if (c.type === 'scripts') {
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch {
      return { status: 'unknown', why: `${c.path} 不是合法的 JSON，认不出` };
    }
    const scripts = isObj(pkg) && isObj(pkg.scripts) ? pkg.scripts : {};
    const absent = c.scripts.filter((n) => typeof scripts[n] !== 'string' || !scripts[n].trim());
    const held = c.scripts.filter((n) => !absent.includes(n) && scripts[n].includes(c.占位记号));
    if (absent.length === 0 && held.length === 0) return { status: 'ok', why: '' };
    const parts = [];
    if (absent.length > 0) parts.push(`${c.path} 缺脚本 ${absent.join('、')}`);
    if (held.length > 0) parts.push(`${held.join('、')} 还是 repo:init 放的占位`);
    return { status: 'missing', why: parts.join('；') };
  }
  const have = new Set(trimLines(text));
  const lacking = c.行.filter((l) => !l.认.some((w) => have.has(w)));
  if (lacking.length === 0) return { status: 'ok', why: '' };
  return { status: 'missing', why: `${c.path} 缺${lacking.map((l) => `「${l.认[0]}」`).join('')}` };
}

/** 查一个仓：每项 ok / missing / skipped / unknown；豁免写了理由才算数，没写理由照查并说出来 */
export function checkRepo(root, items, fs = realFs) {
  const skips = skipsOf(root, fs);
  return items.map((item) => {
    const base = { id: item.id, 说明: item.说明 };
    const reason = skips.get(item.id);
    if (reason) return { ...base, status: 'skipped', why: '', reason };
    const r = { ...base, ...judge(root, item, fs) };
    return reason === '' ? { ...r, note: '豁免没写理由，不算数' } : r;
  });
}

/** 全过（含写了理由的豁免）0；有缺 1；有认不出 2 */
export function exitCodeOf(results) {
  if (results.some((r) => r.status === 'unknown')) return 2;
  return results.some((r) => r.status === 'missing') ? 1 : 0;
}

const MARK = { ok: '✓', missing: '✗', skipped: '–', unknown: '?' };

export function formatReport(root, results) {
  const lines = [`仓合同（agents/repo-contract.json）：${root}`];
  for (const r of results) {
    const tail =
      r.status === 'ok'
        ? ''
        : r.status === 'skipped'
          ? `豁免：${r.reason}`
          : `${r.status === 'unknown' ? '认不出：' : ''}${r.why}`;
    lines.push(`  ${MARK[r.status]} ${r.id}${tail ? `：${tail}` : ''}${r.note ? `（${r.note}）` : ''}`);
  }
  const code = exitCodeOf(results);
  lines.push(
    code === 0
      ? '结论：都过了。'
      : code === 1
        ? '结论：有缺项。只补缺的：repo:init。'
        : '结论：有读不了、认不出的，没查全。',
  );
  return lines.join('\n');
}

/** 缩进按原文件第二行猜，猜不出用两个空格 */
function indentOf(text) {
  const m = /\n([ \t]+)\S/.exec(text);
  return m ? m[1] : 2;
}

const withNewline = (text) => (text === '' || text.endsWith('\n') ? text : `${text}\n`);

/** 要补什么：只补缺的（豁免了的、已经过的不碰）；认不出的那项不动、列进 blocked */
export function planInit(root, items, fs = realFs) {
  const actions = [];
  const blocked = [];
  for (const r of checkRepo(root, items, fs)) {
    if (r.status === 'ok' || r.status === 'skipped') continue;
    const item = items.find((i) => i.id === r.id);
    if (r.status === 'unknown') {
      blocked.push({ id: r.id, why: r.why });
      continue;
    }
    const c = item.检查;
    const f = item.补法;
    const path = join(root, c.path);
    const text = fs.read(path);
    if (f.type === 'create') {
      if (text === null)
        actions.push({ id: r.id, path, kind: 'create', text: f.text, what: `新建 ${c.path}` });
    } else if (f.type === 'placeholder-scripts') {
      const pkg = text === null ? { name: basename(root), private: true } : JSON.parse(text);
      const scripts = isObj(pkg.scripts) ? pkg.scripts : {};
      const add = c.scripts.filter((n) => !(n in scripts));
      if (add.length === 0) continue; // 都在（含占位、空的）：不覆盖，留给人填
      pkg.scripts = {
        ...scripts,
        ...Object.fromEntries(add.map((n) => [n, f.占位.replaceAll('{name}', n)])),
      };
      const out = `${JSON.stringify(pkg, null, text === null ? 2 : indentOf(text))}\n`;
      actions.push({
        id: r.id,
        path,
        kind: text === null ? 'create' : 'add-scripts',
        text: out,
        what: `${text === null ? '新建' : '补进'} ${c.path} 的占位脚本 ${add.join('、')}`,
      });
    } else {
      const have = new Set(trimLines(text ?? ''));
      const lacking = c.行.filter((l) => !l.认.some((w) => have.has(w)));
      if (lacking.length === 0) continue;
      const added = lacking.map((l) => l.补).join('');
      const out =
        text === null
          ? `${f.开头}${f.开头 ? added : added.replace(/^\n/, '')}`
          : `${withNewline(text)}${added}`;
      actions.push({
        id: r.id,
        path,
        kind: text === null ? 'create' : 'append',
        text: out,
        what: `${text === null ? '新建' : '往后补'} ${c.path}：${lacking.map((l) => l.认[0]).join('、')}`,
      });
    }
  }
  return { actions, blocked };
}

/**
 * repo:init --self：仓根 AGENTS.md 在、没有自用仓标记时往后补一行标记；没有 AGENTS.md 的由 agents-md 那项新建（模板里带标记）。
 * 已经标了的回 null。
 */
export function selfMarkAction(root, fs = realFs) {
  const path = join(root, 'AGENTS.md');
  const text = fs.read(path);
  if (text === null || hasSelfMark(root, () => text)) return null;
  return {
    id: 'repo-kind',
    path,
    kind: 'append',
    text: `${withNewline(text)}\n${SELF_MARK}\n`,
    what: `往后补 AGENTS.md：自用仓标记 ${SELF_MARK}`,
  };
}

export function applyInit(_root, plan, fs = realFs) {
  for (const a of plan.actions) fs.write(a.path, a.text);
}

export function formatPlan(root, plan, dryRun) {
  const lines = [`repo:init${dryRun ? '（--dry-run，只列不写）' : ''}：${root}`];
  if (plan.actions.length === 0) lines.push('  没有要补的。');
  for (const a of plan.actions) lines.push(`  ${dryRun ? '会' : '已'}${a.what}`);
  for (const b of plan.blocked) lines.push(`  ? ${b.id} 认不出，没动：${b.why}`);
  return lines.join('\n');
}

/** 北京时间的今天，YYYY-MM-DD（和 session-start.mjs 的 beijingToday 一样） */
function beijingDay(now) {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * 开会话那一段：会话所在仓按合同查，有缺项说一段事实（缺什么、怎么补、怎么豁免）；每个仓每天最多一次，记号在
 * ~/.fleet-dao/repo-contract/<仓的 git 公共目录的指纹>（和 session-net、fetch-ok 同一种分仓法），内容是那一天。
 * 全过不出声；不是 git 仓不出声；git 跑不起来不出声（同步那一句会说 git 的毛病）；合同读不到、钩子自己出错说一句没查成。
 */
export function contractLines({ cwd, git, home, now = Date.now(), hookDir = HERE, readText = undefined }) {
  try {
    // 一次 git 拿到仓根和公共目录（Windows 上起一次 git 就要几十毫秒，开会话钩子每条消息都跑）
    const top = git(cwd, ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir']);
    if (gitBroken(top) || !ok(top)) return [];
    const [root, common] = top.stdout.split(/\r?\n/).map((s) => s.trim());
    // 对外仓照它自己的规矩走，仓合同不提醒（决定 0107）；判不出来的那句提醒归 repo-kind.mjs
    if (!root || repoKind(root, { git }) === 'external') return [];
    const key = common && isAbsolute(common) ? stampKeyOf(common) : null;
    const stamp = key ? join(home, '.fleet-dao', 'repo-contract', key) : null;
    const today = beijingDay(now);
    if (stamp) {
      try {
        if (readFileSync(stamp, 'utf8').trim() === today) return [];
      } catch {
        // 没记过：今天还没说过
      }
    }
    const mark = () => {
      if (!stamp) return;
      try {
        mkdirSync(dirname(stamp), { recursive: true });
        writeFileSync(stamp, `${today}\n`);
      } catch {
        // 记不下只是今天可能多说一次
      }
    };
    const contract = loadContract(contractPaths(home, hookDir), readText);
    mark();
    if (!contract.ok) return [`仓合同没查成：${contract.why}。这个仓合不合规不知道。`];
    const rs = checkRepo(root, contract.items);
    const bad = rs.filter((r) => r.status === 'missing' || r.status === 'unknown');
    if (bad.length === 0) return [];
    const listed = bad.map(
      (r) => `${r.id}（${r.status === 'unknown' ? '认不出：' : ''}${r.why}${r.note ? `；${r.note}` : ''}）`,
    );
    return [
      `这个仓（${root.replaceAll('\\', '/')}）按 fleet-dao 的仓合同（agents/repo-contract.json）还缺：${listed.join('；')}。` +
        `补法是 node "${SELF}" init "${root.replaceAll('\\', '/')}"（只补缺的、不覆盖已有内容；fleet-dao 里是 pnpm repo:init），入口脚本补的是占位，要填上真正的命令。` +
        '某项不适用的，仓根 AGENTS.md 写一行 <!-- repo-contract:skip <id> <理由> -->。这条每个仓每天只说一次。',
    ];
  } catch (e) {
    return [`仓合同没查成：钩子自己出错了（${errText(e)}）。`];
  }
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const [cmd, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes('--dry-run');
  const markSelf = rest.includes('--self');
  const arg = rest.find((a) => !a.startsWith('--'));
  const base = process.env.INIT_CWD || process.cwd();
  const root = arg ? (isAbsolute(arg) ? arg : resolve(base, arg)) : base;
  const usage =
    '用法：repo:check [仓路径]｜repo:init [仓路径] [--self] [--dry-run]（不给路径就是当前目录；--self 先标成自用仓，创始人说了是自用仓才加）';
  if (cmd !== 'check' && cmd !== 'init') {
    console.error(usage);
    process.exit(2);
  }
  try {
    if (!statSync(root).isDirectory()) throw new Error('不是目录');
  } catch (e) {
    console.error(`仓路径 ${root} 读不了（${errText(e)}）。`);
    process.exit(2);
  }
  const contract = loadContract(contractPaths());
  if (!contract.ok) {
    console.error(`仓合同没查成：${contract.why}`);
    process.exit(2);
  }
  // 对外仓照它自己的规矩走：仓合同不查、不补（决定 0107）。check 退出 0（没有要查的），init 拒绝、一个字不写
  const kind = markSelf && cmd === 'init' ? null : repoKindInfo(root);
  if (kind && kind.kind === 'external') {
    console.log(
      `${root} 是对外仓（${kind.why}）：仓合同不管对外仓，照那个仓自己的规矩走，什么都没动。` +
        '创始人说了它是自用仓，先 pnpm repo:kind self 记下（或 repo:init <仓路径> --self 在 AGENTS.md 打标记）再补。',
    );
    process.exit(cmd === 'check' ? 0 : 1);
  }
  if (cmd === 'check') {
    const rs = checkRepo(root, contract.items);
    console.log(formatReport(root, rs));
    process.exit(exitCodeOf(rs));
  }
  const plan = planInit(root, contract.items);
  const mark = markSelf ? selfMarkAction(root) : null;
  if (mark) plan.actions.unshift(mark);
  if (!dryRun) applyInit(root, plan);
  console.log(formatPlan(root, plan, dryRun));
  const after = dryRun ? null : checkRepo(root, contract.items).find((r) => r.id === 'entry');
  if (after && after.status === 'missing' && /占位/.test(after.why))
    console.log('入口脚本是占位：填上这个仓真正的启动方式（dev、start、stop、check）才算 entry 通过。');
  process.exit(plan.blocked.length > 0 ? 2 : 0);
}
