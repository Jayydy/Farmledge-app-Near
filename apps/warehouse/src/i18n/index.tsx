import { createContext, useContext, type ReactNode } from 'react';

import type { ApiErrorCode, DomainErrorCode } from '../types/api';
import { en, enErrors, type MessageKey } from './en';
import { ha, haErrors } from './ha';

export type Language = 'en' | 'ha';

const messages: Record<Language, Record<MessageKey, string>> = { en, ha };
const errors: Record<Language, Record<DomainErrorCode | ApiErrorCode, string>> = {
  en: enErrors,
  ha: haErrors,
};

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export function translator(language: Language): Translate {
  return (key, values = {}) =>
    messages[language][key].replace(/\{(\w+)\}/g, (match, name: string) =>
      name in values ? String(values[name]) : match,
    );
}

/** A plain-words message for an API error code; unknown codes fall back to the API's message. */
export function errorText(language: Language, code: string, fallback: string): string {
  return (errors[language] as Record<string, string | undefined>)[code] ?? fallback;
}

/**
 * Like errorText, but a validation failure names its first field's problem
 * ("The witness cannot be a custodian…") rather than "Request is invalid".
 */
export function apiErrorText(
  language: Language,
  error: { code: string; message: string; details?: unknown },
): string {
  const first: unknown = Array.isArray(error.details) ? error.details[0] : undefined;
  if (typeof first === 'object' && first !== null && 'code' in first) {
    const code = String(first.code);
    const message = 'message' in first ? String(first.message) : error.message;
    return errorText(language, code, message);
  }
  return errorText(language, error.code, error.message);
}

interface I18n {
  language: Language;
  t: Translate;
  setLanguage: (language: Language) => void;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ value, children }: { value: I18n; children: ReactNode }) {
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (value === null) throw new Error('useI18n outside I18nProvider');
  return value;
}
