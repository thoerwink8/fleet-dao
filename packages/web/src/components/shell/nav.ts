import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Boxes,
  CalendarClock,
  Gauge,
  LayoutDashboard,
  ListChecks,
  Network,
  Radio,
  Scale,
  ScrollText,
  Settings,
  Trophy,
  Users,
  Wallet,
  Waypoints,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** 第二批页面：现在是占位页。 */
  soon?: boolean;
  hint: string;
}

export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: '盘面',
    items: [
      { to: '/', label: '看板', icon: Network, hint: '按仓看全局任务树' },
      { to: '/overview', label: '总览', icon: LayoutDashboard, hint: '全部仓的盘面与待你处理的事' },
      { to: '/tasks', label: '任务', icon: ListChecks, hint: '所有需求的清单' },
    ],
  },
  {
    group: '调度',
    items: [
      { to: '/dispatch', label: '调度台', icon: Waypoints, hint: '每个阶段挂哪些路由、先后顺序' },
      { to: '/channels', label: '渠道与账号', icon: Radio, hint: '付费入口、账号池、并发、到期日' },
      { to: '/models', label: '模型目录', icon: Boxes, soon: true, hint: '各家模型、上下架' },
      { to: '/quota', label: '额度', icon: Gauge, hint: '每个账号池每个时间窗还剩多少' },
      { to: '/billing', label: '账单', icon: Wallet, soon: true, hint: '花了多少、值不值' },
      { to: '/record', label: '战绩', icon: Trophy, soon: true, hint: '每条路由干得怎么样' },
    ],
  },
  {
    group: '运转',
    items: [
      { to: '/schedules', label: '定时任务', icon: CalendarClock, hint: '上次跑成、上次结局、失败高亮' },
      { to: '/jev', label: 'Jev 判断', icon: Scale, soon: true, hint: '判断题的记录与准确率' },
      { to: '/notifications', label: '通知中心', icon: Bell, hint: '要你拍、卡住报警、日报' },
    ],
  },
  {
    group: '管理',
    items: [
      { to: '/members', label: '成员与权限', icon: Users, soon: true, hint: '谁能进驾驶舱' },
      { to: '/audit', label: '操作记录', icon: ScrollText, hint: '谁在什么时候做了什么' },
      { to: '/settings', label: '设置', icon: Settings, hint: '外观、通知、订阅月费' },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);
