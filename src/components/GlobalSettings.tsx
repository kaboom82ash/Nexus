import { useState } from 'react'
import { Modal } from './Modal'
import {
  getClientId,
  setClientId,
  isConnected,
  connect,
  disconnect,
} from '../lib/gmail'
import { getApiKey, setApiKey } from '../lib/llm'

/** App-wide settings shared by all widgets: Gmail sign-in + AI key. */
export function GlobalSettings({ onClose }: { onClose: () => void }) {
  const [clientId, setClientIdInput] = useState(getClientId())
  const [apiKey, setApiKeyInput] = useState(getApiKey())
  const [connected, setConnected] = useState(isConnected())
  const [error, setError] = useState<string | null>(null)

  const onConnect = async () => {
    setError(null)
    try {
      await connect()
      setConnected(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connect failed')
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="settings">
        <div className="settings__titlebar">
          <h3 className="settings__title">⚙ Global settings</h3>
        </div>

        <h4 className="settings__section">Gmail</h4>
        <label className="field">
          <span>Google OAuth Client ID</span>
          <input
            type="text"
            placeholder="xxxx.apps.googleusercontent.com (blank = sample data)"
            value={clientId}
            onChange={(e) => {
              setClientIdInput(e.target.value)
              setClientId(e.target.value)
              setConnected(isConnected())
            }}
          />
        </label>
        <p className="settings__hint">
          Shared by every Gmail widget — set it once here, then sign in once.{' '}
          {connected ? (
            <>
              <span className="ok-text">Connected ✓</span>{' '}
              <button
                className="btn btn--sm"
                onClick={() => {
                  disconnect()
                  setConnected(false)
                }}
              >
                Disconnect
              </button>
            </>
          ) : clientId.trim() ? (
            <button className="btn btn--sm btn--primary" onClick={onConnect}>
              Connect Gmail
            </button>
          ) : (
            <>Leave blank to run with sample data.</>
          )}
          {error && <span className="widget__error"> {error}</span>}
        </p>
        <p className="settings__hint">
          Create a Web OAuth Client ID in Google Cloud with the{' '}
          <code>gmail.readonly</code> scope — add{' '}
          <code>calendar.readonly</code> too for the Weekly Briefing's live
          calendar — and this site's origin in “Authorized JavaScript origins”.
        </p>

        <div className="settings__divider" />

        <h4 className="settings__section">AI Prompt</h4>
        <label className="field">
          <span>Anthropic API key</span>
          <input
            type="password"
            placeholder="sk-ant-… (blank = demo mode)"
            value={apiKey}
            onChange={(e) => {
              setApiKeyInput(e.target.value)
              setApiKey(e.target.value)
            }}
          />
        </label>
        <p className="settings__hint">
          Shared by every AI Prompt widget. Stored only in this browser and sent
          directly to Anthropic.
        </p>

        <div className="settings__actions">
          <button className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  )
}
