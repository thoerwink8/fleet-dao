import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Bell,
  Boxes,
  Brain,
  CalendarClock,
  Gauge,
  Home,
  Presentation,
  Route,
  Scale,
  ScrollText,
  ServerCog,
  Settings,
  Trophy,
  Wallet,
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
      {
        to: '/',
        label: '主页',
        icon: Home,
        hint: '一屏三块：要你拍的、在跑的、做完的',
        // 演示版里没有这一页（只在正式驾驶舱建主页）。
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
        to: '/env',
        label: '环境',
        icon: ServerCog,
        hint: '这一台环境现在怎样：引擎、在用版本、在跑的会话、池、健康、最近拉单',
        // 演示版里没有这一页（露机器名、版本号、会话数，R10；路由表里也不放）。
      },
      {
        to: '/schedules',
        label: '定时任务',
        icon: CalendarClock,
        hint: '上次跑成、上次结局、失败高亮',
        module: 'schedules',
      },
      { to: '/judge', label: brand.terms.judgeNav, icon: Scale, soon: true, hint: '判断题的记录与准确率' },
      {
        to: '/changelog',
        label: '更新日志',
        icon: ScrollText,
        hint: '仓根 CHANGELOG.md：还没发版的、已发出去的',
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
    group: '管理',
    items: [
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
