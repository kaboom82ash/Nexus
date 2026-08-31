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
  var AUTO_SYNC_MS = 60 * 60 * 1000
  var STALE_MS = 10 * 60 * 1000

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
    '.stat-rows{max-width:1180px;margin:14px auto 0}',
    '.stat-toggle{font:inherit;font-size:11px;font-weight:700;letter-spacing:.06em;',
    'text-transform:uppercase;color:var(--muted);background:none;border:none;',
    'padding:2px 0 8px;cursor:pointer;display:flex;align-items:center;gap:6px}',
    '.stat-toggle:hover{color:var(--ink)}',
    '.stat-rows.is-collapsed .stat-body{display:none}',
    '.stat-row{margin:0 0 10px;border:none;background:none;border-radius:0;',
    'gap:10px;overflow:visible}',
    '.stat-row--punch{grid-template-columns:repeat(4,minmax(0,1fr))}',
    '.stat-row--cal{grid-template-columns:repeat(3,minmax(0,1fr)) 1.4fr}',
    '.stat-row--mail{grid-template-columns:repeat(4,minmax(0,1fr))}',
    '@media (max-width:860px){.stat-row--punch,.stat-row--cal,.stat-row--mail{',
    'grid-template-columns:repeat(2,minmax(0,1fr))}}',
    '.stat-rows .stat{border-radius:12px;border:1px solid var(--line);',
    'background:var(--surface);padding:12px 14px}',
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
    '.mon-section{margin-bottom:26px}',

    // Tabs: bigger targets, rounded, with the active one clearly seated.
    '.masthead .tabs{gap:8px;flex-wrap:wrap}',
    '.masthead .tab-btn{font-size:14px;padding:11px 16px;border-radius:12px;',
    'border:1px solid var(--line);background:var(--surface);font-weight:600;',
    'transition:transform .08s ease,border-color .12s ease}',
    '.masthead .tab-btn:hover{border-color:var(--accent);transform:translateY(-1px)}',
    '.masthead .tab-btn[aria-selected="true"]{background:var(--accent);',
    'color:var(--accent-ink);border-color:var(--accent)}',
    '.masthead .tab-btn .count{font-size:11px;padding:1px 7px;border-radius:999px;',
    'background:rgba(0,0,0,.18);margin-left:7px}',

    // Filled tiles need air between them, or two colours meeting edge-to-edge
    // read as one band and the severity boundary disappears.
    '.cat-grid-items{gap:12px}',
    '.cat-row[class*="sev-"]{margin-bottom:12px;border:2px solid var(--surface)}',
    '.cat-grid-items .cat-row[class*="sev-"]{margin-bottom:0}',
    '.card[class*="sev-"]{margin-bottom:14px;border:2px solid var(--surface)}',
    '.punch-row[class*="sev-"]{margin-bottom:10px;border:2px solid var(--surface)}',
    '.mon-tile{border:2px solid var(--surface)}',

    '.glance{margin-top:4px}',
    '.glance__head{font-size:11px;font-weight:700;letter-spacing:.06em;',
    'text-transform:uppercase;color:var(--muted);margin:6px 0 8px}',
    '.glance__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}',
    '.glance__cell{border-radius:12px;padding:11px 13px;border:1px solid var(--line);',
    'background:var(--surface);border-left-width:4px}',
    '.glance--personal{border-left-color:var(--cat-personal)}',
    '.glance--kids{border-left-color:var(--cat-kids)}',
    '.glance--home{border-left-color:var(--cat-home)}',
    '.glance--finance{border-left-color:var(--cat-finance)}',
    '.glance--health{border-left-color:var(--cat-health)}',
    '.glance--lifestyle{border-left-color:var(--cat-lifestyle)}',
    '.glance__cat{font-size:12px;font-weight:700;text-transform:capitalize;margin-bottom:5px}',
    '.glance__nums{display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--muted)}',
    '.glance__nums b{color:var(--ink);font-family:"IBM Plex Mono",monospace;font-size:13px}',

    '.rank-list{border:1px solid var(--line);border-radius:12px;overflow:hidden}',
    '.rank-row{display:flex;align-items:center;gap:12px;padding:10px 14px;',
    'background:var(--surface);border-bottom:1px solid var(--line)}',
    '.rank-row:last-child{border-bottom:none}',
    '.rank-row.sev-critical{border-left:4px solid var(--critical)}',
    '.rank-row.sev-high{border-left:4px solid var(--high)}',
    '.rank-row.sev-medium{border-left:4px solid var(--medium)}',
    '.rank-row.sev-low{border-left:4px solid var(--low)}',
    '.rank-n{color:var(--muted);font-size:12px;flex:0 0 18px}',
    '.rank-days{font-size:16px;font-weight:700;flex:0 0 52px}',
    '.rank-days--soon{color:var(--critical)}',
    '.rank-title{flex:1;font-size:13px}',
    '.rank-when{color:var(--muted);font-size:11.5px}',

    '.close-btn{font:inherit;font-size:11px;line-height:1;padding:2px 8px;margin-left:8px;',
    'border-radius:6px;border:1px solid currentColor;background:rgba(0,0,0,.12);',
    'color:inherit;cursor:pointer}',
    '.close-btn:hover{background:rgba(0,0,0,.25)}',
    // A closed item leaves the working view entirely. It is not deleted — it
    // is a completed punch-list entry, reopenable from the tile there.
    '.is-closed{display:none !important}',
    // Thread shape as the tile's headline: the numbers are the point.
    '.tstats{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0 2px}',
    '.tstat__n{font-size:23px;font-weight:700;line-height:1.05}',
    '.tstat__l{font-size:10px;text-transform:uppercase;letter-spacing:.05em;opacity:.75}',
    '.tstat--warn .tstat__n{text-decoration:underline;text-decoration-thickness:2px}',
    '.tstats__note{font-size:11px;opacity:.8;margin-bottom:4px}',
    '.mon-tile__actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:9px}',
    '.mon-act{font:inherit;font-size:11px;padding:3px 8px;border-radius:7px;',
    'border:1px solid currentColor;background:rgba(0,0,0,.12);color:inherit;cursor:pointer}',
    '.mon-act:hover{background:rgba(0,0,0,.22)}',
    'select.mon-act{padding:3px 6px}',

    '.gd-item{border:1px solid var(--line);border-radius:12px;background:var(--surface);',
    'padding:14px 16px;margin-bottom:14px}',
    '.gd-item__head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;',
    'margin-bottom:10px}',
    '.gd-draft+.gd-draft{margin-top:10px;border-top:1px solid var(--line);padding-top:10px}',
    '.gd-draft__meta{display:flex;align-items:center;gap:8px;font-size:11.5px;',
    'color:var(--muted);margin-bottom:6px}',
    '.gd-item .draft-body{border:1px solid var(--line);border-radius:8px;',
    'background:var(--surface-2);font-size:13px;padding:12px}',

    '.prep-past{display:none !important}',
    '.prep-out{opacity:.4}',
    '.prep-out td{text-decoration:line-through}',
    '.prep-x{font:inherit;font-size:12px;line-height:1;padding:2px 7px;border-radius:6px;',
    'border:1px solid var(--line);background:transparent;color:var(--muted);cursor:pointer}',
    '.prep-x:hover{border-color:var(--critical);color:var(--critical)}',

    '.hrs-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;',
    'margin-bottom:22px}',
    '@media (max-width:760px){.hrs-grid{grid-template-columns:1fr}}',
    '.hrs-card{border:1px solid var(--line);border-radius:12px;background:var(--surface);',
    'padding:14px 16px}',
    '.hrs-card__head{font-size:11px;font-weight:700;letter-spacing:.06em;',
    'text-transform:uppercase;color:var(--muted);margin-bottom:10px}',
    '.hrs-row{display:flex;align-items:center;gap:10px;margin-bottom:7px;font-size:12.5px}',
    '.hrs-name{flex:0 0 34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.hrs-bar{flex:1;height:8px;border-radius:999px;background:var(--surface-2);overflow:hidden}',
    '.hrs-fill{display:block;height:100%;background:var(--accent)}',
    '.hrs-val{flex:0 0 auto;color:var(--muted);font-size:11.5px}',

    '.wk-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;',
    'margin-bottom:22px}',
    '@media (max-width:900px){.wk-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}',
    '@media (max-width:560px){.wk-grid{grid-template-columns:1fr}}',
    '.wk-day{border:1px solid var(--line);border-radius:12px;background:var(--surface);',
    'padding:10px;min-height:96px}',
    '.wk-day--today{border-color:var(--accent)}',
    '.wk-day__head{font-size:11px;font-weight:700;text-transform:uppercase;',
    'letter-spacing:.05em;color:var(--muted);display:flex;justify-content:space-between;',
    'margin-bottom:8px}',
    '.wk-day--today .wk-day__head{color:var(--accent)}',
    '.wk-day__num{font-family:"IBM Plex Mono",monospace}',
    '.wk-day__empty{color:var(--muted);font-size:12px}',
    '.wk-ev{display:block;font-size:11.5px;line-height:1.3;padding:5px 7px;',
    'border-radius:8px;margin-bottom:5px;text-decoration:none;color:#0d1412;',
    'background:var(--cat-personal)}',
    '.wk-ev.cat-kids{background:var(--cat-kids)}',
    '.wk-ev.cat-home{background:var(--cat-home)}',
    '.wk-ev.cat-finance{background:var(--cat-finance)}',
    '.wk-ev.cat-health{background:var(--cat-health)}',
    '.wk-ev.cat-lifestyle{background:var(--cat-lifestyle)}',
    '.wk-ev__t{display:block;font-size:10px;opacity:.75}',

    // Severity as the whole tile, everywhere items are listed — Actions &
    // Inbox, the punch list, the calendar — not just on the Monitor board.
    // Each rule sets its own ink so text keeps contrast on the fill; children
    // inherit it so the page's link and muted tokens do not fight the colour.
    '.cat-row.sev-critical,.punch-row.sev-critical,.card.sev-critical{',
    'background:var(--critical);color:#170a0a;border-color:transparent}',
    '.cat-row.sev-high,.punch-row.sev-high,.card.sev-high{',
    'background:var(--high);color:#1c1305;border-color:transparent}',
    '.cat-row.sev-medium,.punch-row.sev-medium,.card.sev-medium{',
    'background:var(--medium);color:#08131c;border-color:transparent}',
    '.cat-row.sev-low,.punch-row.sev-low,.card.sev-low{',
    'background:var(--low);color:#07160d;border-color:transparent}',
    '.cat-row[class*="sev-"],.punch-row[class*="sev-"],.card[class*="sev-"]{',
    'border-radius:10px}',
    '.cat-row[class*="sev-"] *,.punch-row[class*="sev-"] *,.card[class*="sev-"] *{',
    'color:inherit}',
    // The page colours some titles by severity too; on a filled tile that is
    // the same hue as the ground, so it has to give way.
    '.cat-row[class*="sev-"] .cat-title,.cat-row[class*="sev-"] .cat-meta,',
    '.card[class*="sev-"] .card-title,.punch-row[class*="sev-"] .punch-title{color:inherit}',
    '.cat-row[class*="sev-"] .cat-meta,.card[class*="sev-"] .msg-meta{opacity:.8}',
    '.cat-row[class*="sev-"] .mail-link,.cat-row[class*="sev-"] .cal-btn,',
    '.card[class*="sev-"] .mail-link,.card[class*="sev-"] .cal-btn,',
    '.punch-row[class*="sev-"] .mail-link{color:inherit;text-decoration:underline;',
    'background:transparent;border-color:currentColor}',
    // Pills and chips on a filled tile: outline, not another block of colour.
    '.cat-row[class*="sev-"] .pill,.card[class*="sev-"] .pill,',
    '.punch-row[class*="sev-"] .pill{background:rgba(0,0,0,.14);color:inherit}',
    '.cat-row[class*="sev-"] select,.card[class*="sev-"] select,',
    '.cat-row[class*="sev-"] .qa-btn,.card[class*="sev-"] .qa-btn{',
    'background:rgba(0,0,0,.12);color:inherit;border-color:currentColor}',
    '.cat-row[class*="sev-"] .live-attach{border-color:currentColor;color:inherit}',
    '.cat-row[class*="sev-"] .live-attach:hover{background:rgba(0,0,0,.18)}',
    '.cat-row[class*="sev-"] .new-badge,.card[class*="sev-"] .new-badge{',
    'background:rgba(0,0,0,.2);color:inherit}',
  ].join('')

  function injectStyles() {
    if (document.getElementById('live-bridge-styles')) return
    var style = document.createElement('style')
    style.id = 'live-bridge-styles'
    style.textContent = STYLES
    document.head.appendChild(style)
  }

  /**
   * The page is generated with a weekly masthead, but it now refreshes itself
   * hourly and leads with what landed today — so it is retitled here rather
   * than in the generated file, which a rebuild would overwrite.
   */
  function retitle() {
    var eyebrow = document.querySelector('.masthead .eyebrow')
    if (eyebrow) eyebrow.textContent = 'Daily digest · AK'
    if (/weekly briefing/i.test(document.title)) document.title = 'AK Daily Digest'
  }

  function buildStrip() {
    var masthead = document.querySelector('.masthead')
    var tabs = masthead && masthead.querySelector('.tabs')
    if (!masthead || !tabs) return null
    injectStyles()
    retitle()

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
      // Mail leads its panel; the calendar's live list sits AFTER the prep
      // blocks, the hours dashboard and the week ahead.
      if (spec.id === 'live-calendar') panel.appendChild(section)
      else panel.insertBefore(section, panel.firstChild)
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
    var html = items.map(function (m) { return mailRowHtml(m, mock, fresh) }).join('')
    host.innerHTML = html
    refreshMailSubhead()
    setCount('live-inbox', items.length)
  }

  /** One live message as a row the page's injectCheckables() will adopt. */
  function mailRowHtml(m, mock, fresh) {
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

    // The API id is right here, so offer the reliable way to attach a message
    // to an item — the id in Gmail's own address bar is a different encoding
    // the API cannot resolve.
    var link = '<div class="cat-links"><a class="mail-link" href="' + esc(mailHref(m)) +
      '" target="_blank" rel="noopener">✉️ Open in Gmail ↗</a>' +
      (m.id ? '<button type="button" class="live-attach" data-mid="' + esc(m.id) +
        '" data-title="' + esc(m.subject) + '" title="Start a punch-list item with this email attached">📌 Add to punch list</button>' +
        '<button type="button" class="live-attach live-draft" data-mid="' + esc(m.id) +
        '" data-subject="' + esc(m.subject) + '" data-from="' + esc(m.from) +
        '" data-snippet="' + esc((m.reasons || []).join(', ')) +
        '" title="Draft a reply to this message">✍️ Draft reply</button>' : '') +
      '</div>'

    // No data-cat: the page's own inferCategory() reads the title and always
    // returns one of its known keys, so a live item can never land in a
    // category the punch list refuses to render. And no severity pill inside
    // .cat-title — the punch list takes an entry's title from that element's
    // text, and the pill's label would be glued onto it.
    return '<div class="cat-row sev-' + sev + '" data-sync="' + esc(syncKey('mail', m.id)) + '">' +
      '<div class="cat-main">' +
      '<div class="cat-title">' + esc(m.subject) + '</div>' +
      '<div class="cat-meta">' + sevPill(sev) + ' ' +
      ((fresh || []).indexOf(m.id) !== -1 ? '<span class="new-badge">NEW</span> ' : '') +
      (mock ? '<span class="live-tag">sample</span> ' : '') + meta + '</div>' +
      link +
      '</div></div>'
  }

  function renderEvents(allItems, mock, newIds) {
    var fresh = newIds || []
    // Future only, and inside the stated horizon. The API is asked for exactly
    // this window, but the promise on screen is "the next 14 days" — so it is
    // enforced here rather than trusted to the server's timeMin/timeMax.
    var now = Date.now()
    var horizon = now + EVENT_DAYS * 86400000
    var items = (allItems || []).filter(function (ev) {
      var t = new Date(ev.start).getTime()
      return isFinite(t) && t >= now && t <= horizon
    })
    var host = ensureSection({
      panelId: 'panel-calendar',
      id: 'live-calendar',
      heading: 'Live calendar',
      sub: 'Every event in the next ' + EVENT_DAYS +
        ' days, across every calendar you have switched on · check one to queue it',
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
      applyClosed()
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

  var STATS_OPEN_KEY = 'ak-briefing-stats-open'
  /** Which tab the dashboard is describing. */
  var activeTab = 'punchlist'
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
        renderTopActions(bridge)
      }, 60)
    }).observe(root, { childList: true, subtree: true })
  }

  /**
   * Per-category totals for the week: how much mail relates to it, how many
   * events, and how many hours those events take.
   */
  function glanceHtml(events, mail) {
    var weekEnd = Date.now() + 7 * 86400000
    var cats = {}
    function bucket(c) {
      if (!cats[c]) cats[c] = { emails: 0, events: 0, hours: 0 }
      return cats[c]
    }
    ;(events || []).forEach(function (ev) {
      var t = new Date(ev.start).getTime()
      if (!(t >= Date.now() && t <= weekEnd)) return
      var b = bucket(eventCategory(ev))
      b.events++
      b.hours += hoursOf(ev)
    })
    ;(mail || []).forEach(function (m) {
      bucket(inferMailCategory(m)).emails++
    })

    var keys = Object.keys(cats).sort(function (a, b) {
      return (cats[b].hours + cats[b].emails) - (cats[a].hours + cats[a].emails)
    })
    if (!keys.length) return ''

    return '<div class="glance">' +
      '<div class="glance__head">This week at a glance</div>' +
      '<div class="glance__grid">' +
      keys.map(function (c) {
        var g = cats[c]
        return '<div class="glance__cell glance--' + esc(c) + '">' +
          '<div class="glance__cat">' + esc(c) + '</div>' +
          '<div class="glance__nums">' +
          '<span><b>' + g.emails + '</b> ' + (g.emails === 1 ? 'email' : 'emails') + '</span>' +
          '<span><b>' + g.events + '</b> ' + (g.events === 1 ? 'event' : 'events') + '</span>' +
          '<span><b>' + esc(fmtHours(g.hours)) + '</b></span>' +
          '</div></div>'
      }).join('') +
      '</div></div>'
  }

  /** Mail has no category of the page's kind, so infer one from its subject. */
  function inferMailCategory(m) {
    if (typeof inferCategory === 'function') {
      try {
        return inferCategory(document.createElement('div'), m.subject || '')
      } catch (e) {}
    }
    return 'personal'
  }

  function renderStats(events, mail) {
    var strips = document.querySelector('.masthead .stat-strip')
    if (!strips) return
    var p = punchCounts()

    var upcoming = (events || []).filter(function (ev) {
      return new Date(ev.start).getTime() >= Date.now()
    })
    var meetings = upcoming.filter(isMeeting)
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

    var now = Date.now()
    var last24 = (mail || []).filter(function (m) {
      return new Date(m.date).getTime() >= now - 86400000
    })
    var sinceVisit = (mail || []).filter(function (m) {
      return previousVisit && new Date(m.date).getTime() > previousVisit
    })

    // Only the metrics that describe the tab you are on. A punch-list count
    // beside a calendar you are reading is noise, and the whole strip at once
    // is why it needed collapsing in the first place.
    var rows = ''
    if (activeTab === 'punchlist') {
      rows =
        '<div class="stat-strip stat-row stat-row--punch">' +
        statHtml(p.total, '📋 On punch list') +
        statHtml(p.critical, 'Critical', 'var(--critical)') +
        statHtml(p.high, 'High', 'var(--high)') +
        statHtml(p.medium, 'Medium', 'var(--medium)') +
        '</div>'
    } else if (activeTab === 'calendar') {
      rows =
        '<div class="stat-strip stat-row stat-row--cal">' +
        statHtml(upcoming.length, '📅 Events coming up') +
        statHtml(meetings.length, 'Meetings (routines excluded)') +
        statHtml(fmtHours(weekHours), 'Proposed meeting time, next 7 days') +
        '<div class="stat stat--wide"><div class="l">Time per category, next 7 days</div>' +
        '<div class="stat-cats">' +
        (catBits.length ? catBits.join(' · ') : 'nothing scheduled') +
        '</div></div>' +
        '</div>'
    } else if (activeTab === 'daily' || activeTab === 'actions') {
      rows =
        '<div class="stat-strip stat-row stat-row--punch">' +
        statHtml(sinceVisit.length, '🆕 Since your last visit') +
        statHtml(last24.length, '✉️ New emails, last 24 hours') +
        statHtml((mail || []).length, 'In the current window') +
        statHtml((mail || []).filter(function (m) { return m.unread }).length, 'Unread') +
        '</div>'
    } else if (activeTab === 'drafts') {
      own.drafts = own.drafts || {}
      var threads = Object.keys(own.drafts).filter(function (k) { return own.drafts[k].length })
      var total = threads.reduce(function (n, k) { return n + own.drafts[k].length }, 0)
      rows =
        '<div class="stat-strip stat-row stat-row--punch">' +
        statHtml(threads.length, '✍️ Emails with drafts') +
        statHtml(total, 'Drafts written') +
        statHtml(p.total, '📋 On punch list') +
        statHtml(last24.length, '✉️ New, last 24h') +
        '</div>'
    } else {
      rows =
        '<div class="stat-strip stat-row stat-row--punch">' +
        statHtml(p.total, '📋 On punch list') +
        statHtml(upcoming.length, '📅 Events coming up') +
        statHtml(last24.length, '✉️ New, last 24h') +
        statHtml(sinceVisit.length, '🆕 Since last visit') +
        '</div>'
    }

    var wrap = document.getElementById('stat-rows')
    if (!wrap) {
      wrap = el('div', 'stat-rows')
      wrap.id = 'stat-rows'
      wrap.innerHTML =
        '<button type="button" class="stat-toggle" aria-expanded="true">' +
        '<span class="stat-toggle__caret">▾</span> Dashboard</button>' +
        '<div class="stat-body"></div>'
      strips.parentNode.insertBefore(wrap, strips)
      // The page's own strip is superseded. `hidden` is not enough: the
      // attribute's display:none comes from the UA sheet and loses to the
      // page's `.stat-strip { display: grid }`.
      strips.style.display = 'none'

      var toggle = wrap.querySelector('.stat-toggle')
      toggle.addEventListener('click', function () {
        var open = wrap.classList.toggle('is-collapsed') === false
        toggle.setAttribute('aria-expanded', String(open))
        toggle.querySelector('.stat-toggle__caret').textContent = open ? '▾' : '▸'
        writeStored(STATS_OPEN_KEY, open ? '1' : '0')
        syncScrollPadding()
      })
      if (readStored(STATS_OPEN_KEY, '1') === '0') {
        wrap.classList.add('is-collapsed')
        toggle.setAttribute('aria-expanded', 'false')
        toggle.querySelector('.stat-toggle__caret').textContent = '▸'
      }
    }
    // "At a glance" is the home view's job, so it rides with the summary tab.
    wrap.querySelector('.stat-body').innerHTML =
      rows + (activeTab === 'punchlist' || activeTab === 'vault' ? glanceHtml(events, mail) : '')
    syncScrollPadding()
  }

  // ---- drafts -------------------------------------------------------------

  /**
   * Every generated draft is kept, per message, with the date it was written.
   * A draft is a record of what you were going to say at a point in time, so
   * regenerating adds a version rather than overwriting one.
   */
  function draftsFor(id) {
    own.drafts = own.drafts || {}
    return own.drafts[id] || []
  }

  function addDraft(id, meta, text, mock) {
    own.drafts = own.drafts || {}
    own.drafts[id] = own.drafts[id] || []
    own.drafts[id].unshift({
      text: text,
      mock: !!mock,
      at: new Date().toISOString(),
      subject: meta.subject,
      from: meta.from,
    })
    saveOwn()
  }

  function draftDate(iso) {
    var d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }

  function generateDraft(bridge, meta, btn) {
    var was = btn ? btn.textContent : ''
    if (btn) { btn.disabled = true; btn.textContent = '✍️ Drafting…' }
    return bridge
      .draftReply({ id: meta.id, subject: meta.subject, from: meta.from, snippet: meta.snippet })
      .then(function (res) {
        if (btn) { btn.disabled = false; btn.textContent = was }
        if (res.error || !res.text) {
          setStatus(res.error || 'The model returned nothing', 'warn')
          return
        }
        addDraft(meta.id, meta, res.text, res.mock)
        renderDrafts(bridge)
        if (typeof switchTab === 'function') switchTab('drafts')
      })
  }

  /** A section in the Drafts tab holding every draft written here. */
  function renderDrafts(bridge) {
    var panel = document.getElementById('panel-drafts')
    if (!panel) return
    var host = document.getElementById('gen-drafts')
    if (!host) {
      host = el('section', '')
      host.id = 'gen-drafts'
      panel.insertBefore(host, panel.firstChild)
      host.addEventListener('click', function (e) {
        var copy = e.target.closest('.gd-copy')
        if (copy) {
          copyText(decodeURIComponent(copy.dataset.text))
          copy.textContent = '✓ Copied'
          setTimeout(function () { copy.textContent = '📋 Copy' }, 1800)
          return
        }
        var regen = e.target.closest('.gd-regen')
        if (regen) {
          generateDraft(bridge, {
            id: regen.dataset.id,
            subject: regen.dataset.subject,
            from: regen.dataset.from,
          }, regen)
          return
        }
        var del = e.target.closest('.gd-del')
        if (del && confirm('Delete this draft?')) {
          var list = own.drafts[del.dataset.id] || []
          list.splice(parseInt(del.dataset.idx, 10), 1)
          if (!list.length) delete own.drafts[del.dataset.id]
          saveOwn()
          renderDrafts(bridge)
        }
      })
    }

    own.drafts = own.drafts || {}
    var ids = Object.keys(own.drafts).filter(function (id) {
      return (own.drafts[id] || []).length
    })

    var head =
      '<div class="section-head"><h2>✍️ Your generated drafts</h2>' +
      '<span class="sub">Written from the thread, kept per email with the date each was generated · ' +
      'generate one from any message on Actions &amp; Inbox</span></div>'

    if (!ids.length) {
      host.innerHTML = head +
        '<p class="note">No drafts yet. On Actions &amp; Inbox, press <b>✍️ Draft reply</b> on any message.</p>'
      return
    }

    host.innerHTML = head + ids.map(function (id) {
      var list = own.drafts[id]
      var first = list[0]
      return '<div class="gd-item">' +
        '<div class="gd-item__head">' +
        '<b>' + esc(first.subject || '(no subject)') + '</b>' +
        '<span class="note"> · ' + esc(first.from || '') + ' · ' +
        list.length + ' draft' + (list.length === 1 ? '' : 's') + '</span>' +
        '<a class="mail-link" href="https://mail.google.com/mail/u/0/#all/' + esc(id) +
        '" target="_blank" rel="noopener">✉️ Open ↗</a>' +
        '<button type="button" class="live-btn gd-regen" data-id="' + esc(id) +
        '" data-subject="' + esc(first.subject || '') + '" data-from="' + esc(first.from || '') +
        '">✍️ New version</button>' +
        '</div>' +
        list.map(function (d, i) {
          return '<div class="gd-draft">' +
            '<div class="gd-draft__meta">Generated ' + esc(draftDate(d.at)) +
            (d.mock ? ' <span class="live-tag">sample</span>' : '') +
            '<button type="button" class="qa-btn gd-copy" data-text="' +
            encodeURIComponent(d.text) + '">📋 Copy</button>' +
            '<button type="button" class="qa-btn gd-del" data-id="' + esc(id) +
            '" data-idx="' + i + '">✕</button></div>' +
            '<div class="draft-body">' + esc(d.text) + '</div>' +
            '</div>'
        }).join('') +
        '</div>'
    }).join('')
  }


  // ---- close an item where it appears -------------------------------------

  /**
   * The page's contract is that checking a box QUEUES an item and completion
   * happens on the punch list. That is right for triage, but it means a
   * category row you have already dealt with keeps reappearing every sweep.
   * So each checkable row gets a ✓ that completes it in place — recorded on
   * the punch list, so the decision survives rebuilds and is undoable there.
   */
  function isClosed(id) {
    try {
      var e = STATE.punchlist[id]
      return !!(e && e.done)
    } catch (err) {
      return false
    }
  }

  function closeItem(bridge, id, el) {
    try {
      var entry = STATE.punchlist[id]
      if (!entry) {
        // Never queued: record it as a completed entry so it stays closed.
        var data = (typeof ITEM_DATA === 'object' && ITEM_DATA[id]) || {}
        entry = STATE.punchlist[id] = {
          title: data.title || (el ? el.textContent.trim().slice(0, 80) : 'Item'),
          category: data.category || 'personal',
          severity: data.severity || 'low',
          links: data.links || [],
          done: false,
          doneAt: null,
          addedAt: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          subs: [],
        }
      }
      entry.done = true
      entry.doneAt = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      persistPage()
      if (typeof renderPunchList === 'function') renderPunchList()
      applyClosed()
      renderMonitor(bridge)
      renderStats(lastData.events, lastData.mail)
      renderTopActions(bridge)
    } catch (err) {}
  }

  /** Add the ✓ control to every checkable row, and hide the closed ones. */
  function applyClosed() {
    var rows = document.querySelectorAll('main [data-check-id]')
    Array.prototype.forEach.call(rows, function (row) {
      var id = row.dataset.checkId
      if (!row.querySelector('.close-btn') && !row.classList.contains('no-check')) {
        var btn = el('button', 'close-btn', '✓')
        btn.type = 'button'
        btn.dataset.closeId = id
        btn.title = 'Done — close this and stop it coming back'
        var host = row.querySelector('.cat-links, .qa-strip, .cat-main') || row
        if (row.tagName === 'TR') {
          var td = document.createElement('td')
          td.appendChild(btn)
          row.appendChild(td)
        } else {
          host.appendChild(btn)
        }
      }
      row.classList.toggle('is-closed', isClosed(id))
    })
  }

  // ---- 24/7 tab: today's mail, and what landed since you were last here ----

  var LAST_VISIT_KEY = 'ak-briefing-last-visit'
  /** Read once at boot: the previous visit, before this one overwrites it. */
  var previousVisit = (function () {
    var raw = readStored(LAST_VISIT_KEY, '')
    var t = raw ? new Date(raw).getTime() : 0
    writeStored(LAST_VISIT_KEY, new Date().toISOString())
    return isFinite(t) && t > 0 ? t : 0
  })()

  var dailyPanel = null

  /**
   * Mail gets its own tab. Two sections: what has arrived since you were last
   * here, then the last 24 hours — the first is the one that answers "what did
   * I miss", which a rolling 24-hour window cannot.
   */
  function buildDailyTab(bridge) {
    if (dailyPanel) return
    var main = document.querySelector('main')
    var nav = document.querySelector('.masthead .tabs')
    if (!main || !nav || typeof panels !== 'object' || !panels) return

    dailyPanel = el('div', 'panel')
    dailyPanel.id = 'panel-daily'
    dailyPanel.innerHTML =
      '<section id="mail-since"></section><section id="mail-24h"></section>'
    main.appendChild(dailyPanel)
    panels.daily = dailyPanel

    var btn = el('button', 'tab-btn')
    btn.type = 'button'
    btn.setAttribute('role', 'tab')
    btn.dataset.panel = 'daily'
    btn.setAttribute('aria-selected', 'false')
    btn.innerHTML = '🕐 24/7 <span class="count mono" id="daily-tab-count">0</span>'
    // The page wires its tabs from a NodeList captured at load, so a button
    // added afterwards needs its own handler.
    btn.addEventListener('click', function () {
      if (typeof switchTab === 'function') switchTab('daily')
    })
    nav.insertBefore(btn, nav.children[1] || null)
  }

  function mailSectionHtml(title, sub, items, mock, emptyText) {
    var body = items.length
      ? '<div class="cat-grid-band live-band"><div class="cat-grid-items">' +
        items.map(function (m) { return mailRowHtml(m, mock, []) }).join('') +
        '</div></div>'
      : '<p class="note">' + esc(emptyText) + '</p>'
    return '<div class="section-head"><h2>' + esc(title) + '</h2>' +
      '<span class="sub">' + esc(sub) + '</span></div>' + body
  }

  function renderDaily(items, mock) {
    if (!dailyPanel) return
    var now = Date.now()
    var since = (items || []).filter(function (m) {
      return previousVisit && new Date(m.date).getTime() > previousVisit
    })
    var day = (items || []).filter(function (m) {
      return new Date(m.date).getTime() >= now - 86400000
    })

    var sinceLabel = previousVisit
      ? new Date(previousVisit).toLocaleDateString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric',
        }) + ' · ' + new Date(previousVisit).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit',
        })
      : ''

    document.getElementById('mail-since').innerHTML = mailSectionHtml(
      '🆕 Since your last visit',
      previousVisit ? 'Arrived after ' + sinceLabel : 'First visit on this browser — nothing to compare against yet',
      since, mock,
      previousVisit ? 'Nothing new since you were last here.' : 'Come back and this will show what arrived while you were away.',
    )
    document.getElementById('mail-24h').innerHTML = mailSectionHtml(
      '🕐 Last 24 hours',
      'Everything that landed today, ranked by the dashboard’s priority score · check one to queue it',
      day, mock,
      'Nothing in the last 24 hours.',
    )

    var count = document.getElementById('daily-tab-count')
    if (count) count.textContent = since.length || day.length

    rewirePage()
  }

  // ---- Top actions, ranked by deadline ------------------------------------

  /**
   * Deadline order is not severity order: a Low item due tomorrow outranks a
   * Critical one due in a month, and that is exactly what a "what do I do
   * next" list has to say.
   */
  function renderTopActions(bridge) {
    var punch = document.getElementById('panel-punchlist')
    if (!punch) return
    var host = document.getElementById('top-actions-ranked')
    if (!host) {
      host = el('section', 'mon-section')
      host.id = 'top-actions-ranked'
      punch.insertBefore(host, punch.firstChild)
    }

    var ranked = []
    try {
      Object.keys(STATE.punchlist || {}).forEach(function (id) {
        var e = STATE.punchlist[id]
        if (!e || e.done) return
        var d = deadlineFrom(e.title)
        if (d) ranked.push({ id: id, e: e, d: d })
      })
    } catch (err) {}
    ranked.sort(function (a, b) { return a.d.days - b.d.days })

    var head = '<div class="section-head"><h2>⏱️ Top actions — ranked by deadline</h2>' +
      '<span class="sub">Soonest first, from dates found in each item · severity is shown but does not reorder</span></div>'

    if (!ranked.length) {
      host.innerHTML = head +
        '<p class="note">No dated items on the list. Any item whose text carries a date (“Sep 12”) is ranked here.</p>'
      return
    }

    host.innerHTML = head + '<div class="rank-list">' + ranked.slice(0, 8).map(function (r, i) {
      return '<div class="rank-row sev-' + esc(r.e.severity || 'low') + '">' +
        '<span class="rank-n mono">' + (i + 1) + '</span>' +
        '<span class="rank-days mono' + (r.d.days <= 3 ? ' rank-days--soon' : '') + '">' +
        r.d.days + 'd</span>' +
        '<span class="rank-title">' + esc(r.e.title) + '</span>' +
        '<span class="rank-when mono">' + esc(r.d.label) + '</span>' +
        '</div>'
    }).join('') + '</div>'
  }

  // ---- Calendar tab -------------------------------------------------------

  var CAL_LOOKAHEAD_DAYS = 14

  function dismissedPrep() {
    own.prepOut = own.prepOut || {}
    return own.prepOut
  }

  /**
   * Add a dismiss control to each suggested prep block, and total only what
   * survives. A suggestion you have decided against should stop counting
   * toward the prep time you are being asked to find.
   */
  /**
   * A prep block for a meeting that has already happened is noise, and worse,
   * it inflates the prep time you are being asked to find. The event date is
   * in the row's own text ("Aug 27"), which is the only place it exists.
   */
  function prepIsPast(tr) {
    var d = deadlineFrom(tr.textContent)
    // deadlineFrom returns null for a date already gone, so no date parsed
    // from a row that clearly carries one means it is behind us.
    if (d) return false
    return /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i
      .test(tr.textContent)
  }

  function wirePrepBlocks() {
    var tbody = document.getElementById('prep-tbody')
    if (!tbody) return
    var out = dismissedPrep()

    // Drop elapsed blocks before anything is counted or wired.
    Array.prototype.forEach.call(tbody.rows, function (tr) {
      if (prepIsPast(tr)) tr.classList.add('prep-past')
    })

    Array.prototype.forEach.call(tbody.rows, function (tr) {
      var cb = tr.querySelector('.prep-select')
      if (!cb || tr.classList.contains('prep-past')) return
      var pid = cb.dataset.pid
      tr.dataset.prepId = pid
      if (out[pid]) tr.classList.add('prep-out')

      if (!tr.querySelector('.prep-x')) {
        var td = document.createElement('td')
        var x = el('button', 'prep-x', out[pid] ? '↺' : '✕')
        x.type = 'button'
        x.title = out[pid] ? 'Put this prep block back' : 'Not needed — drop this prep block'
        x.addEventListener('click', function () {
          var now = dismissedPrep()
          if (now[pid]) delete now[pid]
          else {
            now[pid] = true
            // Dropping a block must also un-queue it, or it lingers on the
            // punch list as work you have just decided not to do.
            if (cb.checked) cb.click()
          }
          saveOwn()
          tr.classList.toggle('prep-out', !!now[pid])
          x.textContent = now[pid] ? '↺' : '✕'
          x.title = now[pid] ? 'Put this prep block back' : 'Not needed — drop this prep block'
          renderPrepTotals()
        })
        td.appendChild(x)
        tr.appendChild(td)
      }
      cb.addEventListener('change', renderPrepTotals)
    })

    var head = document.querySelector('#panel-calendar thead tr')
    if (head && !head.dataset.prepX) {
      head.dataset.prepX = '1'
      head.appendChild(document.createElement('th'))
    }
    renderPrepTotals()
  }

  function renderPrepTotals() {
    var tbody = document.getElementById('prep-tbody')
    var note = document.getElementById('prep-selected-note')
    if (!tbody || !note) return
    var out = dismissedPrep()
    var proposed = 0
    var selected = 0
    var kept = 0
    Array.prototype.forEach.call(tbody.rows, function (tr) {
      var cb = tr.querySelector('.prep-select')
      if (!cb || out[tr.dataset.prepId] || tr.classList.contains('prep-past')) return
      var mins = parseInt(cb.dataset.mins, 10) || 0
      proposed += mins
      kept++
      if (cb.checked) selected += mins
    })
    var dropped = Object.keys(out).length
    var past = document.querySelectorAll('#prep-tbody .prep-past').length
    if (!kept) {
      note.innerHTML = '<b>No prep blocks left to schedule</b>' +
        (past ? ' — ' + past + ' were for meetings that have already happened' : '') +
        (dropped ? (past ? ', and ' : ' — ') + dropped + ' dropped' : '') + '.'
      return
    }
    note.innerHTML =
      '<b>Prep suggested: ' + fmtHours(proposed / 60) + ' across ' + kept + ' block' +
      (kept === 1 ? '' : 's') + '</b> · selected ' + fmtHours(selected / 60) +
      (dropped ? ' · ' + dropped + ' dropped' : '') +
      (past ? ' · ' + past + ' already past' : '') +
      ' — all proposed for <b>Monday</b>. Checking a row adds it to the punch list too; ✕ drops one you do not need.'
  }

  // ---- calendar hours dashboard + the week starting today -----------------

  function dayKey(d) {
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }

  /**
   * Replace the page's static week grids. They are written at sweep time, so
   * they show a week that has already partly happened — a calendar view whose
   * first columns are in the past is worse than none.
   */
  function renderCalendar(events) {
    var panel = document.getElementById('panel-calendar')
    if (!panel) return

    // The prep section's subhead names the sweep's Monday, which is in the
    // past by the time this page is being read.
    var prepSub = panel.querySelector('.section-head .sub')
    if (prepSub && /\b\d{1,2}:\d{2}\s*[AP]M\b/i.test(prepSub.textContent)) {
      prepSub.textContent = 'Suggested prep blocks, proposed for Monday · nothing is added to your calendar automatically'
    }

    // Hide the sweep-time week tables once, on first render.
    if (!panel.dataset.weeksHidden) {
      panel.dataset.weeksHidden = '1'
      Array.prototype.forEach.call(panel.querySelectorAll('section'), function (sec) {
        if (sec.querySelector('.week-grid')) sec.style.display = 'none'
      })
    }

    var now = Date.now()
    var horizon = now + CAL_LOOKAHEAD_DAYS * 86400000
    var future = (events || []).filter(function (ev) {
      var t = new Date(ev.start).getTime()
      return t >= now && t <= horizon
    })

    var host = document.getElementById('cal-live')
    if (!host) {
      host = el('section', 'no-check')
      host.id = 'cal-live'
      var prep = panel.querySelector('section')
      if (prep && prep.nextSibling) panel.insertBefore(host, prep.nextSibling)
      else panel.appendChild(host)
    }

    host.innerHTML = hoursDashboardHtml(future) + weekAheadHtml(future)
  }

  function hoursDashboardHtml(events) {
    var weekEnd = Date.now() + 7 * 86400000
    var inWeek = events.filter(function (ev) {
      return new Date(ev.start).getTime() <= weekEnd
    })
    var byCal = {}
    var byCat = {}
    var total = 0
    inWeek.forEach(function (ev) {
      var h = hoursOf(ev)
      total += h
      byCal[ev.calendar || 'Calendar'] = (byCal[ev.calendar || 'Calendar'] || 0) + h
      var c = eventCategory(ev)
      byCat[c] = (byCat[c] || 0) + h
    })

    function bars(map) {
      var keys = Object.keys(map).sort(function (a, b) { return map[b] - map[a] })
      if (!keys.length) return '<div class="note">Nothing scheduled.</div>'
      var max = map[keys[0]] || 1
      return keys.map(function (k) {
        return '<div class="hrs-row">' +
          '<span class="hrs-name">' + esc(k) + '</span>' +
          '<span class="hrs-bar"><span class="hrs-fill" style="width:' +
          Math.round((map[k] / max) * 100) + '%"></span></span>' +
          '<span class="hrs-val mono">' + fmtHours(map[k]) + '</span></div>'
      }).join('')
    }

    return (
      '<div class="section-head"><h2>Hours ahead</h2>' +
      '<span class="sub">Next 7 days · ' + fmtHours(total) + ' scheduled in total</span></div>' +
      '<div class="hrs-grid">' +
      '<div class="hrs-card"><div class="hrs-card__head">Per calendar</div>' + bars(byCal) + '</div>' +
      '<div class="hrs-card"><div class="hrs-card__head">Per category</div>' + bars(byCat) + '</div>' +
      '</div>'
    )
  }

  function weekAheadHtml(events) {
    var days = []
    for (var i = 0; i < 7; i++) {
      var d = new Date()
      d.setDate(d.getDate() + i)
      days.push({ date: d, key: dayKey(d), items: [] })
    }
    var index = {}
    days.forEach(function (d) { index[d.key] = d })
    events.forEach(function (ev) {
      var d = index[dayKey(new Date(ev.start))]
      if (d) d.items.push(ev)
    })

    return (
      '<div class="section-head"><h2>The week ahead</h2>' +
      '<span class="sub">Seven days from today · ' + CAL_LOOKAHEAD_DAYS +
      '-day horizon below</span></div>' +
      '<div class="wk-grid">' +
      days.map(function (d, i) {
        return '<div class="wk-day' + (i === 0 ? ' wk-day--today' : '') + '">' +
          '<div class="wk-day__head">' +
          esc(d.date.toLocaleDateString('en-US', { weekday: 'short' })) +
          '<span class="wk-day__num">' + d.date.getDate() + '</span></div>' +
          (d.items.length
            ? d.items.map(function (ev) {
                return '<a class="wk-ev cat-' + esc(eventCategory(ev)) + '" href="' +
                  esc(eventHref(ev)) + '" target="_blank" rel="noopener">' +
                  '<span class="wk-ev__t mono">' +
                  esc(ev.allDay ? 'all day' : new Date(ev.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })) +
                  '</span>' + esc(ev.title) + '</a>'
              }).join('')
            : '<div class="wk-day__empty">—</div>') +
          '</div>'
      }).join('') +
      '</div>'
    )
  }

  // ---- Monitor tab: filters, thread timelines, history --------------------

  var STATUS_FILTERS = [
    ['', 'Any status'],
    ['waiting', '⏳ Waiting on reply'],
    ['court', '➡️ In their court'],
    ['fwd', '📤 Forwarded'],
    ['remind', '⏰ Reminder set'],
    ['none', '— not set (in my court)'],
  ]
  var STATUS_SET_OPTS = [
    ['court', '➡️ In my court'],
    ['waiting', '⏳ Waiting on reply'],
    ['fwd', '📤 Forwarded'],
    ['remind', '⏰ Reminder set'],
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
    if (monitorPanel) return
    // One working surface, not two. The filters and the severity board go at
    // the TOP of the punch list, above the page's own grouped list, so
    // "what am I waiting on" and "what is on the list" are the same tab.
    var punch = document.getElementById('panel-punchlist')
    var root = document.getElementById('punchlist-root')
    if (!punch || !root) return

    monitorPanel = el('section', 'mon-section')
    monitorPanel.id = 'panel-monitor'
    monitorPanel.innerHTML =
      '<div class="section-head"><h2>🔎 Monitor</h2>' +
      '<span class="sub">Everything you are waiting on — filter, follow the mail behind each item, and work it here</span>' +
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
      '<div class="mon-results"></div>'

    // Above the add-item form and the page's own grouped list.
    var form = document.getElementById('own-form')
    punch.insertBefore(monitorPanel, form || root)

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

    monitorPanel.addEventListener('click', function (e) {
      var toggle = e.target.closest('.mon-thread-toggle')
      if (toggle) { loadThread(bridge, toggle.dataset.id, toggle.dataset.email); return }

      var done = e.target.closest('.mon-done-btn')
      if (done) { setDone(bridge, done.dataset.id, done.dataset.state !== 'done'); return }

      var edit = e.target.closest('.mon-edit')
      if (edit) { editTitle(bridge, edit.dataset.id); return }
    })

    // Status is a select, so it changes on change, not click.
    monitorPanel.addEventListener('change', function (e) {
      var sel = e.target.closest('.mon-status-set')
      if (sel) setItemStatus(bridge, sel.dataset.id, sel.value)
    })

  }

  /** Completion, status and title edits belong on the tile, not elsewhere. */
  function setDone(bridge, id, done) {
    try {
      var e = STATE.punchlist[id]
      if (!e) return
      e.done = !!done
      e.doneAt = done
        ? new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : null
      persistPage()
      if (typeof renderPunchList === 'function') renderPunchList()
      // Completion hides the item wherever it appears, so reopening has to
      // bring it back — without this, closing is a one-way door.
      applyClosed()
      renderMonitor(bridge)
      renderStats(lastData.events, lastData.mail)
      renderTopActions(bridge)
    } catch (err) {}
  }

  function setItemStatus(bridge, id, value) {
    try {
      if (!STATE.status) STATE.status = {}
      if (value) STATE.status[id] = value
      else delete STATE.status[id]
      persistPage()
      if (typeof renderPunchList === 'function') renderPunchList()
      renderMonitor(bridge)
    } catch (err) {}
  }

  function editTitle(bridge, id) {
    try {
      var e = STATE.punchlist[id]
      if (!e) return
      var next = prompt('Edit item', e.title)
      if (next === null) return
      next = next.trim()
      if (!next) return
      e.title = next
      if (own.items[id]) { own.items[id].title = next; saveOwn() }
      persistPage()
      if (typeof renderPunchList === 'function') renderPunchList()
      renderMonitor(bridge)
    } catch (err) {}
  }

  var DEFAULT_STATUS = 'court'

  /** Raw stored status; '' when none has been set. */
  function rawStatus(id) {
    try {
      return (STATE.status && STATE.status[id]) || ''
    } catch (e) {
      return ''
    }
  }

  /**
   * An item with no status set is one nobody else is holding — so it is in
   * your court by default, which is the honest reading and the one that keeps
   * the "waiting on someone" filters meaningful.
   */
  function statusOf(id) {
    return rawStatus(id) || DEFAULT_STATUS
  }

  function matches(id, entry, f) {
    if (f.q && String(entry.title || '').toLowerCase().indexOf(f.q) === -1) return false
    if (f.status === 'none' && rawStatus(id)) return false
    if (f.status && f.status !== 'none' && statusOf(id) !== f.status) return false
    if (f.cat && entry.category !== f.cat) return false
    if (f.sev && entry.severity !== f.sev) return false
    if (f.done === 'open' && entry.done) return false
    if (f.done === 'done' && !entry.done) return false
    return true
  }

  function statusLabel(code) {
    var out = ''
    STATUS_SET_OPTS.forEach(function (p) {
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

  function daysBetween(a, b) {
    return Math.max(0, Math.round((b - a) / 86400000))
  }

  /**
   * Thread shape as numbers, from a loaded timeline: how long it has been
   * running and how long it has been quiet. The gap is the number that
   * actually decides whether something needs chasing.
   */
  function threadStats(t) {
    if (!t || t.error || !t.messages || !t.messages.length) return null
    var first = new Date(t.messages[0].date).getTime()
    var last = new Date(t.messages[t.messages.length - 1].date).getTime()
    var now = Date.now()
    return {
      count: t.messages.length,
      started: first,
      totalDays: daysBetween(first, now),
      quietDays: daysBetween(last, now),
      awaitingYou: !t.messages[t.messages.length - 1].outbound,
    }
  }

  function bigStat(value, label, tone) {
    return '<div class="tstat' + (tone ? ' tstat--' + tone : '') + '">' +
      '<div class="tstat__n mono">' + esc(String(value)) + '</div>' +
      '<div class="tstat__l">' + esc(label) + '</div></div>'
  }

  function threadStatsHtml(stats, deadline) {
    if (!stats) return ''
    return '<div class="tstats">' +
      bigStat(stats.count, stats.count === 1 ? 'message' : 'messages') +
      bigStat(stats.totalDays + 'd', 'thread age') +
      bigStat(stats.quietDays + 'd', 'since last reply', stats.quietDays >= 3 ? 'warn' : '') +
      (deadline ? bigStat(deadline.days + 'd', 'to ' + deadline.label, deadline.days <= 3 ? 'warn' : '') : '') +
      '</div>' +
      '<div class="tstats__note">Started ' +
      esc(new Date(stats.started).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })) +
      ' · ' + (stats.awaitingYou ? 'awaiting your reply' : 'last word was yours') + '</div>'
  }

  /**
   * A date in the item's own text is the only deadline we can know about
   * without inventing one, so surface that rather than guessing.
   */
  var DATE_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i

  function deadlineFrom(text) {
    var m = DATE_RE.exec(String(text || ''))
    if (!m) return null
    var now = new Date()
    var d = new Date(m[1] + ' ' + m[2] + ', ' + now.getFullYear())
    if (isNaN(d.getTime())) return null
    // A date already past this year almost certainly means next year.
    if (d.getTime() < now.getTime() - 30 * 86400000) d.setFullYear(now.getFullYear() + 1)
    var days = Math.round((d.getTime() - now.getTime()) / 86400000)
    if (days < 0 || days > 400) return null
    return { days: days, label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
  }

  /** Where the item came from: its calendar, or the mailbox behind it. */
  function sourceOf(id, e, emailId) {
    if (e.source) return e.source
    var ev = (lastData.events || []).filter(function (x) {
      return syncKey('event', x.id) === id.replace(/^sync-/, '')
    })[0]
    if (ev) return '📅 ' + (ev.calendar || 'Calendar')
    if (emailId) return '✉️ Gmail'
    return own.items[id] ? '✍️ Added by you' : '📄 From the sweep'
  }

  function tileHtml(id, e, bridge) {
    var sev = e.severity || 'low'
    var st = statusOf(id)
    var emailId = emailIdFor(id, e, bridge)
    var linksHtml = (e.links || [])
      .map(function (l) {
        return '<a class="mail-link" href="' + esc(l.href) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>'
      })
      .join(' ')
    var cached = threadCache[emailId]
    var stats = threadStats(cached)
    var deadline = deadlineFrom(e.title)

    return (
      '<div class="mon-tile mon-tile--' + esc(sev) + (e.done ? ' is-done' : '') + '">' +
      '<div class="mon-tile__title">' + esc(e.title) + '</div>' +
      '<div class="mon-tile__meta">' + esc(sourceOf(id, e, emailId)) +
      ' · ' + esc(e.category || 'personal') +
      (e.addedAt ? ' · added ' + esc(e.addedAt) : '') +
      ((e.subs || []).length ? ' · ' + e.subs.length + ' steps' : '') + '</div>' +

      threadStatsHtml(stats, deadline) +

      '<div class="mon-tile__actions">' +
      '<button type="button" class="mon-act mon-done-btn" data-id="' + esc(id) + '" data-state="' +
      (e.done ? 'done' : 'open') + '">' + (e.done ? '↺ Reopen' : '✓ Complete') + '</button>' +
      '<button type="button" class="mon-act mon-edit" data-id="' + esc(id) + '">✏️ Edit</button>' +
      '<select class="mon-act mon-status-set" data-id="' + esc(id) + '" title="Forward status">' +
      STATUS_SET_OPTS.map(function (o) {
        return '<option value="' + o[0] + '"' + (o[0] === st ? ' selected' : '') + '>' + esc(o[1]) + '</option>'
      }).join('') +
      '</select>' +
      (e.done ? '<span class="mon-chip mon-chip--done">done ' + esc(e.doneAt || '') + '</span>' : '') +
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
      // The tile's headline numbers come from the timeline, so they only
      // exist once it has loaded — re-render to bring them in.
      renderMonitor(bridge)
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
        renderDaily(mailItems, mail.mock)
        renderCalendar(eventItems)
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
    if (!autoTimer) return ''
    var mins = Math.round(AUTO_SYNC_MS / 60000)
    return ' · auto ' + (mins % 60 === 0
      ? 'hourly'
      : 'every ' + mins + ' min')
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
      var close = e.target.closest('.close-btn')
      if (close) { closeItem(bridge, close.dataset.closeId, close.closest('[data-check-id]')); return }

      var draft = e.target.closest('.live-draft')
      if (draft) {
        generateDraft(bridge, {
          id: draft.dataset.mid,
          subject: draft.dataset.subject || '',
          from: draft.dataset.from || '',
          snippet: draft.dataset.snippet || '',
        }, draft)
        return
      }
      var att = e.target.closest('.live-attach')
      if (att) prefillOwnForm(att.dataset.title || '', att.dataset.mid || '')
    })

    // Own items and the Monitor tab work with or without a connection: they
    // read the punch list, which is local.
    // Every tab button, the page's own included, retargets the dashboard.
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.tab-btn')
      if (!btn || !btn.dataset.panel) return
      activeTab = btn.dataset.panel
      renderStats(lastData.events, lastData.mail)
    })

    buildDailyTab(bridge)
    buildOwnForm(bridge)
    buildMonitorTab(bridge)
    applyOwnItems()
    renderMonitor(bridge)
    renderSyncStamp([], [])
    renderStats([], [])
    wirePrepBlocks()
    renderCalendar([])
    renderDrafts(bridge)
    renderTopActions(bridge)
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
