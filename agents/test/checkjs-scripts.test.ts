// 技能和钩子里的大 .mjs 脚本（被同步工具原样装到各台机器、纯 node 直接跑，不能改成 .ts）靠 JSDoc + checkJs 过严格 tsc。
// 这条测试钉住两件事：它们确实在 agents/tsconfig.json 的 files 里（少一个就等于没检查）、文件里没有盖住检查的写法。
// 为什么用 files 不用 include：packages/agents-sync/test/vendor-repo.test.ts 用 JSON.parse 读这份 tsconfig、钉着 include 只有 test
// （类型检查不碰第三方目录），所以这份配置不能带注释、include 不能动；`files` 是另一个口子，`tsc -b agents`（CI 和本机都跑它）照样检查。
// 类型本身对不对由 CI 的 `tsc -b agents` 判。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const AGENTS = join(import.meta.dirname, '..');

/** 已经纳入严格检查的脚本（相对 agents/）：一个脚本补完类型就加进来，同时加进 tsconfig 的 files。 */
const CHECKED = [
  'skills/commander/scripts/france-lib.mjs',
  'skills/commander/scripts/france-query.mjs',
  'skills/discuss/scripts/second-opinion.mjs',
  'skills/discuss/scripts/tools.mjs',
  'skills/discuss/scripts/walkthrough.mjs',
  'hooks/pretool.mjs',
  'hooks/fresh-main.mjs',
  'hooks/git-run.mjs',
  'hooks/unattended.mjs',
];

/** 盖住类型检查的写法：@ts-nocheck、@ts-expect-error、@ts-expect-error，和 JSDoc 里写 any。回命中的那几处。 */
function suppressions(text: string): string[] {
  const hits = text.match(/@ts-(?:nocheck|ignore|expect-error)|@\w+\s*\{[^\n}]*\bany\b[^\n}]*\}/g);
  return hits ?? [];
}

/** 该纳入却没在 files 里的脚本。 */
function notIncluded(listed: string[] | undefined, files: string[]): string[] {
  return files.filter((f) => !(listed ?? []).includes(f));
}

/** tsconfig 允许 // 注释：去掉整行注释再按 JSON 读。 */
function readTsconfig(): { compilerOptions?: Record<string, unknown>; files?: string[] } {
  const raw = readFileSync(join(AGENTS, 'tsconfig.json'), 'utf8');
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
}

describe('大脚本在严格类型检查里', () => {
  it('agents/tsconfig.json 开了 allowJs、checkJs，并把每个已纳入的脚本列进 files', () => {
    const cfg = readTsconfig();
    expect(cfg.compilerOptions?.allowJs).toBe(true);
    expect(cfg.compilerOptions?.checkJs).toBe(true);
    expect(notIncluded(cfg.files, CHECKED)).toEqual([]);
  });

  it('已纳入的脚本里没有 @ts-nocheck、@ts-ignore、@ts-expect-error，也没有 JSDoc 里的 any', () => {
    for (const file of CHECKED) {
      expect(suppressions(readFileSync(join(AGENTS, file), 'utf8')), file).toEqual([]);
    }
  });

  it('这道检查真拦得住：往脚本里加这些写法，会被认出来', () => {
    expect(suppressions('// @ts-nocheck\nconst a = 1;')).toEqual(['@ts-nocheck']);
    expect(suppressions('// @ts-ignore\n// @ts-expect-error')).toEqual(['@ts-ignore', '@ts-expect-error']);
    expect(suppressions('/** @param {any} x */\n/** @type {Map<string, any>} */')).toEqual([
      '@param {any}',
      '@type {Map<string, any>}',
    ]);
    expect(suppressions('/** @param {unknown} x */ // any 之类的话写在注释里不算')).toEqual([]);
  });

  it('files 里少了脚本会被认出来', () => {
    expect(notIncluded(['test'], CHECKED)).toEqual(CHECKED);
    expect(notIncluded(undefined, CHECKED)).toEqual(CHECKED);
  });
});
