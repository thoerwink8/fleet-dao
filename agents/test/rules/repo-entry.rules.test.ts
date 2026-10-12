// 钉住「仓合同」这条规矩（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json；决定 0081）。
// 2026-10-12 凌晨的断链（带货工作台仓）：创始人要「pnpm xxx 方式，可以命令启动」，AI 先给的是双击 start.cmd 加一串路径。
// 第一版（#1934 初稿）只加了一条长规矩和 progress:directive 上的一句提示，创始人看过不满意：「不应该限制在我们当前有的仓，
// 未来还会有其他仓呀……需要提醒的机制……好像也是存在断链的」，04:37 选了方案 B「只提醒不拦」。
// 规矩只是文字（AGENTS.md / CLAUDE.md 只是上下文，不是强制），所以这里钉的是机制，不只是文字：
// ① 合同写成数据（agents/repo-contract.json），首批四项；② 开会话钩子在任何仓里都按合同查、提醒；
// ③ 引导条目的〔范围：…〕由开会话的 checkDirectives 和收尾的 Stop 钩子提醒，只用 systemMessage、绝不拦；
// ④ 通用段几句话指到合同；⑤ fleet-dao 自己也过合同（不适用的写明豁免理由）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild, runChildOk } from '../child.ts';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const SHARED = read('../../shared-rules.md');
const CONTRACT_TEXT = read('../../repo-contract.json');
const SESSION_SRC = read('../../hooks/session-start.mjs');
const STOP_SRC = read('../../hooks/stop.mjs');
const PKG = JSON.parse(read('../../../package.json')) as { scripts: Record<string, string> };
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LIB_PATH = fileURLToPath(new URL('../../hooks/repo-contract.mjs', import.meta.url));
const STOP = fileURLToPath(new URL('../../hooks/stop.mjs', import.meta.url));

interface Item {
  id: string;
  检查: { type: string; path?: string; scripts?: string[]; 行?: { 认: string[] }[] };
}
interface Checked {
  id: string;
  status: string;
  reason?: string;
}
const lib = (await import(pathToFileURL(LIB_PATH).href)) as {
  parseContract(text: string): { ok: true; items: Item[] } | { ok: false; why: string };
  checkRepo(root: string, items: Item[]): Checked[];
  exitCodeOf(rs: Checked[]): number;
};
const session = (await import(
  pathToFileURL(fileURLToPath(new URL('../../hooks/session-start.mjs', import.meta.url))).href
)) as { DIRECTIVE_HEADING: string; TEMP_HEADING: string };

/** 合同里必须有的四项，缺了哪项、判法变了哪项就列出哪项 */
function contractProblems(text: string): string[] {
  const parsed = lib.parseContract(text);
  if (!parsed.ok) return [`合同读不出：${parsed.why}`];
  const by = Object.fromEntries(parsed.items.map((i) => [i.id, i]));
  const out: string[] = [];
  const entry = by.entry?.检查;
  if (
    entry?.type !== 'scripts' ||
    entry.path !== 'package.json' ||
    entry.scripts?.join() !== 'dev,start,stop,check'
  )
    out.push('entry');
  if (by['agents-md']?.检查.type !== 'file' || by['agents-md']?.检查.path !== 'AGENTS.md')
    out.push('agents-md');
  const prog = by.progress?.检查;
  const progHeads = (prog?.行 ?? []).map((l) => l.认[0]);
  // 和开会话钩子 checkDirectives、checkTemporary 现读的标题一字不差，不另起一套
  if (
    prog?.path !== 'docs/PROGRESS.md' ||
    !progHeads.includes(session.DIRECTIVE_HEADING) ||
    !progHeads.includes(session.TEMP_HEADING)
  )
    out.push('progress');
  const gi = by['gitignore-tmp']?.检查;
  if (gi?.path !== '.gitignore' || !(gi.行 ?? []).some((l) => l.认.includes('_tmp/')))
    out.push('gitignore-tmp');
  return out;
}

/** 开会话钩子真当主程序跑时，把合同检查接进去了 */
function sessionWired(src: string): boolean {
  const main = src.slice(src.indexOf('if (isMain())'));
  return (
    /repoContract:/.test(main) &&
    /\.\.\.\(repoContract \?/.test(src) &&
    /import \{[^}]*contractLines[^}]*\} from '\.\/repo-contract\.mjs'/.test(src)
  );
}
/** Stop 钩子把范围检查接进了「只提醒」那一路（systemMessage 的 notes），不是 decision */
function stopWired(src: string): boolean {
  const main = src.slice(src.indexOf('if (isMain())'));
  return /notes\.push\(scope\.systemMessage\)/.test(main) && /stopScopeCheck\(/.test(main);
}

const SHARED_RULES: Record<string, RegExp> = {
  指到合同: /`agents\/repo-contract\.json`/,
  入口四个命令: /`pnpm dev\/start\/stop\/check`/,
  钩子列缺项: /开会话钩子列缺项/,
  补用repo_init: /`pnpm repo:init`/,
  只记pnpm命令: /我只记 pnpm 命令，不记路径和软件/,
  原则默认通用: /我说的原则、偏好默认各仓通用/,
  引导标范围: /引导条目标〔范围：通用｜只此仓〕/,
};
function missing(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `repo-entry-rules-${name}-`));
  made.push(dir);
  return dir;
}

describe('规矩：仓合同（方案 B，只提醒不拦；决定 0081）', () => {
  it('合同写成数据，首批四项都在、判法对', () => {
    expect(contractProblems(CONTRACT_TEXT)).toEqual([]);
  });

  it('开会话钩子接上了合同检查；Stop 钩子把范围检查接在 systemMessage 那一路', () => {
    expect(sessionWired(SESSION_SRC)).toBe(true);
    expect(stopWired(STOP_SRC)).toBe(true);
  });

  it('fleet-dao 根 package.json 有 repo:check、repo:init，指向同一份逻辑', () => {
    expect(PKG.scripts['repo:check']).toBe('node agents/hooks/repo-contract.mjs check');
    expect(PKG.scripts['repo:init']).toBe('node agents/hooks/repo-contract.mjs init');
  });

  it('通用段「在任何仓里干活」几句话指到合同、默认通用、标范围', () => {
    expect(missing(SHARED_RULES, SHARED)).toEqual([]);
  });

  it('fleet-dao 自己也过合同：不适用的写明了豁免理由', () => {
    const parsed = lib.parseContract(CONTRACT_TEXT);
    if (!parsed.ok) throw new Error(parsed.why);
    const rs = lib.checkRepo(REPO_ROOT, parsed.items);
    expect(lib.exitCodeOf(rs), JSON.stringify(rs)).toBe(0);
    for (const r of rs.filter((x) => x.status === 'skipped')) expect(r.reason, r.id).toBeTruthy();
  });

  it('Stop 钩子真跑：新记的引导没标范围，只给 systemMessage，没有 decision、没有 hookSpecificOutput；同一会话第二次不说', {
    timeout: 0,
  }, () => {
    const dir = temp('repo');
    const g = (...a: string[]) => runChildOk('git', a, { cwd: dir });
    g('init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(
      join(dir, 'docs', 'PROGRESS.md'),
      '# 进度\n\n## 创始人引导（待处理）\n\n- 04:00「要 pnpm 命令」\n',
    );
    const state = temp('state');
    const env = {
      ...process.env,
      FLEET_UNATTENDED_DIR: state,
      FLEET_WORKERS_DIR: temp('workers'),
      FLEET_WORKER: '',
      CLAUDE_CODE_SESSION_ID: '',
      FLEET_MIRASIM_DIR: join(state, 'no-mirasim'),
    };
    const input = JSON.stringify({
      hook_event_name: 'Stop',
      cwd: dir,
      session_id: 'scope-rules-0001',
      stop_hook_active: false,
    });
    const first = runChild(process.execPath, [STOP], { input, env });
    expect(first.status).toBe(0);
    const out = JSON.parse(first.stdout.trim());
    expect(Object.keys(out)).toEqual(['systemMessage']);
    expect(out.systemMessage).toContain('〔范围：');
    expect(first.stdout).not.toContain('decision');
    expect(first.stdout).not.toContain('hookSpecificOutput');
    const second = runChild(process.execPath, [STOP], { input, env });
    expect(second.status).toBe(0);
    expect(second.stdout).not.toContain('范围');
  });

  it('【故意造出的失败】合同里拿掉 entry、progress 换了一套标题：查得出来', () => {
    const obj = JSON.parse(CONTRACT_TEXT) as { items: (Item & Record<string, unknown>)[] };
    obj.items = obj.items.filter((i) => i.id !== 'entry');
    const prog = obj.items.find((i) => i.id === 'progress');
    if (prog?.检查.行?.[0]) prog.检查.行[0].认 = ['## 待办'];
    expect(contractProblems(JSON.stringify(obj))).toEqual(['entry', 'progress']);
    expect(contractProblems('{坏的')[0]).toMatch(/合同读不出/);
  });

  it('【故意造出的失败】拿掉钩子接线（开会话不传 repoContract、Stop 不推范围提醒）：查得出来', () => {
    const cutSession = SESSION_SRC.replace(/\n\s*repoContract: [^\n]*\n/, '\n');
    expect(cutSession).not.toBe(SESSION_SRC);
    expect(sessionWired(cutSession)).toBe(false);
    const cutStop = STOP_SRC.replace(/notes\.push\(scope\.systemMessage\)/, 'void scope');
    expect(cutStop).not.toBe(STOP_SRC);
    expect(stopWired(cutStop)).toBe(false);
  });

  it('【故意造出的失败】Stop 范围提醒改成拦（decision:block）：接线判不过', () => {
    const blocking = STOP_SRC.replace(
      /notes\.push\(scope\.systemMessage\)/,
      "process.stdout.write(JSON.stringify({ decision: 'block', reason: scope.systemMessage }))",
    );
    expect(stopWired(blocking)).toBe(false);
  });

  it('【故意造出的失败】通用段退回只有文字的长规矩（#1934 初稿）：查得出来', () => {
    const s1 =
      '- 能跑起来的仓，根 `package.json` 给 `pnpm dev`（起最新版）、`start`、`stop`、`check`（交活前检查），写进 README 第一屏；没 Node 也放个只有 `scripts` 的。我只记 pnpm 命令，不记路径、软件和环境变量。';
    const cut = SHARED.replace(/- 仓要过 fleet-dao 的仓合同[^\n]*/, s1);
    expect(cut).not.toBe(SHARED);
    expect(missing(SHARED_RULES, cut)).toEqual([
      '指到合同',
      '入口四个命令',
      '钩子列缺项',
      '补用repo_init',
      '只记pnpm命令',
      '原则默认通用',
      '引导标范围',
    ]);
  });
});
