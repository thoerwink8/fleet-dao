// 品牌：正式驾驶舱和演示版各一套名字、图标、说法。代码里统一 `import { brand } from '#brand'`：
// 正式构建按 package.json 的 imports 解析到 cockpit.tsx；演示版构建由 vite.config.ts 把 #brand 换成 demo.tsx——
// 正式那套名字根本不进演示版的包（打包后还有一道扫描兜底，见 src/build/scan.ts）。
import type { ComponentType } from 'react';

export interface Brand {
  /** cockpit = 正式驾驶舱；demo = 演示版（假数据、不连后端、换了一套名字）。 */
  kind: 'cockpit' | 'demo';
  /** 左上角、启动画面上的名字。 */
  name: string;
  /** 自己叫什么：页面上说到自己时用（「××启动中…」「谁能进××」）。 */
  product: string;
  /** 浏览器标签页标题：「看板 · …」；不给页面名就是整站的名字。 */
  title(page?: string): string;
  /** 浏览器本地存储的键名前缀（主题、当前仓、侧栏收起）。 */
  storagePrefix: string;
  Mark: ComponentType<{ className?: string }>;
  /** 标签页小图标（data: 地址）。 */
  favicon: string;
  /** 内部叫法在界面上的说法。 */
  terms: {
    /** 中转渠道这一类执行方式（执行方式编号 mirasim 的显示名）。 */
    relay: string;
    /** 判断题小模型出的题：「××判断题」。 */
    judgeQuiz: string;
    /** 侧栏上判断题记录页的名字。 */
    judgeNav: string;
    /** 定时起来诊断卡住的任务、调调度台的那个 AI 会话。 */
    marshal: string;
    /** 同上，句子里的短说法：「已交××诊断」。 */
    marshalShort: string;
  };
  /** 仓库里某个 PR、issue 的外链；演示版一律不给（不带任何外链）。 */
  repoLink(repo: { owner: string; name: string }, kind: 'pull' | 'issues', n: number): string | undefined;
}
