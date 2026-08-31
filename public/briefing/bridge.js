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

  var strip, statusEl, connectBtn, syncBtn
  var busy = false

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
    connectBtn = el('button', 'live-btn live-btn--primary', 'Connect Google')
    connectBtn.type = 'button'
    connectBtn.title = 'Grant read-only Gmail and Calendar access — one sign-in, shared with your dashboard widgets'
    syncBtn = el('button', 'live-btn', '↻ Sync now')
    syncBtn.type = 'button'
    syncBtn.title = 'Pull the latest mail and calendar events into this page'

    strip.appendChild(el('span', 'live-label', 'Live data'))
    strip.appendChild(statusEl)
    strip.appendChild(connectBtn)
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

  function showButtons(state) {
    if (!connectBtn || !syncBtn) return
    connectBtn.hidden = state !== 'disconnected'
    syncBtn.hidden = state !== 'connected'
    syncBtn.disabled = busy
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

  function sync(bridge, interactiveAllowed) {
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

        var errors = [mail.error, events.error].filter(Boolean)
        if (errors.length) {
          setStatus(errors[0], 'warn')
          // A dead token shows up as an error on both calls; offer the way back.
          if (!interactiveAllowed) showButtons('disconnected')
        } else if (mock) {
          setStatus(
            'Sample data · ' + syncedAt() +
              ' — add a Google Client ID in Nexus settings for live mail and calendar',
            'mock',
          )
        } else {
          setStatus(
            'Connected · ' + (mail.items || []).length + ' messages · ' +
              (events.items || []).length + ' events · ' + syncedAt(),
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

  // ---- boot ---------------------------------------------------------------

  function start() {
    var bridge = getBridge()
    if (!bridge) {
      // Opened as a standalone file: OAuth lives in the Nexus app, so there is
      // nothing to connect to here. Say so rather than leaving a user who
      // clicked "Open full page" wondering where the live sections went.
      if (buildStrip()) {
        showButtons('unavailable')
        setStatus('Open this page inside Nexus for live Gmail and Calendar data', 'idle')
      }
      return
    }
    if (!buildStrip()) return

    var st = bridge.status()

    connectBtn.addEventListener('click', function () {
      setStatus('Opening Google sign-in…')
      connectBtn.disabled = true
      // The click's user activation reaches the same-origin parent, so the
      // consent popup opens there rather than being blocked in this frame.
      bridge.connect().then(function (next) {
        connectBtn.disabled = false
        if (next.error) {
          setStatus(next.error, 'warn')
          showButtons('disconnected')
          return
        }
        showButtons('connected')
        sync(bridge, true)
      })
    })

    syncBtn.addEventListener('click', function () {
      sync(bridge, true)
    })

    if (st.mock || (st.gmail && st.calendar)) {
      // Sample mode, or consent already granted — show data immediately.
      showButtons('connected')
      sync(bridge, false)
    } else {
      showButtons('disconnected')
      setStatus('Not connected — Gmail and Calendar are read-only', 'idle')
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
