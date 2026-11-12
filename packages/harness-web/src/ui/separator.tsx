import { Separator as Root } from '@radix-ui/react-separator';
import { cn } from '../lib/cn';

export function Separator({
  className,
  orientation = 'horizontal',
}: {
  className?: string;
  orientation?: 'horizontal' | 'vertical';
}) {
  return (
    <Root
      orientation={orientation}
      className={cn(orientation === 'horizontal' ? 'h-px w-full bg-line' : 'h-full w-px bg-line', className)}
    />
  );
}
