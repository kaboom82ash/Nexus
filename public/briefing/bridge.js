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

  // Lookback options for the actions list. `candidates` is the scoring pool:
  // a 90-day window ranked from the 40 newest messages would only ever surface
  // the newest slice, so the pool widens with the range (each candidate is one
  // metadata request, which is why it is not simply "all of them").
  var RANGES = [
    { key: '24h', label: '24 hours', hours: 24, limit: 12, candidates: 40 },
    { key: '7d', label: '7 days', hours: 24 * 7, limit: 20, candidates: 80 },
    { key: '30d', label: '30 days', hours: 24 * 30, limit: 30, candidates: 120 },
    { key: '90d', label: '90 days', hours: 24 * 90, limit: 40, candidates: 120 },
    { key: 'custom', label: 'Custom…', hours: 0, limit: 30, candidates: 120 },
  ]
  var DEFAULT_RANGE = '7d'
  var RANGE_KEY = 'ak-briefing-range'
  var CUSTOM_DAYS_KEY = 'ak-briefing-range-days'
  var MAX_CUSTOM_DAYS = 365

  var EVENT_DAYS = 14
  var EVENT_LIMIT = 25

  // Once connected the page keeps itself current on its own. Polling pauses
  // while the tab is hidden — a background tab burning Gmail quota every few
  // minutes helps nobody — and catches up when it comes back.
  var AUTO_SYNC_MS = 5 * 60 * 1000
  var STALE_MS = 2 * 60 * 1000

  /** Own punch-list items and thread pins, kept beside the page's own state. */
  var OWN_KEY = 'ak-briefing-own'

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


  // ---- lookback range -----------------------------------------------------

  function readStored(key, fallback) {
    try {
      return localStorage.getItem(key) || fallback
    } catch (e) {
      return fallback
    }
  }

  function writeStored(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch (e) {
      /* private mode — the choice just does not survive a reload */
    }
  }

  function currentRange() {
    var key = readStored(RANGE_KEY, DEFAULT_RANGE)
    var found = null
    RANGES.forEach(function (r) {
      if (r.key === key) found = r
    })
    if (!found) return RANGES[1]
    if (found.key !== 'custom') return found

    var days = parseInt(readStored(CUSTOM_DAYS_KEY, '14'), 10)
    if (!(days > 0)) days = 14
    days = Math.min(days, MAX_CUSTOM_DAYS)
    return {
      key: 'custom',
      label: days + (days === 1 ? ' day' : ' days'),
      hours: days * 24,
      // Scale the pool with the window, on the same curve as the presets.
      limit: Math.min(40, Math.max(12, Math.round(days * 1.2))),
      candidates: Math.min(120, Math.max(40, days * 4)),
    }
  }

  // ---- own punch-list items ----------------------------------------------

  /**
   * Items the user adds by hand, and the threads they pin, live in their own
   * storage key rather than inside the page's state blob. The page rewrites
   * that blob wholesale on every rebuild-and-restore path, and anything it
   * does not know about is at risk there; keeping our records separate means
   * a weekly rebuild cannot drop them.
   */
  function loadOwn() {
    try {
      var raw = localStorage.getItem(OWN_KEY)
      var parsed = raw ? JSON.parse(raw) : null
      if (parsed && typeof parsed === 'object') {
        return { items: parsed.items || {}, threads: parsed.threads || {} }
      }
    } catch (e) {}
    return { items: {}, threads: {} }
  }

  var own = loadOwn()

  function saveOwn() {
    try {
      localStorage.setItem(OWN_KEY, JSON.stringify(own))
    } catch (e) {}
  }

  /** Push our records into the page's punch list and re-render it. */
  function applyOwnItems() {
    if (typeof STATE !== 'object' || !STATE || !STATE.punchlist) return
    Object.keys(own.items).forEach(function (id) {
      var rec = own.items[id]
      var existing = STATE.punchlist[id]
      if (existing) {
        // The page owns done/doneAt/subs once the entry exists — only refresh
        // the fields we are the source of truth for.
        existing.title = rec.title
        existing.category = rec.category
        existing.severity = rec.severity
        existing.links = rec.links
        return
      }
      STATE.punchlist[id] = {
        title: rec.title,
        category: rec.category,
        severity: rec.severity,
        links: rec.links,
        done: false,
        doneAt: null,
        addedAt: rec.addedAt,
        subs: [],
      }
    })
    persistPage()
    if (typeof renderPunchList === 'function') renderPunchList()
  }

  function persistPage() {
    try {
      if (typeof schedulePersist === 'function') schedulePersist()
    } catch (e) {}
  }

  // ---- the live strip -----------------------------------------------------

  var strip, statusEl, syncBtn, rangeSel, customDays
  var chips = {}
  var busy = false
  var autoTimer = null
  var lastSyncAt = 0
  // Last error per service, so a granted-but-failing service (scope approved,
  // API disabled) reads as broken rather than as a reassuring tick.
  var svcErrors = {}
  /** Last synced payload, so punch-list-driven re-renders keep their numbers. */
  var lastData = { events: [], mail: [] }

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
    '.live-sep{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}',
    '.sync-stamp{text-align:right;margin-bottom:6px}',
    '.sync-stamp__label{font-size:10px;font-weight:700;letter-spacing:.08em;',
    'text-transform:uppercase;color:var(--muted)}',
    '.sync-stamp__when{font-size:20px;font-weight:700;line-height:1.15;color:var(--ink);',
    'font-family:"IBM Plex Mono",monospace}',
    '.sync-stamp__new{font-size:12px;color:var(--accent);font-weight:600;margin-top:2px}',
    '.sync-stamp__new--quiet{color:var(--muted);font-weight:400}',
    '.sweep-stamp{font-size:11px;color:var(--muted)}',
    '.stat-rows{max-width:1180px;margin:18px auto 0}',
    '.stat-row{margin:0;border-radius:0}',
    '.stat-rows .stat-row:first-child{border-radius:10px 10px 0 0}',
    '.stat-rows .stat-row+.stat-row{border-top:none}',
    '.stat-row--punch{grid-template-columns:repeat(4,minmax(0,1fr))}',
    '.stat-row--cal{grid-template-columns:repeat(3,minmax(0,1fr)) 1.4fr}',
    '.stat-row--mail{grid-template-columns:1fr}',
    '@media (max-width:860px){.stat-row--punch,.stat-row--cal{',
    'grid-template-columns:repeat(2,minmax(0,1fr))}}',
    '.stat-cats{font-family:"IBM Plex Mono",monospace;font-size:12.5px;',
    'color:var(--ink);margin-top:2px}',
    '.live-select,.live-days{font:inherit;font-size:12px;padding:4px 6px;border-radius:8px;',
    'border:1px solid var(--line);background:var(--surface-2);color:var(--ink)}',
    '.live-days{width:64px}',
    '.live-section{margin-bottom:24px}',
    '.live-band{border-left-color:var(--accent)}',
    '.live-tag{font-size:10px;font-weight:700;text-transform:uppercase;margin-left:6px;',
    'padding:1px 5px;border-radius:4px;background:var(--high-bg);color:var(--high)}',

    '.own-form{margin:0 0 18px;padding:14px;border:1px solid var(--line);',
    'border-radius:10px;background:var(--surface);box-shadow:var(--shadow)}',
    '.own-form__row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
    '.own-form__row+.own-form__row{margin-top:8px}',
    '.own-in{font:inherit;font-size:13px;padding:7px 9px;border-radius:8px;',
    'border:1px solid var(--line);background:var(--surface-2);color:var(--ink)}',
    '.own-in--title{flex:1 1 320px}',
    '.own-in--email{flex:1 1 380px}',
    '.own-in--sel{flex:0 0 auto}',
    '.own-form__hint{color:var(--muted);font-size:11.5px}',
    '.own-form__msg{margin-top:8px;font-size:12px;color:var(--low)}',
    '.own-form__msg--bad{color:var(--critical)}',
    '.live-attach{font:inherit;font-size:11px;padding:1px 7px;border-radius:6px;',
    'border:1px solid var(--line);background:transparent;color:var(--accent);cursor:pointer}',
    '.live-attach:hover{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}',

    '.mon-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}',
    '.mon-q{flex:1 1 240px}',
    '.mon-count{color:var(--muted);font-size:12px;margin-bottom:10px;',
    'font-family:"IBM Plex Mono",monospace}',
    '.mon-row{border:1px solid var(--line);border-left:4px solid var(--line);',
    'border-radius:10px;background:var(--surface);padding:12px 14px;margin-bottom:10px}',
    '.mon-row.sev-critical{border-left-color:var(--critical)}',
    '.mon-row.sev-high{border-left-color:var(--high)}',
    '.mon-row.sev-medium{border-left-color:var(--medium)}',
    '.mon-row.sev-low{border-left-color:var(--low)}',
    '.mon-row__head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.mon-row__title{font-weight:600}',
    '.mon-row__meta{color:var(--muted);font-size:12px;margin-top:3px}',
    '.mon-chip{font-size:11px;padding:1px 7px;border-radius:999px;',
    'border:1px solid var(--line);color:var(--muted)}',
    '.mon-chip--done{color:var(--low);border-color:var(--low)}',
    '.mon-chip--wait{color:var(--high);border-color:var(--high)}',
    '.mon-err{color:var(--critical)}',
    '.mon-thread{margin-top:10px;border-top:1px solid var(--line);padding-top:8px}',
    '.mon-thread-toggle{cursor:pointer;font-size:12px;color:var(--accent);',
    'font-weight:600;list-style:none}',
    '.mon-thread-toggle::-webkit-details-marker{display:none}',
    '.mon-thread-toggle::before{content:"▸ ";}',
    '.mon-thread[open] .mon-thread-toggle::before{content:"▾ ";}',
    '.mon-thread__head{margin:8px 0;font-size:12.5px;display:flex;gap:8px;',
    'align-items:center;flex-wrap:wrap}',
    '.mon-timeline{list-style:none;margin:0;padding:0 0 0 14px;',
    'border-left:2px solid var(--line)}',
    '.mon-msg{position:relative;padding:0 0 12px 12px}',
    '.mon-msg::before{content:"";position:absolute;left:-19px;top:4px;width:8px;',
    'height:8px;border-radius:50%;background:var(--muted)}',
    '.mon-msg--out::before{background:var(--accent)}',
    '.mon-msg__who{font-weight:600;font-size:12.5px}',
    '.mon-msg__when{color:var(--muted);font-weight:400;margin-left:8px;',
    'font-family:"IBM Plex Mono",monospace;font-size:11px}',
    '.mon-msg__snippet{color:var(--muted);font-size:12px;margin:2px 0 3px}',

    '.mon-board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;',
    'align-items:start}',
    '@media (max-width:1000px){.mon-board{grid-template-columns:repeat(2,minmax(0,1fr))}}',
    '@media (max-width:620px){.mon-board{grid-template-columns:1fr}}',
    '.mon-col__head{font-weight:700;font-size:12px;text-transform:uppercase;',
    'letter-spacing:.05em;padding:0 2px 8px;display:flex;justify-content:space-between;',
    'align-items:center;border-bottom:2px solid var(--line);margin-bottom:10px}',
    '.mon-col--critical .mon-col__head{color:var(--critical);border-bottom-color:var(--critical)}',
    '.mon-col--high .mon-col__head{color:var(--high);border-bottom-color:var(--high)}',
    '.mon-col--medium .mon-col__head{color:var(--medium);border-bottom-color:var(--medium)}',
    '.mon-col--low .mon-col__head{color:var(--low);border-bottom-color:var(--low)}',
    '.mon-col__count{font-family:"IBM Plex Mono",monospace;font-size:12px}',
    '.mon-col__empty{color:var(--muted);font-size:12px;padding:6px 2px}',
    // The tile IS the severity: a solid ground, not a stripe on black.
    '.mon-tile{border-radius:10px;padding:11px 12px;margin-bottom:10px;',
    'box-shadow:var(--shadow);border:1px solid transparent}',
    '.mon-tile--critical{background:var(--critical);color:#170a0a}',
    '.mon-tile--high{background:var(--high);color:#1c1305}',
    '.mon-tile--medium{background:var(--medium);color:#08131c}',
    '.mon-tile--low{background:var(--low);color:#07160d}',
    '.mon-tile__title{font-weight:700;font-size:13.5px;line-height:1.3}',
    // Everything inside inherits the tile ink, at reduced weight, so the
    // colour keeps its meaning instead of fighting the page tokens.
    '.mon-tile__meta{font-size:11.5px;opacity:.78;margin-top:3px}',
    '.mon-tile__chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}',
    '.mon-tile .mon-chip{border-color:currentColor;color:inherit;opacity:.85}',
    '.mon-tile .cat-links{margin-top:7px}',
    '.mon-tile .mail-link,.mon-tile .cal-btn{color:inherit;text-decoration:underline}',
    '.mon-tile .mon-thread-toggle{color:inherit;opacity:.9}',
    '.mon-tile .mon-thread{border-top-color:currentColor}',
    '.mon-tile .note,.mon-tile .mon-msg__snippet,.mon-tile .mon-msg__when{color:inherit;opacity:.75}',
    '.mon-tile .mon-timeline{border-left-color:currentColor}',
    '.mon-tile .mon-msg::before{background:currentColor}',
    '.mon-tile.is-done{opacity:.55}',
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

    // The masthead's "Refresh data" button copied a prompt to paste into
    // Claude for a full rebuild. The page pulls its own data now, so it is
    // one button that does not do what its label promises.
    var oldRefresh = document.getElementById('refresh-btn')
    if (oldRefresh && oldRefresh.parentNode) {
      oldRefresh.parentNode.removeChild(oldRefresh)
    }

    rangeSel = el('select', 'live-select')
    rangeSel.title = 'How far back the actions list looks'
    RANGES.forEach(function (r) {
      var opt = document.createElement('option')
      opt.value = r.key
      opt.textContent = r.key === 'custom' ? r.label : 'Last ' + r.label
      rangeSel.appendChild(opt)
    })
    rangeSel.value = readStored(RANGE_KEY, DEFAULT_RANGE)

    customDays = el('input', 'live-days')
    customDays.type = 'number'
    customDays.min = '1'
    customDays.max = String(MAX_CUSTOM_DAYS)
    customDays.value = readStored(CUSTOM_DAYS_KEY, '14')
    customDays.title = 'Custom window, in days'
    customDays.setAttribute('aria-label', 'Custom window in days')

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
    strip.appendChild(el('span', 'live-sep', 'Actions from'))
    strip.appendChild(rangeSel)
    strip.appendChild(customDays)
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

  function updateRangeUi() {
    if (!customDays || !rangeSel) return
    customDays.hidden = rangeSel.value !== 'custom'
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

  function refreshMailSubhead() {
    var sub = document.querySelector('#live-inbox .section-head .sub')
    if (sub) {
      sub.textContent =
        'Top messages from the last ' + currentRange().label +
        ', ranked by the dashboard’s priority score · check one to queue it'
    }
  }

  function renderMail(items, mock, newIds) {
    var fresh = newIds || []
    var host = ensureSection({
      panelId: 'panel-actions',
      id: 'live-inbox',
      heading: 'Live inbox',
      sub: 'Top messages from the last ' + currentRange().label +
        ', ranked by the dashboard’s priority score · check one to queue it',
      icon: '✉️',
      label: 'Live inbox',
      href: 'https://mail.google.com/mail/u/0/#inbox',
      linkLabel: '✉️ Open Gmail ↗',
    })
    if (!host) return
    if (!items.length) {
      host.innerHTML = '<div class="cat-row no-check"><div class="cat-main"><div class="cat-meta">Nothing in the last ' + currentRange().label + '.</div></div></div>'
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
      // The API id is right here, so offer the reliable way to attach a
      // message to an item — the id in Gmail's own address bar is a different
      // encoding the API cannot resolve.
      var link = '<div class="cat-links"><a class="mail-link" href="' + esc(mailHref(m)) +
        '" target="_blank" rel="noopener">✉️ Open in Gmail ↗</a>' +
        (m.id ? '<button type="button" class="live-attach" data-mid="' + esc(m.id) +
          '" data-title="' + esc(m.subject) + '" title="Start a punch-list item with this email attached">📌 Add to punch list</button>' : '') +
        '</div>'
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
        (fresh.indexOf(m.id) !== -1 ? '<span class="new-badge">NEW</span> ' : '') +
        (mock ? '<span class="live-tag">sample</span> ' : '') + meta + '</div>' +
        link +
        '</div></div>'
    })
    host.innerHTML = html
    refreshMailSubhead()
    setCount('live-inbox', items.length)
  }

  function renderEvents(items, mock, newIds) {
    var fresh = newIds || []
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
        (fresh.indexOf(e.id) !== -1 ? '<span class="new-badge">NEW</span> ' : '') +
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


  // ---- own punch-list items: the add form --------------------------------

  var CATEGORY_OPTS = [
    ['personal', 'Personal & career'],
    ['kids', 'Kids'],
    ['home', 'Home'],
    ['finance', 'Finance'],
    ['health', 'Health'],
    ['lifestyle', 'Lifestyle'],
  ]
  var SEVERITY_OPTS = [
    ['critical', 'Critical'],
    ['high', 'High'],
    ['medium', 'Medium'],
    ['low', 'Low'],
  ]

  function optionsHtml(pairs, selected) {
    return pairs
      .map(function (p) {
        return '<option value="' + p[0] + '"' +
          (p[0] === selected ? ' selected' : '') + '>' + esc(p[1]) + '</option>'
      })
      .join('')
  }

  /**
   * A form at the top of the punch list for items that never came from a
   * sweep. The category select is not decoration: renderPunchList only draws
   * entries whose category is one it knows, so a free-text category would file
   * an item into a group that never renders.
   */
  function buildOwnForm(bridge) {
    var root = document.getElementById('punchlist-root')
    if (!root || document.getElementById('own-form')) return

    var form = el('form', 'own-form')
    form.id = 'own-form'
    form.innerHTML =
      '<div class="own-form__row">' +
      '<input class="own-in own-in--title" name="title" placeholder="Add your own item — what needs doing?" required>' +
      '<select class="own-in own-in--sel" name="category">' + optionsHtml(CATEGORY_OPTS, 'personal') + '</select>' +
      '<select class="own-in own-in--sel" name="severity">' + optionsHtml(SEVERITY_OPTS, 'medium') + '</select>' +
      '<button type="submit" class="live-btn live-btn--primary">Add</button>' +
      '</div>' +
      '<div class="own-form__row">' +
      '<input class="own-in own-in--email" name="email" placeholder="Attach an email — paste a Gmail link or message id (optional)">' +
      '<span class="own-form__hint">Attached mail gets a thread timeline and history on this item.</span>' +
      '</div>' +
      '<div class="own-form__msg" hidden></div>'

    form.addEventListener('submit', function (e) {
      e.preventDefault()
      addOwnItem(form, bridge)
    })
    root.parentNode.insertBefore(form, root)
  }

  /** Send a live message into the add-item form, and go where the form is. */
  function prefillOwnForm(title, messageId) {
    var form = document.getElementById('own-form')
    if (!form) return
    if (typeof switchTab === 'function') switchTab('punchlist')
    form.title.value = title
    form.email.value = messageId
    formMessage(form, 'Email attached — set a category and severity, then Add.', false)
    form.title.focus()
    form.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  function formMessage(form, text, bad) {
    var msg = form.querySelector('.own-form__msg')
    if (!msg) return
    msg.textContent = text || ''
    msg.hidden = !text
    msg.className = 'own-form__msg' + (bad ? ' own-form__msg--bad' : '')
  }

  function addOwnItem(form, bridge) {
    var title = form.title.value.trim()
    if (!title) return
    var rawEmail = form.email.value.trim()
    var emailId = rawEmail ? bridge.parseId(rawEmail) : ''
    if (rawEmail && !emailId) {
      formMessage(form, 'That does not look like a Gmail link or message id.', true)
      return
    }

    var id = uniqueOwnId(title)
    var links = []
    if (emailId) {
      links.push({
        label: '✉️ Email ↗',
        href: 'https://mail.google.com/mail/u/0/#all/' + emailId,
      })
    }
    own.items[id] = {
      title: title,
      category: form.category.value,
      severity: form.severity.value,
      links: links,
      emailId: emailId,
      addedAt: new Date().toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    }
    saveOwn()
    applyOwnItems()

    form.reset()
    formMessage(
      form,
      emailId
        ? 'Added — the thread is on the Monitor tab.'
        : 'Added to your punch list.',
      false,
    )
    if (emailId) renderMonitor(bridge)
  }

  /** Own ids are namespaced so they can never collide with a swept item's. */
  function uniqueOwnId(title) {
    var base = 'own-' + String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 50)
    var id = base || 'own-item'
    var n = 2
    while (own.items[id]) {
      id = base + '-' + n
      n++
    }
    return id
  }



  // ---- masthead: sync stamp + the stat strip ------------------------------

  var LAST_SYNC_KEY = 'ak-briefing-last-sync'
  var SEEN_KEY = 'ak-briefing-seen'

  function lastSyncStamp() {
    var raw = readStored(LAST_SYNC_KEY, '')
    var t = raw ? new Date(raw) : null
    return t && !isNaN(t.getTime()) ? t : null
  }

  /**
   * Ids seen on the previous sync, so "new since last time" is a real diff
   * rather than a guess from timestamps — an email that arrived while the tab
   * was closed is new to the reader even if it is two days old.
   */
  function loadSeen() {
    try {
      var parsed = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}')
      return { mail: parsed.mail || [], events: parsed.events || [] }
    } catch (e) {
      return { mail: [], events: [] }
    }
  }

  function saveSeen(mailIds, eventIds) {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ mail: mailIds, events: eventIds }))
    } catch (e) {}
  }

  function diffNew(current, previous) {
    if (!previous.length) return []   // first sync: nothing is "new" yet
    return current.filter(function (id) {
      return previous.indexOf(id) === -1
    })
  }

  /** Replace the masthead date line with a prominent last-sync stamp. */
  function renderSyncStamp(newMail, newEvents) {
    var asof = document.getElementById('data-asof')
    if (!asof) return
    var host = document.getElementById('sync-stamp')
    if (!host) {
      host = el('div', 'sync-stamp')
      host.id = 'sync-stamp'
      asof.parentNode.insertBefore(host, asof)
      // The sweep date still matters — it dates the curated sections below —
      // but it is no longer the headline, because it is not what changes.
      asof.classList.add('sweep-stamp')
    }
    var t = lastSyncStamp()
    var when = t
      ? t.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) +
        ' · ' + t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : 'never'
    var bits = []
    if (newMail && newMail.length) bits.push(newMail.length + ' new email' + (newMail.length === 1 ? '' : 's'))
    if (newEvents && newEvents.length) bits.push(newEvents.length + ' calendar update' + (newEvents.length === 1 ? '' : 's'))

    host.innerHTML =
      '<div class="sync-stamp__label">Last sync</div>' +
      '<div class="sync-stamp__when">' + esc(when) + '</div>' +
      (bits.length
        ? '<div class="sync-stamp__new">🆕 ' + esc(bits.join(' · ')) + ' since last sync</div>'
        : '<div class="sync-stamp__new sync-stamp__new--quiet">Nothing new since last sync</div>')
  }

  // ---- stat strip ---------------------------------------------------------

  /**
   * A recurring block on the calendar is a routine, not a meeting — counting
   * standups and "focus time" as meetings makes the number useless for
   * deciding whether a week is overloaded.
   */
  var ROUTINE = /\b(routine|block|focus|lunch|break|gym|workout|commute|travel time|prep|hold|busy|ooo|out of office|do not schedule|reminder|birthday|holiday)\b/i

  function isMeeting(ev) {
    if (ev.allDay) return false
    if (ROUTINE.test(ev.title || '')) return false
    return true
  }

  function hoursOf(ev) {
    var a = new Date(ev.start).getTime()
    var b = new Date(ev.end).getTime()
    if (!isFinite(a) || !isFinite(b) || b <= a) return 0
    return (b - a) / 3600000
  }

  function fmtHours(h) {
    if (!h) return '0h'
    var whole = Math.floor(h)
    var mins = Math.round((h - whole) * 60)
    return whole + 'h' + (mins ? ' ' + mins + 'm' : '')
  }

  /** Bucket an event with the page's own category vocabulary. */
  function eventCategory(ev) {
    if (typeof inferCategory === 'function') {
      try {
        return inferCategory(document.createElement('div'), ev.title || '')
      } catch (e) {}
    }
    return 'personal'
  }

  function punchCounts() {
    var out = { total: 0, critical: 0, high: 0, medium: 0 }
    try {
      Object.keys(STATE.punchlist || {}).forEach(function (id) {
        var e = STATE.punchlist[id]
        if (!e || e.done) return
        out.total++
        if (e.severity === 'critical') out.critical++
        else if (e.severity === 'high') out.high++
        else if (e.severity === 'medium') out.medium++
      })
    } catch (e) {}
    return out
  }

  function statHtml(value, label, color) {
    return '<div class="stat"><div class="n mono"' +
      (color ? ' style="color:' + color + '"' : '') + '>' + value + '</div>' +
      '<div class="l">' + label + '</div></div>'
  }

  /**
   * The punch-list counters are the reason the strip exists, and the punch
   * list changes constantly — every checkbox on the page writes to it. Watch
   * the list itself rather than trying to hook each of the page's own paths
   * into it, which would break the moment a rebuild reorganises them.
   */
  function watchPunchList(bridge) {
    var root = document.getElementById('punchlist-root')
    if (!root || typeof MutationObserver !== 'function') return
    var queued = false
    new MutationObserver(function () {
      if (queued) return
      queued = true
      // Coalesce: one toggle can rewrite the whole list.
      setTimeout(function () {
        queued = false
        renderStats(lastData.events, lastData.mail)
        renderMonitor(bridge)
      }, 60)
    }).observe(root, { childList: true, subtree: true })
  }

  function renderStats(events, mail) {
    var strips = document.querySelector('.masthead .stat-strip')
    if (!strips) return
    var p = punchCounts()

    var upcoming = (events || []).filter(function (ev) {
      return new Date(ev.start).getTime() >= Date.now()
    })
    var meetings = upcoming.filter(isMeeting)

    // "Upcoming week" = the next 7 days, which is the horizon the time-per-
    // category split is meant to help you plan against.
    var weekEnd = Date.now() + 7 * 86400000
    var inWeek = meetings.filter(function (ev) {
      return new Date(ev.start).getTime() <= weekEnd
    })
    var byCat = {}
    var weekHours = 0
    inWeek.forEach(function (ev) {
      var h = hoursOf(ev)
      weekHours += h
      var c = eventCategory(ev)
      byCat[c] = (byCat[c] || 0) + h
    })
    var catBits = Object.keys(byCat)
      .sort(function (a, b) { return byCat[b] - byCat[a] })
      .slice(0, 5)
      .map(function (c) { return esc(c) + ' ' + fmtHours(byCat[c]) })

    var dayAgo = Date.now() - 86400000
    var last24 = (mail || []).filter(function (m) {
      return new Date(m.date).getTime() >= dayAgo
    })

    var row1 =
      '<div class="stat-strip stat-row stat-row--punch">' +
      statHtml(p.total, '📋 On punch list') +
      statHtml(p.critical, 'Critical', 'var(--critical)') +
      statHtml(p.high, 'High', 'var(--high)') +
      statHtml(p.medium, 'Medium', 'var(--medium)') +
      '</div>'

    var row2 =
      '<div class="stat-strip stat-row stat-row--cal">' +
      statHtml(upcoming.length, '📅 Events coming up') +
      statHtml(meetings.length, 'Meetings (routines excluded)') +
      statHtml(fmtHours(weekHours), 'Proposed meeting time, next 7 days') +
      '<div class="stat stat--wide"><div class="l">Time per category, next 7 days</div>' +
      '<div class="stat-cats">' +
      (catBits.length ? catBits.join(' · ') : 'nothing scheduled') +
      '</div></div>' +
      '</div>'

    var row3 =
      '<div class="stat-strip stat-row stat-row--mail">' +
      statHtml(last24.length, '✉️ New emails, last 24 hours') +
      '</div>'

    var wrap = document.getElementById('stat-rows')
    if (!wrap) {
      wrap = el('div', 'stat-rows')
      wrap.id = 'stat-rows'
      strips.parentNode.insertBefore(wrap, strips)
      // The page's own strip is superseded. `hidden` is not enough: the
      // attribute's display:none comes from the UA sheet and loses to the
      // page's `.stat-strip { display: grid }`.
      strips.style.display = 'none'
    }
    wrap.innerHTML = row1 + row2 + row3
    syncScrollPadding()
  }

  // ---- Monitor tab: filters, thread timelines, history --------------------

  var STATUS_FILTERS = [
    ['', 'Any status'],
    ['waiting', '⏳ Waiting on reply'],
    ['court', '➡️ In their court'],
    ['fwd', '📤 Forwarded'],
    ['remind', '⏰ Reminder set'],
    ['none', '— no status set'],
  ]
  var DONE_FILTERS = [
    ['open', 'Open only'],
    ['done', 'Completed only'],
    ['all', 'Open + completed'],
  ]

  var monitorPanel = null
  var threadCache = {}

  /**
   * Register a sixth tab on the page's own tab machinery. The page wires its
   * tab buttons from a NodeList captured at load, so a button added later gets
   * no handler — hence the explicit listener onto its global switchTab.
   */
  function buildMonitorTab(bridge) {
    if (monitorPanel || typeof panels !== 'object' || !panels) return
    var main = document.querySelector('main')
    var nav = document.querySelector('.masthead .tabs')
    if (!main || !nav) return

    monitorPanel = el('div', 'panel')
    monitorPanel.id = 'panel-monitor'
    monitorPanel.innerHTML =
      '<section>' +
      '<div class="section-head"><h2>🔎 Monitor</h2>' +
      '<span class="sub">Filter the punch list — everything you are waiting on, in one place — and follow the mail behind each item</span>' +
      '</div>' +
      '<div class="mon-filters">' +
      '<input class="own-in mon-q" placeholder="Search titles…">' +
      '<select class="own-in own-in--sel mon-status">' + optionsHtml(STATUS_FILTERS, '') + '</select>' +
      '<select class="own-in own-in--sel mon-cat"><option value="">Any category</option>' +
      optionsHtml(CATEGORY_OPTS, '_none_') + '</select>' +
      '<select class="own-in own-in--sel mon-sev"><option value="">Any severity</option>' +
      optionsHtml(SEVERITY_OPTS, '_none_') + '</select>' +
      '<select class="own-in own-in--sel mon-done">' + optionsHtml(DONE_FILTERS, 'open') + '</select>' +
      '<button type="button" class="live-btn mon-clear">Clear</button>' +
      '</div>' +
      '<div class="mon-count"></div>' +
      '<div class="mon-results"></div>' +
      '</section>'
    main.appendChild(monitorPanel)
    panels.monitor = monitorPanel

    var btn = el('button', 'tab-btn')
    btn.type = 'button'
    btn.setAttribute('role', 'tab')
    btn.dataset.panel = 'monitor'
    btn.setAttribute('aria-selected', 'false')
    btn.innerHTML = '🔎 Monitor <span class="count mono" id="monitor-tab-count">0</span>'
    btn.addEventListener('click', function () {
      if (typeof switchTab === 'function') switchTab('monitor')
      renderMonitor(bridge)
    })
    nav.appendChild(btn)

    ;['.mon-q', '.mon-status', '.mon-cat', '.mon-sev', '.mon-done'].forEach(function (sel) {
      var node = monitorPanel.querySelector(sel)
      node.addEventListener(sel === '.mon-q' ? 'input' : 'change', function () {
        renderMonitor(bridge)
      })
    })
    monitorPanel.querySelector('.mon-clear').addEventListener('click', function () {
      monitorPanel.querySelector('.mon-q').value = ''
      monitorPanel.querySelector('.mon-status').value = ''
      monitorPanel.querySelector('.mon-cat').value = ''
      monitorPanel.querySelector('.mon-sev').value = ''
      monitorPanel.querySelector('.mon-done').value = 'open'
      renderMonitor(bridge)
    })

    // One delegated handler for every expandable thread on the tab.
    monitorPanel.addEventListener('click', function (e) {
      var toggle = e.target.closest('.mon-thread-toggle')
      if (toggle) loadThread(bridge, toggle.dataset.id, toggle.dataset.email)
    })
  }

  function statusOf(id) {
    try {
      return (STATE.status && STATE.status[id]) || ''
    } catch (e) {
      return ''
    }
  }

  function matches(id, entry, f) {
    if (f.q && String(entry.title || '').toLowerCase().indexOf(f.q) === -1) return false
    var st = statusOf(id)
    if (f.status === 'none' && st) return false
    if (f.status && f.status !== 'none' && st !== f.status) return false
    if (f.cat && entry.category !== f.cat) return false
    if (f.sev && entry.severity !== f.sev) return false
    if (f.done === 'open' && entry.done) return false
    if (f.done === 'done' && !entry.done) return false
    return true
  }

  function statusLabel(code) {
    var out = ''
    STATUS_FILTERS.forEach(function (p) {
      if (p[0] === code && code) out = p[1]
    })
    return out
  }

  /** The email attached to an item — either one we recorded, or a Gmail link. */
  function emailIdFor(id, entry, bridge) {
    if (own.items[id] && own.items[id].emailId) return own.items[id].emailId
    var links = entry.links || []
    for (var i = 0; i < links.length; i++) {
      if (String(links[i].href).indexOf('mail.google.com') !== -1) {
        var parsed = bridge.parseId(links[i].href)
        if (parsed) return parsed
      }
    }
    return ''
  }

  function renderMonitor(bridge) {
    if (!monitorPanel) return
    var f = {
      q: monitorPanel.querySelector('.mon-q').value.trim().toLowerCase(),
      status: monitorPanel.querySelector('.mon-status').value,
      cat: monitorPanel.querySelector('.mon-cat').value,
      sev: monitorPanel.querySelector('.mon-sev').value,
      done: monitorPanel.querySelector('.mon-done').value,
    }

    var entries = []
    try {
      Object.keys(STATE.punchlist || {}).forEach(function (id) {
        var entry = STATE.punchlist[id]
        if (entry && matches(id, entry, f)) entries.push([id, entry])
      })
    } catch (e) {}

    // Hardest first, then most recently added.
    var order = { critical: 0, high: 1, medium: 2, low: 3 }
    entries.sort(function (a, b) {
      var d = (order[a[1].severity] ?? 9) - (order[b[1].severity] ?? 9)
      return d !== 0 ? d : String(b[1].addedAt || '').localeCompare(String(a[1].addedAt || ''))
    })

    var countEl = monitorPanel.querySelector('.mon-count')
    countEl.textContent =
      entries.length + (entries.length === 1 ? ' item' : ' items') + ' match'
    var tabCount = document.getElementById('monitor-tab-count')
    if (tabCount) tabCount.textContent = entries.length

    var results = monitorPanel.querySelector('.mon-results')
    if (!entries.length) {
      results.innerHTML =
        '<p class="note">Nothing matches. Statuses are set from the ⏳ dropdown on any item — filter on one here to keep an eye on what you are waiting for.</p>'
      return
    }

    // A severity board: one column per level, and each tile carries its
    // severity as its whole background rather than a stripe or a word, so the
    // shape of the week reads before any of it is actually read.
    var COLUMNS = [
      { key: 'critical', label: 'Critical' },
      { key: 'high', label: 'High' },
      { key: 'medium', label: 'Medium' },
      { key: 'low', label: 'Low' },
    ]
    var buckets = { critical: [], high: [], medium: [], low: [] }
    entries.forEach(function (pair) {
      var sev = pair[1].severity
      ;(buckets[sev] || buckets.low).push(pair)
    })

    results.innerHTML =
      '<div class="mon-board">' +
      COLUMNS.map(function (col) {
        var items = buckets[col.key]
        return (
          '<div class="mon-col mon-col--' + col.key + '">' +
          '<div class="mon-col__head">' + esc(col.label) +
          '<span class="mon-col__count">' + items.length + '</span></div>' +
          (items.length
            ? items.map(function (pair) { return tileHtml(pair[0], pair[1], bridge) }).join('')
            : '<div class="mon-col__empty">None</div>') +
          '</div>'
        )
      }).join('') +
      '</div>'
  }

  function tileHtml(id, e, bridge) {
    var sev = e.severity || 'low'
    var st = statusLabel(statusOf(id))
    var emailId = emailIdFor(id, e, bridge)
    var linksHtml = (e.links || [])
      .map(function (l) {
        return '<a class="mail-link" href="' + esc(l.href) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>'
      })
      .join(' ')
    var cached = threadCache[emailId]
    return (
      '<div class="mon-tile mon-tile--' + esc(sev) + (e.done ? ' is-done' : '') + '">' +
      '<div class="mon-tile__title">' + esc(e.title) + '</div>' +
      '<div class="mon-tile__meta">' + esc(e.category || '') +
      (e.addedAt ? ' · ' + esc(e.addedAt) : '') +
      ((e.subs || []).length ? ' · ' + e.subs.length + ' steps' : '') + '</div>' +
      '<div class="mon-tile__chips">' +
      (st ? '<span class="mon-chip">' + esc(st) + '</span>' : '') +
      (e.done ? '<span class="mon-chip mon-chip--done">✓ done</span>' : '') +
      (own.items[id] ? '<span class="mon-chip">yours</span>' : '') +
      '</div>' +
      (linksHtml ? '<div class="cat-links">' + linksHtml + '</div>' : '') +
      (emailId
        ? '<details class="mon-thread"' + (cached ? ' open' : '') + '>' +
          '<summary class="mon-thread-toggle" data-id="' + esc(id) + '" data-email="' + esc(emailId) + '">' +
          '🧵 Thread history</summary>' +
          '<div class="mon-thread__body" data-for="' + esc(emailId) + '">' +
          (cached ? threadHtml(cached) : '<span class="note">Loading…</span>') +
          '</div></details>'
        : '') +
      '</div>'
    )
  }

  function loadThread(bridge, id, emailId) {
    if (!emailId || threadCache[emailId]) return
    bridge.fetchThread(emailId).then(function (t) {
      threadCache[emailId] = t
      var body = monitorPanel.querySelector('.mon-thread__body[data-for="' + emailId + '"]')
      if (body) body.innerHTML = threadHtml(t)
    })
  }

  /**
   * The conversation as a timeline: who, when, and Gmail's own preview, oldest
   * first, with inbound and outbound distinguished so the shape of the
   * exchange — who owes whom a reply — is readable at a glance.
   */
  function threadHtml(t) {
    if (t.error) return '<span class="note mon-err">' + esc(t.error) + '</span>'
    if (!t.messages || !t.messages.length) {
      return '<span class="note">No messages found on that thread.</span>'
    }
    var last = t.messages[t.messages.length - 1]
    var head =
      '<div class="mon-thread__head">' +
      '<b>' + esc(t.subject) + '</b>' +
      '<span class="note"> · ' + t.messages.length + ' messages · ' +
      esc(t.participants.join(', ')) + '</span>' +
      (last.outbound
        ? '<span class="mon-chip">last word: you</span>'
        : '<span class="mon-chip mon-chip--wait">awaiting your reply</span>') +
      (t.mock ? '<span class="live-tag">sample</span>' : '') +
      '</div>'

    return head + '<ol class="mon-timeline">' + t.messages
      .map(function (m) {
        return (
          '<li class="mon-msg' + (m.outbound ? ' mon-msg--out' : '') + '">' +
          '<div class="mon-msg__who">' + esc(m.from) +
          '<span class="mon-msg__when">' + esc(timeLabel(m.date, false)) + '</span></div>' +
          '<div class="mon-msg__snippet">' + esc(m.snippet) + '</div>' +
          (m.url
            ? '<a class="mail-link" href="' + esc(m.url) + '" target="_blank" rel="noopener">✉️ Open ↗</a>'
            : '') +
          '</li>'
        )
      })
      .join('') + '</ol>'
  }

  // ---- sync ---------------------------------------------------------------

  function sync(bridge) {
    if (busy) return Promise.resolve()
    busy = true
    if (syncBtn) syncBtn.disabled = true
    setStatus('Syncing…')

    var range = currentRange()
    return Promise.all([
      bridge.fetchMail({
        lookbackHours: range.hours,
        limit: range.limit,
        candidates: range.candidates,
      }),
      bridge.fetchEvents({ days: EVENT_DAYS, limit: EVENT_LIMIT }),
    ])
      .then(function (res) {
        var mail = res[0]
        var events = res[1]
        var mock = mail.mock || events.mock

        var mailItems = mail.items || []
        var eventItems = events.items || []

        // Diff against what the previous sync saw BEFORE recording this one.
        var seen = loadSeen()
        var mailIds = mailItems.map(function (m) { return m.id })
        var eventIds = eventItems.map(function (e) { return e.id })
        var newMail = diffNew(mailIds, seen.mail)
        var newEvents = diffNew(eventIds, seen.events)

        renderMail(mailItems, mail.mock, newMail)
        renderEvents(eventItems, events.mock, newEvents)
        rewirePage()
        lastData = { events: eventItems, mail: mailItems }
        renderMonitor(bridge)
        renderStats(eventItems, mailItems)

        // Only a sync that actually reached both services should redefine the
        // baseline; recording a failed one would swallow the diff.
        if (!mail.error && !events.error) {
          saveSeen(mailIds, eventIds)
          writeStored(LAST_SYNC_KEY, new Date().toISOString())
        }
        renderSyncStamp(newMail, newEvents)

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
      if (rangeSel) rangeSel.disabled = true
      if (customDays) customDays.hidden = true
      return
    }

    SERVICES.forEach(function (svc) {
      chips[svc.key].addEventListener('click', function () {
        setStatus('Opening Google sign-in for ' + svc.label + '…')
        chips[svc.key].disabled = true
        // The click's user activation reaches the same-origin parent, so the
        // consent popup opens there rather than being blocked in this frame.
        // Ask only for this service: the other may already be granted, and a
        // partial grant should be repairable one service at a time. Retrying
        // one that already failed forces the consent screen open — otherwise
        // Google replays the existing partial grant with no UI and the click
        // appears to do nothing.
        var retry = !!svcErrors[svc.key]
        bridge.connect(svc.key, retry).then(function (next) {
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

    rangeSel.addEventListener('change', function () {
      writeStored(RANGE_KEY, rangeSel.value)
      updateRangeUi()
      sync(bridge)
    })
    customDays.addEventListener('change', function () {
      var days = parseInt(customDays.value, 10)
      if (!(days > 0)) days = 14
      days = Math.min(days, MAX_CUSTOM_DAYS)
      customDays.value = days
      writeStored(CUSTOM_DAYS_KEY, String(days))
      if (rangeSel.value === 'custom') sync(bridge)
    })
    updateRangeUi()

    document.addEventListener('click', function (e) {
      var att = e.target.closest('.live-attach')
      if (!att) return
      prefillOwnForm(att.dataset.title || '', att.dataset.mid || '')
    })

    // Own items and the Monitor tab work with or without a connection: they
    // read the punch list, which is local.
    buildOwnForm(bridge)
    buildMonitorTab(bridge)
    applyOwnItems()
    renderMonitor(bridge)
    renderSyncStamp([], [])
    renderStats([], [])
    watchPunchList(bridge)

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
