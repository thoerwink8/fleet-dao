import type * as React from 'react';
import { cn } from '../../lib/utils';
import { fieldSurface } from './styles';

/** 多行输入（#3509，照 Arco，样稿 canvas/fd3.css `textarea.input`）：外观同输入框，最少 88 高，上下 4 左右 12。 */
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-22 w-full px-3 py-1 text-heading font-normal md:text-body',
        fieldSurface,
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
