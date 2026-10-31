import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import './app.css';
import { BlockPlaceholder, MorePage, Shell } from './components/shell';
import { Work } from './pages/work';
import { Workbench } from './pages/workbench';

// 整个新驾驶舱挂在 /next/ 下（vite.config.ts 的 base）；旧驾驶舱在根路径，互不干扰。
const router = createBrowserRouter(
  [
    {
      element: <Shell />,
      children: [
        { index: true, element: <Workbench /> },
        { path: 's/:id', element: <Workbench /> },
        {
          path: 'work',
          element: <Work />,
        },
        {
          path: 'decide',
          element: (
            <BlockPlaceholder
              title="决策"
              slice="决策卡：母单 #3770 的第 6 片（指挥官会话能说话、决策卡、推送）。"
              note="要你拍板的事会汇到这里，一张卡一件事。"
            />
          ),
        },
        {
          path: 'ops',
          element: (
            <BlockPlaceholder
              title="法国运维"
              slice="运维块：旧驾驶舱的法国页在第 10 片换到根路径前并进来。"
              note="现在运维请继续用旧驾驶舱。"
            />
          ),
        },
        {
          path: 'settings',
          element: (
            <BlockPlaceholder
              title="设置"
              slice="设置块：旧驾驶舱的设置、渠道、路由在第 10 片前并进来。"
              note="现在设置请继续用旧驾驶舱。"
            />
          ),
        },
        { path: 'more', element: <MorePage /> },
        {
          path: '*',
          element: <BlockPlaceholder title="没有这一页" slice="" note="地址不对，从左边的导航回到会话。" />,
        },
      ],
    },
  ],
  { basename: import.meta.env.BASE_URL.replace(/\/$/, '') },
);

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}
