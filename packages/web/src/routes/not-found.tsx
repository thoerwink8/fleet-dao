import { Compass } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState } from '../components/layout/empty-state';
import { Page } from '../components/layout/page';
import { Section } from '../components/layout/section';
import { Button } from '../components/ui/button';

export default function NotFound() {
  return (
    <Page title="这个页面不存在">
      <Section>
        <EmptyState
          icon={Compass}
          title="可能是链接写错了"
          hint="按 ⌘K 搜一下，或者回到主页。"
          action={
            <Button asChild size="sm">
              <Link to="/">回到主页</Link>
            </Button>
          }
        />
      </Section>
    </Page>
  );
}
