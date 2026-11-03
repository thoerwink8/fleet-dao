// 内核版本号（#3889）：构建时由 esbuild 的 define 把 __FLEET2_VERSION__ 换成字面量（probes/desktop/bundle-kernel.ts）。
// 不在运行时读源码旁的 package.json：打成单文件、装到别的目录后那个相对路径不存在。
// 没经构建（直接用 node 跑源码、测试）就是回退值，如实表明"不是打包产物"。
declare const __FLEET2_VERSION__: string | undefined;

export const UNBUILT_VERSION = '0.0.0-unbuilt';

/** 注入值优先（参数只为测试能不碰全局），其次构建期内联的常量，都没有就是回退值。 */
export function kernelVersion(injected?: string): string {
  if (injected) return injected;
  return typeof __FLEET2_VERSION__ === 'string' && __FLEET2_VERSION__ !== ''
    ? __FLEET2_VERSION__
    : UNBUILT_VERSION;
}
