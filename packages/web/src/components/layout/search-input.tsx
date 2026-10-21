// 搜索框：带放大镜图标（灰）。桌面 32 高 14px；手机 40 高 16px（防 iOS 点进去自动放大），样式由 ui/input 给（Arco `.input`）。
// onKeyDown：要按键的（会话里找：回车下一个、Esc 清空）自己接。
import { Search } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { cn } from '../../lib/utils';
import { Input } from '../ui/input';

export function SearchInput({
  value,
  onChange,
  onKeyDown,
  placeholder,
  className,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <div className={cn('relative w-full md:max-w-search', className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 -translate-y-1/2 text-ink-3"
        aria-hidden
      />
      <Input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder ?? '搜索'}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="pl-8"
      />
    </div>
  );
}
