// 渠道名册和目录的差（#1302）。只列，不放按钮：加模型走改 deploy/catalog.json 的 PR。
// 没读到、读失败、还没读过，都不写对得上。两头都空、也没有失败时，写明比的是渠道自己的模型表和目录，并写出各自的个数。
// 没有名册命令的渠道（#1357）另写「这个渠道靠手工登记，共 N 个」，不报没读成。

import type { ReactNode } from 'react';
import type { RoutingLayers } from '../api/types';

/** 没有差集时的那一句。个数没随接口来就不编数字。 */
function matchedSentence(roster: NonNullable<RoutingLayers['modelRoster']>): string {
  const channel = roster.channelModelCount;
  const catalog = roster.catalogCount;
  if (typeof channel !== 'number' || typeof catalog !== 'number') {
    return '渠道自己的模型表和目录对得上';
  }
  return `渠道自己的模型表（${channel} 个）和目录（${catalog} 个）对得上`;
}

export function ModelRosterNotice({ layers }: { layers: RoutingLayers }) {
  const roster = layers.modelRoster;
  const manual = roster?.manual ?? [];
  const manualBlock =
    manual.length === 0
      ? null
      : manual.map((item) => (
          <p key={item.channelId}>
            {item.channelName}：这个渠道靠手工登记，共 {item.count} 个
          </p>
        ));
  let body: ReactNode;
  if (layers.modelRosterUnavailable) {
    body = <p>{layers.modelRosterUnavailable}</p>;
  } else if (!roster) {
    body = <p>渠道模型表没读到，不能当成都对得上</p>;
  } else if (
    roster.missingFromCatalog.length === 0 &&
    roster.goneRoutes.length === 0 &&
    roster.failed.length === 0 &&
    roster.notYet.length === 0 &&
    manual.length === 0
  ) {
    body = <p>{matchedSentence(roster)}</p>;
  } else if (
    roster.missingFromCatalog.length === 0 &&
    roster.goneRoutes.length === 0 &&
    roster.failed.length === 0 &&
    roster.notYet.length === 0
  ) {
    body = (
      <div className="space-y-3">
        <p>{matchedSentence(roster)}</p>
        {manualBlock}
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">渠道里有、目录里还没有的模型</h2>
          {roster.missingFromCatalog.length === 0 ? (
            <p className="mt-1 text-muted-foreground">没有</p>
          ) : (
            <ul className="mt-1 list-disc pl-5">
              {roster.missingFromCatalog.map((item) => (
                <li key={`${item.channelId}:${item.modelKey}`}>
                  {item.channelName}：{item.modelKey}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h2 className="text-sm font-semibold">目录里有、渠道已不认的路由</h2>
          {roster.goneRoutes.length === 0 ? (
            <p className="mt-1 text-muted-foreground">没有</p>
          ) : (
            <ul className="mt-1 list-disc pl-5">
              {roster.goneRoutes.map((item) => (
                <li key={item.routeId}>
                  {item.channelName} 的路由 {item.routeId}（模型 {item.modelId}，
                  {item.upstreamModel ? `上游串 ${item.upstreamModel}` : '目录没写上游串'}）
                </li>
              ))}
            </ul>
          )}
        </div>
        {roster.failed.map((item) => (
          <p key={item.channelId}>
            {item.channelName} 没读成（{item.code}）：{item.message}
          </p>
        ))}
        {roster.notYet.map((item) => (
          <p key={item.channelId}>{item.channelName} 还没读过</p>
        ))}
        {manualBlock}
      </div>
    );
  }
  return (
    <section
      aria-label="渠道模型表"
      className="mb-4 rounded-xl border border-dashed bg-card px-4 py-3 text-sm"
    >
      {body}
    </section>
  );
}
