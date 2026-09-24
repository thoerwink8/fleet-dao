import { Compass } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '../components/ui/button';

export default function NotFound() {
  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="text-center">
        <Compass className="mx-auto size-10 text-muted-foreground" aria-hidden />
        <h1 className="mt-4 text-lg font-semibold">这个页面不存在</h1>
        <p className="mt-1 text-sm text-muted-foreground">可能是链接写错了。按 ⌘K 搜一下，或者回到看板。</p>
        <Button asChild className="mt-4" size="sm">
          <Link to="/">回到看板</Link>
        </Button>
      </div>
    </div>
  );
}
