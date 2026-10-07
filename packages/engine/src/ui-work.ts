// 一张单算不算「界面活」（改到了页面代码）：验收冷调用选路用它决定传不传 `uiWork`（选路的硬禁令 gpt-no-ui，GPT 不做界面、不审界面）。
// 动手段（#1264）也用同一份判法：judgeImplementUiWork 动手前按上一轮改到的文件名和单子里写的路径判，界面活按 `ui` 用途选路。
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

const PATH_CHARS = /^[\p{L}\p{N}_.@~\-*/]+$/u;
const FILE_LIKE = /^.+\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/**
 * 单子文字里写在反引号里的路径（动手前还没有改到的文件名，只能按单子写的判）。认路径的规矩比 runner/task-brief.ts 的
 * asModuleRef 窄一圈（宁可认不出，认不出就按界面活处理）：带 / 的算路径，不带 / 的只有像文件名的才算；带空格、网址、
 * 绝对路径、.. 的不是。目录补一个结尾的 /，这样「packages/web」也认得出是整个页面目录；带 * 的取通配前面那段目录，
 * 通配的是页面后缀（*.tsx）的再补一条那个后缀。这个文件会被打进工作流（要确定、不引 node 和别的包），所以不复用 asModuleRef。
 */
export function pathsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const t = (m[1] ?? '')
      .trim()
      .replace(/:\d+(?:-\d+)?$/, '')
      .replace(/^\.\//, '');
    if (!t || /\s/.test(t) || t.includes('://') || t.startsWith('/') || t.includes('..')) continue;
    if (!PATH_CHARS.test(t)) continue;
    if (t.includes('*')) {
      const segs = t.split('/');
      const at = segs.findIndex((s) => s.includes('*'));
      const prefix = segs.slice(0, at).join('/');
      if (prefix) out.push(`${prefix}/`);
      const tail = /\.[A-Za-z][A-Za-z0-9]{0,7}$/.exec(segs.at(-1) ?? '')?.[0];
      if (tail) out.push(`x${tail}`);
      continue;
    }
    const dir = t.endsWith('/');
    const path = t.replace(/\/+$/, '');
    if (!path) continue;
    const last = path.split('/').pop() ?? '';
    const fileLike = FILE_LIKE.test(last) || /^\.[\w-]+$/.test(last);
    if (!dir && !path.includes('/') && !fileLike) continue;
    out.push(!dir && fileLike ? path : `${path}/`);
  }
  return out;
}

export interface ImplementUiInput {
  /** 单子「已知的模块」每一项的原文（TaskBrief.touches）。 */
  touches: readonly string[];
  /** 单子正文（TaskBrief.request）：模块栏之外写了路径的也认。 */
  request?: string | undefined;
  /** 上一轮推上去的改动文件名；第 1 轮是空的。 */
  changedFiles: readonly unknown[];
}

/**
 * 动手前判这张单是不是界面活（动手选路用它决定按 `ui` 用途选、传不传 `uiWork`）。复用 judgeUiWork 的判法（同一份页面代码路径），
 * 只是依据多一份：上一轮改到的文件名，加上单子里写的路径（第 1 轮还没有文件名，只能看单子）。
 *
 * 认出界面活（任一份依据命中页面代码）就是；要判成「不是界面活」得三条都站得住：改到的文件名（有的话）认得出且没有页面代码、
 * 单子里一个路径都认得出、模块栏里没有一项认不出路径。差一条就是判不出，按界面活处理（调用方把 UI_UNRECOGNIZED_NOTE 写进状态）。
 */
export function judgeImplementUiWork(input: ImplementUiInput): UiJudgement {
  if (input.changedFiles.length > 0) {
    const fromFiles = judgeUiWork(input.changedFiles);
    if (fromFiles.uiWork) {
      return { ...fromFiles, why: `上一轮${fromFiles.why}` };
    }
  }
  const perItem = input.touches.map((item) => pathsIn(item));
  const written = [...perItem.flat(), ...pathsIn(input.request ?? '')];
  if (written.length > 0) {
    const fromText = judgeUiWork(written);
    if (fromText.uiWork) return { ...fromText, why: `单子里写的路径：${fromText.why}` };
  }
  if (written.length === 0) {
    return { uiWork: true, recognized: false, why: '单子里一个路径都没认出来，判不出' };
  }
  if (perItem.some((paths) => paths.length === 0)) {
    return { uiWork: true, recognized: false, why: '「已知的模块」里有一项认不出路径，判不出' };
  }
  return { uiWork: false, recognized: true, why: '改到的文件和单子里写的路径都没有页面代码' };
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
