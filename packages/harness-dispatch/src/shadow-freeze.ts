// 冻结影子批次的正式入口（#3776）：人给一串「owner/仓#单号」，逐张读 GitHub（只读）确认单在、不是 PR，
// 基线取主线现在的提交，整批一次经 freezeBatch 写进 fleet2.shadow_batch_items（冻结后不改）。
// 只写 fleet2 自己的影子库；旧生产表和 GitHub 一律只读。
import { type BatchItem, type Db, freezeBatch } from '@fleet-dao/harness-store';

export interface ShadowFreezeReader {
  issueFacts(repo: string, issue: number): Promise<{ open: boolean; isPr: boolean }>;
  headSha(repo: string, branch: string): Promise<string>;
}

export interface ShadowRef {
  repo: string;
  issue: number;
}

const REF = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

/** 「owner/仓#号」→ 结构；写法不对抛错，不猜。 */
export function parseShadowRef(s: string): ShadowRef {
  const m = REF.exec(s);
  if (!m) throw new Error(`单号写法不对（要 owner/仓#号）：${s}`);
  return { repo: m[1] as string, issue: Number(m[2]) };
}

export interface FreezeOptions {
  /** 允许已经关了的单（冻结「已合并旧单」的对照批）；默认只收开着的单。 */
  allowClosed?: boolean;
  now?: () => Date;
}

/** 读齐再写：任何一张单不合格整批都不冻结；同一张单在入参里写两遍也拒。 */
export async function freezeShadowRefs(
  db: Db,
  gh: ShadowFreezeReader,
  batchId: string,
  refs: readonly ShadowRef[],
  opts: FreezeOptions = {},
): Promise<BatchItem[]> {
  if (!/^[\w.-]{1,64}$/.test(batchId)) throw new Error(`批次号写法不对：${batchId}`);
  if (refs.length === 0) throw new Error('没给单号，不冻结空批次');
  const seen = new Set<string>();
  const shas = new Map<string, string>();
  const items: BatchItem[] = [];
  for (const r of refs) {
    const key = `${r.repo}#${r.issue}`;
    if (seen.has(key)) throw new Error(`${key} 写了两遍`);
    seen.add(key);
    const facts = await gh.issueFacts(r.repo, r.issue);
    if (facts.isPr) throw new Error(`${key} 是 PR，不是单`);
    if (!facts.open && !opts.allowClosed) throw new Error(`${key} 已经关了（对照批要 --allow-closed）`);
    let sha = shas.get(r.repo);
    if (!sha) {
      sha = await gh.headSha(r.repo, 'main');
      shas.set(r.repo, sha);
    }
    items.push({
      repo: r.repo,
      issue: r.issue,
      baseSha: sha,
      snapshotAt: (opts.now ?? (() => new Date()))(),
    });
  }
  await freezeBatch(db, batchId, items);
  return items;
}
