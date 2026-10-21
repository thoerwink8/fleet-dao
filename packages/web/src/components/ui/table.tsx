'use client';

import type * as React from 'react';
import { cn } from '../../lib/utils';

/**
 * 表格（#3509，照 Arco，样稿 canvas/fd3.css `.table`）：表头 fill-2 底、ink 字 500、40 高、左右 16；
 * 格子上下 12 左右 16、底边一道 line；整行悬停 fill-1（100ms），选中（data-state=selected）brand-1。
 * 外面包一层横向滚动：表格只在自己的盒子里横滑，不把页面撑宽。
 */
function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn('w-full caption-bottom text-body text-ink', className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return (
    <thead
      data-slot="table-header"
      className={cn('[&_tr]:border-b [&_tr]:border-line [&_tr]:hover:bg-transparent', className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('border-t border-line bg-fill-1 font-medium [&>tr]:last:border-b-0', className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b border-line transition-colors duration-100 hover:bg-fill-1 has-aria-expanded:bg-fill-1 data-[state=selected]:bg-brand-1',
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-row bg-fill-2 px-4 text-left align-middle font-medium whitespace-nowrap text-ink first:rounded-tl-sm last:rounded-tr-sm [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-check',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        'px-4 py-3 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-check',
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption data-slot="table-caption" className={cn('mt-4 text-body text-ink-3', className)} {...props} />
  );
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow };
