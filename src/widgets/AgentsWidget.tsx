import { useCallback, useEffect, useRef, useState } from 'react'
import { defineWidget, type WidgetProps, type WidgetSettingsProps } from './types'
import { runPrompt, isLlmMock, listAccountAgents } from '../lib/llm'
import { makeId } from '../lib/id'

interface Agent {
  id: string
  name: string
  /** System prompt that defines the agent's role. */
  system: string
}

interface AgentsConfig {
  agents: Agent[]
  activeAgentId: string
  model: string
  maxTokens: number
}

const DEFAULT_AGENTS: Agent[] = [
  {
    id: 'summarizer',
    name: 'Summarizer',
    system:
      'You are a concise summarizer. Given any text or topic, produce a tight, well-structured bullet-point summary. No preamble.',
  },
  {
    id: 'brainstormer',
    name: 'Brainstormer',
    system:
      'You are a creative brainstorming partner. Offer diverse, concrete, non-obvious ideas as a short numbered list.',
  },
  {
    id: 'explainer',
    name: 'Explainer',
    system:
      'You explain complex topics simply and accurately, like to a smart 12-year-old, using short paragraphs and analogies.',
  },
  {
    id: 'email',
    name: 'Email Drafter',
    system:
      'You draft clear, professional, friendly emails from brief instructions. Return only the email, with a subject line.',
  },
  {
    id: 'critic',
    name: 'Critic',
    system:
      'You are a rigorous but constructive critic. Identify the biggest flaws, risks, and concrete improvements. Be direct.',
  },
]

const DEFAULT_CONFIG: AgentsConfig = {
  agents: DEFAULT_AGENTS,
  activeAgentId: 'summarizer',
  model: 'claude-haiku-4-5-20251001',
  maxTokens: 800,
}

function AgentsBody({ config, title }: WidgetProps<AgentsConfig>) {
  const [activeId, setActiveId] = useState(
    config.agents.some((a) => a.id === config.activeAgentId)
      ? config.activeAgentId
      : config.agents[0]?.id ?? '',
  )
  const [prompt, setPrompt] = useState('')
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const mounted = useRef(true)
  const abortRef = useRef<AbortController | null>(null)
  const mock = isLlmMock()

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      abortRef.current?.abort()
    }
  }, [])

  const agent = config.agents.find((a) => a.id === activeId) ?? config.agents[0]

  const run = useCallback(async () => {
    if (!prompt.trim() || !agent) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setRunning(true)
    setError(null)
    setOutput('')
    try {
      await runPrompt({
        prompt,
        system: agent.system,
        model: config.model,
        maxTokens: config.maxTokens,
        signal: ctrl.signal,
        onToken: (chunk) => {
          if (!ctrl.signal.aborted && mounted.current) {
            setOutput((prev) => prev + chunk)
          }
        },
      })
    } catch (err) {
      if (!ctrl.signal.aborted && mounted.current) {
        setError(err instanceof Error ? err.message : 'Failed')
      }
    } finally {
      if (mounted.current) setRunning(false)
    }
  }, [prompt, agent, config.model, config.maxTokens])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void run()
    }
  }

  return (
    <div className="widget agents-widget">
      <div className="widget__head">
        <span className="widget__icon" aria-hidden>
          🤖
        </span>
        <span className="widget__title">{title}</span>
        <select
          className="agents__select"
          value={activeId}
          onChange={(e) => setActiveId(e.target.value)}
          title={agent?.system}
        >
          {config.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      <div className="widget__body widget__body--scroll">
        {error ? (
          <p className="widget__error">{error}</p>
        ) : output ? (
          <p className="prompt-output">
            {output}
            {running && <span className="prompt-caret" />}
          </p>
        ) : (
          <p className="widget__hint">
            {agent ? `Ask the ${agent.name} agent…` : 'No agents configured.'}
          </p>
        )}
      </div>

      <div className="agents__inputrow">
        <textarea
          className="agents__input"
          rows={1}
          placeholder="Prompt (⌘/Ctrl+Enter to send)"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          className="btn btn--sm btn--primary"
          onClick={() => void run()}
          disabled={running || !prompt.trim()}
        >
          {running ? '…' : 'Send'}
        </button>
      </div>

      <div className="widget__foot">
        {mock && <span className="badge badge--mock">demo — no API key</span>}
        <span className="badge">{config.agents.length} agents</span>
      </div>
    </div>
  )
}

function AgentsSettings({ config, onChange }: WidgetSettingsProps<AgentsConfig>) {
  const set = (patch: Partial<AgentsConfig>) => onChange({ ...config, ...patch })

  const [pulling, setPulling] = useState(false)
  const [pullMsg, setPullMsg] = useState<string | null>(null)
  const [pullErr, setPullErr] = useState<string | null>(null)

  const pullFromAccount = async () => {
    setPulling(true)
    setPullMsg(null)
    setPullErr(null)
    try {
      const account = await listAccountAgents()
      if (account.length === 0) {
        setPullMsg('No agents found on your Claude account.')
        return
      }
      // Map each server-managed agent to a local persona. Keep any locally
      // authored agents that aren't backed by an account agent so custom
      // personas survive a pull.
      const pulled: Agent[] = account.map((a) => ({
        id: a.id,
        name: a.name,
        system: a.system || (a.description ? a.description : `You are ${a.name}.`),
      }))
      const pulledIds = new Set(pulled.map((a) => a.id))
      const localOnly = config.agents.filter(
        (a) => !a.id.startsWith('agent_') && !pulledIds.has(a.id),
      )
      const agents = [...pulled, ...localOnly]
      set({
        agents,
        activeAgentId: agents.some((a) => a.id === config.activeAgentId)
          ? config.activeAgentId
          : agents[0]?.id ?? '',
      })
      setPullMsg(
        `Loaded ${pulled.length} agent${pulled.length === 1 ? '' : 's'} from your Claude account.`,
      )
    } catch (err) {
      setPullErr(err instanceof Error ? err.message : 'Failed to load agents.')
    } finally {
      setPulling(false)
    }
  }

  const updateAgent = (id: string, patch: Partial<Agent>) =>
    set({ agents: config.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) })

  const addAgent = () =>
    set({
      agents: [
        ...config.agents,
        { id: makeId('agent'), name: 'New agent', system: 'You are a helpful assistant.' },
      ],
    })

  const removeAgent = (id: string) => {
    const agents = config.agents.filter((a) => a.id !== id)
    set({
      agents,
      activeAgentId:
        config.activeAgentId === id ? agents[0]?.id ?? '' : config.activeAgentId,
    })
  }

  return (
    <div className="settings-body">
      <div className="field-row">
        <label className="field">
          <span>Model</span>
          <input
            type="text"
            value={config.model}
            onChange={(e) => set({ model: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Max tokens</span>
          <input
            type="number"
            min={50}
            max={4000}
            value={config.maxTokens}
            onChange={(e) =>
              set({ maxTokens: Math.min(4000, Math.max(50, Number(e.target.value))) })
            }
          />
        </label>
      </div>

      <div className="settings__divider" />
      <div className="agents__pullhead">
        <h4 className="settings__section">Agents</h4>
        <button
          className="btn btn--sm"
          onClick={() => void pullFromAccount()}
          disabled={pulling}
          title="Replace the list with the agents saved on your Claude account"
        >
          {pulling ? 'Loading…' : '⟲ Pull from my Claude account'}
        </button>
      </div>
      {pullErr && <p className="widget__error settings__hint">{pullErr}</p>}
      {pullMsg && <p className="settings__hint">{pullMsg}</p>}

      {config.agents.map((a) => (
        <div key={a.id} className="agentedit">
          <div className="agentedit__row">
            <input
              className="agentedit__name"
              type="text"
              value={a.name}
              onChange={(e) => updateAgent(a.id, { name: e.target.value })}
            />
            <button
              className="btn btn--sm"
              onClick={() => removeAgent(a.id)}
              title="Remove agent"
            >
              ✕
            </button>
          </div>
          <textarea
            className="field__textarea"
            rows={2}
            placeholder="System prompt — this agent's role"
            value={a.system}
            onChange={(e) => updateAgent(a.id, { system: e.target.value })}
          />
        </div>
      ))}

      <button className="picker__importlink" onClick={addAgent}>
        + Add agent
      </button>

      <p className="settings__hint">
        Each agent is a name + a system prompt (its role). Pick one on the tile
        and send it a prompt; the reply streams live. Uses the Anthropic API key
        from <strong>Global settings</strong>.
      </p>
      <p className="settings__hint">
        <strong>Pull from my Claude account</strong> lists the agents you've
        saved via Anthropic's Managed Agents API and turns each into a persona
        here (name + system prompt). It needs your Anthropic API key in Global
        settings; if your account has no saved agents, or the browser can't
        reach the beta endpoint, keep using the built-in agents above.
      </p>
    </div>
  )
}

export const agentsWidget = defineWidget<AgentsConfig>({
  type: 'claude-agents',
  name: 'Claude Agents',
  description: 'Pick from your Claude agents and invoke one with a prompt.',
  icon: '🤖',
  defaultConfig: DEFAULT_CONFIG,
  component: AgentsBody,
  settings: AgentsSettings,
})
