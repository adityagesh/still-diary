import type { DiaryApi, Result } from '../shared/types';

export function api(): DiaryApi {
  if (!window.diary) throw new Error('Open Still Diary as a desktop app with npm run dev or npm start.');
  return window.diary;
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
