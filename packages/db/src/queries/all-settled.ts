/**
 * 并行几条库查询，都落定再返回；有失败的，抛第一条（按传入顺序）的错。db 包里并行查询一律用它，不用 Promise.all
 * （test/static.test.ts 拦着）。
 *
 * 为什么（#2181、#2261）：Promise.all 一条失败就立刻返回，其余查询还在别的连接上跑、占着连接和表锁；调用方紧接着的写或清表
 * （如测试的 resetTestDb TRUNCATE）和残留的查询交叉等锁，真 Postgres 报 deadlock detected（PGlite 单连接排队，撞不上）。
 * 这里等全部落定才返回，调用方拿到结果或错误时，这一批查询都已经结束。
 */
export async function allSettledOrThrow<const T extends readonly unknown[]>(
  promises: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const settled = await Promise.allSettled(promises);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failed) throw failed.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<unknown>).value) as {
    -readonly [K in keyof T]: Awaited<T[K]>;
  };
}
