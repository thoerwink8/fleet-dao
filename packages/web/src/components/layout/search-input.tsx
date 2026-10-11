// 搜索框：带放大镜图标。桌面 32 高 14px；手机 40 高 16px（防 iOS 点进去自动放大），样式由 ui/input 给。
import { Search } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Input } from '../ui/input';

export function SearchInput({
  value,
  onChange,
  placeholder,
  className,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <div className={cn('relative w-full md:max-w-search', className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder ?? '搜索'}
        onChange={(e) => onChange(e.target.value)}
        className="pl-8"
      />
    </div>
  );
}
