import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Boxes,
  CalendarClock,
  Gauge,
  LayoutDashboard,
  ListChecks,
  Network,
  Presentation,
  Radio,
  Scale,
  ScrollText,
  Settings,
  Trophy,
  Users,
  Wallet,
  Waypoints,
} from 'lucide-react';
import { brand } from '#brand';
import { canSee, isDemo } from '../../demo/access';
import type { DemoModule } from '../../demo/scope';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** 第二批页面：现在是占位页。 */
  soon?: boolean;
  hint: string;
  /** 演示版里归哪个模块（可见范围逐个开关）。没有 = 演示版里没有这一页（占位页、只有正式版才有的页）。 */
  module?: DemoModule;
}

export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: '盘面',
    items: [
      { to: '/', label: '看板', icon: Network, hint: '按仓看全局任务树', module: 'board' },
      {
        to: '/overview',
        label: '总览',
        icon: LayoutDashboard,
        hint: '全部仓的盘面与待你处理的事',
        module: 'board',
      },
      { to: '/tasks', label: '任务', icon: ListChecks, hint: '所有需求的清单', module: 'task' },
    ],
  },
  {
    group: '调度',
    items: [
      {
        to: '/dispatch',
        label: '调度台',
        icon: Waypoints,
        hint: '每个阶段挂哪些路由、先后顺序',
        module: 'dispatch',
      },
      {
        to: '/channels',
        label: '渠道与账号',
        icon: Radio,
        hint: '付费入口、账号池、并发、到期日',
        module: 'channels',
      },
      { to: '/models', label: '模型目录', icon: Boxes, soon: true, hint: '各家模型、上下架' },
      { to: '/quota', label: '额度', icon: Gauge, hint: '每个账号池每个时间窗还剩多少', module: 'quota' },
      { to: '/billing', label: '账单', icon: Wallet, soon: true, hint: '花了多少、值不值' },
      { to: '/record', label: '战绩', icon: Trophy, soon: true, hint: '每条路由干得怎么样' },
    ],
  },
  {
    group: '运转',
    items: [
      {
        to: '/schedules',
        label: '定时任务',
        icon: CalendarClock,
        hint: '上次跑成、上次结局、失败高亮',
        module: 'schedules',
      },
      { to: '/judge', label: brand.terms.judgeNav, icon: Scale, soon: true, hint: '判断题的记录与准确率' },
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
    group: '管理',
    items: [
      { to: '/members', label: '成员与权限', icon: Users, soon: true, hint: `谁能进${brand.product}` },
      { to: '/demo-links', label: '演示版', icon: Presentation, hint: '发演示链接、定游客能看什么' },
      { to: '/audit', label: '操作记录', icon: ScrollText, hint: '谁在什么时候做了什么', module: 'audit' },
      { to: '/settings', label: '设置', icon: Settings, hint: '外观、通知、订阅月费', module: 'settings' },
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
