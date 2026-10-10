/**
 * 标题转 URL 里的 slug：
 * - 先去掉重音符号（Café → Cafe），再全部转小写；
 * - 连续的非字母数字（空格、标点、下划线都算）合成一个 `-`；
 * - 头尾不留 `-`；
 * - 什么都不剩就返回 `untitled`。
 */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/^-/, '')
      .replace(/-$/, '') || 'untitled'
  );
}
