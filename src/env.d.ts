import type { DiaryApi } from '../shared/types';

declare global {
  interface Window {
    diary?: DiaryApi;
  }
}
