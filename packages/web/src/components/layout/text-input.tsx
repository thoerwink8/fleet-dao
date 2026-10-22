// 单行输入框（包 ui/input，样子照 Arco 的 Input）：fill-2 底无描边，聚焦白底品牌色描边。
// 带放大镜的搜索框是 SearchInput。不收 className 和 style。
import { Input } from '../ui/input';

export function TextInput({
  value,
  onChange,
  placeholder,
  disabled,
  id,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  /** 控件的 id：FormItem 的 htmlFor 指过来，标签点一下聚焦它。 */
  id?: string | undefined;
  'aria-label'?: string | undefined;
}) {
  return (
    <Input
      {...(id !== undefined ? { id } : {})}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...(placeholder !== undefined ? { placeholder } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
      {...(ariaLabel !== undefined ? { 'aria-label': ariaLabel } : {})}
    />
  );
}
