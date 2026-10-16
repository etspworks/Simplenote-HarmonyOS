// Options.swift lives in ../common/OptionsStore (single implementation over the SimplenoteDefaults
// preferences file). This module only re-exports it for model-path importers.
export {
  Options,
  OptionsStore,
  OptionsEvent,
  DefaultsKey,
  DefaultsKey as UserDefaultsKey,
  SORT_MODES,
  THEMES,
  sortModeRawValue,
  sortModeDescription,
  themeRawValue,
  themeDescription
} from '../common/OptionsStore';
