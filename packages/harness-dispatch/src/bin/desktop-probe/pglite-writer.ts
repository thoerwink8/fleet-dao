// 桌面第 0 片实测 ②（#3868）的写入端：由 pglite-kill.ts 起、被它 taskkill /F 强杀。
// 用法：node packages/harness-dispatch/src/bin/desktop-probe/pglite-writer.ts <数据目录> <落盘确认文件> <写几轮，0 = 只检查>
// 开库（走 openLocalDb，同 local 档案：PGlite 落文件 + 迁移），先自检再写；自检结果打成一行 JSON：
//   {"opened":{"count":N,"maxSeq":M,"badBatches":K}}
// 写入分两种：单行 insert；一个事务里 5 行（批）。每次 commit 返回后才往确认文件追加 maxSeq，
// 所以"确认文件里的最大 seq"是肯定已经提交成功的下限。
import { appendFileSync, readFileSync } from 'node:fs';
import { openLocalDb } from '@fleet-dao/harness-store/local-db';

const [dir, ackFile, roundsRaw] = process.argv.slice(2);
if (!dir || !ackFile || roundsRaw === undefined) {
  console.error('用法：node pglite-writer.ts <数据目录> <确认文件> <轮数>');
  process.exit(2);
}
const rounds = Number(roundsRaw);
const STREAM = 'probe';

const store = await openLocalDb(dir);
const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await store.pg.query<T>(sql, params)).rows;

const [head] = await q<{ count: string; max: string | null }>(
  `select count(*)::text as count, max(seq)::text as max from fleet2.events where stream_id = $1`,
  [STREAM],
);
if (!head) throw new Error('自检查询没返回行');
const { count, max } = head;
// 批的原子性：每个批号的行数要么 0 要么等于它声明的 n
const bad = await q<{ batch: string }>(
  `select payload->>'batch' as batch from fleet2.events where stream_id = $1 and payload ? 'batch'
   group by payload->>'batch', (payload->>'n')::int having count(*) <> (payload->>'n')::int`,
  [STREAM],
);
const acked = (() => {
  try {
    return Number(readFileSync(ackFile, 'utf8').trim().split('\n').pop() || 0);
  } catch {
    return 0;
  }
})();
console.log(
  JSON.stringify({
    opened: { count: Number(count), maxSeq: Number(max ?? 0), badBatches: bad.length, acked },
  }),
);

let seq = Number(max ?? 0);
for (let i = 0; i < rounds; i++) {
  if (i % 4 === 3) {
    const batch = `${process.pid}-${i}`;
    await store.pg.transaction(async (tx) => {
      for (let k = 0; k < 5; k++) {
        await tx.query(
          `insert into fleet2.events (stream_id, seq, type, schema_version, payload) values ($1,$2,'probe',1,$3::jsonb)`,
          [STREAM, seq + 1 + k, JSON.stringify({ batch, n: 5, pad: 'x'.repeat(2000) })],
        );
      }
    });
    seq += 5;
  } else {
    await q(
      `insert into fleet2.events (stream_id, seq, type, schema_version, payload) values ($1,$2,'probe',1,$3::jsonb)`,
      [STREAM, seq + 1, JSON.stringify({ pad: 'x'.repeat(2000) })],
    );
    seq += 1;
  }
  appendFileSync(ackFile, `${seq}\n`);
  if (i === 0) console.log('writing');
}
await store.close();
