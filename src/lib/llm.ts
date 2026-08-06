/**
 * Minimal browser-side LLM client for the AI Prompt widget.
 *
 * LIVE mode: calls the Anthropic Messages API directly from the browser using
 * a user-provided API key (stored locally) and streams tokens back. This uses
 * the `anthropic-dangerous-direct-browser-access` header, which Anthropic
 * provides specifically to allow direct browser calls.
 *
 * MOCK mode (no key): "types out" a canned response so the prompt tile still
 * demonstrates streaming output with zero setup.
 */

const KEY_STORAGE = 'nexus.anthropic.key'
const API_URL = 'https://api.anthropic.com/v1/messages'

export function getApiKey(): string {
  try {
    return (localStorage.getItem(KEY_STORAGE) ?? '').trim()
  } catch {
    return ''
  }
}

export function setApiKey(key: string): void {
  try {
    const t = key.trim()
    if (t) localStorage.setItem(KEY_STORAGE, t)
    else localStorage.removeItem(KEY_STORAGE)
  } catch {
    /* ignore */
  }
}

export function isLlmMock(): boolean {
  return getApiKey() === ''
}

export interface RunPromptOptions {
  prompt: string
  model: string
  maxTokens: number
  /** Called with each incremental chunk of text as it streams in. */
  onToken: (chunk: string) => void
  signal?: AbortSignal
}

export async function runPrompt(opts: RunPromptOptions): Promise<string> {
  const { prompt, model, maxTokens, onToken, signal } = opts
  if (!prompt.trim()) return ''

  if (isLlmMock()) return runMock(prompt, onToken, signal)

  const res = await fetch(API_URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': getApiKey(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`
    try {
      const err = await res.json()
      detail = err?.error?.message || detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSE events are separated by a blank line.
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const evt of events) {
      const line = evt.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data)
        if (
          parsed.type === 'content_block_delta' &&
          parsed.delta?.type === 'text_delta' &&
          typeof parsed.delta.text === 'string'
        ) {
          full += parsed.delta.text
          onToken(parsed.delta.text)
        }
      } catch {
        /* skip malformed event */
      }
    }
  }
  return full
}

async function runMock(
  prompt: string,
  onToken: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const canned =
    `(demo) No API key set, so here's a simulated response.\n\n` +
    `You asked: “${prompt.trim()}”.\n\n` +
    `Add an Anthropic API key in this tile's settings to get real, live answers ` +
    `streamed here on every refresh.`
  const words = canned.split(/(\s+)/)
  let full = ''
  for (const w of words) {
    if (signal?.aborted) break
    full += w
    onToken(w)
    await new Promise((r) => setTimeout(r, 18))
  }
  return full
}
