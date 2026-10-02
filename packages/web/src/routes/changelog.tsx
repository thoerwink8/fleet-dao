// 仓根的 CHANGELOG 在驾驶舱里的一份对照：仓里有什么版本、下一版要发什么，看这里就够了。
// 数据来源是仓根的 CHANGELOG.md 在打包时被内联进来的字符串（lib/changelog.ts 用 vite 的 ?raw 取），
// 格式解析共用 packages/shared/src/changelog.ts——和发布那条线是同一个实现，格式变了两边一样认不出。
// 演示版不把这一页放进路由表、导航也不给它 module：CHANGELOG 里有仓名，不能进演示版产物。
import { CalendarClock, ScrollText } from 'lucide-react';
import { brand } from '#brand';
import { Empty, LoadError, Page, Panel } from '../components/page';
import { readChangelog } from '../lib/changelog';

export function meta() {
  return [{ title: brand.title('更新日志') }];
}

export default function Changelog() {
  let data: ReturnType<typeof readChangelog>;
  try {
    data = readChangelog();
  } catch (error) {
    return (
      <Page title="更新日志" description="仓根的 CHANGELOG.md 在驾驶舱里的一份对照。">
        <LoadError error={error} what="CHANGELOG" />
      </Page>
    );
  }
  const { section, released, hasContent, next } = data;

  return (
    <Page
      title="更新日志"
      description="仓根 CHANGELOG.md 的一份对照：还没发出去的写在「还没发版」里，已经发出去的按版本排在下面。"
    >
      <Panel
        title={`还没发版 · 下一版 ${next.version}`}
        description={
          hasContent
            ? 'Unreleased 段里现在写的东西，随下一次发布进正式版本。'
            : 'Unreleased 段现在是空的；下一次发布会把这段填上。'
        }
      >
        {hasContent ? (
          <pre className="font-sans text-[13px] leading-6 whitespace-pre-wrap text-foreground">{section}</pre>
        ) : (
          <Empty
            icon={CalendarClock}
            title="还什么都没写"
            hint="下一次发布前，把要发出去的更新写进 CHANGELOG.md 的 Unreleased 段。"
          />
        )}
      </Panel>

      <div className="mt-6">
        <h2 className="mb-2 text-sm font-semibold">已发布</h2>
        {released.length === 0 ? (
          <Panel>
            <Empty icon={ScrollText} title="还没有发过版" hint="仓里还没有任何形式的正式发布。" />
          </Panel>
        ) : (
          <Panel bodyClassName="divide-y p-0">
            {released.map((r) => (
              <div
                key={`${r.version}-${r.date}`}
                className="flex items-baseline justify-between gap-3 px-4 py-3"
              >
                <span className="num text-sm font-medium">{r.version}</span>
                <span className="num text-xs text-muted-foreground">{r.date}</span>
              </div>
            ))}
          </Panel>
        )}
      </div>
    </Page>
  );
}
