// 演示版的包里要换掉的几处：vite.config.ts 的 demoRename 打包时照这张表换，换完由 scan.ts 再扫一遍（新冒出来的扫描会拦）。
// 只放源头改不了的：前后端共用的契约和规矩、第三方库里的字。自己界面上的说法走品牌（src/brand/）。
export const DEMO_RENAMES: readonly (readonly [RegExp, string])[] = [
  // 契约里绕不开的内部编号：执行方式的编号 mirasim 进了 zod 校验和假数据。
  // 整个演示版的包自成一体（假数据、不连后端），两头一起换不会对不上。
  [/\bmirasim\b/g, 'relay'],
  // 第三方库报错提示里带的 GitHub 地址（react-router 缺 URLSearchParams 时的提示）：演示版里一个 GitHub 地址都不留。
  [/https:\/\/github\.com\/ungap\/url-search-params/g, 'a URLSearchParams polyfill'],
  // 全局禁令的理由是本项目自己的规矩原话（packages/shared/src/bans.ts，前后端共用），拿一句去搜就能对上公开仓：
  // 换成意思一样的样例说法（演示版里照样按这两条禁令拦）。改了那边的原话，demo-renames.test.ts 会红。
  [/GPT 不做 UI 类活/g, 'GPT 族不接界面类的活'],
  [/不用 Fable（出比 5\.1 更高的版本之前）/g, 'Fable 暂不启用'],
];

export function demoRenamed(code: string): string {
  let out = code;
  for (const [re, to] of DEMO_RENAMES) out = out.replace(re, to);
  return out;
}
