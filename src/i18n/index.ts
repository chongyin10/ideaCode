import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN/common.json';
import zhTW from './locales/zh-TW/common.json';
import en from './locales/en/common.json';

export const resources = {
  'zh-CN': { common: zhCN },
  'zh-TW': { common: zhTW },
  en: { common: en },
} as const;

export const SUPPORTED_LANGUAGES = [
  { code: 'zh-CN' as const, name: '简体中文' },
  { code: 'zh-TW' as const, name: '繁體中文' },
  { code: 'en' as const, name: 'English' },
];

export type LanguageCode = typeof SUPPORTED_LANGUAGES[number]['code'];

const STORAGE_KEY = 'ideacode-language';

export function getSavedLanguage(): LanguageCode {
  const saved = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
  if (saved && (saved === 'zh-CN' || saved === 'zh-TW' || saved === 'en')) {
    return saved;
  }
  return 'zh-CN';
}

export function saveLanguage(lng: LanguageCode): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, lng);
  }
}

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: getSavedLanguage(),
    fallbackLng: 'zh-CN',
    ns: ['common'],
    defaultNS: 'common',
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
