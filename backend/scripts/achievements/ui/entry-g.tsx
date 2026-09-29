import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '../../../../web/src/i18n';
import GameCard, { type CardDragProps } from '../../../../web/src/components/GameCard';
import type { GameSummary } from '../../../../web/src/types';

const game = (over: Partial<GameSummary> = {}): GameSummary =>
  ({
    id: 'g1', name: 'Hades', posterUrl: '', posters: [], posterMode: 'static',
    mediaCount: 3, durationSeconds: 0, durationText: '0秒', metacriticScore: 93,
    metacriticCriticCount: 88, metaError: null, firstPlayedAt: null, lastPlayedAt: null,
    ...over,
  }) as GameSummary;

/** 图库卡片：普通形态 / 拖拽中 / 落点高亮三种状态。 */
export const cardPlain = () => (
  <QueryClientProvider client={new QueryClient()}>
    <I18nProvider>
      <MemoryRouter>
        <GameCard game={game()} />
      </MemoryRouter>
    </I18nProvider>
  </QueryClientProvider>
);

export const cardWithDrag = (drag: Partial<CardDragProps>) => {
  const full: CardDragProps = {
    enabled: true, dragging: false, dropSide: null,
    onDragStart: () => {}, onDragOver: () => {}, onDrop: () => {}, onDragEnd: () => {},
    ...drag,
  };
  return (
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <MemoryRouter>
          <GameCard game={game()} drag={full} />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>
  );
};
