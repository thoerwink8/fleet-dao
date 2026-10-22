// 多行输入（包 ui/textarea，样子照 canvas/fd3.css `textarea.input`）：受控，打字把字符串交给 onChange。
// 页面只能从这里拿多行输入，不直接引 ui/textarea。要在表单里配标签用 FormItem 的 htmlFor 指过来（给 id）。不收 className 和 style。
import { Textarea } from '../ui/textarea';

export function TextArea({
  value,
  onChange,
  id,
  rows = 3,
  maxLength,
  placeholder,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  'aria-label'?: string;
}) {
  return (
    <Textarea
      value={value}
      rows={rows}
      onChange={(e) => onChange(e.target.value)}
      {...(id ? { id } : {})}
      {...(maxLength !== undefined ? { maxLength } : {})}
      {...(placeholder ? { placeholder } : {})}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
    />
  );
}
