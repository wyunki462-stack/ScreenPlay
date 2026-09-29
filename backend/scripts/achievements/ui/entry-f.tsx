import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '../../../../web/src/i18n';
import RatingPickDialog from '../../../../web/src/components/RatingPickDialog';

/** 渲染真实的「手动选择评分」弹窗，用于校验结构、文案与交互。 */
export const ratingDialogTree = (props: { gameId: string; gameName: string; onClose: () => void }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })}
  >
    <I18nProvider>
      <MemoryRouter>
        <RatingPickDialog {...props} />
      </MemoryRouter>
    </I18nProvider>
  </QueryClientProvider>
);
