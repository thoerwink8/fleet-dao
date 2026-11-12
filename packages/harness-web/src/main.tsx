import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import './app.css';
import { BlockPlaceholder, MorePage, Shell } from './components/shell';
import { IS_LOCAL } from './lib/profile';
import { DecidePage } from './pages/decide';
import { HostsPage, InboxPage, LocalSettingsPage } from './pages/local-pages';
import { OpsPage } from './pages/ops';
import { SettingsPage } from './pages/settings';
import { Work } from './pages/work';
import { WorkWavePage } from './pages/work-wave';
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
          path: 'waves',
          element: <WorkWavePage />,
        },
        ...(IS_LOCAL
          ? [
              { path: 'inbox', element: <InboxPage /> },
              { path: 'hosts', element: <HostsPage /> },
              { path: 'settings', element: <LocalSettingsPage /> },
            ]
          : []),
        {
          path: 'decide',
          element: <DecidePage />,
        },
        {
          path: 'ops',
          element: <OpsPage />,
        },
        ...(IS_LOCAL
          ? []
          : [
              {
                path: 'settings',
                element: <SettingsPage />,
              },
            ]),
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
