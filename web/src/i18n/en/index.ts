import { commonEn } from './common';
import { homeEn } from './home';
import { detailEn } from './detail';
import { settingsEn } from './settings';
import { dialogsEn } from './dialogs';
import { mediaEn } from './media';

export const en: Record<string, string> = {
  ...commonEn,
  ...homeEn,
  ...detailEn,
  ...settingsEn,
  ...dialogsEn,
  ...mediaEn,
};