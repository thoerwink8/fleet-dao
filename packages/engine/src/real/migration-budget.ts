import { verifyMigrationBudget } from '@fleet-dao/db/migration-budget';
import { PortError } from '../ports.ts';
import type { LineBudgetMeasurement } from '../task-contract.ts';
import { describeFailure } from './exec.ts';
import { GIT, type UserTree } from './user-git.ts';

export const GENERATED_BUDGET_MAX_LINES = 20_000;
export const GENERATED_BUDGET_MAX_BYTES = 2 * 1024 * 1024;
const JOURNAL = 'packages/db/migrations/meta/_journal.json';
const MIGRATIONS = 'packages/db/migrations/';
// 候选不能同时改未来发布版的信任根并获得此根的折扣；不执行候选代码是另一条独立防线。
const TRUST_INPUTS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.pnpmfile.cjs',
  'packages/db/package.json',
  'packages/db/src/package.json',
  'packages/db/src/bin/package.json',
  'packages/db/src/migration-budget.ts',
  'packages/db/src/migration-budget-data.ts',
  'packages/db/src/bin/migration-budget.ts',
  'packages/engine/package.json',
  'packages/engine/src/package.json',
  'packages/engine/src/real/package.json',
  'packages/engine/src/workflows/package.json',
  'packages/engine/src/real/migration-budget.ts',
  'packages/engine/src/real/user-git.ts',
  'packages/engine/src/real/exec.ts',
  'packages/engine/src/real/task-activities.ts',
  'packages/engine/src/task-contract.ts',
  'packages/engine/src/limits.ts',
  'packages/engine/src/workflows/task.ts',
  'packages/engine/src/workflows/kit.ts',
]);
let sequence = 0;
function utf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return null;
  }
}

/** 只从钉住提交读 blob；读取错误抛出，只有明确不适用/产物验证失败回 raw。 */
export async function measureMigrationBudget(
  t: UserTree,
  mainline: string,
  head: string,
  rawAddedLines: number,
): Promise<LineBudgetMeasurement> {
  if (!/^[a-f0-9]{40}$/.test(mainline) || !/^[a-f0-9]{40}$/.test(head))
    throw new PortError('BAD_INPUT', '迁移预算要求完整 base/head');
  const read = async (args: string[], maxStdoutBytes = 1024 * 1024) => {
    const result = await t.exec({
      user: t.user,
      cwd: t.dir,
      argv: [t.git ?? GIT, '--no-replace-objects', '--no-pager', '-c', 'core.quotePath=false', ...args],
      timeoutMs: 15_000,
      maxStdoutBytes,
      scopeId: `${t.scopePrefix.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40)}-budget-${++sequence}`,
      env: { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
      ...(t.signal ? { signal: t.signal } : {}),
    });
    if (result.outputOverflow) return null;
    if (result.code !== 0)
      throw new PortError('GIT_FAILED', describeFailure('读取迁移预算固定提交', result), {
        retryable: !result.aborted,
      });
    return result.stdout;
  };
  const baseOut = await read(['merge-base', mainline, head]);
  const base = baseOut?.toString('utf8').trim() ?? '';
  if (!/^[a-f0-9]{40}$/.test(base)) throw new PortError('GIT_FAILED', '迁移预算 merge-base 读取不完整');
  const fallback = (reason: string, rawDiffBytes?: number): LineBudgetMeasurement => ({
    version: 1,
    base,
    head,
    rawAddedLines,
    verifiedGeneratedLines: 0,
    chargeableAddedLines: rawAddedLines,
    verified: false,
    reason,
    ...(rawDiffBytes === undefined ? {} : { rawDiffBytes }),
  });
  if (!Number.isSafeInteger(rawAddedLines) || rawAddedLines < 0)
    throw new PortError('GIT_FAILED', 'raw 新增行数无效');
  if (rawAddedLines > GENERATED_BUDGET_MAX_LINES) return fallback('raw 新增超过 20000 行，不适用自动折扣');
  const patch = await read(
    ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', base, head, '--'],
    GENERATED_BUDGET_MAX_BYTES,
  );
  if (!patch) return fallback('完整 patch 超过 2MiB，不适用自动折扣');
  const rawDiffBytes = patch.length;
  const names = await read(['diff', '--name-status', '-z', '--no-renames', base, head, '--']);
  if (!names) return fallback('完整变更清单超限，信任根未核实', rawDiffBytes);
  const parts = names.toString('utf8').split('\0');
  if (parts.pop() !== '' || parts.length % 2) throw new PortError('GIT_FAILED', '迁移文件清单形状不完整');
  const changed = new Map<string, string>();
  for (let i = 0; i < parts.length; i += 2) {
    const p = parts[i + 1] as string;
    if (TRUST_INPUTS.has(p) || p === '.gitattributes' || p.endsWith('/.gitattributes')) {
      return fallback(`候选改动信任根 ${p}，不适用快照折扣`, rawDiffBytes);
    }
    if (p.startsWith(MIGRATIONS)) changed.set(p, parts[i] as string);
  }
  if (changed.size !== 3 || changed.get(JOURNAL) !== 'M')
    return fallback('仅支持 journal 加一份新快照和一份新 SQL', rawDiffBytes);
  const snapshots = [...changed].filter(
    ([p, status]) => status === 'A' && /^packages\/db\/migrations\/meta\/\d{4}_snapshot\.json$/.test(p),
  );
  const sqls = [...changed].filter(
    ([p, status]) => status === 'A' && /^packages\/db\/migrations\/\d{4}_[a-zA-Z0-9_]+\.sql$/.test(p),
  );
  const snapshotPath = snapshots[0]?.[0],
    sqlPath = sqls[0]?.[0];
  if (snapshots.length !== 1 || sqls.length !== 1 || !snapshotPath || !sqlPath)
    return fallback('新增产物身份不明确', rawDiffBytes);
  const blob = async (sha: string, p: string) => {
    const mode = await read(['ls-tree', '-z', sha, '--', p]);
    if (!mode?.toString('utf8').startsWith('100644 blob ')) return null;
    return read(['show', `${sha}:${p}`]);
  };
  const baseJournal = await blob(base, JOURNAL),
    headJournal = await blob(head, JOURNAL);
  if (!baseJournal || !headJournal) return fallback('journal 不是有界普通文件', rawDiffBytes);
  const baseJournalText = utf8(baseJournal),
    headJournalText = utf8(headJournal);
  if (baseJournalText === null || headJournalText === null)
    return fallback('journal 不是有效 UTF-8', rawDiffBytes);
  let baseSnapshotPath: string;
  try {
    const parsed = JSON.parse(baseJournalText);
    const idx: unknown = parsed?.entries?.at(-1)?.idx;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx > 9999) throw new Error('idx');
    baseSnapshotPath = `packages/db/migrations/meta/${String(idx).padStart(4, '0')}_snapshot.json`;
  } catch {
    return fallback('base journal 未支持，未取候选指定的基线', rawDiffBytes);
  }
  const baseSnapshot = await blob(base, baseSnapshotPath),
    headSnapshot = await blob(head, snapshotPath),
    sql = await blob(head, sqlPath);
  if (!baseSnapshot || !headSnapshot || !sql) return fallback('迁移产物不是有界普通文件', rawDiffBytes);
  const baseSnapshotText = utf8(baseSnapshot),
    headSnapshotText = utf8(headSnapshot),
    sqlText = utf8(sql);
  if (baseSnapshotText === null || headSnapshotText === null || sqlText === null)
    return fallback('迁移产物不是有效 UTF-8，未做有损转换', rawDiffBytes);
  const stat = await read(['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', base, head, '--']);
  if (!stat) return fallback('完整 numstat 超限，未核快照在 raw 中的贡献', rawDiffBytes);
  const entries = stat.toString('utf8').split('\0');
  if (entries.pop() !== '') throw new PortError('GIT_FAILED', '完整 numstat 没有结束标记');
  let sum = 0,
    generatedLines: number | undefined;
  for (const entry of entries) {
    // -z 的 rename 是空 path 头再接旧/新两个path；初版整批退回raw，不能拿局部no-renames的数扣全局raw。
    if (/^(\d+|-)\t(\d+|-)\t$/.test(entry)) return fallback('改动含改名，暂不支持快照折扣', rawDiffBytes);
    const row = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
    if (!row) throw new PortError('GIT_FAILED', '完整 numstat 有无法识别的记录');
    if (row[1] !== '-') sum += Number(row[1]);
    if (row[3] === snapshotPath && row[1] !== '-' && row[2] === '0') generatedLines = Number(row[1]);
  }
  if (sum !== rawAddedLines || generatedLines === undefined || generatedLines > rawAddedLines)
    return fallback('新增快照行数未核实', rawDiffBytes);
  const checked = await verifyMigrationBudget(
    {
      baseJournal: baseJournalText,
      headJournal: headJournalText,
      baseSnapshot: baseSnapshotText,
      headSnapshot: headSnapshotText,
      sql: sqlText,
      snapshotPath,
      sqlPath,
    },
    t.signal ? { signal: t.signal } : {},
  );
  if (t.signal?.aborted) throw new PortError('GIT_FAILED', '迁移预算核验已取消', { retryable: false });
  if (!checked.verified) return fallback(checked.reason, rawDiffBytes);
  const verifiedGeneratedLines = generatedLines;
  return {
    version: 1,
    base,
    head,
    rawAddedLines,
    rawDiffBytes,
    verifiedGeneratedLines,
    chargeableAddedLines: rawAddedLines - verifiedGeneratedLines,
    verified: true,
    reason: '固定 base/head 的单份 PG7 快照与独立生成 SQL 完全相等；TS 漂移仍由 CI 检查',
  };
}
