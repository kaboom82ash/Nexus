import { useCallback, useEffect, useRef, useState } from 'react'
import { defineWidget, type WidgetProps, type WidgetSettingsProps } from './types'
import { runPrompt, isLlmMock } from '../lib/llm'

interface PromptConfig {
  prompt: string
  model: string
  maxTokens: number
  /** 0 = run once (and on prompt change); >0 = auto-refresh every N seconds. */
  refreshSeconds: number
}

const DEFAULT_CONFIG: PromptConfig = {
  prompt: 'Give me a one-sentence motivational quote for today.',
  model: 'claude-haiku-4-5-20251001',
  maxTokens: 400,
  refreshSeconds: 0,
}

function PromptBody({ config, title }: WidgetProps<PromptConfig>) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const mounted = useRef(true)
  const abortRef = useRef<AbortController | null>(null)
  const mock = isLlmMock()

  const run = useCallback(async () => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    setText('')
    try {
      await runPrompt({
        prompt: config.prompt,
        model: config.model,
        maxTokens: config.maxTokens,
        signal: ctrl.signal,
        onToken: (chunk) => {
          if (!ctrl.signal.aborted && mounted.current) {
            setText((prev) => prev + chunk)
          }
        },
      })
    } catch (err) {
      if (!ctrl.signal.aborted && mounted.current) {
        setError(err instanceof Error ? err.message : 'Prompt failed')
      }
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [config.prompt, config.model, config.maxTokens])

  // Run on mount and whenever the prompt/model changes.
  useEffect(() => {
    mounted.current = true
    void run()
    return () => {
      mounted.current = false
      abortRef.current?.abort()
    }
  }, [run])

  // Optional auto-refresh.
  useEffect(() => {
    if (!config.refreshSeconds || config.refreshSeconds <= 0) return
    const ms = Math.max(15, config.refreshSeconds) * 1000
    const timer = setInterval(() => void run(), ms)
    return () => clearInterval(timer)
  }, [config.refreshSeconds, run])

  return (
    <div className="widget prompt-widget">
      <div className="widget__head">
        <span className="widget__icon" aria-hidden>
          ✨
        </span>
        <span className="widget__title">{title}</span>
        <button
          className="widget__inline-btn"
          title="Re-run prompt"
          onClick={() => void run()}
        >
          ↻
        </button>
      </div>

      <div className="widget__body widget__body--scroll">
        {error ? (
          <p className="widget__error">{error}</p>
        ) : (
          <p className="prompt-output">
            {text}
            {loading && <span className="prompt-caret" />}
          </p>
        )}
      </div>

      <div className="widget__foot">
        {mock && <span className="badge badge--mock">demo — no API key</span>}
        {loading && <span className="badge">streaming…</span>}
      </div>
    </div>
  )
}

function PromptSettings({ config, onChange }: WidgetSettingsProps<PromptConfig>) {
  return (
    <div className="settings-body">
      <label className="field">
        <span>Prompt — rendered live on the tile</span>
        <textarea
          className="field__textarea"
          rows={4}
          value={config.prompt}
          placeholder="e.g. Summarize today's top 3 tech headlines in bullet points."
          onChange={(e) => onChange({ ...config, prompt: e.target.value })}
        />
      </label>

      <label className="field">
        <span>Model</span>
        <input
          type="text"
          value={config.model}
          onChange={(e) => onChange({ ...config, model: e.target.value })}
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>Max tokens</span>
          <input
            type="number"
            min={50}
            max={4000}
            value={config.maxTokens}
            onChange={(e) =>
              onChange({
                ...config,
                maxTokens: Math.min(4000, Math.max(50, Number(e.target.value))),
              })
            }
          />
        </label>
        <label className="field">
          <span>Auto-refresh (sec, 0 = once)</span>
          <input
            type="number"
            min={0}
            value={config.refreshSeconds}
            onChange={(e) =>
              onChange({ ...config, refreshSeconds: Math.max(0, Number(e.target.value)) })
            }
          />
        </label>
      </div>

      <div className="settings__divider" />
      <p className="settings__hint">
        The <strong>Anthropic API key</strong> lives in{' '}
        <strong>Global settings</strong> (the ⚙ in the top bar) — set once for
        every AI Prompt widget. Blank = demo mode.
      </p>
    </div>
  )
}

export const promptWidget = defineWidget<PromptConfig>({
  type: 'ai-prompt',
  name: 'AI Prompt',
  description: 'Type a prompt; the result streams live onto the tile.',
  icon: '✨',
  defaultConfig: DEFAULT_CONFIG,
  component: PromptBody,
  settings: PromptSettings,
})
