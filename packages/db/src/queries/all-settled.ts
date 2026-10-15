/**
 * 等全部落地再返回；有失败的，抛第一条（按传入顺序）的错。
 * 和 Promise.all 的区别：不会提前返回、把还在跑的查询留在别的连接上占着锁（#2181）。
 * 一条先失败就返回时，其余查询还握着表锁，紧接着的写或清表会交叉等锁，真 Postgres 报 deadlock detected。
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
