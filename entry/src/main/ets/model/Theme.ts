// Port of Theme.swift: the available themes. Raw values are what Options.theme persists.

export enum Theme {
  /** Darkness! */
  DARK = 0,
  /** Old School Light */
  LIGHT = 1,
  /** Matches the System Settings */
  SYSTEM = 2
}

export class ThemeInfo {
  /** CaseIterable.allCases */
  static readonly ALL_CASES: Theme[] = [Theme.DARK, Theme.LIGHT, Theme.SYSTEM];

  static readonly ALL_THEMES: Theme[] = [Theme.DARK, Theme.LIGHT, Theme.SYSTEM];

  static readonly LEGACY_THEMES: Theme[] = [Theme.DARK, Theme.LIGHT];

  static readonly DEFAULT_THEME_FOR_CURRENT_OS: Theme = Theme.SYSTEM;

  /** Theme(rawValue:) */
  static fromRawValue(rawValue: number): Theme | null {
    return ThemeInfo.ALL_CASES.indexOf(rawValue as Theme) !== -1 ? rawValue as Theme : null;
  }

  /** Returns a localized Description, matching the current rawValue */
  static description(theme: Theme): string {
    switch (theme) {
      case Theme.DARK:
        return 'Dark';
      case Theme.LIGHT:
        return 'Light';
      case Theme.SYSTEM:
        return 'System Default';
      default:
        return '';
    }
  }
}
