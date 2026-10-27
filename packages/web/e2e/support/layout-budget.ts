// 版面预算的量法（#3708 批次 4）：跨文件容器嵌套层数、一屏区块数。
//
// 为什么放进 e2e：`scripts/lint-design.ts` 的 R18 只看一个文件的 AST，容器套在另一个文件的组件里就看不见
// （`docs/design/驾驶舱界面.md` 第五节自己写了这条盲区）。页面拼起来到底几层、一屏摆了几块，只有渲染出来才量得准。
//
// 哪些算容器（规范第五节的判法，别把开关圆点算进去）：
// - `<Section>`（渲染成 `section[data-variant]`，`components/layout/section.tsx`），不管多大都算；
// - 带底色的块：计算出来的背景色不透明、又不是页面底色（`--color-page`），并且大到像一块版面
//   （宽 ≥ 120、高 ≥ 32）。开关、圆点、状态标签这类小组件够不着这个尺寸，不算；
//   讨论稿第七节实测到的那些「2–3 层」正是这类小组件，不是规范要禁的卡片套卡片。
// - `Section` 左侧那道色条（`[data-section-rail]`）不算。
//
// 层数怎么数：一个容器的「层」= 它往上数有几个容器祖先 + 1。规范要的是最多两层
// （`Section` 里直接摆内容，里面的用 Descriptions/List/分隔，不再套一层卡片）。
//
// 一屏区块数怎么数：只算最外层（有容器祖先的不算，免得一个卡片套一个卡片数成两块）、
// 顶边落在首屏里（`top < innerHeight`）、收起的块不算（`data-open="false"`，它们只露一行标题）。

/** 量出来的一个容器：它的层数、以及够不够得着首屏。只在本文件里用，不外露。 */
interface ContainerReading {
  /** 元素的简短描述（标签 + data-fold-block/data-home-block + 前两个类名），出问题时看得出是哪个。 */
  where: string;
  /** 往上数有几个容器祖先 + 1。 */
  depth: number;
  /** 顶边落在首屏里。 */
  aboveFold: boolean;
  /** 算不算「一屏里的一块」：最外层、够得着首屏、且不是收起的块。 */
  block: boolean;
}

export interface LayoutReading {
  /** 所有容器的层数里最大的那个（没有容器是 0）。 */
  maxDepth: number;
  /** 首屏里摆着的一块一块（正文露着的）。 */
  firstScreenBlocks: number;
  /** 超过两层的那些容器，写清在哪。 */
  deep: ContainerReading[];
  /** 逐块明细，测试失败时贴出来方便定位。 */
  containers: ContainerReading[];
}

/**
 * 在浏览器里跑的测量脚本（`page.evaluate` 的入参）。
 * 抽成常量而不是内联函数：反例和正式断言用同一份，改一处两边一起变。
 */
export const MEASURE_LAYOUT = `(() => {
  const PAGE_BG = 'rgb(242, 243, 245)';
  const NIGHT_BG = 'rgb(23, 23, 26)';
  const MIN_W = 120;
  const MIN_H = 32;
  const isContainer = (el) => {
    if (el.hasAttribute('data-section-rail')) return false;
    if (el.matches('section[data-variant]')) return true;
    const bg = getComputedStyle(el).backgroundColor;
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') return false;
    if (bg === PAGE_BG || bg === NIGHT_BG) return false;
    const r = el.getBoundingClientRect();
    return r.width >= MIN_W && r.height >= MIN_H;
  };
  const desc = (el) => {
    const key = el.getAttribute('data-fold-block') || el.getAttribute('data-home-block');
    const head = (el.querySelector('h2,h1,h3') || el).textContent || '';
    const text = head.trim().slice(0, 20);
    const cls = (el.getAttribute('class') || '').trim().split(/\\s+/).slice(0, 2).join(' ');
    return [el.tagName.toLowerCase(), key ? '[' + key + ']' : '', cls, text ? '"' + text + '"' : '']
      .filter(Boolean)
      .join(' ');
  };
  const containers = [];
  for (const el of Array.from(document.querySelectorAll('main *')).filter(isContainer)) {
    let depth = 1;
    for (let p = el.parentElement; p; p = p.parentElement) if (isContainer(p)) depth++;
    const r = el.getBoundingClientRect();
    const aboveFold = r.top < window.innerHeight;
    const block = depth === 1 && aboveFold && el.getAttribute('data-open') !== 'false';
    containers.push({ where: desc(el), depth, aboveFold, block });
  }
  return {
    maxDepth: containers.reduce((m, c) => Math.max(m, c.depth), 0),
    firstScreenBlocks: containers.filter((c) => c.block).length,
    deep: containers.filter((c) => c.depth > 2),
    containers,
  };
})()`;
