import type { WidgetDefinition } from './types'
import { gmailInboxWidget } from './GmailInboxWidget'
import { topEmailsWidget } from './TopEmailsWidget'

/**
 * The widget registry. To add a new widget type, build it in its own file
 * (exporting a `WidgetDefinition`) and add it to this array — nothing else
 * needs to change.
 */
const WIDGETS: WidgetDefinition<any>[] = [gmailInboxWidget, topEmailsWidget]

const byType = new Map<string, WidgetDefinition<any>>(
  WIDGETS.map((w) => [w.type, w]),
)

export function listWidgets(): WidgetDefinition<any>[] {
  return WIDGETS
}

export function getWidget(type: string): WidgetDefinition<any> | undefined {
  return byType.get(type)
}
