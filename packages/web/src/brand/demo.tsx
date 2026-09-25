// 演示版的品牌：一套和正式版不沾边的名字和图标，内部叫法都换成通用说法，不给任何外链。
import { cn } from '../lib/utils';
import type { Brand } from './types';

/** 标志：一个圆、一条子午线、一颗在走的点。 */
function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--fg)" />
      <circle cx="16" cy="16" r="8.5" stroke="var(--bg)" strokeWidth="1.8" fill="none" />
      <path
        d="M16 7.5c-3.2 2.4-4.8 5.3-4.8 8.5s1.6 6.1 4.8 8.5"
        stroke="var(--bg)"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="22.4" cy="11.2" r="2.6" fill="var(--st-run)" />
    </svg>
  );
}

export const brand: Brand = {
  kind: 'demo',
  name: '子午',
  product: '控制台',
  title: (page) => (page ? `${page} · 子午（演示版）` : '子午（演示版）'),
  storagePrefix: 'meridian-demo.',
  Mark,
  favicon: `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#15161a"/><circle cx="16" cy="16" r="8.5" stroke="#ececef" stroke-width="1.8" fill="none"/><path d="M16 7.5c-3.2 2.4-4.8 5.3-4.8 8.5s1.6 6.1 4.8 8.5" stroke="#ececef" stroke-width="1.8" stroke-linecap="round" fill="none"/><circle cx="22.4" cy="11.2" r="2.6" fill="#4c9aff"/></svg>',
  )}`,
  terms: {
    relay: '中转站',
    judgeQuiz: '判断题',
    judgeNav: '判断题',
    marshal: 'AI 调度员',
    marshalShort: '调度员',
  },
  stageHints: {
    triage: '判断是哪类活、说没说清、多大、要不要人来拍板',
    ui: '界面类写码；GPT 族不接',
  },
  repoLink: () => undefined,
};
