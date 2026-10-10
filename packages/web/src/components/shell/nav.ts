import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Bell,
  Brain,
  CalendarClock,
  Gauge,
  History,
  Home,
  ListChecks,
  Route,
  SatelliteDish,
  ScrollText,
  Settings,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  hint: string;
}

/**
 * 侧栏只放做好了的页（驾驶舱改版 2026-10-07）：没做的页（账单、战绩、判断题记录）不占导航，
 * 它们的地址还在、打开写明「还没做」（routes/soon.tsx）。/models 转到路由页的模型目录。
 * 分组按创始人回来看一眼的先后：先看盘面和要他拍的，再看调度，再看法国这台机器，最后是管理。
 */
export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: '盘面',
    items: [
      {
        to: '/',
        label: '主页',
        icon: Home,
        hint: '一屏三块：要你拍的、在跑的、做完的',
      },
      {
        to: '/tasks',
        label: '任务',
        icon: ListChecks,
        hint: '所有单子：在跑、排队、等人、做完、失败、叫停，能按仓筛、按单号和标题搜',
      },
      {
        to: '/notifications',
        label: '通知中心',
        icon: Bell,
        hint: '要你拍、卡住报警、日报',
      },
    ],
  },
  {
    group: '调度',
    items: [
      {
        to: '/routing',
        label: '路由',
        icon: Route,
        hint: '每个用途排哪些模型、走哪几条路，现在派得出去吗',
      },
      {
        to: '/routing/status',
        label: '渠道状态',
        icon: Activity,
        hint: '每个渠道一张卡：近 60 次柱条、平均耗时、可用率，点开看 request/response 原文',
      },
      {
        to: '/efforts',
        label: '思考档位',
        icon: Brain,
        hint: '每个模型走的每条路起会话想多深：没配用 high，改了下一个会话就照新的',
      },
      { to: '/quota', label: '额度', icon: Gauge, hint: '每个账号池每个时间窗还剩多少' },
    ],
  },
  {
    group: '运转',
    items: [
      {
        to: '/france',
        label: '法国',
        icon: SatelliteDish,
        hint: '本台六项事实、引擎总开关、定时任务、发版；多一台机器时按台并排',
      },
      {
        to: '/schedules',
        label: '定时任务',
        icon: CalendarClock,
        hint: '上次跑成、上次结局、失败高亮',
      },
      {
        to: '/changelog',
        label: '更新日志',
        icon: ScrollText,
        hint: '仓根 CHANGELOG.md：还没发版的、已发出去的',
      },
    ],
  },
  {
    group: '管理',
    items: [
      { to: '/audit', label: '操作记录', icon: History, hint: '谁在什么时候做了什么' },
      {
        to: '/settings',
        label: '设置',
        icon: Settings,
        hint: '运行设置、仓库、凭据、外观',
      },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);
