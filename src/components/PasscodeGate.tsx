import { useEffect, useState, type ReactNode } from 'react'

/**
 * A passcode gate in front of the whole app.
 *
 * WHAT THIS IS AND IS NOT. Nexus is a static site: every file it serves —
 * including `weekly-briefing.html` and its contents — can be fetched directly
 * by URL, and this component is client-side code the visitor's browser runs on
 * their behalf. So this stops someone opening the app on your unlocked laptop,
 * and it stops a casual visitor who lands on the URL. It does NOT stop anyone
 * willing to open devtools or request the HTML directly, and it cannot: there
 * is no server here to withhold anything. Real protection means a private
 * repository, or a host that authenticates the request before serving bytes.
 *
 * Two modes:
 *  - `VITE_APP_PASSCODE_HASH` set at build time → that passcode, everywhere.
 *    Note the hash ships inside the bundle, so a short passcode is guessable
 *    offline by anyone who wants to; use a long one.
 *  - unset → each browser sets its own passcode on first use. That is a device
 *    lock, not site access control, and it says so on screen.
 */

const UNLOCK_KEY = 'nexus.unlocked.until'
const LOCAL_HASH_KEY = 'nexus.passcode.hash'
/** How long an unlock lasts before the passcode is asked for again. */
const UNLOCK_HOURS = 12
/** Not a secret — it only stops a plain rainbow-table lookup of the hash. */
const SALT = 'nexus.passcode.v1:'

const BUILD_HASH = (
  (import.meta.env.VITE_APP_PASSCODE_HASH as string | undefined) ?? ''
).trim()

async function hash(passcode: string): Promise<string> {
  const bytes = new TextEncoder().encode(SALT + passcode)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode — the unlock just will not persist */
  }
}

function stillUnlocked(): boolean {
  const until = Number(read(UNLOCK_KEY))
  return Number.isFinite(until) && until > Date.now()
}

export function PasscodeGate({ children }: { children: ReactNode }) {
  // The expected hash: the build's if there is one, else this device's.
  const [deviceHash, setDeviceHash] = useState(() => read(LOCAL_HASH_KEY))
  const expected = BUILD_HASH || deviceHash
  const setupNeeded = !expected

  const [unlocked, setUnlocked] = useState(stillUnlocked)
  const [entry, setEntry] = useState('')
  const [confirmEntry, setConfirmEntry] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Re-lock on expiry without needing a reload.
  useEffect(() => {
    if (!unlocked) return
    const timer = setInterval(() => {
      if (!stillUnlocked()) setUnlocked(false)
    }, 30_000)
    return () => clearInterval(timer)
  }, [unlocked])

  if (unlocked) return <>{children}</>

  const unlock = () => {
    write(UNLOCK_KEY, String(Date.now() + UNLOCK_HOURS * 3600_000))
    setUnlocked(true)
    setEntry('')
    setConfirmEntry('')
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (setupNeeded) {
        if (entry.length < 6) {
          setError('Use at least 6 characters.')
          return
        }
        if (entry !== confirmEntry) {
          setError('The two entries do not match.')
          return
        }
        const h = await hash(entry)
        write(LOCAL_HASH_KEY, h)
        setDeviceHash(h)
        unlock()
        return
      }
      if ((await hash(entry)) === expected) unlock()
      else setError('That passcode does not match.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gate">
      <form className="gate__card" onSubmit={submit}>
        <div className="gate__brand">
          <span className="brand__mark">◲</span>
          <span className="brand__name">Nexus</span>
        </div>

        <h1 className="gate__title">
          {setupNeeded ? 'Set a passcode' : 'Enter your passcode'}
        </h1>
        <p className="gate__sub">
          {setupNeeded
            ? 'Choose a passcode for this browser. You will be asked for it once every 12 hours.'
            : 'Your briefing and punch list are behind this.'}
        </p>

        <input
          className="gate__input"
          type="password"
          autoFocus
          autoComplete={setupNeeded ? 'new-password' : 'current-password'}
          placeholder="Passcode"
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
        />
        {setupNeeded && (
          <input
            className="gate__input"
            type="password"
            autoComplete="new-password"
            placeholder="Confirm passcode"
            value={confirmEntry}
            onChange={(e) => setConfirmEntry(e.target.value)}
          />
        )}

        {error && <p className="gate__error">{error}</p>}

        <button className="btn btn--primary gate__go" type="submit" disabled={busy}>
          {setupNeeded ? 'Set passcode' : 'Unlock'}
        </button>

        <p className="gate__note">
          {BUILD_HASH
            ? 'This is a deterrent, not access control.'
            : 'This locks the app on this device only — another browser sets its own.'}{' '}
          Nexus is a static site, so its pages can still be fetched directly by
          URL. Make the repository private for real protection.
        </p>
        {!setupNeeded && !BUILD_HASH && (
          <button
            type="button"
            className="gate__reset"
            onClick={() => {
              if (!confirm('Forget this device passcode and set a new one?')) return
              write(LOCAL_HASH_KEY, '')
              setDeviceHash('')
              setError('')
            }}
          >
            Forgot it — reset this device
          </button>
        )}
      </form>
    </div>
  )
}
