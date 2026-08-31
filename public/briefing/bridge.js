/*
 * Live Google data for the Weekly Briefing.
 *
 * The briefing is a static page: its content is written at build time by a
 * Claude sweep, and by itself it cannot reach Gmail or Calendar. Inside Nexus
 * it runs in a same-origin iframe, so this script calls up to the parent's
 * `window.__nexusBriefing` (src/lib/briefingBridge.ts), which fronts the app's
 * existing Gmail client and the Calendar client sharing its OAuth layer. One
 * sign-in, shared with every dashboard widget.
 *
 * It adds one strip under the masthead — connect / sync / status — and renders
 * two live sections built from the page's own markup vocabulary, so the
 * briefing's `injectCheckables()` gives live items the same checkbox as
 * everything else and they queue to the punch list identically.
 *
 * Nothing here is required for the page to work: without the bridge (opened as
 * a standalone file), it disables itself and the briefing behaves exactly as it
 * did before. It also touches no state the page persists, so a weekly rebuild
 * that drops a new HTML file in place keeps working with no changes here.
 */
(function () {
  'use strict'

  var MAIL_LOOKBACK_HOURS = 72
  var MAIL_LIMIT = 12
  var EVENT_DAYS = 14
  var EVENT_LIMIT = 25

  // Once connected the page keeps itself current on its own. Polling pauses
  // while the tab is hidden — a background tab burning Gmail quota every few
  // minutes helps nobody — and catches up when it comes back.
  var AUTO_SYNC_MS = 5 * 60 * 1000
  var STALE_MS = 2 * 60 * 1000

  // Each Google service gets its own icon and its own connection state,
  // because a partial grant is a real outcome: the consent screen lets you
  // approve mail and refuse calendar, and one merged indicator would hide it.
  var SERVICES = [
    { key: 'gmail', icon: '✉️', label: 'Gmail', what: 'inbox' },
    { key: 'calendar', icon: '📅', label: 'Calendar', what: 'events' },
  ]

  // ---- bridge handshake ---------------------------------------------------

  function getBridge() {
    try {
      // Cross-origin parents throw on property access; treat that as absent.
      var b = window.parent && window.parent !== window
        ? window.parent.__nexusBriefing
        : null
      return b && b.version === 1 ? b : null
    } catch (e) {
      return null
    }
  }

  // ---- small helpers ------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function el(tag, className, html) {
    var n = document.createElement(tag)
    if (className) n.className = className
    if (html != null) n.innerHTML = html
    return n
  }

  function timeLabel(iso, allDay) {
    var d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    var day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    if (allDay) return day + ' · all day'
    return day + ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }

  function relativeDay(iso) {
    var d = new Date(iso)
    if (isNaN(d.getTime())) return 99
    var start = new Date()
    start.setHours(0, 0, 0, 0)
    return Math.floor((d.getTime() - start.getTime()) / 86400000)
  }

  // The page's four severities carry all its visual weight, so live items are
  // rated on the same scale rather than introducing a fifth state.
  function mailSeverity(score) {
    if (score >= 10) return 'critical'
    if (score >= 6) return 'high'
    if (score >= 3) return 'medium'
    return 'low'
  }

  function eventSeverity(iso) {
    var days = relativeDay(iso)
    if (days <= 0) return 'high'
    if (days <= 3) return 'medium'
    return 'low'
  }

  /**
   * A sync key must be a clean token: the page uses it verbatim inside
   * attribute selectors and as a punch-list id.
   */
  function syncKey(prefix, raw) {
    var slug = String(raw || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 50)
    return prefix + '-' + (slug || 'item')
  }

  /**
   * Every checkable row needs a link — that is how the page distinguishes an
   * actionable item from prose. Live results normally carry the API's own
   * link; sample data does not, so fall back to a real search/day view that
   * still lands the user on the right thing.
   */
  function mailHref(m) {
    if (m.url) return m.url
    return 'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(m.subject || '')
  }

  function eventHref(e) {
    if (e.url) return e.url
    var d = new Date(e.start)
    if (isNaN(d.getTime())) return 'https://calendar.google.com/calendar/r'
    return 'https://calendar.google.com/calendar/r/day/' +
      d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate()
  }

  function sevPill(sev) {
    var label = sev.charAt(0).toUpperCase() + sev.slice(1)
    return '<span class="pill sev-' + sev + ' sev-tag">' + label + '</span>'
  }

  // ---- the live strip -----------------------------------------------------

  var strip, statusEl, syncBtn
  var chips = {}
  var busy = false
  var autoTimer = null
  var lastSyncAt = 0
  // Last error per service, so a granted-but-failing service (scope approved,
  // API disabled) reads as broken rather than as a reassuring tick.
  var svcErrors = {}

  // Styles live here rather than in the theme file so the bridge stays one
  // droppable file; every value is a page token, so it themes itself.
  var STYLES = [
    '.live-strip{display:flex;align-items:center;gap:10px;flex-wrap:wrap;',
    'padding:10px 0 0;margin-top:14px;border-top:1px solid var(--line);font-size:12px}',
    '.live-label{font-weight:700;letter-spacing:.04em;text-transform:uppercase;',
    'font-size:11px;color:var(--muted)}',
    '.live-status{color:var(--muted);margin-right:auto}',
    '.live-status--ok{color:var(--low)}',
    '.live-status--warn{color:var(--critical)}',
    '.live-status--mock{color:var(--high)}',
    '.live-btn{font:inherit;font-size:12px;padding:5px 10px;border-radius:8px;',
    'border:1px solid var(--line);background:var(--surface-2);color:var(--ink);cursor:pointer}',
    '.live-btn:hover{border-color:var(--accent)}',
    '.live-btn[disabled]{opacity:.6;cursor:default}',
    '.live-btn--primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}',
    '.live-chip{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12px;',
    'padding:4px 9px;border-radius:999px;border:1px solid var(--line);',
    'background:var(--surface-2);color:var(--muted);cursor:pointer}',
    '.live-chip__icon{font-size:13px;line-height:1;filter:grayscale(1);opacity:.55}',
    '.live-chip__state{font-weight:700;font-size:11px}',
    '.live-chip--on{color:var(--ink);border-color:var(--low)}',
    '.live-chip--on .live-chip__icon{filter:none;opacity:1}',
    '.live-chip--on .live-chip__state{color:var(--low)}',
    '.live-chip--off{color:var(--ink);border-color:var(--accent)}',
    '.live-chip--off .live-chip__state{color:var(--accent)}',
    '.live-chip--off:hover{background:var(--accent);color:var(--accent-ink)}',
    '.live-chip--off:hover .live-chip__state{color:var(--accent-ink)}',
    '.live-chip--sample .live-chip__state{color:var(--high)}',
    '.live-chip--err{color:var(--ink);border-color:var(--critical)}',
    '.live-chip--err .live-chip__state{color:var(--critical)}',
    '.live-chip--err .live-chip__icon{filter:none;opacity:1}',
    '.live-chip[disabled]{cursor:default}',
    '.live-auto{color:var(--muted);font-size:11px}',
    '.live-section{margin-bottom:24px}',
    '.live-band{border-left-color:var(--accent)}',
    '.live-tag{font-size:10px;font-weight:700;text-transform:uppercase;margin-left:6px;',
    'padding:1px 5px;border-radius:4px;background:var(--high-bg);color:var(--high)}',
  ].join('')

  function injectStyles() {
    if (document.getElementById('live-bridge-styles')) return
    var style = document.createElement('style')
    style.id = 'live-bridge-styles'
    style.textContent = STYLES
    document.head.appendChild(style)
  }

  function buildStrip() {
    var masthead = document.querySelector('.masthead')
    var tabs = masthead && masthead.querySelector('.tabs')
    if (!masthead || !tabs) return null
    injectStyles()

    strip = el('div', 'live-strip')
    strip.id = 'live-strip'

    statusEl = el('span', 'live-status')
    syncBtn = el('button', 'live-btn', '↻ Sync now')
    syncBtn.type = 'button'
    syncBtn.title = 'Pull the latest mail and calendar events in now'

    strip.appendChild(el('span', 'live-label', 'Live data'))
    SERVICES.forEach(function (svc) {
      var chip = el('button', 'live-chip')
      chip.type = 'button'
      chip.dataset.service = svc.key
      chip.appendChild(el('span', 'live-chip__icon', svc.icon))
      chip.appendChild(el('span', 'live-chip__label', svc.label))
      chip.appendChild(el('span', 'live-chip__state', ''))
      chips[svc.key] = chip
      strip.appendChild(chip)
    })
    strip.appendChild(statusEl)
    strip.appendChild(syncBtn)

    masthead.insertBefore(strip, tabs)
    syncScrollPadding()
    window.addEventListener('resize', syncScrollPadding)
    return strip
  }

  /**
   * The masthead is sticky, so any scrollIntoView — the page's own tab
   * switches and dashboard tiles included — lands content underneath it. The
   * live strip makes the masthead taller, so keeping this in step is ours to
   * own; a scroll-padding on the scrolling element fixes every jump at once.
   */
  function syncScrollPadding() {
    var masthead = document.querySelector('.masthead')
    if (!masthead) return
    document.documentElement.style.scrollPaddingTop =
      masthead.offsetHeight + 12 + 'px'
  }

  function setStatus(text, tone) {
    if (!statusEl) return
    statusEl.textContent = text
    statusEl.className = 'live-status' + (tone ? ' live-status--' + tone : '')
  }

  /**
   * Paint each service chip from the live status. This is the single place
   * connection state reaches the UI, so it can never drift from what the
   * bridge actually holds a token for.
   */
  function renderChips(st) {
    SERVICES.forEach(function (svc) {
      var chip = chips[svc.key]
      if (!chip) return
      var sample = st && st.mock
      var on = st && st[svc.key]
      var err = svcErrors[svc.key]
      // A granted scope whose API still fails is NOT connected in any sense
      // the reader cares about, so the error state outranks the tick.
      var state = sample ? 'sample' : err ? 'err' : on ? 'on' : 'off'

      chip.className = 'live-chip live-chip--' + state
      chip.querySelector('.live-chip__state').textContent = {
        sample: 'sample',
        err: '!',
        on: '✓',
        off: 'Connect',
      }[state]
      // Retrying consent is the fix for a scope problem, so a failing chip
      // stays clickable; a healthy or sample one has nothing to do.
      chip.disabled = state === 'sample' || state === 'on'
      chip.title = {
        sample: svc.label + ': sample data — no Google Client ID configured',
        err: svc.label + ': ' + err + ' (click to retry access)',
        on: svc.label + ' connected (read-only) — keeping the ' + svc.what + ' up to date',
        off: 'Connect ' + svc.label + ' (read-only) to load your ' + svc.what,
      }[state]
    })
    if (syncBtn) {
      syncBtn.hidden = !st || (!st.mock && !st.gmail && !st.calendar)
      syncBtn.disabled = busy
    }
  }

  /** Standalone page: no parent to connect through, so say so on the chips. */
  function renderChipsUnavailable() {
    SERVICES.forEach(function (svc) {
      var chip = chips[svc.key]
      if (!chip) return
      chip.className = 'live-chip'
      chip.querySelector('.live-chip__state').textContent = '—'
      chip.disabled = true
      chip.title = svc.label + ' needs the Nexus app, which is where sign-in lives'
    })
    if (syncBtn) syncBtn.hidden = true
  }

  // ---- live sections ------------------------------------------------------

  /**
   * Live items are ordinary `.cat-row`s in a `.cat-grid-band`, the same shape
   * the briefing writes for its swept items — that is what makes
   * `injectCheckables()` treat them as first-class and queue them to the punch
   * list. They carry `data-sync`, the page's own stable-identity mechanism, so
   * a message queued on one sync keeps the same punch-list entry on the next.
   */
  function ensureSection(spec) {
    var panel = document.getElementById(spec.panelId)
    if (!panel) return null
    var section = document.getElementById(spec.id)
    if (!section) {
      section = el('section', 'live-section')
      section.id = spec.id
      // A band is a two-column grid — label rail, then items. Without the
      // label column the items land in the 150px rail.
      section.innerHTML =
        '<div class="section-head">' +
        '<h2>' + esc(spec.heading) + '</h2>' +
        '<span class="sub">' + esc(spec.sub) + '</span>' +
        '</div>' +
        '<div class="cat-grid-band live-band">' +
        '<div class="cat-grid-label">' +
        '<span class="icon">' + spec.icon + '</span>' +
        '<span class="name">' + esc(spec.label) + '</span>' +
        '<span class="cnt live-count"></span>' +
        '<a class="mail-link" href="' + esc(spec.href) + '" target="_blank" rel="noopener">' +
        esc(spec.linkLabel) + '</a>' +
        '</div>' +
        '<div class="cat-grid-items live-items"></div>' +
        '</div>'
      panel.insertBefore(section, panel.firstChild)
    }
    return section.querySelector('.live-items')
  }

  function setCount(sectionId, n) {
    var c = document.querySelector('#' + sectionId + ' .live-count')
    if (c) c.textContent = n + (n === 1 ? ' item' : ' items')
  }

  function renderMail(items, mock) {
    var host = ensureSection({
      panelId: 'panel-actions',
      id: 'live-inbox',
      heading: 'Live inbox',
      sub: 'Top messages from the last ' + MAIL_LOOKBACK_HOURS + ' hours, ranked by the dashboard’s priority score · check one to queue it',
      icon: '✉️',
      label: 'Live inbox',
      href: 'https://mail.google.com/mail/u/0/#inbox',
      linkLabel: '✉️ Open Gmail ↗',
    })
    if (!host) return
    if (!items.length) {
      host.innerHTML = '<div class="cat-row no-check"><div class="cat-main"><div class="cat-meta">Nothing in the last ' + MAIL_LOOKBACK_HOURS + ' hours.</div></div></div>'
      return
    }
    var html = ''
    items.forEach(function (m) {
      var sev = mailSeverity(m.score)
      var meta = [
        esc(m.from),
        timeLabel(m.date, false),
        m.unread ? 'Unread' : '',
        // Gmail's own tab, kept as prose: it is not one of the page's
        // categories, so it must not become a data-cat.
        m.category && m.category !== 'other' ? esc(m.category) : '',
        esc((m.reasons || []).slice(0, 3).join(' · ')),
      ].filter(Boolean).join(' · ')
      var link = '<div class="cat-links"><a class="mail-link" href="' + esc(mailHref(m)) +
        '" target="_blank" rel="noopener">✉️ Open in Gmail ↗</a></div>'
      // No data-cat: the page's own inferCategory() reads the title and always
      // returns one of its known keys, so a live item can never land in a
      // category the punch list refuses to render. And no severity pill inside
      // .cat-title — the punch list takes an entry's title from that element's
      // text, and the pill's label would be glued onto it.
      html +=
        '<div class="cat-row sev-' + sev + '" data-sync="' + esc(syncKey('mail', m.id)) + '">' +
        '<div class="cat-main">' +
        '<div class="cat-title">' + esc(m.subject) + '</div>' +
        '<div class="cat-meta">' + sevPill(sev) + ' ' +
        (mock ? '<span class="live-tag">sample</span> ' : '') + meta + '</div>' +
        link +
        '</div></div>'
    })
    host.innerHTML = html
    setCount('live-inbox', items.length)
  }

  function renderEvents(items, mock) {
    var host = ensureSection({
      panelId: 'panel-calendar',
      id: 'live-calendar',
      heading: 'Live calendar',
      sub: 'Next ' + EVENT_DAYS + ' days across every calendar you have switched on · check one to queue it',
      icon: '📅',
      label: 'Next ' + EVENT_DAYS + ' days',
      href: 'https://calendar.google.com/calendar/r',
      linkLabel: '📅 Open Calendar ↗',
    })
    if (!host) return
    if (!items.length) {
      host.innerHTML = '<div class="cat-row no-check"><div class="cat-main"><div class="cat-meta">Nothing scheduled in the next ' + EVENT_DAYS + ' days.</div></div></div>'
      return
    }
    var html = ''
    items.forEach(function (e) {
      var sev = eventSeverity(e.start)
      var meta = [timeLabel(e.start, e.allDay), esc(e.location), esc(e.calendar)]
        .filter(Boolean)
        .join(' · ')
      // The API's own htmlLink is the only reliable way back to an event;
      // constructed event ids do not resolve, so the fallback is a day view.
      var link = '<div class="cat-links"><a class="cal-btn" href="' + esc(eventHref(e)) +
        '" target="_blank" rel="noopener">📅 Open event ↗</a></div>'
      html +=
        '<div class="cat-row sev-' + sev + '" data-sync="' + esc(syncKey('event', e.id)) + '">' +
        '<div class="cat-main">' +
        '<div class="cat-title">' + esc(e.title) + '</div>' +
        '<div class="cat-meta">' + sevPill(sev) + ' ' +
        (mock ? '<span class="live-tag">sample</span> ' : '') + meta + '</div>' +
        link +
        '</div></div>'
    })
    host.innerHTML = html
    setCount('live-calendar', items.length)
  }

  /**
   * Drop checkbox registrations whose element left the DOM on the last
   * re-render. The key itself stays, even when its list empties: the page
   * treats a missing key as "first sighting of this item" and would count it
   * into the dashboard totals a second time.
   */
  function pruneRegistry() {
    try {
      if (typeof registry !== 'object' || !registry) return
      Object.keys(registry).forEach(function (id) {
        registry[id] = registry[id].filter(function (r) {
          return r.el && r.el.isConnected
        })
      })
    } catch (e) {
      /* the page may not expose its registry — re-wiring still works */
    }
  }

  /** Re-run the page's own wiring so live rows behave like swept ones. */
  function rewirePage() {
    pruneRegistry()
    try {
      if (typeof injectCheckables === 'function') injectCheckables()
      if (typeof renderPunchList === 'function') renderPunchList()
      if (typeof renderDashboard === 'function') renderDashboard()
    } catch (e) {
      /* the page's own rendering is best-effort here — live rows still show */
    }
  }

  /*
   * The masthead's "Data as of" stamp belongs to the SWEEP that generated this
   * page's curated content, and a sync does not refresh that content — only the
   * two live sections. Overwriting it with the sync time makes a week-old
   * briefing look current, so the sync time is reported in the strip instead.
   */
  function syncedAt() {
    return 'synced ' + new Date().toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  // ---- sync ---------------------------------------------------------------

  function sync(bridge) {
    if (busy) return Promise.resolve()
    busy = true
    if (syncBtn) syncBtn.disabled = true
    setStatus('Syncing…')

    return Promise.all([
      bridge.fetchMail({ lookbackHours: MAIL_LOOKBACK_HOURS, limit: MAIL_LIMIT }),
      bridge.fetchEvents({ days: EVENT_DAYS, limit: EVENT_LIMIT }),
    ])
      .then(function (res) {
        var mail = res[0]
        var events = res[1]
        var mock = mail.mock || events.mock

        renderMail(mail.items || [], mail.mock)
        renderEvents(events.items || [], events.mock)
        rewirePage()
        syncScrollPadding()
        lastSyncAt = Date.now()

        // Report per-service failures against the service that failed, so a
        // working inbox is not hidden behind a calendar problem.
        svcErrors.gmail = mail.error || null
        svcErrors.calendar = events.error || null
        renderChips(bridge.status())

        var errors = []
        if (mail.error) errors.push('Gmail: ' + mail.error)
        if (events.error) errors.push('Calendar: ' + events.error)

        if (errors.length) {
          setStatus(errors.join(' · '), 'warn')
        } else if (mock) {
          setStatus(
            'Sample data · ' + syncedAt() +
              ' — add a Google Client ID in Nexus settings for live mail and calendar',
            'mock',
          )
        } else {
          setStatus(
            (mail.items || []).length + ' messages · ' +
              (events.items || []).length + ' events · ' + syncedAt() + autoNote(),
            'ok',
          )
        }
      })
      .catch(function (err) {
        setStatus((err && err.message) || 'Sync failed', 'warn')
      })
      .then(function () {
        busy = false
        if (syncBtn) syncBtn.disabled = false
      })
  }

  // ---- automatic updates --------------------------------------------------

  function autoNote() {
    return autoTimer
      ? ' · auto every ' + Math.round(AUTO_SYNC_MS / 60000) + ' min'
      : ''
  }

  /** True once at least one service is connected and there is live data to pull. */
  function canAutoSync(bridge) {
    var st = bridge.status()
    return !st.mock && (st.gmail || st.calendar)
  }

  /**
   * Keep the page current on its own once connected. Idempotent — connecting
   * the second service must not start a second timer.
   */
  function startAutoSync(bridge) {
    if (autoTimer || !canAutoSync(bridge)) return
    autoTimer = setInterval(function () {
      // A hidden tab does not need fresh data, and polling one just spends
      // API quota; visibilitychange below catches it up on return.
      if (document.hidden || busy || !canAutoSync(bridge)) return
      sync(bridge)
    }, AUTO_SYNC_MS)

    document.addEventListener('visibilitychange', function () {
      if (document.hidden || busy || !canAutoSync(bridge)) return
      if (Date.now() - lastSyncAt < STALE_MS) return
      sync(bridge)
    })
  }

  // ---- boot ---------------------------------------------------------------

  function start() {
    var bridge = getBridge()
    if (!buildStrip()) return

    if (!bridge) {
      // Opened as a standalone file: OAuth lives in the Nexus app, so there is
      // nothing to connect to here. Say so rather than leaving a user who
      // clicked "Open full page" wondering where the live sections went.
      renderChipsUnavailable()
      setStatus('Open this page inside Nexus for live Gmail and Calendar data', 'idle')
      return
    }

    SERVICES.forEach(function (svc) {
      chips[svc.key].addEventListener('click', function () {
        setStatus('Opening Google sign-in for ' + svc.label + '…')
        chips[svc.key].disabled = true
        // The click's user activation reaches the same-origin parent, so the
        // consent popup opens there rather than being blocked in this frame.
        // Ask only for this service: the other may already be granted, and a
        // partial grant should be repairable one service at a time.
        bridge.connect(svc.key).then(function (next) {
          svcErrors[svc.key] = null
          renderChips(next)
          if (next.error) {
            setStatus(next.error, 'warn')
            return
          }
          startAutoSync(bridge)
          sync(bridge)
        })
      })
    })

    syncBtn.addEventListener('click', function () {
      sync(bridge)
    })

    var st = bridge.status()
    renderChips(st)

    if (st.mock || st.gmail || st.calendar) {
      // Sample mode, or at least one service already granted — show data now.
      startAutoSync(bridge)
      sync(bridge)
    } else {
      setStatus('Not connected — both are read-only, and update themselves once granted', 'idle')
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
