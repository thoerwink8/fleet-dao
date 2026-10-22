// 陈列页 /_design 的「会话 Transcript」一节（#3533）：弹出窗口和任务页会话抽屉用的几件——
// TranscriptPane、StepDivider、ToolToggle、OutputBox、SubagentFrame、ClampedText、Markdown、Popout、PickGroup，
// 加会话里的读失败 / 刷新没成 / 没记录几种样子。业务层：一个样式类也不写，只拼组件。
import { useState } from 'react';
import { Button } from '../components/layout/button';
import { Message, ROLE } from '../components/layout/chat';
import { EmptyState } from '../components/layout/empty-state';
import { LoadError, LoadStale } from '../components/layout/load-state';
import { Markdown } from '../components/layout/markdown';
import { Nest } from '../components/layout/nest';
import { PickGroup, PickList } from '../components/layout/pick-list';
import { Popout } from '../components/layout/popout';
import { Section } from '../components/layout/section';
import { Stack } from '../components/layout/stack';
import { Tag } from '../components/layout/tag';
import { Text } from '../components/layout/text';
import {
  ClampedText,
  OutputBox,
  StepDivider,
  SubagentFrame,
  ToolToggle,
  TranscriptFooter,
  TranscriptItem,
  TranscriptList,
  TranscriptPane,
} from '../components/layout/transcript';

const LONG_PROMPT =
  '上一回合 CI 没过：test（5/8）、check。失败的是 push-handback.test.ts，20 秒超时；check 报了一条 lint 警告。请先本机单跑，判断是你的改动引起的还是偶发，再决定改不改。';

export function TranscriptSection() {
  const [group, setGroup] = useState(true);
  const [okRow, setOkRow] = useState(false);
  const [sub, setSub] = useState(false);
  const [full, setFull] = useState(false);
  return (
    <Stack gap="lg">
      <Section
        title="会话内容 TranscriptPane"
        description="筛选条在上、正文自己滚、底栏在下。步骤分隔线、对话气泡、调用行、子代理卡都在正文里。"
        flush
      >
        <TranscriptPane
          filters={<Text tone="secondary">全部 / 只看出错 / 只看文字（FilterTabs segmented）</Text>}
          search={<Text tone="muted">在会话里找（SearchInput）</Text>}
          footer={
            <TranscriptFooter
              action={
                <Button size="xs" variant="outline">
                  跳到最新
                </Button>
              }
            >
              还在跑 · 每 3 秒读一次 · 上次 12:43:20
            </TranscriptFooter>
          }
        >
          <TranscriptList label="示例会话">
            <TranscriptItem block="divider">
              <StepDivider index={0} title="第 1 步" tail="12:42:41 · 8 分" />
            </TranscriptItem>
            <TranscriptItem block="entry">
              <Message role={ROLE.me} kind="prompt" meta="提示词">
                <ClampedText variant="body" {...(full ? {} : { lines: 2 as const })}>
                  {LONG_PROMPT}
                </ClampedText>
                <Button size="xs" variant="text" aria-expanded={full} onClick={() => setFull((v) => !v)}>
                  {full ? '收起' : '看全文'}
                </Button>
              </Message>
            </TranscriptItem>
            <TranscriptItem block="say">
              <Message role={ROLE.other}>
                <Markdown
                  text={'先看工作树状态，再定位真实超时：\n\n- 看 **git status**\n- 单跑 `prerender-trace`'}
                />
              </Message>
            </TranscriptItem>
            <TranscriptItem block="tools">
              <ToolToggle
                open={group}
                onToggle={() => setGroup((v) => !v)}
                label="已运行 2 个命令，已读取 1 个文件"
                quiet
                trailing={<Tag tone="error">1 个失败</Tag>}
              >
                <Nest>
                  <ToolToggle
                    open={okRow}
                    onToggle={() => setOkRow((v) => !v)}
                    lead="已运行"
                    label="git status --short"
                    mono
                  >
                    <OutputBox>
                      <ClampedText>（空）</ClampedText>
                    </OutputBox>
                  </ToolToggle>
                  <ToolToggle
                    open
                    onToggle={() => undefined}
                    lead="运行失败"
                    label="sed -n 1,80p vite.js"
                    failed
                    wrap
                    mono
                  >
                    <OutputBox failed>
                      <ClampedText tone="danger">退出码 1：没有这个文件</ClampedText>
                    </OutputBox>
                  </ToolToggle>
                </Nest>
              </ToolToggle>
            </TranscriptItem>
            <TranscriptItem block="divider">
              <StepDivider index={1} title="第 2 步" tail="12:43:20 · 在跑" tone="processing" />
            </TranscriptItem>
            <TranscriptItem block="divider">
              <StepDivider
                index={2}
                title="运行 pnpm test"
                tail="12:50:02 · 1 分"
                tone="error"
                flag={<Tag tone="error">有失败</Tag>}
              />
            </TranscriptItem>
            <TranscriptItem block="subagent">
              <SubagentFrame
                open={sub}
                onToggle={() => setSub((v) => !v)}
                head="子代理 fleet-scout · 找文件 · 1 次调用 · 6 秒"
                trailing={<Tag tone="error">1 个失败</Tag>}
              >
                <Markdown tone="secondary" text="读了 deploy/release.sh 的预渲染段，没有改动。" />
                <OutputBox indent={false} label="它回的话">
                  <ClampedText variant="body">找到了。</ClampedText>
                </OutputBox>
              </SubagentFrame>
            </TranscriptItem>
            <TranscriptItem block="entry">
              <Message
                role={ROLE.other}
                kind="result"
                meta={
                  <>
                    结论 <Tag tone="error">没成</Tag>
                  </>
                }
              >
                <Markdown strong text="单跑也卡住，没能判断是不是偶发。" />
              </Message>
            </TranscriptItem>
          </TranscriptList>
        </TranscriptPane>
      </Section>

      <Section title="会话的读取状态">
        <Stack>
          <LoadError
            text="没读成：连不上后端（网关超时）"
            error={new Error('网关超时')}
            onRetry={() => undefined}
          />
          <LoadStale
            stale={{
              error: new Error('网关超时'),
              dataUpdatedAt: Date.now() - 3 * 60_000,
              retry: () => undefined,
            }}
            staleAfterMs={5 * 60_000}
          />
          <EmptyState title="没有记录" hint="这一段跑在记录会话内容之前，没有记录" />
        </Stack>
      </Section>

      <Section
        title="弹出窗口 Popout"
        description="左卡列这张单的笔（PickGroup 加 PickList，每行可以是链接），右卡放会话。窄屏左卡收起。"
      >
        <Popout
          embedded
          backHref="/_design"
          taskLabel="#3491 发布 SPA 外壳预渲染请求超时"
          sideTitle="这张单的笔"
          sideCount={3}
          side={
            <>
              <PickGroup label="第 1 回合">
                <PickList
                  aria-label="第 1 回合"
                  value="b"
                  items={[
                    {
                      key: 'a',
                      title: '第 1 笔 · 动手',
                      meta: 'Sonnet 5.5 · 41 分',
                      status: 'task:segment:done',
                    },
                    {
                      key: 'b',
                      title: '第 2 笔 · 动手',
                      meta: 'Sonnet 5.5 · 1 小时 12 分',
                      status: 'tone:run',
                    },
                  ]}
                />
              </PickGroup>
              <PickGroup label="第 2 回合">
                <PickList
                  aria-label="第 2 回合"
                  items={[
                    { key: 'c', title: '第 3 笔 · 验收', meta: '耗时没读到', status: 'task:segment:unread' },
                  ]}
                />
              </PickGroup>
            </>
          }
          title="第 2 笔 · 动手"
          meta={
            <Text size="meta" tone="muted">
              主写 · 接上一笔的会话 · 09:30 起 · 1 小时 12 分 · $0.30
            </Text>
          }
        >
          <TranscriptPane>
            <TranscriptList label="弹出窗口示例">
              <TranscriptItem block="say">
                <Message role={ROLE.other}>
                  <Markdown text="先在本机单独跑 push-handback.test.ts。" />
                </Message>
              </TranscriptItem>
            </TranscriptList>
          </TranscriptPane>
        </Popout>
      </Section>
    </Stack>
  );
}
