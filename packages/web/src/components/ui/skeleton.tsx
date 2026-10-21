import { cn } from '../../lib/utils';
import { motionStop } from './styles';

/** 骨架（#3509，照 Arco，样稿 canvas/fd3.css `.skeleton`）：fill-2 底、2 圆角，一呼一吸；减少动效时不动。 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-sm bg-fill-2', motionStop, className)}
      {...props}
    />
  );
}

export { Skeleton };
