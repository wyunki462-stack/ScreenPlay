import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '../../../../web/src/i18n';
import GameDetail from '../../../../web/src/pages/GameDetail';
import GameCard from '../../../../web/src/components/GameCard';

function wrap(node: React.ReactNode, path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false } } });
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/game/:id" element={node} />
            <Route path="/card" element={node} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>
  );
}
export const detailTree = (id: string) => wrap(<GameDetail />, `/game/${id}`);
export const cardTree = (game: any) => wrap(<GameCard game={game} />, '/card');
