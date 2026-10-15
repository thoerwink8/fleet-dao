import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Bell,
  CalendarClock,
  Gauge,
  HardDrive,
  History,
  Home,
  ListChecks,
  MessageSquarePlus,
  Network,
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

/** 主页：一打开就看到的三件事（决定 0093）。侧栏、底部导航里只有它常驻，其余都在「更多」里。 */
export const NAV_HOME: NavItem = {
  to: '/',
  label: '主页',
  icon: Home,
  hint: '三块：要你拍的、在跑的、上线了的',
};

/**
 * 「更多」里的页（导航降级，决定 0093：创始人一周只登几次，打开只看主页三块；别的页不删，收在这里）。
 * 侧栏只放做好了的页。还没做的账单不占导航，地址还在，打开写明「还没做」（routes/soon.tsx）。
 * 思考档位、模型目录在路由页的页签里。
 * 分组按回来看一眼的先后：先看盘面，再看调度，再看法国这台机器，最后是管理。
 */
export const NAV_MORE: { group: string; items: NavItem[] }[] = [
  {
    group: '盘面',
    items: [
      {
        to: '/board',
        label: '画布',
        icon: Network,
        hint: '原来的主页：思维导图看板，中心引擎 → 对题 / 动手 / 验收 → 每张单',
      },
      {
        to: '/tasks',
        label: '任务',
        icon: ListChecks,
        hint: '所有单子：在跑、排队、等人、做完、失败、叫停，能按仓筛、按单号和标题搜',
      },
      {
        to: '/intake',
        label: '提需求',
        icon: MessageSquarePlus,
        hint: '和指挥官聊清楚一件事，确定后开成单',
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
        // 思考档位在这页的「思考档位」页签（#1914 第 5 轮）
        hint: '每个用途排哪些模型、走哪几条路，现在派得出去吗；每条路的思考档位也在这里改',
      },
      {
        to: '/routing/status',
        label: '渠道状态',
        icon: Activity,
        hint: '每个渠道一张卡：近 60 次柱条、平均耗时、可用率，点开看 request/response 原文',
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
        hint: '本台六项事实、引擎总开关、命令行工具、定时任务、发版；多一台机器时按台并排',
      },
      {
        to: '/resources',
        label: '资源',
        icon: HardDrive,
        hint: '整机内存、CPU、磁盘，每个上线项目各占多少、放在哪，按目录的磁盘占用',
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

/** 命令面板、整份清单用：主页在最前，后面是「更多」的各组。 */
export const NAV: { group: string; items: NavItem[] }[] = [{ group: '主页', items: [NAV_HOME] }, ...NAV_MORE];

export const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);
