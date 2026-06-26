import enDict from './en.json';
import heDict from './he.json';

export type Lang = 'en' | 'he';
export type TranslationKey = keyof typeof enDict;

let lang = $state<Lang>('en');

export function getLang(): Lang {
  return lang;
}

export function setLang(next: Lang): void {
  lang = next;
}

export function t(key: TranslationKey): string {
  const dict = lang === 'he' ? heDict : enDict;
  // Cast to a string-indexable record for the fallback path.
  // The HE-coverage Bun test enforces that no real key is missing.
  const value = (dict as Record<string, string>)[key];
  return value ?? key;
}
