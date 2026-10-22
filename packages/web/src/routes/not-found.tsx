// 不存在的页面（样稿 canvas/NotFound.dc.html）：外壳里一张空状态，标题说明、一句提示、一个「回工作台」按钮（次要，不抢眼）。
import { Compass } from 'lucide-react';
import { Button } from '../components/layout/button';
import { EmptyState } from '../components/layout/empty-state';
import { Page } from '../components/layout/page';
import { Section } from '../components/layout/section';

export default function NotFound() {
  return (
    <Page title="这个页面不存在">
      <Section>
        <EmptyState
          icon={Compass}
          title="可能是链接写错了"
          hint="按 ⌘K 搜一下，或者回到工作台。"
          action={<Button href="/">回工作台</Button>}
        />
      </Section>
    </Page>
  );
}
