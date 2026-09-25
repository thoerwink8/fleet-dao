// 正式驾驶舱的品牌。页面上看得见的名字、标签页标题只写「驾驶舱」，不带仓名：登录页是公开的（#54）。
import { cn } from '../lib/utils';
import type { Brand } from './types';

/** 标志：一个节点分出两支——需求拆成子任务，一支在跑、一支已完成。 */
function Mark({ className }: { className?: string }) {
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

export const brand: Brand = {
  kind: 'cockpit',
  name: '驾驶舱',
  product: '驾驶舱',
  title: (page) => (page ? `${page} · 驾驶舱` : '驾驶舱'),
  storagePrefix: 'fleet-dao.',
  Mark,
  favicon: `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#15161a"/><path d="M11.5 16c4.5 0 4.2-6.5 8.5-6.5M11.5 16c4.5 0 4.2 6.5 8.5 6.5" stroke="#ececef" stroke-width="1.8" stroke-linecap="round" fill="none"/><circle cx="9.5" cy="16" r="3" fill="#ececef"/><circle cx="22.5" cy="9.5" r="3" fill="#4c9aff"/><circle cx="22.5" cy="22.5" r="3" fill="#3fcf8e"/></svg>',
  )}`,
  terms: {
    relay: 'Mirasim',
    judgeQuiz: 'Jev 判断题',
    judgeNav: 'Jev 判断',
    marshal: 'AI 帅位',
    marshalShort: '帅位',
  },
  stageHints: {
    triage: '判断是哪类活、说没说清、多大、碰不碰人闸',
    ui: '界面类写码；GPT 族不碰',
  },
  repoLink: (repo, kind, n) => `https://github.com/${repo.owner}/${repo.name}/${kind}/${n}`,
};
