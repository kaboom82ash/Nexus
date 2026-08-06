import { defineWidget, type WidgetProps } from './types'
import { listWidgets } from './registry'

interface SkillsConfig {
  /** Hide this widget from its own list to avoid recursion in the display. */
  hideSelf: boolean
}

const DEFAULT_CONFIG: SkillsConfig = { hideSelf: true }

const SELF_TYPE = 'skills'

function SkillsBody({ config, title }: WidgetProps<SkillsConfig>) {
  const widgets = listWidgets().filter(
    (w) => !(config.hideSelf && w.type === SELF_TYPE),
  )
  return (
    <div className="widget skills-widget">
      <div className="widget__head">
        <span className="widget__icon" aria-hidden>
          🧩
        </span>
        <span className="widget__title">{title}</span>
        <span className="widget__inline-count">{widgets.length}</span>
      </div>

      <div className="widget__body widget__body--list">
        <ul className="skills-list">
          {widgets.map((w) => (
            <li key={w.type} className="skill">
              <span className="skill__icon" aria-hidden>
                {w.icon}
              </span>
              <span className="skill__text">
                <span className="skill__name">{w.name}</span>
                <span className="skill__desc">{w.description}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="widget__foot">
        <span className="widget__hint">Add any from an empty tile’s +</span>
      </div>
    </div>
  )
}

export const skillsWidget = defineWidget<SkillsConfig>({
  type: SELF_TYPE,
  name: 'Skills',
  description: 'Lists every widget (skill) available to add to the dashboard.',
  icon: '🧩',
  defaultConfig: DEFAULT_CONFIG,
  component: SkillsBody,
})
