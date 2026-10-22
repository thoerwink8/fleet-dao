// 开关（包 ui/switch，#3533；页面只能从这里拿，不引 ui/、不引 radix）。样子照 canvas/fd3.css `.switch`：关着灰、开着品牌蓝。
// 参数照原生：checked、onCheckedChange、disabled、aria-label（没有可见标签时必给）、aria-labelledby。不收 className 和 style。
import type { ComponentProps } from 'react';
import { Switch as BaseSwitch } from '../ui/switch';

export function Switch({
  size = 'default',
  ...props
}: Omit<ComponentProps<typeof BaseSwitch>, 'className' | 'style' | 'size'> & { size?: 'sm' | 'default' }) {
  return <BaseSwitch size={size} {...props} />;
}
