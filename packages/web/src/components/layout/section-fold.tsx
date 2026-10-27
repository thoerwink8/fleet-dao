// 区块收起的上下文（#3707 批次 3）：外壳包一次，页面和页面里的各块从这一处拿开合，不再一层层传 props。
// 开合本身记在网址参数 ?open=（lib/section-open.ts），外壳把 useSectionOpen() 的那套塞进来。
// 没有 Provider 时（组件测试单独摆一页、陈列页）返回 undefined：那些块照老样子全展开，不会因为缺上下文就收起。
// FoldSection 是给页面用的那一层：一块能收起的 Section，开合从上下文拿，收起时行尾换成 summary 一行摘要。
import { type ComponentProps, createContext, type ReactNode, useContext } from 'react';
import { Section } from './section';

export interface SectionFold {
  /** 这一块现在是开是合；defaultOpen 是这一块自己的默认。 */
  isOpen: (key: string, defaultOpen: boolean) => boolean;
  /** 点一下：翻过来，写回网址参数。 */
  toggle: (key: string, defaultOpen: boolean) => void;
  /** 直接展开（点页内目录跳到收着的一节）：和默认无关，记成展开。 */
  open: (key: string) => void;
}

const FoldContext = createContext<SectionFold | null>(null);

/** 包一层就能让这一页的区块可收起。value 直接给 useSectionOpen()。 */
export const SectionFoldProvider = FoldContext.Provider;

export interface FoldState {
  open: boolean;
  onToggle: () => void;
}

/** 这一页整套开合（给页内目录用）；没有 Provider 就是 null。 */
export function useSectionFoldPage(): SectionFold | null {
  return useContext(FoldContext);
}

/** 这一块现在开没开、点了做什么；没有 Provider 就 undefined（块照老样子全展开）。 */
export function useSectionFold(key: string, defaultOpen = false): FoldState | undefined {
  const ctx = useContext(FoldContext);
  if (ctx === null) return undefined;
  return { open: ctx.isOpen(key, defaultOpen), onToggle: () => ctx.toggle(key, defaultOpen) };
}

/** 摊到 `Section` 上的那三个开关 prop；没有 Provider 就一个都不给，老样子全展开。 */
export function foldProps(
  fold: FoldState | undefined,
): { collapsible: true; open: boolean; onToggle: () => void } | Record<string, never> {
  return fold ? { collapsible: true, open: fold.open, onToggle: fold.onToggle } : {};
}

type SectionProps = ComponentProps<typeof Section>;

/**
 * 一块能收起的 `Section`：头照画，收起时正文不画、行尾换成 summary 一行摘要（几项、有没有异常）。
 * `block` 是网址参数里那个键；`defaultOpen` 是这一块自己的默认。没有 Provider 就不收，老样子全展开。
 */
export function FoldSection({
  block,
  defaultOpen = false,
  summary,
  children,
  ...rest
}: Omit<SectionProps, 'collapsible' | 'open' | 'onToggle' | 'summary'> & {
  block: string;
  defaultOpen?: boolean;
  summary?: ReactNode;
  children: ReactNode;
}) {
  const fold = useSectionFold(block, defaultOpen);
  return (
    // data-fold-block：e2e 按它数这一页有几块能收起、现在露着几块（#3708 的量法也用这一份）
    <Section data-fold-block={block} summary={summary} {...foldProps(fold)} {...rest}>
      {children}
    </Section>
  );
}
