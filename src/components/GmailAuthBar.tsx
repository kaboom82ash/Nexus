import { useEffect, useState } from 'react'
import { isMockMode, isConnected, ensureConnected, connect } from '../lib/gmail'

type AuthState = 'mock' | 'connecting' | 'connected' | 'loggedout'

/**
 * Landing Gmail login control. On load it silently logs you in if consent is
 * already granted; otherwise it shows a "Log in to Gmail" button.
 */
export function GmailAuthBar() {
  const [state, setState] = useState<AuthState>(() =>
    isMockMode() ? 'mock' : isConnected() ? 'connected' : 'connecting',
  )

  useEffect(() => {
    let alive = true
    if (isMockMode()) {
      setState('mock')
      return
    }
    if (isConnected()) {
      setState('connected')
      return
    }
    setState('connecting')
    ensureConnected().then((ok) => {
      if (alive) setState(ok ? 'connected' : 'loggedout')
    })
    return () => {
      alive = false
    }
  }, [])

  const login = async () => {
    setState('connecting')
    try {
      await connect()
      setState('connected')
    } catch {
      setState('loggedout')
    }
  }

  if (state === 'mock') {
    return <span className="authbar authbar--mock">Gmail: sample data</span>
  }
  if (state === 'connected') {
    return <span className="authbar authbar--ok">Gmail connected ✓</span>
  }
  if (state === 'connecting') {
    return <span className="authbar">Connecting Gmail…</span>
  }
  return (
    <button className="btn btn--sm btn--primary" onClick={login}>
      Log in to Gmail
    </button>
  )
}
