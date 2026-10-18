// 钉住「仓合同」这条规矩（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 每个仓都该有 pnpm 命令入口，只提醒不拦。规矩文字只是上下文、不是强制，所以这里钉的是机制，不钉文字：
// ① 合同写成数据（agents/repo-contract.json），三项，补给新仓的 AGENTS.md 不提 AI 的事；② 开会话钩子在任何仓里都按合同查、提醒；
// ③ 收尾的 Stop 钩子不再提醒引导范围、不拦；④ fleet-dao 自己也过合同（不适用的写明豁免理由）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild, runChildOk } from '../child.ts';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const CONTRACT_TEXT = read('../../repo-contract.json');
const SESSION_SRC = read('../../hooks/session-start.mjs');
const PKG = JSON.parse(read('../../../package.json')) as { scripts: Record<string, string> };
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LIB_PATH = fileURLToPath(new URL('../../hooks/repo-contract.mjs', import.meta.url));
const STOP = fileURLToPath(new URL('../../hooks/stop.mjs', import.meta.url));

interface Item {
  id: string;
  检查: { type: string; path?: string; scripts?: string[]; 行?: { 认: string[]; 补?: string }[] };
  补法?: { text?: string };
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
/** 合同里必须有的三项、不该有的 progress 项：缺了哪项、判法变了哪项就列出哪项 */
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
  // 补给新自用仓的 AGENTS.md 带自用仓标记，只写项目本身的记法：不提 AI、fleet-dao、原话、引导（对外仓仓合同不管，决定 0107）
  const agents = by['agents-md'];
  if (
    agents?.检查.type !== 'file' ||
    agents.检查.path !== 'AGENTS.md' ||
    !agents.补法?.text?.includes('docs/decisions.md') ||
    !agents.补法.text.split('\n').includes('<!-- repo-kind: 自用仓 -->') ||
    /fleet-dao|AI|Claude|原话|引导|临时调整/.test(agents.补法.text)
  )
    out.push('agents-md');
  // 不再要各仓有 docs/PROGRESS.md 的引导清单和临时调整表：AI 运营的事只记 fleet-dao
  if (by.progress) out.push('progress');
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

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `repo-entry-rules-${name}-`));
  made.push(dir);
  return dir;
}

describe('规矩：仓合同（只提醒不拦）', () => {
  it('合同写成数据，三项都在、判法对，没有往各仓塞引导清单的 progress 项', () => {
    expect(contractProblems(CONTRACT_TEXT)).toEqual([]);
  });

  it('开会话钩子接上了合同检查', () => {
    expect(sessionWired(SESSION_SRC)).toBe(true);
  });

  it('fleet-dao 根 package.json 有 repo:check、repo:init，指向同一份逻辑', () => {
    expect(PKG.scripts['repo:check']).toBe('node agents/hooks/repo-contract.mjs check');
    expect(PKG.scripts['repo:init']).toBe('node agents/hooks/repo-contract.mjs init');
  });

  it('fleet-dao 自己也过合同：不适用的写明了豁免理由', () => {
    const parsed = lib.parseContract(CONTRACT_TEXT);
    if (!parsed.ok) throw new Error(parsed.why);
    const rs = lib.checkRepo(REPO_ROOT, parsed.items);
    expect(lib.exitCodeOf(rs), JSON.stringify(rs)).toBe(0);
    for (const r of rs.filter((x) => x.status === 'skipped')) expect(r.reason, r.id).toBeTruthy();
  });

  it('Stop 钩子真跑：新记的引导没标范围也不提醒，没有 decision、没有 hookSpecificOutput', {
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
    expect(first.stdout).not.toContain('范围');
    expect(first.stdout).not.toContain('decision');
    expect(first.stdout).not.toContain('hookSpecificOutput');
  });

  it('【故意造出的失败】合同里拿掉 entry、模板写回 AI 的事、加回 progress 项：查得出来', () => {
    const obj = JSON.parse(CONTRACT_TEXT) as { items: (Item & Record<string, unknown>)[] };
    obj.items = obj.items.filter((i) => i.id !== 'entry');
    const agents = obj.items.find((i) => i.id === 'agents-md');
    if (agents?.补法) agents.补法.text += '- 创始人引导、临时调整记在 docs/PROGRESS.md\n';
    obj.items.push({
      id: 'progress',
      说明: '旧的引导清单',
      检查: { type: 'lines', path: 'docs/PROGRESS.md', 行: [{ 认: ['## x'], 补: '\n## x\n' }] },
      补法: { type: 'append', 开头: '# 进度\n' },
    } as Item & Record<string, unknown>);
    expect(contractProblems(JSON.stringify(obj))).toEqual(['entry', 'agents-md', 'progress']);
    expect(contractProblems('{坏的')[0]).toMatch(/合同读不出/);
  });

  it('【故意造出的失败】拿掉钩子接线（开会话不传 repoContract）：查得出来', () => {
    const cutSession = SESSION_SRC.replace(/\n\s*repoContract: [^\n]*\n/, '\n');
    expect(cutSession).not.toBe(SESSION_SRC);
    expect(sessionWired(cutSession)).toBe(false);
  });
});
