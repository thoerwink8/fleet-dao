import { cn } from '../lib/utils';

/** 标志：一个节点分出两支——需求拆成子任务，一支在跑、一支已完成。 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--fg)" />
      <path
        d="M11.5 16c4.5 0 4.2-6.5 8.5-6.5M11.5 16c4.5 0 4.2 6.5 8.5 6.5"
        stroke="var(--bg)"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="9.5" cy="16" r="3" fill="var(--bg)" />
      <circle cx="22.5" cy="9.5" r="3" fill="var(--st-run)" />
      <circle cx="22.5" cy="22.5" r="3" fill="var(--st-done)" />
    </svg>
  );
}

/** 浏览器标签页上的小图标（不跟主题，固定深色底）。 */
export const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#15161a"/><path d="M11.5 16c4.5 0 4.2-6.5 8.5-6.5M11.5 16c4.5 0 4.2 6.5 8.5 6.5" stroke="#ececef" stroke-width="1.8" stroke-linecap="round" fill="none"/><circle cx="9.5" cy="16" r="3" fill="#ececef"/><circle cx="22.5" cy="9.5" r="3" fill="#4c9aff"/><circle cx="22.5" cy="22.5" r="3" fill="#3fcf8e"/></svg>',
)}`;
