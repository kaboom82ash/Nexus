import type { ComponentType } from 'react'

/** Props every widget body receives. */
export interface WidgetProps<Config = Record<string, unknown>> {
  /** The stored instance config (already merged with defaults). */
  config: Config
  /** Persist a config change for this instance. */
  onConfigChange: (next: Config) => void
  /** Title to display (custom override if set, else the widget default). */
  title: string
}

/**
 * Props for a widget's settings form. This is a *controlled body* — it renders
 * only fields and calls `onChange` on every edit. The surrounding Customize
 * modal owns the Save / Cancel buttons and persistence.
 */
export interface WidgetSettingsProps<Config = Record<string, unknown>> {
  config: Config
  onChange: (next: Config) => void
}

export interface WidgetDefinition<Config = Record<string, unknown>> {
  /** Stable key stored on each instance. */
  type: string
  /** Human name shown in the widget picker and as the default tile title. */
  name: string
  /** One-line description for the picker. */
  description: string
  /** Emoji or short glyph shown in the picker. */
  icon: string
  /** Config applied to a freshly-added instance. */
  defaultConfig: Config
  /** The rendered widget body. */
  component: ComponentType<WidgetProps<Config>>
  /** Optional settings form body; if omitted, only common tile options show. */
  settings?: ComponentType<WidgetSettingsProps<Config>>
}

/** Helper to declare a widget while keeping its Config type inferred. */
export function defineWidget<Config>(
  def: WidgetDefinition<Config>,
): WidgetDefinition<Config> {
  return def
}
