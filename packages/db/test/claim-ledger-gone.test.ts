// 钉住认领账「代码不再读、表和列也删了」不会倒退（#556-4：PR-1 删代码引用，PR-2 迁移 0024 删表和列）。
// 创始人 2026-10-03 对话里回「选 1」同意删库表，但顺序有硬坑：deploy/release.sh 先跑迁移才切版本，
// 库表和「代码不读它」同一批改，上线那一刻老代码会当场报错。所以先删代码引用、上线之后再 DROP。
// 钉的内容：提醒的读链上不许再出现认领账的读取；schema 里的定义和 flow_* 列不在了；迁移 0024 里有对应的 DROP。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** 读认领账的人：这些文件里不许再 import / 查 issue_claims。 */
const READERS = [
  'packages/db/src/queries/alert-work.ts',
  'packages/store/src/alert-work.ts',
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
    // web-api.ts 拆分后（#901 ③）只是入口，ALERT_STAGES 在 web-api/notifications.ts；先确认读到的文件里真有它，不空扫
    const shared = read('packages/shared/src/web-api/notifications.ts');
    expect(shared).toMatch(/ALERT_STAGES\s*=/);
    expect(shared).not.toMatch(/ALERT_STAGES[\s\S]{0,300}'claimed'/);
    expect(shared).not.toMatch(/ALERT_STAGES[\s\S]{0,300}'engine_stuck'/);
  });

  it('表和列也删了（迁移 0024）：schema 里不再有定义，迁移里有对应的 DROP', () => {
    expect(existsSync(join(ROOT, 'packages/db/src/schema/seat.ts'))).toBe(false);
    const work = read('packages/db/src/schema/work.ts');
    expect(work).not.toMatch(/flow_(config|source|commit|synced_at|error|checked_at|unread)/);
    const mig = read('packages/db/migrations/0024_clammy_maestro.sql');
    for (const t of ['issue_claims', 'seat_boards', 'seat_leases'])
      expect(mig).toContain(`DROP TABLE "${t}"`);
    for (const c of [
      'flow_config',
      'flow_source',
      'flow_commit',
      'flow_synced_at',
      'flow_error',
      'flow_checked_at',
      'flow_unread',
    ])
      expect(mig, c).toContain(`ALTER TABLE "repos" DROP COLUMN "${c}"`);
    expect(mig).toContain('ALTER TABLE "tasks" DROP COLUMN "flow_source"');
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
