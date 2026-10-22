// 按下 / 松开的筛选钮（包 ui/toggle，样子照 Arco 的可选标签）：「只看已开启」「显示全部」这类开关式筛选。
// 按下是品牌浅底；手机上至少 40 高。不收 className 和 style。
import type { ReactNode } from 'react';
import { Toggle as BaseToggle } from '../ui/toggle';

export function Toggle({
  pressed,
  onPressedChange,
  children,
  disabled,
}: {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  children: ReactNode;
  disabled?: boolean | undefined;
}) {
  return (
    <BaseToggle
      size="sm"
      pressed={pressed}
      onPressedChange={onPressedChange}
      {...(disabled !== undefined ? { disabled } : {})}
    >
      {children}
    </BaseToggle>
  );
}
