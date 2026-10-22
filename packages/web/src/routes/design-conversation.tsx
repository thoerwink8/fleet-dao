// 陈列页 /_design 的「对话和工作区」一节（#3533）：提需求页用的 Title、Avatar、Inset、RuleLabel、ChoiceRow、Pane/Workspace、MenuButton。
// 业务层：一个样式类也不写，只拼组件。
import { useState } from 'react';
import { Avatar, AvatarPair, AvatarStack, BotAvatar } from '../components/layout/avatar';
import { Button } from '../components/layout/button';
import { Message } from '../components/layout/chat';
import { ChoiceRow } from '../components/layout/choice-row';
import { Inset, RuleLabel } from '../components/layout/inset';
import { List } from '../components/layout/list';
import { MenuButton } from '../components/layout/menu-button';
import { Pane, Workspace } from '../components/layout/pane';
import { RowMenuRadioGroup, RowMenuRadioItem } from '../components/layout/row-menu';
import { Section } from '../components/layout/section';
import { Stack } from '../components/layout/stack';
import { StatusBadge } from '../components/layout/status-badge';
import { Tag } from '../components/layout/tag';
import { Text } from '../components/layout/text';
import { Title } from '../components/layout/title';

const A = { id: 'a', name: '成员 A' };
const B = { id: 'b', name: '成员 B' };

export function ConversationSection() {
  const [sel, setSel] = useState(1);
  const [model, setModel] = useState('opus');
  return (
    <Stack gap="xl">
      <Section
        title="标题 Title、头像 Avatar"
        description="Title 三档：页面 20、区块 16、小标题 14；头像只分我（品牌色）和别人（灰）。"
      >
        <Stack>
          <Title level={1}>页面标题 level 1</Title>
          <Title level={2}>区块标题 level 2</Title>
          <Title level={3}>小标题 level 3</Title>
          <Stack direction="horizontal" gap="md" align="center">
            <Avatar person={A} me />
            <Avatar person={B} me={false} />
            <BotAvatar who="commander" />
            <BotAvatar who="engine" />
            <AvatarPair main={A} extra={B} meId="a" />
            <AvatarStack people={[A, B]} meId="a" />
          </Stack>
        </Stack>
      </Section>
      <Section
        title="内嵌卡片 Inset、分隔线 RuleLabel"
        description="对话里的方案卡、建议卡、拍板卡；虚线是还没生效的建议。"
      >
        <Stack>
          <Inset>
            <Text size="meta" tone="muted">
              方案 · 草稿第 3 版
            </Text>
            <Text>把设置页的几个密钥一次填好。</Text>
            <Stack direction="horizontal" gap="sm">
              <Button size="sm" variant="outline">
                确认开单
              </Button>
              <Button size="sm" variant="text">
                改某一栏
              </Button>
            </Stack>
          </Inset>
          <Inset look="dashed">
            <Text size="meta" tone="muted">
              建议改「场景」（这一栏人改过，指挥官不直接动）
            </Text>
            <Text>登录后第一次进设置页时。</Text>
          </Inset>
          <RuleLabel>已结案 · 2026-10-20 · 同意做 · 开成 #3487</RuleLabel>
          <RuleLabel accent>以下是新消息</RuleLabel>
        </Stack>
      </Section>
      <Section
        title="工作区 Workspace、窗格 Pane、可选行 ChoiceRow"
        description="桌面左列表右对话各一张卡，各自滚；手机叠成一列。"
      >
        <Workspace>
          <Pane label="示例列表" as="nav" size="list" head={<Title>需求</Title>}>
            <List divided={false}>
              {[1, 2, 3].map((n) => (
                <ChoiceRow
                  key={n}
                  selected={sel === n}
                  leading={<AvatarPair main={A} extra={n === 2 ? B : undefined} meId="a" />}
                  title={`第 ${n} 条需求的标题`}
                  time="3 分钟前"
                  meta="指挥官：你要哪种？"
                  tags={
                    n === 2 ? (
                      <Tag>等我 2</Tag>
                    ) : (
                      <StatusBadge status="request:request:discussing" variant="dot" />
                    )
                  }
                  note={n === 3 ? '没删成：只有发起人说过话的才能删' : undefined}
                  onClick={() => setSel(n)}
                />
              ))}
            </List>
          </Pane>
          <Pane
            label="示例对话"
            column
            head={
              <Stack direction="horizontal" gap="sm" align="center" justify="between">
                <Title truncate>第 {sel} 条需求的标题</Title>
                <StatusBadge status="request:request:discussing" />
              </Stack>
            }
            foot={
              <Stack direction="horizontal" gap="sm" align="center">
                <MenuButton label={model === 'opus' ? 'Opus 5.5' : 'Sonnet 5.5'} title="换这一条的指挥官模型">
                  <RowMenuRadioGroup value={model} onValueChange={setModel}>
                    <RowMenuRadioItem value="opus">Opus 5.5</RowMenuRadioItem>
                    <RowMenuRadioItem value="sonnet">Sonnet 5.5</RowMenuRadioItem>
                  </RowMenuRadioGroup>
                </MenuButton>
                <Text size="meta" tone="muted">
                  左下角的模型芯片
                </Text>
              </Stack>
            }
          >
            {/* biome-ignore lint/a11y/useValidAriaRole: role 是消息的角色，不是 ARIA role。 */}
            <Message role="other" meta="指挥官 · 10:01">
              你想让这个按钮在哪一页出现？
            </Message>
            {/* biome-ignore lint/a11y/useValidAriaRole: role 是消息的角色，不是 ARIA role。 */}
            <Message role="me" meta="10:02">
              设置页就行。
            </Message>
          </Pane>
        </Workspace>
      </Section>
    </Stack>
  );
}
