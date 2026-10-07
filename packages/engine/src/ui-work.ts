// 一张单算不算「界面活」（改到了页面代码）：验收冷调用选路用它决定传不传 `uiWork`（选路的硬禁令 gpt-no-ui，GPT 不做界面、不审界面）。
//
// 判的依据是 PR 改到的文件名单（和验收会话看到的是同一份）：文件名纯代码就能判，不起模型。
// 认不出（名单是空的、有文件名读不成字符串）按界面活处理，调用方要把「没认出」写进验收 notes：宁可这一回不派 GPT，
// 也不把认不出当成「不是界面」放过去。
//
// 判法的来历：Fusion 时代按流程配置里的 uiPaths 判（core 的 filesUnder），Fusion 删掉时 uiPaths 一起没了，任务工作流的动手段
// 没有接过这一层。这里先用一份写在代码里的页面代码路径顶着；以后要按项目配置，把下面两份名单换成读配置，调用点不用动。

/** 整个目录都算页面代码的路径前缀（驾驶舱前端、健康页等静态页）。 */
export const PAGE_CODE_PREFIXES: readonly string[] = ['packages/web/', 'deploy/web/'];

/** 不管在哪个目录，这些后缀一律算页面代码。 */
export const PAGE_CODE_EXTENSIONS: readonly string[] = [
  '.tsx',
  '.jsx',
  '.css',
  '.scss',
  '.html',
  '.vue',
  '.svelte',
];

export interface UiJudgement {
  /** 按界面活处理（认出是界面活，或没认出）。 */
  uiWork: boolean;
  /** 认出来了吗：false = 名单读不成，`uiWork` 是按「宁可不派 GPT」兜底定的。 */
  recognized: boolean;
  /** 给人看的一句：为什么这么判。 */
  why: string;
}

/** 验收 notes 里写的那一句（认不出时）。 */
export const UI_UNRECOGNIZED_NOTE = '没认出是不是界面活，按界面活处理';

function isPageCode(file: string): boolean {
  const path = file.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  if (PAGE_CODE_PREFIXES.some((p) => path.startsWith(p))) return true;
  return PAGE_CODE_EXTENSIONS.some((e) => path.endsWith(e));
}

export function judgeUiWork(files: readonly unknown[]): UiJudgement {
  if (files.length === 0) {
    return { uiWork: true, recognized: false, why: '改到的文件名单是空的，判不出' };
  }
  const names: string[] = [];
  for (const f of files) {
    if (typeof f !== 'string' || f.trim() === '') {
      return { uiWork: true, recognized: false, why: '改到的文件名单里有读不成文件名的项，判不出' };
    }
    names.push(f);
  }
  const hit = names.find(isPageCode);
  if (hit !== undefined) return { uiWork: true, recognized: true, why: `改到了页面代码：${hit}` };
  return { uiWork: false, recognized: true, why: '没有改到页面代码' };
}
