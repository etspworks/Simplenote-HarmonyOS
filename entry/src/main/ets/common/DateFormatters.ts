// Port of DateFormatter+Simplenote.swift: the three shared, locale-aware formatters.
import { i18n, intl } from '@kit.LocalizationKit';

function build(dateStyle: string, timeStyle?: string): intl.DateTimeFormat {
  const options: intl.DateTimeOptions = { dateStyle: dateStyle };
  if (timeStyle !== undefined) {
    options.timeStyle = timeStyle;
  }
  return new intl.DateTimeFormat(i18n.System.getSystemLocale(), options);
}

// listDateFormatter: dateStyle .short, timeStyle .none
const LIST_DATE_FORMATTER: intl.DateTimeFormat = build('short');
// dateTimeFormatter: dateStyle .medium, timeStyle .short
const DATE_TIME_FORMATTER: intl.DateTimeFormat = build('medium', 'short');
// dateFormatter: dateStyle .medium, timeStyle .none
const DATE_FORMATTER: intl.DateTimeFormat = build('medium');

export function formatListDate(date: Date): string {
  return LIST_DATE_FORMATTER.format(date);
}

export function formatDateTime(date: Date): string {
  return DATE_TIME_FORMATTER.format(date);
}

export function formatMediumDate(date: Date): string {
  return DATE_FORMATTER.format(date);
}
