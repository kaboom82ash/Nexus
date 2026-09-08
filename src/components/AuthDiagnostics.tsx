import { useState } from 'react'
import { Modal } from './Modal'
import { authDiagnostics } from '../lib/gmail'

/**
 * Everything needed to work out why a Google sign-in is failing, in one
 * copyable block.
 *
 * Sign-in breaks in the user's browser against the user's Google project, and
 * neither is reachable from where this code is written. Guessing at causes
 * from the symptom — "it loops" — has cost several rounds. This is the
 * shortcut: the origin, the client id, whether Google's script even loaded,
 * which scopes are actually held and for how much longer, how many consent
 * screens have opened in the last minute, and Google's own last words about
 * each failure.
 *
 * Nothing here is a secret. A browser OAuth client id is public by design, and
 * no access token, address or message content is included.
 */
export function AuthDiagnostics({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const report = JSON.stringify(authDiagnostics(), null, 2)

  const copy = () => {
    navigator.clipboard?.writeText(report).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1800)
      },
      () => {},
    )
  }

  return (
    <Modal onClose={onClose}>
      <div className="settings">
        <div className="settings__titlebar">
          <h3 className="settings__title">🩺 Sign-in diagnostics</h3>
          <button className="btn btn--sm" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="settings__hint">
          If Google keeps asking you to sign in, copy this and send it over — it
          names the cause. No tokens or message content are included; the OAuth
          client id is public by design.
        </p>
        <pre className="diag">{report}</pre>
        <button className="btn btn--sm btn--primary" onClick={copy}>
          {copied ? '✓ Copied' : 'Copy report'}
        </button>
      </div>
    </Modal>
  )
}
