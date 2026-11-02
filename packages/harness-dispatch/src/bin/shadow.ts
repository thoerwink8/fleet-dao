// 影子批次的人手命令（#3776）。配置同内核（环境变量），在法国上以 fleet 跑：
//   node packages/harness-dispatch/src/bin/shadow.ts freeze <批次号> [--allow-closed] <owner/仓#单号>…
// 基线取主线现在的提交；单要开着、不是 PR（--allow-closed 放行已关的，给已合并旧单的对照批用）。
// 只写 fleet2.shadow_batch_items；读 GitHub 只发 GET。输出一行 JSON。冻结后不改，要换单另起一批。
import type { Db } from '@fleet-dao/harness-store';
import * as schema from '@fleet-dao/harness-store/schema';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { appTokenSource } from '../github-app.ts';
import { githubReader } from '../github-read.ts';
import { freezeShadowRefs, parseShadowRef } from '../shadow-freeze.ts';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    console.error(`没给 ${k}`);
    process.exit(2);
  }
  return v;
};
const args = process.argv.slice(2);
const allowClosed = args.includes('--allow-closed');
const [cmd, batchId, ...refs] = args.filter((a) => a !== '--allow-closed');
if (cmd !== 'freeze' || !batchId || refs.length === 0) {
  console.error('用法：shadow.ts freeze <批次号> [--allow-closed] <owner/仓#单号>…');
  process.exit(2);
}

const sql = postgres(need('FLEET2_DATABASE_URL'), { max: 2, onnotice: () => {} });
const db = drizzle(sql, { schema }) as unknown as Db;
const gh = githubReader({ tokenFor: appTokenSource({ file: need('FLEET2_GITHUB_APP_FILE') }) });
try {
  const items = await freezeShadowRefs(db, gh, batchId, refs.map(parseShadowRef), { allowClosed });
  console.log(
    JSON.stringify({
      frozen: batchId,
      items: items.map((i) => ({ repo: i.repo, issue: i.issue, baseSha: i.baseSha })),
    }),
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
