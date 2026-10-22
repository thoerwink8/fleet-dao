// 下拉选择（包 ui/select，样子照 Arco 的 Select）：触发器和输入框同一套外观，选项在浮层里。
// 手机上要原生选择器用 NativeSelect；这个给选项带说明（悬停）、等宽数字这类自绘的场合。不收 className 和 style。
import type { ReactNode } from 'react';
import { Select as BaseSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** 悬停说明。 */
  title?: string | undefined;
  /** 选项是数字、档位名：等宽数字对齐。 */
  numeric?: boolean | undefined;
}

const WIDTH = { sm: 'w-28', md: 'w-36', full: 'w-full' } as const;

export function Select({
  value,
  onValueChange,
  options,
  disabled,
  width = 'md',
  'aria-label': ariaLabel,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  disabled?: boolean | undefined;
  /** 触发器宽：sm 112、md 144、full 撑满。 */
  width?: keyof typeof WIDTH;
  'aria-label': string;
}) {
  return (
    <BaseSelect value={value} onValueChange={onValueChange} {...(disabled !== undefined ? { disabled } : {})}>
      <SelectTrigger size="sm" className={WIDTH[width]} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value}
            {...(o.title !== undefined ? { title: o.title } : {})}
            {...(o.numeric ? { className: 'num' } : {})}
          >
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </BaseSelect>
  );
}
