// 钉住认领账的本机脚本删干净了、技能说明里也不再指着它们（#446 脚本那半）。
// 创始人 2026-10-02 批的正是这半：「先做脚本和文档那半（改标准），库表删除等单独点头」。
// 改这个文件就是改规矩（packages/conventions/standard-paths.json: agents/test/rules/）。
// 为什么要钉：删了一半留个入口，下一个人照技能说明里的旧句子去找 claim.mjs，撞到的是一句
// 「找不到模块」——比没有更糟。库里那半（issue_claims 表、claim-status）另有单，不在这里管。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPTS = join(ROOT, 'agents', 'skills', 'commander', 'scripts');
const SKILL = join(ROOT, 'agents', 'skills', 'commander', 'SKILL.md');

/** #446 删掉的四份本机认领脚本；留着名字是为了不许它们回来。 */
const GONE = ['claim.mjs', 'doing.mjs', 'doing-lib.mjs', 'seat-lib.mjs'];
/** 这几份没删，必须还在（把删除做过头时这条会红）。 */
const KEPT = ['france.mjs', 'france-lib.mjs', 'server.mjs', 'worker.mjs', 'worker-lib.mjs'];

/** 技能说明里「叫你去跑某个脚本」的用法行：`node $S/<脚本> …` 或 `node <脚本> …`。 */
function scriptInvocations(text: string): string[] {
  return [...text.matchAll(/node\s+\$?S?\/?([\w.-]+\.mjs)/g)].map((m) => m[1] ?? '');
}

describe('规矩：认领账的本机脚本删了就别回来（#446）', () => {
  it('四份脚本都不在 scripts/ 里，剩下的脚本还在', () => {
    expect(GONE.filter((name) => existsSync(join(SCRIPTS, name)))).toEqual([]);
    for (const name of KEPT) expect(existsSync(join(SCRIPTS, name)), name).toBe(true);
  });

  it('技能说明里没有「去跑这几份脚本」的用法行；写成「删掉了」那一句留着', () => {
    const text = readFileSync(SKILL, 'utf8').replace(/\r\n/g, '\n');
    expect(scriptInvocations(text).filter((name) => GONE.includes(name))).toEqual([]);
    // 反过来：还活着的脚本照样给用法行（正则写死了也能被这条挡住）。
    expect(scriptInvocations(text)).toEqual(expect.arrayContaining(['france.mjs', 'worker.mjs']));
    // 说清楚它们被删了、别去调——不然下一个人只看到「少了两行」。
    expect(text).toMatch(/认领账和单上「在做」镜子整份删掉了（#446/);
    expect(text).toMatch(/别再去调这几个脚本/);
  });

  it('【故意造出的失败】把 claim.mjs 放回来、技能说明照旧给用法行：两条各拦得住', () => {
    // ① 文件回来：拿一份真在的脚本名冒充，断言「不在」这一条会红。
    const restored = ['worker.mjs'];
    expect(restored.filter((name) => existsSync(join(SCRIPTS, name)))).not.toEqual([]);
    // ② 说明退回去：塞一行旧用法，解析得出来、且相对现文只多这一条（不写死个数，现文怎么变都成立）。
    const stale = '\n- `node $S/claim.mjs show`：看认领。\n';
    expect(scriptInvocations(stale).filter((name) => GONE.includes(name))).toEqual(['claim.mjs']);
    expect(scriptInvocations(`abc${stale}`).length).toBe(scriptInvocations('abc').length + 1);
  });
});
