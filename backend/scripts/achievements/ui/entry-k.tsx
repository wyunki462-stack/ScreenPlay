import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '../../../../web/src/i18n';
import GameDetail from '../../../../web/src/pages/GameDetail';

/** 真实渲染游戏详情页，用于校验「进入即置顶」与上/下一个导航按钮。 */
export const detailPage = (route: string) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })}
  >
    <I18nProvider>
      <MemoryRouter initialEntries={[route]}>
        {/* 必须走真实路由：GameDetail 用 useParams 取 id，没有 Routes 拿不到 id，
            查询就不会发出，测试会假失败。 */}
        <Routes>
          <Route path="/game/:id" element={<GameDetail />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>
  </QueryClientProvider>
);
