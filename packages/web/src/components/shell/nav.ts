import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Bell,
  CalendarClock,
  Gauge,
  HardDrive,
  History,
  LayoutDashboard,
  ListChecks,
  MessageSquarePlus,
  Route,
  ScrollText,
  Server,
  SlidersHorizontal,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  hint: string;
}

/**
 * 左菜单（#3509，照 Arco Pro）：上面四项常用的，「运维」一组三项，最底下设置。一共八项，别的页不进菜单。
 * 菜单只放做好了的页。
 */
export const NAV_HOME: NavItem = {
  to: '/',
  label: '工作台',
  icon: LayoutDashboard,
  hint: '三块：要你拍的、在跑的、上线了的',
};

export const NAV_TOP: NavItem[] = [
  NAV_HOME,
  { to: '/notifications', label: '通知', icon: Bell, hint: '要你拍、卡住报警、日报' },
  {
    to: '/tasks',
    label: '任务',
    icon: ListChecks,
    hint: '所有单子：在跑、排队、等人、做完、失败、叫停，能按仓筛、按单号和标题搜',
  },
  { to: '/intake', label: '提需求', icon: MessageSquarePlus, hint: '和指挥官聊清楚一件事，确定后开成单' },
];

export const NAV_OPS: { group: string; items: NavItem[] } = {
  group: '运维',
  items: [
    {
      to: '/france',
      label: '法国',
      icon: Server,
      hint: '运行概况、引擎总开关与派单方式、版本与发版、各台机器，零散页的入口在「更多」',
    },
    {
      to: '/routing',
      label: '路由',
      icon: Route,
      // 思考档位、模型目录在这页的页签里（#1914 第 5 轮）
      hint: '每个用途排哪些模型、走哪几条路，现在派得出去吗；每条路的思考档位也在这里改',
    },
    { to: '/quota', label: '额度', icon: Gauge, hint: '每个账号池每个时间窗还剩多少' },
  ],
};

export const NAV_FOOT: NavItem = {
  to: '/settings',
  label: '设置',
  icon: SlidersHorizontal,
  hint: '运行设置、仓库、凭据、外观',
};

/**
 * 不进菜单的页（低频，做减法）：从法国页的「更多」和 ⌘K 进。在这些页时菜单亮 `under` 那一项。
 */
export const NAV_HIDDEN: (NavItem & { under: string })[] = [
  {
    to: '/schedules',
    label: '定时任务',
    icon: CalendarClock,
    hint: '上次跑成、上次结局、失败高亮',
    under: '/france',
  },
  {
    to: '/resources',
    label: '资源',
    icon: HardDrive,
    hint: '整机内存、CPU、磁盘，每个上线项目各占多少、放在哪，按目录的磁盘占用',
    under: '/france',
  },
  {
    to: '/changelog',
    label: '发布记录',
    icon: ScrollText,
    hint: '仓根 CHANGELOG.md：还没发版的、已发出去的（更新日志）',
    under: '/france',
  },
  { to: '/audit', label: '操作记录', icon: History, hint: '谁在什么时候做了什么', under: '/france' },
  {
    to: '/routing/status',
    label: '渠道状态',
    icon: Activity,
    hint: '每个渠道一张卡：近 60 次柱条、平均耗时、可用率，点开看 request/response 原文',
    under: '/routing',
  },
];

/** 菜单里的全部项，从上到下。 */
export const NAV_MENU: NavItem[] = [...NAV_TOP, ...NAV_OPS.items, NAV_FOOT];

/** 命令面板用：菜单分组在前，不进菜单的页放最后一组。 */
export const NAV: { group: string; items: NavItem[] }[] = [
  { group: '常用', items: NAV_TOP },
  NAV_OPS,
  { group: '更多页面', items: [...NAV_HIDDEN, NAV_FOOT] },
];

export const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);

const within = (pathname: string, to: string) =>
  to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`);

/**
 * 当前页该亮菜单里的哪一项：先认不进菜单的页（/routing/status 比 /routing 具体，先判），再认菜单项；
 * 任务详情 /tasks/:id 亮「任务」。认不出（404 之类）返回 null，一项都不亮。
 */
export function activeMenu(pathname: string): string | null {
  const hidden = NAV_HIDDEN.find((h) => within(pathname, h.to));
  if (hidden) return hidden.under;
  return NAV_MENU.find((m) => within(pathname, m.to))?.to ?? null;
}
