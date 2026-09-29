import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '../../../../web/src/i18n';
import AchievementPickDialog from '../../../../web/src/components/AchievementPickDialog';

/** 渲染真实的「手动选择游戏」弹窗，用于校验搜索框提示文案。 */
export const pickDialogTree = (props: { gameId: string; gameName: string; onClose: () => void }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })}
  >
    <I18nProvider>
      <MemoryRouter>
        <AchievementPickDialog {...props} />
      </MemoryRouter>
    </I18nProvider>
  </QueryClientProvider>
);
