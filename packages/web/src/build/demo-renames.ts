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
  [/不用 Fable（创始人定）/g, 'Fable 暂不启用'],
  // 路由用途的显示名在 shared/flow-purposes.ts，路由页和选路读同一份，正式版必须叫「Jev 判断」。
  // 演示版改不了这份源头；短名整词进包会被 scan.ts 拦住。换成演示版里判断题那一格的说法。
  // 改了那边的原话，demo-renames.test.ts 会红。
  [/Jev 判断/g, '判断题'],
];

export function demoRenamed(code: string): string {
  let out = code;
  for (const [re, to] of DEMO_RENAMES) out = out.replace(re, to);
  return out;
}
