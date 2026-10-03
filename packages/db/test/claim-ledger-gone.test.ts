// 钉住认领账的「代码不再读它」这一半不会倒退（#556-4 的 PR-1：删代码引用；表和列留到 PR-2 的迁移才删）。
// 创始人 2026-10-03 对话里回「选 1」同意删库表，但顺序有硬坑：deploy/release.sh 先跑迁移才切版本，
// 库表和「代码不读它」同一批改，上线那一刻老代码会当场报错。所以先删代码引用、上线之后再 DROP。
// 这里钉的是 PR-1 的结果：下面这些源文件里不许再出现认领账的读取；schema 里的定义此刻还在（PR-2 才摘），要断言它还在，
// 免得有人把 PR-2 的活提前塞进来、又不带迁移，schema 和库对不上。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** 读认领账的人：这些文件里不许再 import / 查 issue_claims。 */
const READERS = [
  'packages/db/src/queries/alert-work.ts',
  'packages/api/src/alert-work.ts',
  'packages/core/src/alert-work.ts',
];

/** 代码里「用它」的写法：引入表对象、行类型、工厂函数。注释里提到名字不算。 */
const USES = [/\bissueClaims\b/, /\bIssueClaimRow\b/, /\bClaimRow\b/, /\btoIssueClaim\b/];

/** 去掉行注释和块注释，只看代码。 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function uses(text: string): string[] {
  const c = code(text);
  return USES.filter((re) => re.test(c)).map((re) => re.source);
}

describe('规矩：认领账代码不再读它（#556-4 PR-1）', () => {
  it('提醒的读链上，三个文件的代码里都没有认领账的用法', () => {
    for (const rel of READERS) expect(uses(read(rel)), rel).toEqual([]);
  });

  it('提醒阶段里没有「有人在修」这一档了', () => {
    const shared = read('packages/shared/src/web-api.ts');
    expect(shared).not.toMatch(/ALERT_STAGES[\s\S]{0,300}'claimed'/);
    expect(shared).not.toMatch(/ALERT_STAGES[\s\S]{0,300}'engine_stuck'/);
  });

  it('表的定义此刻还在 schema 里（PR-2 带迁移才摘，别提前摘）', () => {
    const schema = read('packages/db/src/schema/seat.ts');
    expect(schema).toMatch(/export const issueClaims = pgTable\(/);
    expect(schema).toMatch(/export const seatLeases = pgTable\(/);
    expect(schema).toMatch(/export const seatBoards = pgTable\(/);
  });

  it('【故意造出的失败】把读链塞回来：查得出来；注释里提名字不算', () => {
    // ① 代码里真用了：抓得到。
    expect(uses("import { issueClaims } from '../schema/index.ts';\nconst a = issueClaims;")).toEqual([
      '\\bissueClaims\\b',
    ]);
    expect(uses('export type X = IssueClaimRow;')).toEqual(['\\bIssueClaimRow\\b']);
    // ② 只在注释里提：不误报（现文件头注释就写着「issue_claims」「toIssueClaim」）。
    expect(uses('// 认领账（issue_claims）整张删了，不再有 toIssueClaim。\nconst a = 1;')).toEqual([]);
    expect(uses('/* issueClaims 已删 */\nconst a = 1;')).toEqual([]);
  });
});
