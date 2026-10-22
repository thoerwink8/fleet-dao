// 陈列页 /_design 的「按钮和输入」一节（#3533）：layout 的 Button（五种样子 × 三档尺寸 × 忙态、置灰、链接）和 Input、Textarea、Label、Switch、SaveButton。
// 业务层：一个样式类也不写，只拼组件。
import { useState } from 'react';
import { Button } from '../components/layout/button';
import { FieldGroup, FieldRow } from '../components/layout/field-row';
import { Input, Label, Textarea } from '../components/layout/input';
import { SaveButton } from '../components/layout/save-button';
import { Section } from '../components/layout/section';
import { Stack } from '../components/layout/stack';
import { Switch } from '../components/layout/switch';
import { Text } from '../components/layout/text';

export function ControlsSection() {
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState(true);
  const [name, setName] = useState('fleet-dao');
  return (
    <Stack gap="xl">
      <Section
        title="按钮 Button"
        description="主按钮一块只有一个、列表行里不放；次要用 secondary（默认）；描边只在样稿画了描边的地方用。"
      >
        <Stack>
          <Stack direction="horizontal" gap="sm" align="center" wrap>
            <Button variant="primary">主要</Button>
            <Button variant="secondary">次要</Button>
            <Button variant="outline">描边</Button>
            <Button variant="text">文字</Button>
            <Button variant="danger">危险</Button>
          </Stack>
          <Stack direction="horizontal" gap="sm" align="center" wrap>
            <Button size="xs">xs 24</Button>
            <Button size="sm">sm 28</Button>
            <Button size="md">md 32</Button>
            <Button disabledReason="远程快照只读">置灰</Button>
            <Button href="/tasks" variant="text">
              链接
            </Button>
          </Stack>
          <Stack direction="horizontal" gap="sm" align="center" wrap>
            <Button
              variant="outline"
              loading={busy}
              onClick={() => {
                setBusy(true);
                setTimeout(() => setBusy(false), 1200);
              }}
            >
              点一下转圈
            </Button>
            <Button loading>忙态</Button>
          </Stack>
        </Stack>
      </Section>
      <Section
        title="输入 Input、Textarea、Label"
        description="宽度走 width 档位：full（默认）、sm、md、search。"
      >
        <FieldGroup>
          <FieldRow label={<Label htmlFor="ctl-name">名字</Label>} hint="显示在列表里。">
            <Input id="ctl-name" value={name} onChange={(e) => setName(e.target.value)} width="md" />
          </FieldRow>
          <FieldRow label="说明" htmlFor="ctl-note" error="说明不能为空。">
            <Textarea id="ctl-note" aria-invalid defaultValue="" width="search" />
          </FieldRow>
          <FieldRow label="短的">
            <Input aria-label="短的" width="sm" placeholder="sm" />
            <Text tone="muted">定宽 160</Text>
          </FieldRow>
          <FieldRow label="百分数">
            <Input aria-label="百分数" width="xs" placeholder="—" />
            <Text size="meta" tone="muted">
              %
            </Text>
            <Text tone="muted">定宽 88，空着显示占位</Text>
          </FieldRow>
          <FieldRow label="开关 Switch">
            <Switch checked={on} onCheckedChange={setOn} aria-label="演示开关" />
            <Text tone="secondary">{on ? '开着' : '关着'}</Text>
            <Switch checked disabled aria-label="演示置灰" />
          </FieldRow>
          <FieldRow label="保存 SaveButton">
            <SaveButton canSave variant="secondary" />
            <SaveButton canSave={false} />
            <Text tone="muted">一页好几个保存键并列时用 secondary；没东西可存是灰的</Text>
          </FieldRow>
        </FieldGroup>
      </Section>
    </Stack>
  );
}
