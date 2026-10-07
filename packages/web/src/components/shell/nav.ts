import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Bell,
  Brain,
  CalendarClock,
  Gauge,
  History,
  Home,
  Presentation,
  Route,
  SatelliteDish,
  ScrollText,
  Settings,
} from 'lucide-react';
import { canSee, isDemo } from '../../demo/access';
import type { DemoModule } from '../../demo/scope';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  hint: string;
  /** 演示版里归哪个模块（可见范围逐个开关）。没有 = 演示版里没有这一页（只有正式版才有的页）。 */
  module?: DemoModule;
}

/**
 * 侧栏只放做好了的页（驾驶舱改版 2026-10-07）：没做的页（模型目录、账单、战绩、判断题记录）不占导航，
 * 它们的地址还在、打开写明「还没做」（routes/soon.tsx）。
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
        // 演示版里没有这一页（只在正式驾驶舱建主页）。
      },
      {
        to: '/notifications',
        label: '通知中心',
        icon: Bell,
        hint: '要你拍、卡住报警、日报',
        module: 'notifications',
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
        // 演示版里没有这一页（只在正式驾驶舱建）。
      },
      {
        to: '/routing/status',
        label: '渠道状态',
        icon: Activity,
        hint: '每个渠道一张卡：近 60 次柱条、平均耗时、可用率，点开看 request/response 原文',
        // 演示版里没有这一页（只在正式驾驶舱建）。
      },
      {
        to: '/efforts',
        label: '思考档位',
        icon: Brain,
        hint: '每个模型走的每条路起会话想多深：没配用 high，改了下一个会话就照新的',
        // 演示版里没有这一页（只在正式驾驶舱建）。
      },
      { to: '/quota', label: '额度', icon: Gauge, hint: '每个账号池每个时间窗还剩多少', module: 'quota' },
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
        // 演示版里没有这一页（露机器名、版本号、会话数，R10；路由表里也不放）。
      },
      {
        to: '/schedules',
        label: '定时任务',
        icon: CalendarClock,
        hint: '上次跑成、上次结局、失败高亮',
        module: 'schedules',
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
      { to: '/demo-links', label: '演示版', icon: Presentation, hint: '发演示链接、定游客能看什么' },
      { to: '/audit', label: '操作记录', icon: History, hint: '谁在什么时候做了什么', module: 'audit' },
      {
        to: '/settings',
        label: '设置',
        icon: Settings,
        hint: '运行设置、仓库、凭据、外观',
        module: 'settings',
      },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);

/** 这一次能看的导航：正式驾驶舱全部；演示版只留可见范围里开了的模块。 */
export function visibleNav(): { group: string; items: NavItem[] }[] {
  if (!isDemo()) return NAV;
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => i.module !== undefined && canSee(i.module)),
  })).filter((g) => g.items.length);
}

/** 演示版：这个路径所在的模块没开放（或者演示版里就没有这一页）。不是导航里的路径交给 404 页。 */
export function demoBlocked(pathname: string): boolean {
  if (!isDemo()) return false;
  const item =
    pathname === '/'
      ? NAV_ITEMS[0]
      : NAV_ITEMS.find((i) => i.to !== '/' && (pathname === i.to || pathname.startsWith(`${i.to}/`)));
  if (!item) return false;
  return item.module === undefined || !canSee(item.module);
}
