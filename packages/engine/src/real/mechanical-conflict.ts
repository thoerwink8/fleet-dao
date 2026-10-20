// 并主线冲突里「机械可解」的那几类，引擎自己解，不派模型会话（#3428，design 第十二节「冲突引擎先自己并」）。
//
// 改这里之前必须知道：
// - 名单只有 MECHANICAL_CONFLICT_RULES 一处。冲突文件全在名单里才整个解开；有名单外的文件，名单内的取主线版并暂存，
//   树停在没并完的合并上交给会话（reason 里写明哪些已经解掉、会话接着该做什么）。其他仓不认这些路径，名单里一个都没撞上就不动树。
// - 迁移只认 drizzle-kit 生成的：分支新增的迁移，快照（去掉 id、prevId）和上一版一模一样的是手写的（触发器之类），
//   不自己解；分支改过、删过已有迁移也不解。认得出才丢掉分支上的生成迁移、取主线的，在合好的树上重新生成。
// - 解完先自测（schema-drift 测试和 tsc）才推；没过就撤回这次机械解（树回到并之前），原因交给会话。没装依赖没法自测，不动。
// - 一切在会话的树里以会话用户的身份跑（经 UserTree.exec）。不抛业务上的「没解成」，回 declined；git 撤不回来才抛。

import { PortError } from '../ports.ts';
import type { ResolveConflictResult } from '../task-contract.ts';
import { digestOutput } from './self-check.ts';
import {
  GIT,
  gitInTree,
  hasCommit,
  headOf,
  mainlineRef,
  mergeInto,
  runInTree,
  SH,
  type UserTree,
} from './user-git.ts';

export const MIGRATIONS_DIR = 'packages/db/migrations';
export const MIGRATIONS_JOURNAL = `${MIGRATIONS_DIR}/meta/_journal.json`;
export const LOCKFILE = 'pnpm-lock.yaml';

export type MechanicalKind = 'migration' | 'lockfile';

/** 机械可解的冲突文件名单（唯一一处）。路径是仓根相对路径。 */
export const MECHANICAL_CONFLICT_RULES: readonly { kind: MechanicalKind; match: RegExp }[] = [
  { kind: 'migration', match: /^packages\/db\/migrations\/meta\/[^/]+\.json$/ },
  { kind: 'migration', match: /^packages\/db\/migrations\/\d{4}_[^/]+\.sql$/ },
  { kind: 'lockfile', match: /^pnpm-lock\.yaml$/ },
];

export function mechanicalKindOf(path: string): MechanicalKind | null {
  return MECHANICAL_CONFLICT_RULES.find((rule) => rule.match.test(path))?.kind ?? null;
}

/** 重新生成和自测用的命令（树根目录里跑）。 */
export const MECHANICAL_COMMANDS = {
  regenerate: 'pnpm --filter @fleet-dao/db db:generate',
  lockfile: 'pnpm install --lockfile-only',
  drift: 'node_modules/.bin/vitest run packages/db/test/schema-drift.test.ts',
  tsc: 'node_modules/.bin/tsc -b --pretty false',
  /** 有这两个才算装了依赖，能自测。 */
  deps: 'test -x node_modules/.bin/tsc && test -x node_modules/.bin/vitest',
  /** 在 packages/db 里跑，脚本（GENERATED_CHECK_SCRIPT）从标准输入进，参数是 idx:tag:prevIdx。 */
  generatedCheck: 'node --input-type=module -',
};

/** 迁移所在的包目录；生成核对在这里跑，drizzle-kit 从它的 node_modules 解析。 */
export const MIGRATIONS_PACKAGE = 'packages/db';

/**
 * 核「分支新增的迁移是纯生成的」：对每个新增迁移，用它的上一版快照和它自己的快照重新跑一遍 drizzle-kit 的生成，
 * 产物（语句之间用 drizzle-kit 写 .sql 时的分隔）和提交的 .sql 逐字节比。有一个不同打印 `MISMATCH <tag>`；
 * 全部比完打印 `CHECKED`。迁移目录默认 migrations，环境变量 MIG_DIR 可换（测试用）。
 */
export const GENERATED_CHECK_SCRIPT = [
  "import { readFileSync } from 'node:fs';",
  "import { generateMigration } from 'drizzle-kit/api';",
  "const dir = process.env.MIG_DIR || 'migrations';",
  "const pad = (n) => String(n).padStart(4, '0');",
  'for (const arg of process.argv.slice(2)) {',
  "  const [idx, tag, prevIdx] = arg.split(':');",
  "  const prev = JSON.parse(readFileSync(`${dir}/meta/${pad(prevIdx)}_snapshot.json`, 'utf8'));",
  "  const cur = JSON.parse(readFileSync(`${dir}/meta/${pad(idx)}_snapshot.json`, 'utf8'));",
  '  const statements = await generateMigration(prev, cur);',
  "  const made = statements.join('--> statement-breakpoint\\n');",
  "  const committed = readFileSync(`${dir}/${tag}.sql`, 'utf8');",
  '  if (made !== committed) console.log(`MISMATCH ${tag}`);',
  '}',
  "console.log('CHECKED');",
  '',
].join('\n');

/** 各条命令的限时（毫秒）。 */
export const MECHANICAL_TIMEOUTS_MS = {
  generatedCheck: 2 * 60_000,
  install: 5 * 60_000,
  regenerate: 5 * 60_000,
  drift: 10 * 60_000,
  tsc: 5 * 60_000,
};

/** 和 self-check.ts 一样：会话用户的 shell 里 node、pnpm、go 都在这条路径上。 */
const SHELL_PATH = '$HOME/.local/go/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin';

export interface MechanicalOptions {
  /** PR 现在的头，也必须是工作树的头。 */
  head: string;
  defaultBranch: string;
  /** 并主线时 GitHub 报的冲突文件。 */
  conflictFiles: readonly string[];
  /** 把并出来的提交推上去，回远端新头。起点（base）是 head。 */
  push: (t: UserTree, merged: string, base: string) => Promise<string>;
  /** 测试换命令。 */
  commands?: Partial<typeof MECHANICAL_COMMANDS>;
  /** 测试换限时；null 表示不设 PATH（夹具自己的 shell）。 */
  shellPath?: string | null;
  /** 长命令之间报活。 */
  heartbeat?: () => void;
}

const SHA40 = /^[0-9a-f]{40}$/;
const short = (sha: string) => sha.slice(0, 7);
const textOf = (r: { stdout: Buffer }) => r.stdout.toString('utf8');
const linesOf = (r: { stdout: Buffer }) =>
  textOf(r)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const declined = (
  reason: string,
  extra: { resolvedFiles?: string[]; inTree?: boolean } = {},
): ResolveConflictResult => ({
  state: 'declined',
  reason,
  ...extra,
});

/** 递归排序键，JSON 比较不受键序影响。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function snapshotShape(raw: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const { id: _id, prevId: _prevId, ...rest } = parsed;
  return canonical(rest);
}

interface JournalEntry {
  idx: number;
  tag: string;
}

function parseJournal(raw: string): JournalEntry[] {
  const parsed = JSON.parse(raw) as { entries?: JournalEntry[] };
  if (!Array.isArray(parsed.entries)) throw new Error('_journal.json 里没有 entries');
  return parsed.entries;
}

async function showFile(t: UserTree, rev: string, path: string): Promise<string> {
  const r = await gitInTree(t, ['show', `${rev}:${path}`], `读 ${short(rev)} 上的 ${path}`);
  return textOf(r);
}

/**
 * 分支新增的迁移是不是都是 drizzle-kit 生成的、没碰已有的。回要丢掉的文件（分支新增的 .sql 和快照）；
 * 认不出回一句原因（字符串）。
 */
async function planMigrations(
  t: UserTree,
  head: string,
  mainline: string,
  verify: (added: { idx: number; tag: string; prevIdx: number }[]) => Promise<string | null>,
): Promise<{ drop: string[] } | string> {
  const base = await gitInTree(t, ['merge-base', head, mainline], '找分支和主线的共同祖先', { allow: [1] });
  const mb = textOf(base).trim();
  if (base.code !== 0 || !SHA40.test(mb)) return '分支和主线找不到共同祖先，没法判迁移是谁加的';
  const diff = await gitInTree(
    t,
    ['diff', '--name-status', '--no-renames', mb, head, '--', MIGRATIONS_DIR],
    '看分支改了迁移目录里的什么',
  );
  const drop: string[] = [];
  for (const line of linesOf(diff)) {
    const [status, path] = line.split('\t');
    if (
      status === 'A' &&
      path &&
      /^packages\/db\/migrations\/(?:\d{4}_[^/]+\.sql|meta\/\d{4}_snapshot\.json)$/.test(path)
    ) {
      drop.push(path);
    } else if (status === 'M' && path === MIGRATIONS_JOURNAL) {
      // 分支往 journal 里加了条目：丢掉时整份取主线的
    } else {
      return `分支改动了迁移目录里不是新生成的文件（${line.replace('\t', ' ')}），不自己解`;
    }
  }
  try {
    const mine = parseJournal(await showFile(t, head, MIGRATIONS_JOURNAL));
    const known = new Set(parseJournal(await showFile(t, mb, MIGRATIONS_JOURNAL)).map((e) => e.tag));
    const pad = (n: number) => String(n).padStart(4, '0');
    const added: { idx: number; tag: string; prevIdx: number }[] = [];
    for (const [i, entry] of mine.entries()) {
      if (known.has(entry.tag)) continue;
      const prev = mine[i - 1];
      if (!prev) return `分支新增的迁移 ${entry.tag} 前面没有上一版快照，不自己解`;
      const own = snapshotShape(
        await showFile(t, head, `${MIGRATIONS_DIR}/meta/${pad(entry.idx)}_snapshot.json`),
      );
      const before = snapshotShape(
        await showFile(t, head, `${MIGRATIONS_DIR}/meta/${pad(prev.idx)}_snapshot.json`),
      );
      if (own === before)
        return `分支新增的迁移 ${entry.tag} 的快照和上一版一致，像是手写的（触发器之类），不自己解`;
      added.push({ idx: entry.idx, tag: entry.tag, prevIdx: prev.idx });
    }
    // 硬条件：快照比对只挡得住纯手写的；生成后又手改过 SQL 的（补 UPDATE/INSERT 之类）快照照样变，重生成会悄悄丢掉手改部分
    const mismatch = await verify(added);
    if (mismatch !== null) return mismatch;
  } catch (error) {
    return `读不懂分支的迁移记录（${error instanceof Error ? error.message : String(error)}），不自己解`;
  }
  return { drop };
}

/** 撤回：树回到并之前的 head。撤不回来抛，不装作撤了。 */
async function restore(t: UserTree, head: string): Promise<void> {
  try {
    await gitInTree(t, ['merge', '--abort'], '撤掉没并完的合并', { allow: [1, 128] });
    await gitInTree(t, ['reset', '--hard', '-q', head], `树回到 ${short(head)}`);
    await gitInTree(t, ['clean', '-fdq', '--', MIGRATIONS_DIR], '清掉重新生成留下的迁移文件');
  } catch (error) {
    throw new PortError(
      'GIT_FAILED',
      `机械解没成，撤回也没成（树里可能停在半截）：${error instanceof Error ? error.message : String(error)}`,
      { retryable: false },
    );
  }
}

export async function resolveMechanically(t: UserTree, o: MechanicalOptions): Promise<ResolveConflictResult> {
  const cmds = { ...MECHANICAL_COMMANDS, ...o.commands };
  const shellPath = o.shellPath === undefined ? SHELL_PATH : o.shellPath;
  const beat = () => o.heartbeat?.();
  const sh = async (script: string, timeoutMs: number) => {
    beat();
    const prefix = shellPath === null ? '' : `PATH=${shellPath}; export PATH; `;
    return runInTree(t, [t.sh ?? SH, '-c', `${prefix}unset FLEET_RUN_ID; ${script} 2>&1`], { timeoutMs });
  };

  // ---- 不动树就能判的
  if (o.conflictFiles.length === 0) return declined('');
  if (!o.conflictFiles.some((name) => mechanicalKindOf(name) !== null)) return declined('');
  const head = await headOf(t);
  if (head !== o.head) return declined(`工作树的头 ${short(head)} 不是 PR 的头 ${short(o.head)}，机械解没动`);
  if ((await runInTree(t, [t.git ?? GIT, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0) {
    return declined('树里已经有没并完的合并，机械解没动');
  }
  const dirty = await gitInTree(t, ['status', '--porcelain', '--untracked-files=no'], '看工作树干不干净');
  if (linesOf(dirty).length > 0) return declined('工作树里有没提交的改动，机械解没动');
  if ((await sh(cmds.deps, 30_000)).code !== 0) return declined('树里没装依赖，机械解完没法自测，没动');
  const pinned = await gitInTree(
    t,
    ['rev-parse', '--verify', '-q', `${mainlineRef(o.defaultBranch)}^{commit}`],
    '读树里钉住的主线',
    {
      allow: [1],
    },
  );
  const mainline = textOf(pinned).trim();
  if (pinned.code !== 0 || !SHA40.test(mainline) || !(await hasCommit(t, mainline))) {
    return declined('树里没有钉住的最新主线，机械解没动');
  }

  // ---- 并之前（树在分支头上、干净）判分支新增的迁移是不是纯生成的；不是就一点不动
  const verify = async (added: { idx: number; tag: string; prevIdx: number }[]): Promise<string | null> => {
    if (added.length === 0) return null;
    const args = added.map((a) => `${a.idx}:${a.tag}:${a.prevIdx}`).join(' ');
    beat();
    const prefix = shellPath === null ? '' : `PATH=${shellPath}; export PATH; `;
    const r = await runInTree(
      t,
      [
        t.sh ?? SH,
        '-c',
        `${prefix}unset FLEET_RUN_ID; cd ${MIGRATIONS_PACKAGE} && ${cmds.generatedCheck} ${args} 2>&1`,
      ],
      { timeoutMs: MECHANICAL_TIMEOUTS_MS.generatedCheck, stdin: Buffer.from(GENERATED_CHECK_SCRIPT) },
    );
    const out = textOf(r);
    const bad = /^MISMATCH (\S+)$/gm;
    const tags = [...out.matchAll(bad)].map((m) => m[1]);
    if (r.code === 0 && /^CHECKED$/m.test(out) && tags.length === 0) return null;
    if (tags.length > 0) {
      return `分支新增的迁移 ${tags.map((tag) => `${tag}.sql`).join('、')} 和用上一版快照重新生成的产物不是逐字节一致，像是生成后又手改过（比如补了 UPDATE/INSERT）；重新生成会丢掉手改的部分，不自己解`;
    }
    return `没能核对分支新增的迁移是不是纯生成的（${digestOutput(out, 400)}），不自己解`;
  };
  let plan: { drop: string[] } | undefined;
  if (o.conflictFiles.some((name) => mechanicalKindOf(name) === 'migration')) {
    try {
      const got = await planMigrations(t, head, mainline, verify);
      if (typeof got === 'string') return declined(got);
      plan = got;
    } catch (error) {
      return declined(
        `判分支的迁移没成：${error instanceof Error ? error.message : String(error)}，机械解没动`,
      );
    }
  }

  // ---- 并主线，看 git 报的冲突
  let merge: Awaited<ReturnType<typeof mergeInto>>;
  try {
    merge = await mergeInto(t, mainline);
  } catch (error) {
    await restore(t, head);
    return declined(`引擎并主线没成：${error instanceof Error ? error.message : String(error)}`);
  }
  if ('conflict' in merge && !merge.pending) {
    return declined(`并主线被工作树里的文件挡住：${merge.conflict.join('、')}（树没动）`);
  }
  const unmerged = 'conflict' in merge ? merge.conflict : [];
  const mech = unmerged.filter((name) => mechanicalKindOf(name) !== null);
  const others = unmerged.filter((name) => mechanicalKindOf(name) === null);
  if (unmerged.length > 0 && mech.length === 0) {
    await restore(t, head);
    return declined('');
  }

  // ---- 把名单内的解开
  const wantMigrations = mech.some((name) => mechanicalKindOf(name) === 'migration');
  const wantLockfile = mech.some((name) => mechanicalKindOf(name) === 'lockfile');
  try {
    if (wantMigrations) {
      if (plan === undefined) {
        // git 报的迁移冲突比 GitHub 报的多：并之前没核过分支的迁移，不凭空解
        await restore(t, head);
        return declined('git 报了迁移文件冲突，但并之前没核过分支的迁移是不是纯生成的，不自己解');
      }
      if (plan.drop.length > 0)
        await gitInTree(
          t,
          ['rm', '-f', '-q', '--ignore-unmatch', '--', ...plan.drop],
          '丢掉分支上生成的迁移',
        );
      await gitInTree(t, ['checkout', mainline, '--', MIGRATIONS_DIR], '迁移目录取主线的');
      await gitInTree(t, ['add', '-A', '--', MIGRATIONS_DIR], '暂存主线的迁移');
      const left = await gitInTree(
        t,
        ['diff', '--cached', '--quiet', mainline, '--', MIGRATIONS_DIR],
        '核迁移目录和主线一致',
        {
          allow: [1],
        },
      );
      if (left.code !== 0) {
        await restore(t, head);
        return declined('迁移目录取了主线的版本之后仍和主线不一致，撤回，不自己解');
      }
    }
    if (wantLockfile) {
      await gitInTree(t, ['checkout', mainline, '--', LOCKFILE], 'pnpm-lock.yaml 取主线的');
      await gitInTree(t, ['add', '--', LOCKFILE], '暂存主线的 pnpm-lock.yaml');
    }
  } catch (error) {
    await restore(t, head);
    return declined(`机械解中途没成：${error instanceof Error ? error.message : String(error)}`);
  }

  const resolvedFiles = mech;
  if (others.length > 0) {
    const todo = [
      wantMigrations
        ? '迁移已取主线版（你分支上原来生成的迁移已丢掉）：合好之后在树里跑 `pnpm --filter @fleet-dao/db db:generate` 重新生成'
        : '',
      wantLockfile ? 'pnpm-lock.yaml 已取主线版：合好之后跑 `pnpm install --lockfile-only`' : '',
    ].filter(Boolean);
    return declined(
      `名单外还有冲突文件（${others.join('、')}），引擎只解了名单内的 ${mech.join('、')}（已取主线版并暂存）。树里停在没并完的合并上，${todo.join('；')}，再 git add、提交。`,
      { resolvedFiles, inTree: true },
    );
  }

  // ---- 全解开了：重新生成、提交、自测、推
  const fail = async (what: string, out: { stdout: Buffer; code: number | null }) => {
    await restore(t, head);
    return declined(
      `机械解完${what}没过（${out.code === null ? '超时或没跑起来' : `退出码 ${out.code}`}），已撤回：${digestOutput(textOf(out), 1500)}`,
    );
  };
  try {
    if (wantLockfile) {
      const r = await sh(cmds.lockfile, MECHANICAL_TIMEOUTS_MS.install);
      if (r.code !== 0) return await fail('重跑 pnpm install --lockfile-only ', r);
      await gitInTree(t, ['add', '--', LOCKFILE], '暂存重新生成的 pnpm-lock.yaml');
    }
    if (wantMigrations) {
      const r = await sh(cmds.regenerate, MECHANICAL_TIMEOUTS_MS.regenerate);
      if (r.code !== 0) return await fail('重新生成迁移', r);
      await gitInTree(t, ['add', '-A', '--', MIGRATIONS_DIR], '暂存重新生成的迁移');
    }
    if ('conflict' in merge) await gitInTree(t, ['commit', '--no-edit', '-q'], '提交机械解开的合并');
    const merged = await headOf(t);
    const drift = await sh(cmds.drift, MECHANICAL_TIMEOUTS_MS.drift);
    if (drift.code !== 0) return await fail('schema-drift 自测', drift);
    const tsc = await sh(cmds.tsc, MECHANICAL_TIMEOUTS_MS.tsc);
    if (tsc.code !== 0) return await fail('tsc 自测', tsc);
    const fresh = linesOf(
      await gitInTree(
        t,
        ['diff', '--name-only', '--diff-filter=A', '--no-renames', mainline, merged, '--', MIGRATIONS_DIR],
        '看重新生成了哪些迁移',
      ),
    ).filter((name) => name.endsWith('.sql'));
    const pushed = await o.push(t, merged, head);
    const parts = [
      wantMigrations
        ? `迁移取主线的，在合好的树上重新生成${fresh.length > 0 ? `（${fresh.join('、')}）` : '（没有新迁移要生成）'}`
        : '',
      wantLockfile ? 'pnpm-lock.yaml 取主线的再 pnpm install --lockfile-only' : '',
    ].filter(Boolean);
    return {
      state: 'resolved',
      head: pushed,
      files: resolvedFiles,
      note: `引擎机械解开了 ${resolvedFiles.join('、')}：${parts.join('；')}；schema-drift 和 tsc 自测过了`,
    };
  } catch (error) {
    if (t.signal?.aborted) throw error;
    await restore(t, head);
    return declined(`机械解中途没成：${error instanceof Error ? error.message : String(error)}，已撤回`);
  }
}
