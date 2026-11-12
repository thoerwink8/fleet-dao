import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          'min-h-12 w-full resize-none rounded-md border border-line bg-transparent px-3 py-2 text-sm text-ink outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-brand',
          className,
        )}
        {...props}
      />
    );
  },
);
