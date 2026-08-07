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
const AGENTS_URL = 'https://api.anthropic.com/v1/agents'
/** Beta header gating the Managed Agents API. */
const AGENTS_BETA = 'managed-agents-2026-04-01'

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
  /** Optional system prompt — used to give an "agent" its role. */
  system?: string
  /** Called with each incremental chunk of text as it streams in. */
  onToken: (chunk: string) => void
  signal?: AbortSignal
}

export async function runPrompt(opts: RunPromptOptions): Promise<string> {
  const { prompt, model, maxTokens, system, onToken, signal } = opts
  if (!prompt.trim()) return ''

  if (isLlmMock()) return runMock(prompt, onToken, signal)

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    stream: true,
    messages: [{ role: 'user', content: prompt }],
  }
  if (system && system.trim()) body.system = system

  const res = await fetch(API_URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': getApiKey(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
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

/**
 * A saved agent pulled from your Anthropic (Claude) account via the
 * Managed Agents API. We only keep the fields this dashboard needs to turn a
 * server-managed agent into a local persona: its id, display name, and the
 * system prompt that defines its role.
 */
export interface AccountAgent {
  id: string
  name: string
  system: string
  description?: string
}

/**
 * List the agents saved on your Claude account (Managed Agents, beta).
 *
 * Calls `GET /v1/agents` directly from the browser using the Anthropic API key
 * from Global settings, with the `managed-agents-2026-04-01` beta header. Pages
 * through all results. Throws a readable Error on any failure (no key, CORS,
 * beta not enabled, HTTP error) so the caller can surface it inline.
 */
export async function listAccountAgents(signal?: AbortSignal): Promise<AccountAgent[]> {
  const key = getApiKey()
  if (!key) throw new Error('Set your Anthropic API key in Global settings first.')

  const out: AccountAgent[] = []
  let afterId: string | undefined
  // Bounded loop so a misbehaving cursor can never spin forever.
  for (let page = 0; page < 20; page++) {
    const url = new URL(AGENTS_URL)
    url.searchParams.set('limit', '100')
    if (afterId) url.searchParams.set('after_id', afterId)

    const res = await fetch(url.toString(), {
      method: 'GET',
      signal,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': AGENTS_BETA,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    })

    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const err = await res.json()
        detail = err?.error?.message || detail
      } catch {
        /* ignore */
      }
      throw new Error(detail)
    }

    const body = await res.json()
    const data: unknown = body?.data
    if (Array.isArray(data)) {
      for (const raw of data) {
        const a = raw as Record<string, unknown>
        if (!a || typeof a.id !== 'string') continue
        out.push({
          id: a.id,
          name:
            typeof a.name === 'string' && a.name.trim() ? (a.name as string) : a.id,
          system: typeof a.system === 'string' ? (a.system as string) : '',
          description:
            typeof a.description === 'string' ? (a.description as string) : undefined,
        })
      }
    }

    if (body?.has_more && typeof body?.last_id === 'string') {
      afterId = body.last_id as string
    } else {
      break
    }
  }

  return out
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
