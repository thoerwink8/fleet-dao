## 场景

接口返回的项目列表多了一个 `lastSyncAt` 字段，页面上要显示出来。

## 原话

「项目页上看得到最近一次同步是什么时候」

## 已知的模块

- `packages/api/src/routes/projects.ts`
- `packages/web/src/pages/projects.tsx`

## 怎么算做完

1. 接口的项目对象带 `lastSyncAt`。
2. 项目页每一行显示它，没有值显示「从未同步」。
