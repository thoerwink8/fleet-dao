// 品牌：驾驶舱的名字、图标、说法。代码里统一 `import { brand } from '#brand'`，按 package.json 的 imports 解析到 cockpit.tsx。
import type { ComponentType } from 'react';

export interface Brand {
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
    /** Claude 订阅里多人共用的那一类账号（切号：额度用满自动切到另一类）。 */
    carpool: string;
    /** Claude 订阅里自己专用的那一类账号。 */
    solo: string;
  };
  /**
   * 调度台里转述本项目规矩的两条阶段说明。
   */
  stageHints: { triage: string; ui: string };
  /** 仓库里某个 PR、issue 的外链；不给就只显示文字。 */
  repoLink(repo: { owner: string; name: string }, kind: 'pull' | 'issues', n: number): string | undefined;
}
