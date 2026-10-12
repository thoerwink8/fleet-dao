// 钉住通用段「在任何仓里干活」里两条（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json；决定 0081）。
// 2026-10-12 凌晨的断链（带货工作台仓）：创始人要「pnpm xxx 方式，可以命令启动」，AI 先给的是双击 start.cmd 加一串路径；
// 他说「这个非常重要……fleet-dao 应该也接收到，作为一个规则；但是显然没有这个意识，说明存在断链」。
// 断点：① 通用段没有「仓要给一条 pnpm 命令起最新版」这条，新仓的 AI 读不到；② 「各仓都用得上的规矩给 fleet-dao 开 PR」没有触发点，
// 「项目特有还是通用」默认落在项目一侧——同一个仓几小时里「不要让我记东西」说了两次（密钥要有历史、能随时换；要 pnpm 命令），两次都只记进了那个仓。
// 修法：通用段加入口那条；把默认翻过来（他说的原则、偏好默认各仓通用）；`pnpm progress:directive` 记完引导当场问一句通用吗。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIRECTIVE_SCOPE_HINT } from '../../../packages/conventions/src/directive-scope.ts';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const SHARED = read('../../shared-rules.md');
const PROGRESS_BIN = read('../../../packages/conventions/src/bin/progress.ts');

/** 通用段里必须写着的几条，缺了哪条就列出哪条。 */
const ENTRY_RULES: Record<string, RegExp> = {
  仓根package给pnpm入口: /能跑起来的仓，根 `package\.json` 给 `pnpm dev`/,
  四个命令都在: /`pnpm dev`（起最新版）、`start`、`stop`、`check`（交活前检查）/,
  写进README第一屏: /写进 README 第一屏/,
  没Node也放: /没 Node 也放个只有 `scripts` 的/,
  只记pnpm命令: /我只记 pnpm 命令，不记路径、软件和环境变量/,
};
const DEFAULT_SHARED_RULES: Record<string, RegExp> = {
  原则偏好默认通用: /（我说的原则、偏好默认各仓通用）/,
  当场开PR: /各仓都用得上的[^；]*当场给 fleet-dao 开 PR 改这一份，不横着抄/,
  只此仓的要写明: /只此仓有效的要我明说过，或在仓里记决定处写明为什么/,
};

function missing(rules: Record<string, RegExp>, text: string): string[] {
  return Object.entries(rules)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

/** 通用段「在任何仓里干活」那一节（到下一个 ## 为止） */
function anyRepoSection(text: string): string {
  const at = text.indexOf('## 在任何仓里干活');
  if (at < 0) throw new Error('通用段里认不出「## 在任何仓里干活」');
  const next = text.indexOf('\n## ', at + 1);
  return text.slice(at, next < 0 ? undefined : next);
}

/** bin/progress.ts 里 directive 分支那一段（到 claim 分支为止） */
function directiveBranch(src: string): string {
  const at = src.indexOf("cmd === 'directive'");
  const end = src.indexOf("cmd === 'claim'");
  if (at < 0 || end < at) throw new Error('bin/progress.ts 里认不出 directive 分支');
  return src.slice(at, end);
}

describe('规矩：仓根要有 pnpm 命令入口；创始人说的原则默认各仓通用（2026-10-12，决定 0081）', () => {
  it('「在任何仓里干活」里写着 pnpm 入口那条', () => {
    expect(missing(ENTRY_RULES, anyRepoSection(SHARED))).toEqual([]);
  });

  it('「在任何仓里干活」里写着「默认各仓通用」那半句', () => {
    expect(missing(DEFAULT_SHARED_RULES, anyRepoSection(SHARED))).toEqual([]);
  });

  it('pnpm progress:directive 记完引导当场问一句：各仓通用吗', () => {
    expect(DIRECTIVE_SCOPE_HINT).toMatch(/各仓通用吗/);
    expect(DIRECTIVE_SCOPE_HINT).toContain('`agents/shared-rules.md`');
    expect(DIRECTIVE_SCOPE_HINT).toMatch(/只此仓有效/);
    expect(directiveBranch(PROGRESS_BIN)).toMatch(/console\.log\(DIRECTIVE_SCOPE_HINT\)/);
  });

  it('【故意造出的失败】把 pnpm 入口那条整条拿掉：查得出来', () => {
    const cut = SHARED.replace(/- 能跑起来的仓[^\n]*\n/, '');
    expect(cut).not.toBe(SHARED);
    expect(missing(ENTRY_RULES, anyRepoSection(cut))).toEqual(Object.keys(ENTRY_RULES));
  });

  it('【故意造出的失败】入口退回「双击 start.cmd」、少了 start/stop：查得出来', () => {
    const cut = SHARED.replace(/、`start`、`stop`/, '、双击 `start.cmd`');
    expect(cut).not.toBe(SHARED);
    expect(missing(ENTRY_RULES, anyRepoSection(cut))).toEqual(['四个命令都在']);
  });

  it('【故意造出的失败】默认翻回「项目特有」（删掉默认通用那半句）：查得出来', () => {
    const cut = SHARED.replace(/（我说的原则、偏好默认各仓通用）/, '');
    expect(cut).not.toBe(SHARED);
    expect(missing(DEFAULT_SHARED_RULES, anyRepoSection(cut))).toEqual(['原则偏好默认通用']);
  });

  it('【故意造出的失败】directive 不再打那句提示：查得出来', () => {
    const cut = PROGRESS_BIN.replace(/\n\s*console\.log\(DIRECTIVE_SCOPE_HINT\);/, '');
    expect(cut).not.toBe(PROGRESS_BIN);
    expect(directiveBranch(cut)).not.toMatch(/console\.log\(DIRECTIVE_SCOPE_HINT\)/);
  });

  it('【故意造出的失败】认不出那一节、认不出 directive 分支：明确报错，不当成「都在」', () => {
    expect(() => anyRepoSection('# 没有这一节')).toThrow(/认不出「## 在任何仓里干活」/);
    expect(() => directiveBranch('// 没有分支')).toThrow(/认不出 directive 分支/);
  });
});
