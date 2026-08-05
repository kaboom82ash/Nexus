import type { ComponentType } from 'react'

/** Props every widget component receives. */
export interface WidgetProps<Config = Record<string, unknown>> {
  /** The stored instance config (already merged with defaults). */
  config: Config
  /** Persist a config change for this instance. */
  onConfigChange: (next: Config) => void
  /** Open this widget's settings UI, if it defines one. */
  onOpenSettings: () => void
}

/** Props for an optional settings/config form. */
export interface WidgetSettingsProps<Config = Record<string, unknown>> {
  config: Config
  onSave: (next: Config) => void
  onClose: () => void
}

export interface WidgetDefinition<Config = Record<string, unknown>> {
  /** Stable key stored on each instance. */
  type: string
  /** Human name shown in the widget picker. */
  name: string
  /** One-line description for the picker. */
  description: string
  /** Emoji or short glyph shown in the picker. */
  icon: string
  /** Config applied to a freshly-added instance. */
  defaultConfig: Config
  /** The rendered widget body. */
  component: ComponentType<WidgetProps<Config>>
  /** Optional settings form; if omitted the settings button is hidden. */
  settings?: ComponentType<WidgetSettingsProps<Config>>
}

/** Helper to declare a widget while keeping its Config type inferred. */
export function defineWidget<Config>(
  def: WidgetDefinition<Config>,
): WidgetDefinition<Config> {
  return def
}
