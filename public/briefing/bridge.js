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
  // Events are returned oldest-first, so a low limit does not "sample" the
  // window — it truncates it at whatever day the count runs out, and every
  // total derived from it is short. Match the client's own page cap instead.
  var EVENT_LIMIT = 250

  // Once connected the page keeps itself current on its own. Polling pauses
  // while the tab is hidden — a background tab burning Gmail quota every few
  // minutes helps nobody — and catches up when it comes back.
  var AUTO_SYNC_MS = 60 * 60 * 1000
  var STALE_MS = 10 * 60 * 1000

  /** Own punch-list items and thread pins, kept beside the page's own state. */
  var OWN_KEY = 'ak-briefing-own'

  // ---- bridge handshake ---------------------------------------------------

  function getBridge() {
    try {
      // Cross-origin parents throw on property access; treat that as absent.
      var b = window.parent && window.parent !== window
        ? window.parent.__nexusBriefing
        : null
      // A MINIMUM, not an equality. The contract only ever grows — new methods
      // are added, existing ones keep their shape — so pinning the exact
      // version means the next bump silently disconnects this whole file and
      // the page falls back to "open this inside Nexus" with no error anywhere.
      return b && b.version >= 1 ? b : null
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

  // The page's four severities carry all its visual weight, so live items are
  // rated on the same scale rather than introducing a fifth state.
  function mailSeverity(score) {
    if (score >= 10) return 'critical'
    if (score >= 6) return 'high'
    if (score >= 3) return 'medium'
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
  var busy = false
  var autoTimer = null
  var lastSyncAt = 0

  /**
   * Why a service is failing decides what a retry should DO.
   *
   * A refused scope is fixed by asking Google again. An API that is not
   * enabled on the Cloud project is not — consent was already given, the
   * request fails downstream of it, and re-prompting cannot help. Forcing the
   * consent screen for that case is a loop by construction: sign in, still
   * 403, click, sign in again, forever. So config problems never reopen
   * Google; they re-sync and keep saying what to go and fix.
   */
  function errorKind(msg) {
    var text = String(msg || '')
    if (/not enabled|has not been used in project|is disabled|Cloud project/i.test(text)) {
      return 'config'
    }
    if (/not granted|insufficient|scope|not connected|reconnect/i.test(text)) {
      return 'scope'
    }
    return 'other'
  }
  /** Last synced payload, so punch-list-driven re-renders keep their numbers. */
  var lastData = { events: [], mail: [] }
  /** punch-list id -> { threadId, date } for the mail it was made from. */
  var mailMeta = {}

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
    '@media (max-width:860px){.stat-row--punch,.stat-row--cal{',
    'grid-template-columns:repeat(2,minmax(0,1fr))}}',
    '.stat-rows .stat{border-radius:12px;border:1px solid var(--line);',
    'background:var(--surface);padding:12px 14px}',
    '.stat-cats{font-family:"IBM Plex Mono",monospace;font-size:12.5px;',
    'color:var(--ink);margin-top:2px}',
    '.live-select,.live-days{font:inherit;font-size:12px;padding:4px 6px;border-radius:8px;',
    'border:1px solid var(--line);background:var(--surface-2);color:var(--ink)}',
    '.live-days{width:64px}',
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

    // Mail as a card grid, one section per category.
    '.mailcats{display:flex;flex-direction:column;gap:18px}',
    '.mailcat{border:1px solid var(--line);border-radius:14px;overflow:hidden;',
    'background:var(--surface)}',
    '.mailcat__head{display:flex;align-items:center;gap:10px;padding:11px 16px;',
    'border-bottom:1px solid var(--line);background:var(--surface-2)}',
    '.mailcat__icon{font-size:16px;line-height:1}',
    '.mailcat__name{margin:0;font-size:14px;font-weight:700;letter-spacing:.01em}',
    '.mailcat__n{font-family:"IBM Plex Mono",monospace;font-size:12px;padding:1px 9px;',
    'border-radius:999px;background:rgba(127,127,127,.22)}',
    '.mailcat__unread{margin-left:auto;font-size:11.5px;color:var(--accent);font-weight:600}',
    // Each category keeps its colour as a top edge — enough to tell them
    // apart while scrolling, without tinting the mail itself.
    '.mailcat--personal .mailcat__head{box-shadow:inset 0 3px 0 var(--cat-personal)}',
    '.mailcat--kids .mailcat__head{box-shadow:inset 0 3px 0 var(--cat-kids)}',
    '.mailcat--home .mailcat__head{box-shadow:inset 0 3px 0 var(--cat-home)}',
    '.mailcat--finance .mailcat__head{box-shadow:inset 0 3px 0 var(--cat-finance)}',
    '.mailcat--health .mailcat__head{box-shadow:inset 0 3px 0 var(--cat-health)}',
    '.mailcat--lifestyle .mailcat__head{box-shadow:inset 0 3px 0 var(--cat-lifestyle)}',
    '.mailcat__grid{display:grid;gap:10px;padding:14px 16px;',
    'grid-template-columns:repeat(auto-fill,minmax(285px,1fr))}',

    // A card. Severity is a left bar, not a fill: a grid of saturated tiles is
    // a wall of colour, and the colour is there to make ONE card stand out.
    '.cat-row.mail-card{display:block;max-width:none;width:auto;margin:0;',
    'padding:12px 14px 10px;border:1px solid var(--line);border-left:3px solid var(--line);',
    'border-radius:10px;background:var(--surface-2);color:var(--ink);',
    'transition:border-color .12s,transform .12s}',
    '.cat-row.mail-card:hover{transform:translateY(-1px);border-color:var(--accent)}',
    '.cat-row.mail-card.sev-critical{background:var(--surface-2);color:var(--ink);',
    'border-left-color:var(--critical)}',
    '.cat-row.mail-card.sev-high{background:var(--surface-2);color:var(--ink);',
    'border-left-color:var(--high)}',
    '.cat-row.mail-card.sev-medium{background:var(--surface-2);color:var(--ink);',
    'border-left-color:var(--medium)}',
    '.cat-row.mail-card.sev-low{background:var(--surface-2);color:var(--ink);',
    'border-left-color:var(--low)}',
    '.mail-card--unread{background:var(--surface)}',
    '.mail-card__body{display:block}',
    '.mail-card__top{display:flex;align-items:baseline;gap:8px;margin-bottom:5px}',
    '.mail-card__from{flex:1;min-width:0;font-size:11.5px;font-weight:600;',
    'color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mail-card__when{flex:0 0 auto;font-size:10.5px;color:var(--muted)}',
    '.cat-row .mail-card__subj{font-size:14px;font-weight:600;line-height:1.35;',
    'color:var(--ink);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;',
    'overflow:hidden;margin-bottom:8px}',
    '.mail-card__tags{display:flex;align-items:center;gap:6px;margin-bottom:9px;',
    'min-height:16px}',
    '.mail-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);',
    'display:inline-block;flex:0 0 auto}',
    '.mail-card__sev{font-size:9.5px;font-weight:700;text-transform:uppercase;',
    'letter-spacing:.06em;padding:1px 6px;border-radius:4px;color:#0b0f16}',
    '.mail-card__sev--critical{background:var(--critical)}',
    '.mail-card__sev--high{background:var(--high)}',
    '.mail-card__sev--medium{background:var(--medium)}',
    '.mail-card__sev--low{background:var(--low)}',
    // The card's footer is one zone, not two. Our actions and the page's own
    // quick actions are separate elements, and giving each its own bordered
    // strip stacked two rules inside a small card — so only the first carries
    // the rule and the rest flow underneath it.
    '.mail-card .cat-links{display:flex;gap:5px;align-items:center;flex-wrap:wrap;',
    'margin:0;padding-top:9px;border-top:1px solid var(--line)}',
    '.mail-card .qa-strip{display:flex;gap:5px;align-items:center;flex-wrap:wrap;',
    'margin:6px 0 0;padding:0;border:none}',
    '.mail-act,.mail-card .qa-btn,.mail-card .close-btn{padding:3px 8px;font-size:12.5px;',
    'line-height:1.4;text-decoration:none;border-radius:7px;',
    'border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}',
    '.mail-act:hover,.mail-card .qa-btn:hover,.mail-card .close-btn:hover{',
    'border-color:var(--accent);background:var(--accent);color:var(--accent-ink)}',
    '.mail-card .close-btn{margin-left:0}',
    '.mail-card .dismiss-btn{margin-left:0}',
    '.mail-card select{font:inherit;font-size:11.5px;padding:2px 6px;border-radius:7px;',
    'border:1px solid var(--line);background:var(--surface);color:var(--ink);',
    'max-width:120px}',
    // The page puts its checkbox at the top of the row; on a card it belongs
    // beside the sender rather than on a line of its own.
    '.mail-card input[type="checkbox"]{margin:0 0 6px}',
    // The page appends its own .qa-group (calendar/reminder/note/flag +
    // status) as a separate block. On a one-line row it has to sit inline
    // with everything else, or "all buttons in one row" is two.
    // Wide screens get a true single line; narrow ones may wrap, which is
    // the right trade rather than a horizontal scrollbar.

    '.mon-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}',
    '.mon-q{flex:1 1 240px}',
    '.mon-count{color:var(--muted);font-size:12px;margin-bottom:10px;',
    'font-family:"IBM Plex Mono",monospace}',
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

    // One-page items: one line each, severity as the left edge rather than the
    // whole fill — a full-bleed board here would drown the sections under it.
    '.op-items{border:1px solid var(--line);border-radius:12px;overflow:hidden;',
    'margin-bottom:18px}',
    '.op-item{display:flex;align-items:center;gap:14px;padding:9px 14px;',
    'background:var(--surface);border-bottom:1px solid var(--line);',
    'border-left:4px solid var(--line)}',
    '.op-item:last-child{border-bottom:none}',
    '.op-item.sev-critical{border-left-color:var(--critical)}',
    '.op-item.sev-high{border-left-color:var(--high)}',
    '.op-item.sev-medium{border-left-color:var(--medium)}',
    '.op-item.sev-low{border-left-color:var(--low)}',
    '.op-item__due{flex:0 0 52px;font-size:13px;font-weight:700}',
    '.op-item__t{flex:1;min-width:0;font-size:13px;overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap}',
    '.op-item__cat{flex:0 0 auto;font-size:11.5px;color:var(--muted)}',
    '.op-item__st{flex:0 0 auto;font-size:11.5px;color:var(--muted);',
    'min-width:130px;text-align:right}',
    '.op-item__more{padding:10px 14px}',

    // One-page dashboard: each calendar view a disclosure, so all four are
    // reachable without leaving the page.
    '.op-sec{border:1px solid var(--line);border-radius:12px;margin-bottom:10px;',
    'background:var(--surface);overflow:hidden}',
    '.op-sec__head{cursor:pointer;padding:12px 16px;font-size:14px;font-weight:700;',
    'list-style:none;display:flex;align-items:center;gap:8px}',
    '.op-sec__head::-webkit-details-marker{display:none}',
    '.op-sec__head::before{content:"▸";color:var(--muted);font-size:12px}',
    '.op-sec[open] .op-sec__head::before{content:"▾"}',
    '.op-sec__head:hover{background:var(--surface-2)}',
    '.op-sec__body{padding:0 16px 16px;border-top:1px solid var(--line)}',
    '.op-sec__body .section-head{margin-top:14px}',

    // Suggested planning: one line per proposed block, the drive time big
    // enough to read at a glance and the add control always in the same place.
    '.plan-list{border:1px solid var(--line);border-radius:12px;overflow:hidden;',
    'margin-bottom:16px}',
    '.plan-row{display:flex;align-items:center;gap:14px;padding:10px 14px;',
    'background:var(--surface);border-bottom:1px solid var(--line)}',
    '.plan-row:last-child{border-bottom:none}',
    '.plan-when{flex:0 0 92px;font-size:12px;color:var(--muted)}',
    '.plan-drive{flex:0 0 62px;display:flex;align-items:baseline;gap:3px}',
    '.plan-drive b{font-size:26px;font-weight:700;line-height:1}',
    '.plan-drive__u{font-size:10px;text-transform:uppercase;letter-spacing:.05em;',
    'color:var(--muted)}',
    '.plan-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
    '.plan-title{font-size:13px;font-weight:600}',
    '.plan-meta{font-size:11.5px;color:var(--muted);overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap}',
    '.plan-add{flex:0 0 auto;font-size:12px;padding:5px 11px;border-radius:8px;',
    'border:1px solid var(--accent);color:var(--accent);text-decoration:none;',
    'white-space:nowrap}',
    '.plan-add:hover{background:var(--accent);color:var(--accent-ink)}',

    // The inbox section: two windows side by side, each a small board of
    // numbers with the categories under it.
    '.inbox-wins{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));',
    'gap:12px;margin-bottom:16px}',
    '.inbox-win{border:1px solid var(--line);border-radius:12px;padding:12px 14px;',
    'background:var(--surface)}',
    '.inbox-win__head{display:flex;align-items:baseline;justify-content:space-between;',
    'gap:8px;font-size:12px;font-weight:700;text-transform:uppercase;',
    'letter-spacing:.05em;color:var(--muted);margin-bottom:8px}',
    '.inbox-win__src{font-size:10px;font-weight:600;text-transform:none;',
    'letter-spacing:0;opacity:.8}',
    '.inbox-nums{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:10px}',
    '.inbox-cats{display:flex;gap:6px;flex-wrap:wrap}',
    '.inbox-cat{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;',
    'padding:3px 9px;border-radius:999px;border:1px solid var(--line);',
    'background:var(--surface-2)}',
    '.inbox-cat b{font-size:12.5px}',

    '.close-btn{font:inherit;font-size:11px;line-height:1;padding:2px 8px;margin-left:8px;',
    'border-radius:6px;border:1px solid currentColor;background:rgba(0,0,0,.12);',
    'color:inherit;cursor:pointer}',
    '.close-btn:hover{background:rgba(0,0,0,.25)}',
    '.dismiss-btn{margin-left:4px;opacity:.75}',
    '.dismiss-btn:hover{opacity:1}',
    '.mon-close-btn{color:var(--critical)}',
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
    '.hrs-group{border-bottom:1px solid var(--line)}',
    '.hrs-group:last-child{border-bottom:none}',
    '.hrs-group>summary{list-style:none;cursor:pointer}',
    '.hrs-group>summary::-webkit-details-marker{display:none}',
    '.hrs-group>summary:hover .hrs-name{color:var(--accent)}',
    '.hrs-count{flex:0 0 auto;font-size:11px;color:var(--muted);',
    'border:1px solid var(--line);border-radius:999px;padding:0 6px}',
    '.hrs-items{padding:2px 0 8px 8px}',
    '.hrs-item{display:flex;gap:8px;align-items:baseline;font-size:11.5px;',
    'padding:3px 0;text-decoration:none;color:var(--ink)}',
    '.hrs-item:hover{color:var(--accent)}',
    '.hrs-item__d{flex:0 0 96px;color:var(--muted)}',
    '.hrs-item__t{flex:0 0 62px;color:var(--muted)}',
    '.hrs-item__n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.hrs-item__h{flex:0 0 auto;color:var(--muted)}',

    '.key-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));',
    'gap:12px;margin-bottom:22px}',
    '.key-card{border:1px solid var(--line);border-radius:12px;background:var(--surface);',
    'padding:12px 14px;border-top-width:3px}',
    '.key-card--india{border-top-color:var(--cat-finance)}',
    '.key-card--us{border-top-color:var(--medium)}',
    '.key-card--birthday{border-top-color:var(--cat-kids)}',
    '.key-card--evite{border-top-color:var(--cat-personal)}',
    '.key-card__head{display:flex;align-items:center;gap:7px;font-size:12px;',
    'font-weight:700;margin-bottom:9px}',
    '.key-card__icon{font-size:15px}',
    '.key-card__n{margin-left:auto;color:var(--muted);font-size:11px}',
    '.key-row{display:flex;gap:8px;align-items:baseline;padding:4px 0;',
    'text-decoration:none;color:var(--ink);font-size:12px}',
    '.key-row:hover{color:var(--accent)}',
    '.key-row__in{flex:0 0 42px;font-weight:700;color:var(--muted)}',
    '.key-row__in--soon{color:var(--high)}',
    '.key-row__t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.key-row__d{flex:0 0 auto;color:var(--muted);font-size:10.5px}',
    '.key-more{color:var(--muted);font-size:11px;margin-top:5px}',
    '.cal-sel{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));',
    'gap:10px;margin:0 0 20px}',
    '.cal-pick{font:inherit;text-align:left;cursor:pointer;transition:transform .08s ease}',
    '.cal-pick:hover{transform:translateY(-1px)}',
    '.cal-pick.is-on{border-color:var(--accent);background:var(--surface-2)}',
    '.cal-nav{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 18px}',
    '.cal-nav__btn{font:inherit;font-size:13px;font-weight:600;padding:8px 14px;',
    'border-radius:10px;border:1px solid var(--line);background:var(--surface);',
    'color:var(--ink);cursor:pointer}',
    '.cal-nav__btn:hover{border-color:var(--accent)}',
    '.cal-nav__btn.is-on{background:var(--accent);border-color:var(--accent);',
    'color:var(--accent-ink)}',
    '.is-filtered{display:none !important}',

    // Drive time is the one number on a logistics row you actually act on.
    '.logi-drive{display:flex;align-items:baseline;gap:5px;flex-shrink:0;',
    'padding-left:14px}',
    '.logi-drive__n{font-size:30px;font-weight:700;line-height:1;color:var(--accent)}',
    '.logi-drive__u{font-size:13px;font-weight:600;color:var(--accent)}',
    '.logi-drive__l{font-size:10px;text-transform:uppercase;letter-spacing:.06em;',
    'color:var(--muted)}',
    '.logi-empty{padding:14px 16px}',

    '.wk-ev{display:block;font-size:11.5px;line-height:1.3;padding:5px 7px;',
    'border-radius:8px;margin-bottom:5px;text-decoration:none;color:#0d1412;',
    'background:var(--cat-personal)}',
    '.wk-ev.cat-kids{background:var(--cat-kids)}',
    '.wk-ev.cat-home{background:var(--cat-home)}',
    '.wk-ev.cat-finance{background:var(--cat-finance)}',
    '.wk-ev.cat-health{background:var(--cat-health)}',
    '.wk-ev.cat-lifestyle{background:var(--cat-lifestyle)}',
    '.wk-ev__t{display:block;font-size:10px;opacity:.75}',
    '.wk-table{width:100%;table-layout:fixed}',
    '.wk-table th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;',
    'color:var(--muted);padding:8px 6px;text-align:left}',
    '.wk-table th.today{color:var(--accent)}',
    '.wk-table td{vertical-align:top;padding:6px;border-top:1px solid var(--line)}',
    '.wk-table .wg-label{font-size:12px;font-weight:600;white-space:nowrap;width:150px}',
    '.wk-table .wk-ev{margin-bottom:4px}',

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
    // The sweep's date range is a rebuild artefact, not something the reader
    // acts on — and it contradicts a page that refreshes hourly.
    var h1 = document.querySelector('.masthead h1')
    if (h1) h1.style.display = 'none'
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

    // No connect chips here: the app's top bar owns Google connection, and
    // two sets of the same control was the duplication worth removing.
    strip.appendChild(el('span', 'live-label', 'Live data'))
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
  /**
   * The sync button only makes sense once something is connected. The
   * per-service indicators it used to sit beside now live in the app's header,
   * which owns Google connection — this frame reports, it does not connect.
   */
  function renderSyncButton(st) {
    if (!syncBtn) return
    syncBtn.hidden = !st || (!st.mock && !st.gmail && !st.calendar)
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
  /**
   * Mail no longer has a section on Actions & Inbox — it has its own 24/7
   * tab, and the same messages listed in two places meant two sets of
   * checkboxes writing to one punch-list entry.
   */
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
        renderOnePage(lastData.events, lastData.mail)
        renderTopActions()
        refreshTabCounts()
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
      rows +
      (activeTab === 'punchlist' || activeTab === 'vault' || activeTab === 'onepage'
        ? glanceHtml(events, mail)
        : '')
    syncScrollPadding()
  }

  // ---- drafts -------------------------------------------------------------

  /**
   * Every generated draft is kept, per message, with the date it was written.
   * A draft is a record of what you were going to say at a point in time, so
   * regenerating adds a version rather than overwriting one.
   */
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
        if (typeof switchTab === 'function') {
          switchTab('drafts')
          activeTab = 'drafts'
          renderStats(lastData.events, lastData.mail)
        }
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
          if (typeof copyText === 'function') copyText(decodeURIComponent(copy.dataset.text))
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



  // ---- a reply reopens what you closed ------------------------------------

  /**
   * Closing an item says "dealt with" — but a thread is only dealt with until
   * the other side writes back. So a message arriving on a closed item's
   * thread AFTER it was closed reopens it and puts it back in your court:
   * that is precisely the moment it becomes yours again, and leaving it closed
   * would bury the reply you were waiting for.
   *
   * Matching is by thread, not message: the reply is a different message id,
   * so a message-level match could never see it.
   */
  function closedAtOf(entry) {
    if (entry.doneTs) {
      var t = Date.parse(entry.doneTs)
      if (isFinite(t)) return t
    }
    if (entry.doneAt) {
      // Older entries only carry a display date. Read it as end-of-day so a
      // message from earlier the same day does not spuriously reopen it.
      var d = new Date(entry.doneAt)
      if (!isNaN(d.getTime())) return d.getTime() + 86399000
    }
    return 0
  }

  function reopenOnReply(bridge, mailItems) {
    if (!mailItems || !mailItems.length) return []
    var reopened = []
    try {
      // Newest arrival per thread is all that matters.
      var newest = {}
      mailItems.forEach(function (m) {
        if (!m.threadId) return
        var t = new Date(m.date).getTime()
        if (!isFinite(t)) return
        if (!newest[m.threadId] || t > newest[m.threadId].t) {
          newest[m.threadId] = { t: t, m: m }
        }
      })

      Object.keys(STATE.punchlist || {}).forEach(function (id) {
        var e = STATE.punchlist[id]
        if (!e || !e.done || !e.threadId) return
        var hit = newest[e.threadId]
        if (!hit || hit.t <= closedAtOf(e)) return

        e.done = false
        e.doneAt = null
        e.doneTs = null
        e.reopenedAt = new Date(hit.t).toISOString()
        // Back in your court: a reply is waiting on you, not on them.
        if (!STATE.status) STATE.status = {}
        STATE.status[id] = 'court'
        reopened.push({ id: id, title: e.title, from: hit.m.from })
      })

      if (reopened.length) {
        persistPage()
        if (typeof renderPunchList === 'function') renderPunchList()
        applyClosed()
      }
    } catch (err) {}
    return reopened
  }

  /** Remember which thread a live row came from, so closing can record it. */
  function indexMail(items) {
    ;(items || []).forEach(function (m) {
      if (!m.id) return
      mailMeta['sync-' + syncKey('mail', m.id)] = {
        threadId: m.threadId || '',
        date: m.date,
      }
    })
  }


  /**
   * Tab counts have to mean something specific or they are just decoration.
   *  - Punch List: how many are open AND in your court. Not the whole list —
   *    the number you want on a tab is "how many need me", and items parked
   *    with someone else are precisely the ones that do not.
   *  - Actions & Inbox: the rows actually visible on it, so closing an item
   *    moves the count. It was counting every item the page had ever seen.
   *  - 24/7: what has arrived since your last visit, else today's.
   */
  function refreshTabCounts() {
    try {
      var mine = 0
      Object.keys(STATE.punchlist || {}).forEach(function (id) {
        var e = STATE.punchlist[id]
        if (!e || e.done) return
        if (statusOf(id) === 'court') mine++
      })
      var punchCount = document.getElementById('punch-tab-count')
      if (punchCount) punchCount.textContent = mine
      var btn = document.querySelector('.tab-btn[data-panel="punchlist"]')
      if (btn) btn.title = mine + ' open and in your court'
    } catch (e) {}

    // Calendar: upcoming events inside the horizon, after the filter.
    var calBtn = document.querySelector('.tab-btn[data-panel="calendar"] .count')
    if (calBtn) {
      var horizon = Date.now() + EVENT_DAYS * 86400000
      calBtn.textContent = (lastData.events || []).filter(function (ev) {
        var t = new Date(ev.start).getTime()
        return isFinite(t) && t >= Date.now() && t <= horizon && eventPasses(ev)
      }).length
    }

    // Drafts: the page's own, plus every one generated here.
    var draftBtn = document.querySelector('.tab-btn[data-panel="drafts"] .count')
    if (draftBtn) {
      own.drafts = own.drafts || {}
      var generated = Object.keys(own.drafts).filter(function (k) {
        return (own.drafts[k] || []).length
      }).length
      var staticDrafts = document.querySelectorAll('#panel-drafts .draft-body').length
      var mine = document.querySelectorAll('#gen-drafts .draft-body').length
      draftBtn.textContent = Math.max(0, staticDrafts - mine) + generated
    }

    var actions = document.getElementById('inbox-tab-count')
    if (actions) {
      var visible = 0
      Array.prototype.forEach.call(
        document.querySelectorAll('#panel-actions .cat-row, #panel-actions .card'),
        function (row) {
          if (row.classList.contains('is-closed')) return
          if (row.classList.contains('is-filtered')) return
          if (row.style.display === 'none') return
          // A hidden ANCESTOR SECTION still means hidden, but the panel
          // itself is display:none whenever another tab is open — so check
          // sections, never the panel.
          var sec = row.closest('section')
          if (sec && sec.style.display === 'none') return
          visible++
        },
      )
      actions.textContent = visible
    }
  }



  /**
   * Mark a message read in the real mailbox.
   *
   * The unread flag is not ours — it lives in Gmail, and every count on this
   * page derives from it — so this writes there first and only then updates
   * what is on screen. Failing halfway would otherwise leave the page saying
   * "read" about a message that is still bold in the inbox.
   */
  function markRead(bridge, id, btn) {
    if (!id || !bridge.markRead) return
    btn.disabled = true
    var was = btn.textContent
    btn.textContent = '…'
    bridge
      .markRead([id])
      .then(function (res) {
        if (!res || !res.ok) {
          btn.disabled = false
          btn.textContent = was
          setStatus((res && res.error) || 'Could not mark that read', 'warn')
          return
        }
        ;(lastData.mail || []).forEach(function (m) {
          if (m.id === id) m.unread = false
        })
        renderDaily(lastData.mail, false, [])
        renderInbox(lastData.mail)
        renderStats(lastData.events, lastData.mail)
        refreshTabCounts()
        setStatus(res.mock ? 'Sample data — nothing was changed in Gmail' : 'Marked read in Gmail',
          res.mock ? 'mock' : 'ok')
      })
      .catch(function (err) {
        btn.disabled = false
        btn.textContent = was
        setStatus((err && err.message) || 'Could not mark that read', 'warn')
      })
  }

  // ---- automatic drafts ---------------------------------------------------

  /**
   * Draft replies for mail that has just arrived and looks like it wants one.
   *
   * Not everything does: a receipt, a newsletter or a promotion needs no
   * reply, and drafting for them would spend an API call per message and bury
   * the drafts that matter. So this is limited to inbound, unread, non-bulk
   * mail, capped per sync — the rest stays available on demand via ✍️.
   */
  var AUTO_DRAFT_MAX = 3
  var NO_REPLY_RE = /\b(no-?reply|do-?not-?reply|newsletter|unsubscribe|receipt|invoice|statement|shipped|delivered|verification code|otp|one-time)\b/i

  function wantsReply(m) {
    if (!m.unread) return false
    if (m.category === 'promotions' || m.category === 'social') return false
    if (NO_REPLY_RE.test(String(m.subject || '') + ' ' + String(m.from || ''))) return false
    // Bulk mail is scored down by the dashboard's own heuristic; reuse it
    // rather than inventing a second definition of "worth replying to".
    return (m.reasons || []).indexOf('Bulk mail') === -1
  }

  function autoDraft(bridge, mailItems, newIds) {
    if (!newIds || !newIds.length) return
    own.drafts = own.drafts || {}
    var queue = (mailItems || []).filter(function (m) {
      if (newIds.indexOf(m.id) === -1) return false
      if ((own.drafts[m.id] || []).length) return false   // already drafted
      return wantsReply(m)
    }).slice(0, AUTO_DRAFT_MAX)
    if (!queue.length) return

    setStatus('Drafting ' + queue.length + ' repl' + (queue.length === 1 ? 'y' : 'ies') + '…')
    // Sequential: each draft reads its thread, and firing them together would
    // burst the same Gmail rate limit the sync already works around.
    var i = 0
    function next() {
      if (i >= queue.length) {
        renderDrafts(bridge)
        refreshTabCounts()
        return
      }
      var m = queue[i++]
      bridge
        .draftReply({ id: m.id, subject: m.subject, from: m.from })
        .then(function (res) {
          if (res && res.text && !res.error) addDraft(m.id, m, res.text, res.mock)
        })
        .catch(function () {})
        .then(next)
    }
    next()
  }

  // ---- global category filter --------------------------------------------

  /**
   * One filter across every tab, driven from the app's top bar. "Critical" is
   * a severity rather than a category, but it belongs in the same control:
   * from the reader's side both answer "show me only this slice", and keeping
   * them apart would mean two filters that have to be reasoned about together.
   */
  var FILTER_KEY = 'ak-digest-filters'
  /**
   * Empty means everything, which is now the only state there is: the category
   * chips that drove this are gone from the top of the app. A selection left
   * in storage from before would hide most of the page with no control on
   * screen to explain it or undo it, so any stored one is cleared here rather
   * than adopted.
   */
  var activeFilters = (function () {
    try {
      localStorage.removeItem(FILTER_KEY)
    } catch (e) {}
    return []
  })()

  function filtersOn() {
    return activeFilters.length > 0
  }

  function matchesFilter(category, severity) {
    if (!filtersOn()) return true
    if (activeFilters.indexOf('critical') !== -1 && severity === 'critical') return true
    return activeFilters.indexOf(category) !== -1
  }

  /** Punch-list entries the filter admits. */
  function entryPasses(e) {
    return matchesFilter(e.category, e.severity)
  }

  function eventPasses(ev) {
    return matchesFilter(eventCategory(ev), '')
  }

  function mailPasses(m) {
    return matchesFilter(inferMailCategory(m), mailSeverity(m.score))
  }

  function setFilters(next) {
    activeFilters = Array.isArray(next) ? next.slice() : []
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(activeFilters))
    } catch (e) {}
    redrawAll()
  }

  /** Re-render everything the filter touches, from the last synced payload. */
  function redrawAll() {
    var bridge = getBridge()
    try {
      renderDaily(lastData.mail, false, [])
      renderCalendar(lastData.events)
      renderOnePage(lastData.events, lastData.mail)
      if (bridge) renderMonitor(bridge)
      renderStats(lastData.events, lastData.mail)
      applyFilterToStaticRows()
      refreshTabCounts()
    } catch (e) {}
  }

  /**
   * The sweep-written category rows are not ours to re-render, so they are
   * shown or hidden in place. `data-cat` is the page's own category marker.
   */
  function applyFilterToStaticRows() {
    var rows = document.querySelectorAll('main .cat-row, main .card')
    Array.prototype.forEach.call(rows, function (row) {
      if (row.classList.contains('mail-card')) return   // ours; already filtered
      var cat = row.dataset.cat || ''
      if (!cat && typeof inferCategory === 'function') {
        var t = row.querySelector('.cat-title, .card-title')
        try {
          cat = inferCategory(row, t ? t.textContent : '')
        } catch (e) {
          cat = ''
        }
      }
      var sev = 'low'
      ;['critical', 'high', 'medium', 'low'].some(function (x) {
        if (row.classList.contains('sev-' + x)) { sev = x; return true }
        return false
      })
      row.classList.toggle('is-filtered', !matchesFilter(cat, sev))
    })
  }

  /**
   * The API the app's top bar drives. Same-origin, so the parent calls these
   * directly rather than posting messages — one less protocol to keep in step.
   */
  /**
   * The tab row, as data. The app's top bar draws it, so it needs the labels
   * and counts that the in-frame buttons carry — reading them off the buttons
   * themselves keeps one source of truth, including for tabs the sweep writes
   * that this file has never heard of.
   */
  /**
   * Which tab is showing, read off the panels rather than the buttons.
   *
   * The page sets aria-selected from a NodeList it captured at load, so the
   * tabs added here — 24/7, One page — never get it, and asking the buttons
   * would report no selection at all on the tab we now open on.
   */
  function activePanelKey() {
    try {
      var keys = Object.keys(panels || {})
      for (var i = 0; i < keys.length; i++) {
        var node = panels[keys[i]]
        if (node && getComputedStyle(node).display !== 'none') return keys[i]
      }
    } catch (e) {}
    return activeTab
  }

  function tabList() {
    var out = []
    var live = activePanelKey()
    Array.prototype.forEach.call(document.querySelectorAll('.tab-btn'), function (btn) {
      var key = btn.dataset.panel
      if (!key) return
      var count = btn.querySelector('.count')
      out.push({
        key: key,
        label: btn.textContent.replace(count ? count.textContent : '', '').trim(),
        count: count ? count.textContent.trim() : '',
        active: key === live,
        title: btn.title || '',
      })
    })
    return out
  }

  function selectTab(key) {
    if (typeof switchTab !== 'function') return
    switchTab(key)
    activeTab = key
    // The masthead is sticky and the scroll position survives the switch, so
    // arriving on a new tab part-way down it — with its first rows behind the
    // masthead — is the default unless this is done.
    toTop()
    renderStats(lastData.events, lastData.mail)
  }

  function toTop() {
    try {
      window.scrollTo(0, 0)
      if (window.parent && window.parent !== window) window.parent.scrollTo(0, 0)
    } catch (e) {}
  }

  /**
   * With the app drawing the tabs, the in-frame row is a second copy of the
   * same control — and two rows that can disagree is worse than either.
   */
  function hideOwnTabs() {
    try {
      if (!window.parent || window.parent === window) return
    } catch (e) {
      return
    }
    var nav = document.querySelector('.masthead .tabs')
    if (nav) nav.style.display = 'none'
  }

  function publishDigestApi() {
    window.__nexusDigest = {
      // 2: adds tabs()/selectTab().
      version: 2,
      setFilters: setFilters,
      getFilters: function () { return activeFilters.slice() },
      categoryCounts: categoryCounts,
      tabs: tabList,
      selectTab: selectTab,
      sync: function () {
        var bridge = getBridge()
        if (bridge) sync(bridge)
      },
      status: function () {
        return {
          lastSync: readStored(LAST_SYNC_KEY, ''),
          counts: categoryCounts(),
        }
      },
    }
    try {
      if (window.parent && window.parent !== window) {
        window.parent.dispatchEvent(new Event('nexus:digest-ready'))
      }
    } catch (e) {}
  }

  /**
   * Per-category totals for the top bar's chips.
   *
   * Counts everything the filter governs — open punch-list items, mail in the
   * current window, and upcoming events — not just the punch list. A chip
   * reading 0 beside a screen full of that category's email is a number that
   * contradicts what you are looking at.
   */
  function categoryCounts() {
    var out = { all: 0, critical: 0 }
    CATEGORY_OPTS.forEach(function (p) { out[p[0]] = 0 })
    function add(cat, sev) {
      out.all++
      if (sev === 'critical') out.critical++
      if (out[cat] !== undefined) out[cat]++
    }
    try {
      Object.keys(STATE.punchlist || {}).forEach(function (id) {
        var e = STATE.punchlist[id]
        if (e && !e.done) add(e.category, e.severity)
      })
    } catch (e) {}
    ;(lastData.mail || []).forEach(function (m) {
      add(inferMailCategory(m), mailSeverity(m.score))
    })
    var horizon = Date.now() + EVENT_DAYS * 86400000
    ;(lastData.events || []).forEach(function (ev) {
      var t = new Date(ev.start).getTime()
      if (isFinite(t) && t >= Date.now() && t <= horizon) add(eventCategory(ev), '')
    })
    return out
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

  /**
   * Closed is not completed. "I did this" and "this never needed doing" both
   * take the item off the list, but only one of them is an accomplishment —
   * and when you come back to a closed item, which of the two it was is the
   * whole question. Both set `done`, since that is what every count and every
   * renderer already reads; `dismissed` records which door it went out of.
   */
  function isDismissed(id) {
    try {
      var e = STATE.punchlist[id]
      return !!(e && e.done && e.dismissed)
    } catch (err) {
      return false
    }
  }

  function closeItem(bridge, id, el, dismissed) {
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
      entry.dismissed = !!dismissed
      entry.doneAt = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      entry.doneTs = new Date().toISOString()
      // Record the conversation so a later reply can find its way back here.
      var meta = mailMeta[id]
      if (meta && meta.threadId) entry.threadId = meta.threadId
      persistPage()
      if (typeof renderPunchList === 'function') renderPunchList()
      applyClosed()
      renderMonitor(bridge)
      renderStats(lastData.events, lastData.mail)
      renderTopActions()
      refreshTabCounts()
    } catch (err) {}
  }

  /**
   * `injectCheckables` only adopts rows that carry a link — that is how the
   * page tells an actionable item from prose. But "not applicable" applies to
   * anything on screen, so closing is offered on every category row and card,
   * linked or not. Unlinked ones get an id derived from their own text.
   */
  function closableId(node) {
    if (node.dataset.checkId) return node.dataset.checkId
    if (node.dataset.closeKey) return node.dataset.closeKey
    var t = node.querySelector('.cat-title, .card-title')
    var text = (t ? t.textContent : node.textContent).trim()
    var id = syncKey('item', text.slice(0, 60))
    node.dataset.closeKey = id
    return id
  }

  function applyClosed() {
    var rows = document.querySelectorAll(
      'main .cat-row, main .card, main [data-check-id]',
    )
    Array.prototype.forEach.call(rows, function (row) {
      if (row.classList.contains('no-check')) return
      var id = closableId(row)
      if (!row.querySelector('.close-btn')) {
        var btn = el('button', 'close-btn', '✓')
        btn.type = 'button'
        btn.dataset.closeId = id
        btn.title = 'Done — take this off the list'
        // Two doors, because they mean different things when you come back:
        // ✓ is "I did it", ✕ is "this never needed doing".
        var x = el('button', 'close-btn dismiss-btn', '✕')
        x.type = 'button'
        x.dataset.closeId = id
        x.title = 'Not needed — close this without marking it done'
        var host = row.querySelector('.cat-links, .qa-strip, .cat-main') || row
        if (row.tagName === 'TR') {
          var td = document.createElement('td')
          td.appendChild(btn)
          td.appendChild(x)
          row.appendChild(td)
        } else {
          host.appendChild(btn)
          host.appendChild(x)
        }
      }
      row.classList.toggle('is-closed', isClosed(id))
    })
  }

  // ---- 24/7 tab: today's mail, and what landed since you were last here ----

  var LAST_VISIT_KEY = 'ak-briefing-last-visit'
  var LAST_SEEN_KEY = 'ak-briefing-last-seen'
  /** A gap this long means you went away and came back. */
  var SESSION_GAP_MS = 2 * 60 * 60 * 1000

  /**
   * When "last login" was.
   *
   * This used to be "the previous page load", stamped forward on every boot —
   * which meant that reloading the page, or the app remounting the frame,
   * silently redefined your last visit as a few seconds ago and emptied the
   * section that answers "what did I miss". It has to be a SESSION, not a
   * load: the stamp only moves when you have actually been away, and every
   * load in between keeps pointing at the same moment.
   */
  var previousVisit = (function () {
    var stamp = function (raw) {
      var t = raw ? new Date(raw).getTime() : 0
      return isFinite(t) && t > 0 ? t : 0
    }
    var visit = stamp(readStored(LAST_VISIT_KEY, ''))
    var seen = stamp(readStored(LAST_SEEN_KEY, ''))
    var now = Date.now()

    // A fresh browser: nothing to compare against, and nothing to claim.
    if (!seen) {
      writeStored(LAST_VISIT_KEY, new Date(now).toISOString())
      writeStored(LAST_SEEN_KEY, new Date(now).toISOString())
      return visit
    }

    writeStored(LAST_SEEN_KEY, new Date(now).toISOString())
    if (now - seen > SESSION_GAP_MS) {
      // Back after a real absence: the last moment you were here becomes the
      // mark, and everything since it is what you missed.
      writeStored(LAST_VISIT_KEY, new Date(seen).toISOString())
      return seen
    }
    // Same sitting — a reload, a remount, a tab switch. Keep the mark put.
    return visit
  })()

  /**
   * Live mail is rendered into the sweep's own "Inbox & tasks by category"
   * panel rather than a tab of its own. Two tabs both listing the same
   * messages meant two sets of checkboxes writing to one punch-list entry, and
   * the question each answered — "what came in" — was the same question.
   */
  function mailHost() {
    var panel = document.getElementById('panel-actions')
    if (!panel) return null
    var host = document.getElementById('mail-by-cat')
    if (!host) {
      // NOT `no-check`: that class tells the page's injectCheckables() to skip
      // a subtree, which is right for the calendar host and exactly wrong
      // here — it is what puts the tick box on a message that queues it to the
      // punch list.
      host = el('section', '')
      host.id = 'mail-by-cat'
      panel.insertBefore(host, panel.firstChild)
    }
    return host
  }

  var CATEGORY_META = {
    personal: { icon: '📧', label: 'Personal & career' },
    kids: { icon: '🧒', label: 'Kids' },
    home: { icon: '🏠', label: 'Home' },
    finance: { icon: '💰', label: 'Finance' },
    health: { icon: '🏥', label: 'Health' },
    lifestyle: { icon: '🎡', label: 'Lifestyle' },
  }

  /**
   * Mail grouped into the page's own category bands, so a run of messages
   * reads as areas of your life rather than one undifferentiated list.
   */
  function categoryBandsHtml(items, mock, fresh) {
    var groups = {}
    items.forEach(function (m) {
      var c = inferMailCategory(m)
      ;(groups[c] = groups[c] || []).push(m)
    })
    var keys = Object.keys(groups).sort(function (a, b) {
      return groups[b].length - groups[a].length
    })
    return '<div class="mailcats">' + keys.map(function (c) {
      var meta = CATEGORY_META[c] || { icon: '📧', label: c }
      var list = groups[c]
      var unread = list.filter(function (m) { return m.unread }).length
      return '<section class="mailcat mailcat--' + esc(c) + '">' +
        '<header class="mailcat__head">' +
        '<span class="mailcat__icon">' + meta.icon + '</span>' +
        '<h3 class="mailcat__name">' + esc(meta.label) + '</h3>' +
        '<span class="mailcat__n">' + list.length + '</span>' +
        (unread ? '<span class="mailcat__unread">' + unread + ' unread</span>' : '') +
        '</header>' +
        '<div class="mailcat__grid">' +
        list.map(function (m) { return mailCardHtml(m, mock, fresh) }).join('') +
        '</div></section>'
    }).join('') + '</div>'
  }

  /**
   * One message as a card.
   *
   * The subject is the only part anyone reads first, so it gets the size and
   * two lines to use; who and when sit above it in the muted register they
   * belong to; the actions sit on their own row so they never compete with the
   * subject for width, as they did when this was a single line. Severity is a
   * bar down the left rather than a fill: a grid of saturated tiles is a wall
   * of colour, and the point of the colour is to let one card stand out.
   */
  function mailCardHtml(m, mock, fresh) {
    var sev = mailSeverity(m.score)
    var when = new Date(m.date)
    var received = isNaN(when.getTime())
      ? ''
      : when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' · ' +
        when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    var isNew = (fresh || []).indexOf(m.id) !== -1

    return '<article class="cat-row mail-card sev-' + sev +
      (m.unread ? ' mail-card--unread' : '') + '" data-sync="' +
      esc(syncKey('mail', m.id)) + '">' +
      '<div class="cat-main mail-card__body">' +
      '<div class="mail-card__top">' +
      '<span class="mail-card__from">' + esc(m.from) + '</span>' +
      '<span class="mail-card__when mono">' + esc(received) + '</span>' +
      '</div>' +
      '<div class="cat-title mail-card__subj">' + esc(m.subject) + '</div>' +
      '<div class="mail-card__tags">' +
      (m.unread ? '<span class="mail-dot" title="Unread"></span>' : '') +
      (isNew ? '<span class="new-badge">NEW</span>' : '') +
      (mock ? '<span class="live-tag">sample</span>' : '') +
      '<span class="mail-card__sev mail-card__sev--' + sev + '">' + sev + '</span>' +
      '</div>' +
      '<div class="cat-links mail-card__acts">' +
      '<a class="mail-link mail-act" href="' + esc(mailHref(m)) +
      '" target="_blank" rel="noopener" title="Open in Gmail">✉️</a>' +
      (m.id
        ? '<button type="button" class="live-attach mail-act" data-mid="' + esc(m.id) +
          '" data-title="' + esc(m.subject) + '" title="Start a punch-list item with this email attached">📌</button>' +
          '<button type="button" class="live-attach live-draft mail-act" data-mid="' + esc(m.id) +
          '" data-subject="' + esc(m.subject) + '" data-from="' + esc(m.from) +
          '" data-snippet="' + esc((m.reasons || []).join(', ')) +
          '" title="Draft a reply to this message">✍️</button>'
        : '') +
      (m.id && m.unread
        ? '<button type="button" class="live-attach live-read mail-act" data-mid="' + esc(m.id) +
          '" title="Mark this read in Gmail">📖</button>'
        : '') +
      '</div></div></article>'
  }

  /**
   * Every message in the current window, grouped by category, newest first.
   * One list rather than the old "since your last visit" / "last 24 hours"
   * split: those were two views of the same mail, and a message could only be
   * checked off in one of them.
   */
  function mailByCategoryHtml(items, mock, newIds) {
    var pool = (items || []).filter(mailPasses).slice()
    pool.sort(function (a, b) { return b.date.localeCompare(a.date) })
    var fresh = newIds || []
    var fresh24 = pool.filter(function (m) {
      return new Date(m.date).getTime() >= Date.now() - 86400000
    }).length

    return '<div class="section-head"><h2>✉️ Emails by category</h2>' +
      '<span class="sub">' +
      (pool.length
        ? pool.length + ' in the current window · ' + fresh24 + ' in the last 24 hours · ' +
          'check one to queue it, ✓ done, ✕ not needed, 📖 read'
        : 'Nothing in the current window') +
      '</span></div>' +
      (pool.length
        ? categoryBandsHtml(pool, mock, fresh)
        : '<p class="note">No mail in this window. Widen it with "Actions from", or press Sync now.</p>')
  }

  function renderDaily(items, mock, newIds) {
    var host = mailHost()
    if (host) host.innerHTML = mailByCategoryHtml(items, mock, newIds)
    renderInbox(items)
    rewirePage()
  }


  // ---- the inbox section: what arrived, and how much of it ----------------

  /**
   * Two windows, because they answer different questions: 24 hours is "what
   * landed while I was away", 7 days is "is this week heavier than usual".
   */
  var INBOX_WINDOWS = [
    { key: 'h24', hours: 24, label: 'Last 24 hours' },
    { key: 'd7', hours: 24 * 7, label: 'Last 7 days' },
  ]

  /**
   * Totals counted by Gmail itself, per window.
   *
   * The page holds a RANKED SAMPLE of mail — twenty or so messages scored out
   * of a wider candidate pool — so counting arrivals from it would report the
   * size of the sample, not of the inbox. Gmail can answer "how many, how many
   * unread" for a search in two cheap requests, so the totals come from there
   * and only the breakdowns, which need per-message data, come from the sample.
   */
  var mailboxCounts = {}

  function refreshMailboxCounts(bridge) {
    if (!bridge || !bridge.mailCounts) return
    INBOX_WINDOWS.forEach(function (w) {
      bridge
        .mailCounts(w.hours)
        .then(function (res) {
          if (!res || res.error) return
          mailboxCounts[w.key] = res
          renderInbox(lastData.mail)
        })
        .catch(function () {})
    })
  }

  function urgentMail(items) {
    return items.filter(function (m) {
      var sev = mailSeverity(m.score)
      return sev === 'critical' || sev === 'high'
    })
  }

  function inboxWindowHtml(w, mail) {
    var since = Date.now() - w.hours * 3600000
    var pool = (mail || []).filter(mailPasses).filter(function (m) {
      var t = new Date(m.date).getTime()
      return isFinite(t) && t >= since
    })
    var counted = mailboxCounts[w.key]
    var urgent = urgentMail(pool)

    var cats = {}
    pool.forEach(function (m) {
      var c = inferMailCategory(m)
      cats[c] = (cats[c] || 0) + 1
    })
    var keys = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a] })

    // When Gmail has answered, its numbers are the arrivals and the unread
    // count; otherwise say the sample is what is being counted rather than
    // presenting a sample total as an inbox total.
    var arrived = counted ? counted.total : pool.length
    var unread = counted ? counted.unread : pool.filter(function (m) { return m.unread }).length
    // Two different bases in one card, so say which is which rather than
    // stamping one source over the whole thing: arrivals and unread are the
    // mailbox's own numbers, urgency and category can only come from the
    // messages this page actually scored.
    var source = counted
      ? 'arrivals from Gmail · the rest from the ' + pool.length + ' ranked here'
      : 'all from the ' + pool.length + ' ranked here'
    var ranked = ' of ' + pool.length + ' ranked'

    return '<div class="inbox-win">' +
      '<div class="inbox-win__head">' + esc(w.label) +
      '<span class="inbox-win__src">' + esc(source) + '</span></div>' +
      '<div class="inbox-nums">' +
      statHtml(arrived, '✉️ Arrived') +
      statHtml(unread, '● Unread', unread ? 'var(--high)' : '') +
      statHtml(urgent.length, '🔴 Urgent' + (counted ? ranked : ''),
        urgent.length ? 'var(--critical)' : '') +
      '</div>' +
      (keys.length
        ? '<div class="inbox-cats">' + keys.map(function (c) {
            var meta = CATEGORY_META[c] || { icon: '📧', label: c }
            return '<span class="inbox-cat glance--' + esc(c) + '">' +
              meta.icon + ' ' + esc(meta.label) +
              '<b class="mono">' + cats[c] + '</b></span>'
          }).join('') + '</div>'
        : '<p class="note">Nothing in this window.</p>') +
      '</div>'
  }

  /**
   * Mail that arrived since the last time this browser opened the digest,
   * grouped by category — the list that answers "what did I miss", which a
   * rolling window cannot.
   */
  function sinceLoginHtml(mail) {
    var pool = (mail || []).filter(mailPasses).filter(function (m) {
      return previousVisit && new Date(m.date).getTime() > previousVisit
    })
    pool.sort(function (a, b) { return b.date.localeCompare(a.date) })

    var when = previousVisit
      ? new Date(previousVisit).toLocaleDateString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric',
        }) + ' · ' + new Date(previousVisit).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit',
        })
      : ''

    return '<div class="section-head"><h3>🆕 Since your last login</h3>' +
      '<span class="sub">' +
      (previousVisit
        ? 'Arrived after ' + esc(when) + ' · grouped by category · 📖 marks one read in Gmail'
        : 'First visit on this browser — nothing to compare against yet') +
      '</span></div>' +
      (pool.length
        ? categoryBandsHtml(pool, false, [])
        : '<p class="note">' +
          (previousVisit ? 'Nothing new since you were last here.'
            : 'Come back and this will show what arrived while you were away.') +
          '</p>')
  }

  /**
   * The mail itself, newest first.
   *
   * "Since your last login" is the section you want and the one that can
   * legitimately be empty — you may genuinely have missed nothing. An inbox
   * that then shows no mail at all reads as broken rather than as caught up,
   * so the recent list always follows it.
   */
  function recentMailHtml(mail) {
    var pool = (mail || []).filter(mailPasses).slice()
    pool.sort(function (a, b) { return b.date.localeCompare(a.date) })

    var since = previousVisit
      ? pool.filter(function (m) { return new Date(m.date).getTime() > previousVisit })
      : []
    // Do not print the same message twice: whatever the "since" list already
    // showed is dropped from the recent one.
    var seen = {}
    since.forEach(function (m) { seen[m.id] = true })
    var rest = pool.filter(function (m) { return !seen[m.id] }).slice(0, RECENT_MAIL_MAX)

    if (!rest.length) return ''
    return '<div class="section-head"><h3>✉️ Recent mail</h3>' +
      '<span class="sub">The ' + rest.length + ' most recent in the current window · ' +
      '📖 marks one read in Gmail</span></div>' +
      categoryBandsHtml(rest, false, [])
  }

  var RECENT_MAIL_MAX = 12

  function inboxHtml(mail, withList) {
    return '<div class="section-head"><h2>📥 Inbox</h2>' +
      '<span class="sub">How much arrived, how much of it is still unread, and where it came from</span></div>' +
      '<div class="inbox-wins">' +
      INBOX_WINDOWS.map(function (w) { return inboxWindowHtml(w, mail) }).join('') +
      '</div>' +
      (withList ? sinceLoginHtml(mail) + recentMailHtml(mail) : '')
  }

  /** Paint the inbox wherever it is hosted — the one-page view, the mail tab. */
  function renderInbox(mail) {
    var full = document.getElementById('inbox-slot')
    if (full) full.innerHTML = inboxHtml(mail, true)
    var counts = document.getElementById('mail-counts')
    if (counts) counts.innerHTML = inboxHtml(mail, false)
    if (full || counts) rewirePage()
  }

  // ---- Top actions, ranked by deadline ------------------------------------

  /**
   * Deadline order is not severity order: a Low item due tomorrow outranks a
   * Critical one due in a month, and that is exactly what a "what do I do
   * next" list has to say.
   */
  /**
   * Deadline ranking has been removed from Actions & Inbox: the punch list
   * board already orders by severity and shows each item's deadline, so a
   * second ranked list of the same items was one more place to keep in step.
   */
  function renderTopActions() {
    var old = document.getElementById('top-actions-ranked')
    if (old && old.parentNode) old.parentNode.removeChild(old)
  }

  // ---- Calendar tab -------------------------------------------------------

  var CAL_LOOKAHEAD_DAYS = 14

  /**
   * Sweep-written markup the calendar tab reuses — the logistics rows and the
   * prep table. Both are MOVED into whichever section is showing, so they must
   * be held onto rather than re-queried: `host.innerHTML = …` on a section
   * change would otherwise destroy them, and leaving Suggested planning once
   * would empty it for good.
   */
  var salvaged = { logi: null, prep: null }

  function salvageCalendarParts() {
    if (!salvaged.logi) {
      var wrap = document.querySelector('.logi-wrap')
      if (wrap) {
        var sec = wrap.closest('section')
        if (sec) sec.style.display = 'none'
        salvaged.logi = wrap
      }
    }
    if (!salvaged.prep) {
      var body = document.getElementById('prep-tbody')
      var prepSec = body && body.closest('section')
      if (prepSec) salvaged.prep = prepSec
    }
    // Detached so the next innerHTML wipe cannot take them with it.
    if (salvaged.logi && salvaged.logi.parentNode) salvaged.logi.remove()
    if (salvaged.prep && salvaged.prep.parentNode) salvaged.prep.remove()
  }

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
      if (!cb.dataset.prepWired) {
        cb.dataset.prepWired = '1'
        cb.addEventListener('change', renderPrepTotals)
      }
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
    var noteEl = document.getElementById('prep-selected-note')
    if (!tbody || !noteEl) return
    // #prep-selected-note is a <b> inside the paragraph, and the rest of that
    // paragraph is sweep-time prose with its own (now wrong) totals. Replace
    // the paragraph, or the page's stale numbers sit right beside the live ones.
    var note = noteEl.closest('p.note') || noteEl
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
      note.innerHTML = '<b id="prep-selected-note">No prep blocks left to schedule</b>' +
        (past ? ' — ' + past + ' were for meetings that have already happened' : '') +
        (dropped ? (past ? ', and ' : ' — ') + dropped + ' dropped' : '') + '.'
      return
    }
    note.innerHTML =
      '<b id="prep-selected-note">Prep suggested: ' + fmtHours(proposed / 60) + ' across ' + kept + ' block' +
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

    // The approval callout describes a chat workflow that no longer exists —
    // the page is operated here, not by replying to Claude.
    Array.prototype.forEach.call(panel.querySelectorAll('.callout'), function (c) {
      if (/nothing gets added automatically/i.test(c.textContent)) c.style.display = 'none'
    })

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
        // Ours is rendered later into #cal-live; only the sweep-time ones
        // exist at this point, so this cannot hide the new grid.
        if (sec.querySelector('.week-grid')) sec.style.display = 'none'
      })
    }

    var now = Date.now()
    var horizon = now + CAL_LOOKAHEAD_DAYS * 86400000
    var future = (events || []).filter(function (ev) {
      var t = new Date(ev.start).getTime()
      return t >= now && t <= horizon && eventPasses(ev)
    })

    var host = document.getElementById('cal-live')
    if (!host) {
      host = el('section', 'no-check')
      host.id = 'cal-live'
      var prep = panel.querySelector('section')
      if (prep && prep.nextSibling) panel.insertBefore(host, prep.nextSibling)
      else panel.appendChild(host)
    }

    // The selector counts the whole horizon; everything below it respects the
    // current pick, so the tiles keep showing what you would get by choosing
    // them rather than collapsing to the filtered set.
    var picked = calCatFilter
      ? future.filter(function (ev) { return eventCategory(ev) === calCatFilter })
      : future

    // Take the sweep's prep and logistics markup out of the page before the
    // wipe below, so a section change cannot destroy it.
    salvageCalendarParts()

    var body
    if (calSection === 'deadlines') body = keyDatesHtml(events) + deadlinesHtml(picked)
    else if (calSection === 'meetings') body = meetingsHtml(picked)
    else if (calSection === 'load') body = loadHtml(picked)
    else body = planningHtml(picked)

    host.innerHTML = calNavHtml() + body

    // Prep and logistics are sweep-written markup; move them into the section
    // rather than duplicating them.
    var prepSlot = document.getElementById('prep-slot')
    if (prepSlot && salvaged.prep) {
      prepSlot.appendChild(salvaged.prep)
      salvaged.prep.style.display = ''
      wirePrepBlocks()
    }
    var logiSlot = document.getElementById('logi-slot')
    if (logiSlot && salvaged.logi) logiSlot.appendChild(salvaged.logi)
    trimLogistics()

    if (!host.dataset.picker) {
      host.dataset.picker = '1'
      host.addEventListener('click', function (e) {
        var nav = e.target.closest('.cal-nav__btn')
        if (nav) {
          calSection = nav.dataset.calSec
          renderCalendar(lastData.events)
          return
        }
        var pick = e.target.closest('.cal-pick')
        if (!pick) return
        var next = pick.dataset.calCat
        calCatFilter = next === calCatFilter ? '' : next
        renderCalendar(lastData.events)
      })
    }
  }

  /**
   * Hours for the next 7 days, per calendar and per category, each row
   * expandable to the meetings behind it — a total you cannot audit is a
   * total you cannot trust, and "12h personal" is useless without knowing
   * which twelve.
   */
  function hoursDashboardHtml(events) {
    var weekEnd = Date.now() + 7 * 86400000
    var inWeek = (events || []).filter(function (ev) {
      var t = new Date(ev.start).getTime()
      return isFinite(t) && t >= Date.now() && t <= weekEnd
    })

    function group(keyFn) {
      var map = {}
      inWeek.forEach(function (ev) {
        var k = keyFn(ev)
        if (!map[k]) map[k] = { hours: 0, items: [] }
        map[k].hours += hoursOf(ev)
        map[k].items.push(ev)
      })
      return map
    }

    function bars(map) {
      var keys = Object.keys(map).sort(function (a, b) { return map[b].hours - map[a].hours })
      if (!keys.length) return '<div class="note">Nothing scheduled.</div>'
      var max = map[keys[0]].hours || 1
      return keys.map(function (k) {
        var g = map[k]
        var rows = g.items
          .slice()
          .sort(function (a, b) { return a.start.localeCompare(b.start) })
          .map(function (ev) {
            return '<a class="hrs-item" href="' + esc(eventHref(ev)) + '" target="_blank" rel="noopener">' +
              '<span class="hrs-item__d mono">' + esc(dayLabel(ev.start)) + '</span>' +
              '<span class="hrs-item__t mono">' +
              esc(ev.allDay ? 'all day' : new Date(ev.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })) +
              '</span>' +
              '<span class="hrs-item__n">' + esc(ev.title) + '</span>' +
              '<span class="hrs-item__h mono">' + esc(fmtHours(hoursOf(ev))) + '</span></a>'
          }).join('')
        return '<details class="hrs-group"><summary class="hrs-row">' +
          '<span class="hrs-name">' + esc(k) + '</span>' +
          '<span class="hrs-bar"><span class="hrs-fill" style="width:' +
          Math.round((g.hours / max) * 100) + '%"></span></span>' +
          '<span class="hrs-val mono">' + fmtHours(g.hours) + '</span>' +
          '<span class="hrs-count mono">' + g.items.length + '</span>' +
          '</summary><div class="hrs-items">' + rows + '</div></details>'
      }).join('')
    }

    var byCal = group(function (ev) { return ev.calendar || 'Calendar' })
    var byCat = group(eventCategory)
    var total = inWeek.reduce(function (n, ev) { return n + hoursOf(ev) }, 0)

    return (
      '<div class="section-head"><h2>Hours ahead</h2>' +
      '<span class="sub">Next 7 days · ' + fmtHours(total) + ' across ' + inWeek.length +
      ' events · click any row to see what makes it up</span></div>' +
      '<div class="hrs-grid">' +
      '<div class="hrs-card"><div class="hrs-card__head">Per calendar</div>' + bars(byCal) + '</div>' +
      '<div class="hrs-card"><div class="hrs-card__head">Per category</div>' + bars(byCat) + '</div>' +
      '</div>'
    )
  }

  /**
   * One row per calendar, columns per day — the shape the page's own week grid
   * used, which reads far better than a flat day list when several calendars
   * are in play.
   */
  function weekAheadHtml(events) {
    var days = []
    for (var i = 0; i < 7; i++) {
      var d = new Date()
      d.setDate(d.getDate() + i)
      days.push({ date: d, key: dayKey(d) })
    }

    var rows = {}
    events.forEach(function (ev) {
      var name = ev.calendar || 'Calendar'
      if (!rows[name]) {
        rows[name] = {}
        days.forEach(function (d) { rows[name][d.key] = [] })
      }
      var slot = rows[name][dayKey(new Date(ev.start))]
      if (slot) slot.push(ev)
    })
    var names = Object.keys(rows).sort()

    var header = '<tr><th></th>' + days.map(function (d, i) {
      return '<th' + (i === 0 ? ' class="today"' : '') + '>' +
        esc(d.date.toLocaleDateString('en-US', { weekday: 'short' })) + ' ' +
        d.date.getDate() + '</th>'
    }).join('') + '</tr>'

    var body = names.length
      ? names.map(function (name) {
          return '<tr><td class="wg-label">📅 ' + esc(name) + '</td>' +
            days.map(function (d) {
              var list = rows[name][d.key]
              return '<td>' + (list.length
                ? list.map(function (ev) {
                    return '<a class="wk-ev cat-' + esc(eventCategory(ev)) + '" href="' +
                      esc(eventHref(ev)) + '" target="_blank" rel="noopener">' +
                      '<span class="wk-ev__t mono">' +
                      esc(ev.allDay ? 'all day' : new Date(ev.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })) +
                      '</span>' + esc(ev.title) + '</a>'
                  }).join('')
                : '') + '</td>'
            }).join('') + '</tr>'
        }).join('')
      : '<tr><td class="wg-label">—</td><td colspan="7" class="note">Nothing scheduled in the next 7 days.</td></tr>'

    return (
      '<div class="section-head"><h2>The week ahead</h2>' +
      '<span class="sub">Seven days from today, one row per calendar · ' +
      CAL_LOOKAHEAD_DAYS + '-day horizon below</span></div>' +
      '<div class="week-grid-wrap"><table class="week-grid wk-table no-check">' +
      '<thead>' + header + '</thead><tbody>' + body + '</tbody></table></div>'
    )
  }



  /**
   * Logistics rows are written at sweep time and carry their date as text
   * ("Tue, Aug 25"). Anywhere you needed to be last week is not logistics any
   * more, and the drive time — the only number here you act on — is buried in
   * a muted line, so it is pulled out.
   */
  function trimLogistics() {
    // The wrap is detached whenever another calendar section is showing, so a
    // document-wide query would find nothing and silently skip the trim.
    var scope = salvaged.logi || document
    var rows = scope.querySelectorAll('.logi-row')
    if (!rows.length) return
    Array.prototype.forEach.call(rows, function (row) {
      var dayEl = row.querySelector('.logi-day')
      var text = dayEl ? dayEl.textContent : ''
      // Only a row that CARRIES a date can be past. Rows labelled "Recurring"
      // have none and are ongoing, so treating "no future date" as "past"
      // would delete exactly the standing commitments worth keeping.
      var dated = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i
        .test(text)
      if (dated && !deadlineFrom(text)) {
        row.style.display = 'none'
        return
      }
      row.style.display = ''
      if (row.dataset.logiDone) return
      row.dataset.logiDone = '1'

      var addr = row.querySelector('.logi-addr')
      if (!addr) return
      var m = /~?\s*(\d+)\s*(min|minutes|hr|hour|hours)\b([^·<]*)/i.exec(addr.textContent)
      if (!m) return
      var chip = el('div', 'logi-drive')
      chip.innerHTML = '<span class="logi-drive__n mono">' + esc(m[1]) + '</span>' +
        '<span class="logi-drive__u">' + esc(/hr|hour/i.test(m[2]) ? 'hours' : 'min') + '</span>' +
        '<span class="logi-drive__l">drive</span>'
      var main = row.querySelector('.logi-main') || row
      main.parentNode.insertBefore(chip, main.nextSibling)
    })

    var wrap = salvaged.logi || document.querySelector('.logi-wrap')
    var anyLeft = Array.prototype.some.call(
      scope.querySelectorAll('.logi-row'),
      function (r) { return r.style.display !== 'none' },
    )
    if (wrap && !anyLeft) {
      var note = wrap.querySelector('.logi-empty')
      if (!note) {
        note = el('div', 'logi-empty note')
        note.textContent = 'Nothing left this week — every logged stop has already happened.'
        wrap.appendChild(note)
      }
    }
  }

  // ---- key dates: holidays, birthdays, invitations ------------------------

  var KEY_KINDS = [
    { key: 'india', icon: '🇮🇳', label: 'Indian holidays',
      cal: /holidays?\s+in\s+india|indian?\s+holiday/i,
      title: /\b(diwali|deepavali|holi|raksha|navratri|dussehra|dasara|onam|pongal|baisakhi|ganesh|janmashtami|eid|gurpurab|republic day|independence day \(india\)|karwa)\b/i },
    { key: 'us', icon: '🇺🇸', label: 'US holidays',
      cal: /holidays?\s+in\s+(the\s+)?united states|us\s+holiday/i,
      title: /\b(thanksgiving|christmas|new year|independence day|labor day|memorial day|veterans day|columbus day|juneteenth|presidents|martin luther king|halloween)\b/i },
    { key: 'birthday', icon: '🎂', label: 'Birthdays',
      cal: /birthday/i, title: /\bbirthday\b|\bb-?day\b/i },
    { key: 'evite', icon: '💌', label: 'Invitations',
      cal: /(^|\s)invit/i,
      title: /\b(evite|rsvp|invitation|invite|party|wedding|shower|graduation|reception|anniversary|reunion)\b/i },
  ]

  function keyKindOf(ev) {
    var cal = ev.calendar || ''
    var title = ev.title || ''
    for (var i = 0; i < KEY_KINDS.length; i++) {
      // The calendar it lives on is the stronger signal — Google's own
      // holiday and birthday calendars are named exactly this way — so it is
      // checked first, and title matching is the fallback for events sitting
      // on a personal calendar.
      if (KEY_KINDS[i].cal.test(cal)) return KEY_KINDS[i]
    }
    for (var j = 0; j < KEY_KINDS.length; j++) {
      if (KEY_KINDS[j].title.test(title)) return KEY_KINDS[j]
    }
    return null
  }

  function dayLabel(iso) {
    var d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  }

  function daysAway(iso) {
    var d = new Date(iso)
    var start = new Date()
    start.setHours(0, 0, 0, 0)
    return Math.max(0, Math.round((d.getTime() - start.getTime()) / 86400000))
  }

  /**
   * Dates that matter but never appear in a to-do list — holidays, birthdays,
   * invitations. They are easy to miss precisely because nothing is asked of
   * you until suddenly it is, so they lead the calendar tab. Looks further
   * ahead than the working horizon, since a birthday four weeks out is still
   * worth knowing about today.
   */
  var KEY_DATES_DAYS = 60

  /** Category filter for the calendar, in the same tile idiom as the glance. */
  var calCatFilter = ''

  function calSelectorHtml(events) {
    var counts = {}
    var hours = {}
    ;(events || []).forEach(function (ev) {
      var c = eventCategory(ev)
      counts[c] = (counts[c] || 0) + 1
      hours[c] = (hours[c] || 0) + hoursOf(ev)
    })
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] })
    if (!keys.length) return ''

    var total = (events || []).length
    var totalH = keys.reduce(function (n, k) { return n + hours[k] }, 0)

    return '<div class="cal-sel">' +
      '<button type="button" class="glance__cell cal-pick' +
      (calCatFilter === '' ? ' is-on' : '') + '" data-cal-cat="">' +
      '<div class="glance__cat">🗂️ All calendars</div>' +
      '<div class="glance__nums"><span><b>' + total + '</b> events</span>' +
      '<span><b>' + esc(fmtHours(totalH)) + '</b></span></div></button>' +
      keys.map(function (c) {
        var meta = CATEGORY_META[c] || { icon: '📧', label: c }
        return '<button type="button" class="glance__cell glance--' + esc(c) + ' cal-pick' +
          (calCatFilter === c ? ' is-on' : '') + '" data-cal-cat="' + esc(c) + '">' +
          '<div class="glance__cat">' + meta.icon + ' ' + esc(meta.label) + '</div>' +
          '<div class="glance__nums"><span><b>' + counts[c] + '</b> events</span>' +
          '<span><b>' + esc(fmtHours(hours[c])) + '</b></span></div></button>'
      }).join('') +
      '</div>'
  }

  function keyDatesHtml(events) {
    var now = Date.now()
    var horizon = now + KEY_DATES_DAYS * 86400000
    var groups = {}
    ;(events || []).forEach(function (ev) {
      var t = new Date(ev.start).getTime()
      if (!isFinite(t) || t < now - 86400000 || t > horizon) return
      var kind = keyKindOf(ev)
      if (!kind) return
      ;(groups[kind.key] = groups[kind.key] || []).push(ev)
    })

    var shown = KEY_KINDS.filter(function (k) { return groups[k.key] && groups[k.key].length })
    if (!shown.length) return ''

    return '<div class="section-head"><h2>⭐ Key dates ahead</h2>' +
      '<span class="sub">Holidays, birthdays and invitations in the next ' +
      KEY_DATES_DAYS + ' days — nothing asks anything of you until it does</span></div>' +
      '<div class="key-grid">' +
      shown.map(function (k) {
        var list = groups[k.key].sort(function (a, b) { return a.start.localeCompare(b.start) })
        return '<div class="key-card key-card--' + k.key + '">' +
          '<div class="key-card__head"><span class="key-card__icon">' + k.icon + '</span>' +
          esc(k.label) + '<span class="key-card__n mono">' + list.length + '</span></div>' +
          list.slice(0, 6).map(function (ev) {
            var away = daysAway(ev.start)
            return '<a class="key-row" href="' + esc(eventHref(ev)) + '" target="_blank" rel="noopener">' +
              '<span class="key-row__in mono' + (away <= 7 ? ' key-row__in--soon' : '') + '">' +
              (away === 0 ? 'today' : away + 'd') + '</span>' +
              '<span class="key-row__t">' + esc(ev.title) + '</span>' +
              '<span class="key-row__d mono">' + esc(dayLabel(ev.start)) + '</span></a>'
          }).join('') +
          (list.length > 6 ? '<div class="key-more">+' + (list.length - 6) + ' more</div>' : '') +
          '</div>'
      }).join('') +
      '</div>'
  }


  /**
   * Rename the sweep's tabs to what they now hold, and give Calendar its four
   * named sections. The generated page still calls them Actions & Inbox and
   * Reference vault; a rebuild would restore those names, so this runs here.
   */
  function retabs() {
    var map = {
      punchlist: '📋 Punch List',
      calendar: '📅 Calendar',
    }
    Array.prototype.forEach.call(document.querySelectorAll('.tab-btn'), function (btn) {
      var name = map[btn.dataset.panel]
      if (!name) return
      var count = btn.querySelector('.count')
      btn.textContent = name + ' '
      if (count) btn.appendChild(count)
    })

    // Actions & Inbox held the sweep's category bands; mail lives on its own
    // tab now, so it is the sweep's reference material rather than a queue.
    var actions = document.querySelector('.tab-btn[data-panel="actions"]')
    if (actions) {
      var c = actions.querySelector('.count')
      actions.textContent = '🗂️ Inbox & tasks by category '
      if (c) actions.appendChild(c)
    }

    // "Top actions — ranked by deadline", and the "Critical & time-sensitive"
    // block inside it, is the sweep's own ranking of items the punch list
    // already orders by severity and shows a deadline for. Two rankings of one
    // set of items is one to keep in step, so it goes.
    var actionsPanel = document.getElementById('panel-actions')
    if (actionsPanel) {
      Array.prototype.forEach.call(actionsPanel.querySelectorAll('section'), function (sec) {
        var h = sec.querySelector('h2')
        if (h && /top actions|ranked by deadline/i.test(h.textContent)) {
          sec.style.display = 'none'
        }
      })
    }
  }

  /** The one-page tab is today's view, so it is labelled with today's date. */
  function todayLabel() {
    return new Date().toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
    })
  }

  /** Section navigation within the Calendar tab. */
  var CAL_SECTIONS = [
    { key: 'deadlines', label: '⏱️ Deadlines' },
    { key: 'meetings', label: '🤝 Meetings' },
    { key: 'planning', label: '🧭 Suggested planning' },
    { key: 'load', label: '⚖️ Load balancing' },
  ]
  var calSection = 'deadlines'

  function calNavHtml() {
    return '<div class="cal-nav">' + CAL_SECTIONS.map(function (sec) {
      return '<button type="button" class="cal-nav__btn' +
        (sec.key === calSection ? ' is-on' : '') + '" data-cal-sec="' +
        sec.key + '">' + sec.label + '</button>'
    }).join('') + '</div>'
  }

  /**
   * Deadlines: dated items and key dates, soonest first — everything with a
   * clock on it, in one place.
   */
  function deadlinesHtml(events) {
    var rows = []
    ;(events || []).forEach(function (ev) {
      var t = new Date(ev.start).getTime()
      if (!isFinite(t) || t < Date.now()) return
      rows.push({ when: t, title: ev.title, kind: 'event', href: eventHref(ev),
        meta: (ev.calendar || 'Calendar') })
    })
    try {
      Object.keys(STATE.punchlist || {}).forEach(function (id) {
        var e = STATE.punchlist[id]
        if (!e || e.done || !entryPasses(e)) return
        var d = deadlineFrom(e.title)
        if (!d) return
        rows.push({ when: Date.now() + d.days * 86400000, title: e.title,
          kind: 'task', href: (e.links && e.links[0] && e.links[0].href) || '',
          meta: 'punch list · ' + (e.severity || 'low') })
      })
    } catch (e) {}
    rows.sort(function (a, b) { return a.when - b.when })

    if (!rows.length) return '<p class="note">Nothing dated ahead.</p>'
    return '<div class="rank-list">' + rows.slice(0, 20).map(function (r, i) {
      var days = Math.max(0, Math.round((r.when - Date.now()) / 86400000))
      return '<div class="rank-row">' +
        '<span class="rank-n mono">' + (i + 1) + '</span>' +
        '<span class="rank-days mono' + (days <= 3 ? ' rank-days--soon' : '') + '">' +
        (days === 0 ? 'today' : days + 'd') + '</span>' +
        '<span class="rank-title">' +
        (r.href ? '<a class="mail-link" href="' + esc(r.href) + '" target="_blank" rel="noopener">' + esc(r.title) + '</a>' : esc(r.title)) +
        '</span><span class="rank-when mono">' + esc(r.meta) + '</span></div>'
    }).join('') + '</div>'
  }

  /** Meetings: the week grid, plus the prep blocks that feed it. */
  function meetingsHtml(future) {
    return weekAheadHtml(future)
  }

  // ---- suggested planning: prep blocks and the travel they imply ----------

  /**
   * A meeting with an address is really two commitments: the meeting, and
   * getting there. Only one of them is on the calendar, which is why the day
   * that looked fine at 9am is late by 10. So every located event gets a
   * proposed travel block on each side of it, with a leave-by time you can put
   * on the calendar in one click.
   *
   * Nothing here writes to your calendar. Each block opens Google's own event
   * composer, prefilled — the decision stays yours, and no write scope is
   * asked for.
   */
  var DEFAULT_DRIVE_MIN = 20
  /** A location that is a link or a phone bridge is not somewhere you drive. */
  var VIRTUAL_RE = /(^https?:)|zoom|meet\.google|teams\.microsoft|webex|hangout|phone|dial-?in|call|online|virtual|tbd/i

  function isTravelWorthy(ev) {
    if (ev.allDay) return false
    var loc = String(ev.location || '').trim()
    if (loc.length < 4) return false
    if (VIRTUAL_RE.test(loc)) return false
    return true
  }

  /**
   * Drive times the sweep already measured, keyed by the destination text it
   * wrote them against. A real number beats an estimate, so the logistics rows
   * are read for one before falling back.
   */
  function knownDriveTimes() {
    var out = []
    var wrap = salvaged.logi || document.querySelector('.logi-wrap')
    if (!wrap) return out
    Array.prototype.forEach.call(wrap.querySelectorAll('.logi-row'), function (row) {
      var addr = row.querySelector('.logi-addr')
      if (!addr) return
      var m = /~?\s*(\d+)\s*(min|minutes|hr|hour|hours)\b/i.exec(addr.textContent)
      if (!m) return
      var mins = parseInt(m[1], 10)
      if (/hr|hour/i.test(m[2])) mins *= 60
      out.push({ text: row.textContent.toLowerCase(), mins: mins })
    })
    return out
  }

  function driveMinutes(ev, known) {
    var loc = String(ev.location || '').toLowerCase()
    var title = String(ev.title || '').toLowerCase()
    for (var i = 0; i < known.length; i++) {
      var probe = loc.slice(0, 14)
      if (probe && known[i].text.indexOf(probe) !== -1) {
        return { mins: known[i].mins, measured: true }
      }
      var t = title.slice(0, 14)
      if (t && known[i].text.indexOf(t) !== -1) {
        return { mins: known[i].mins, measured: true }
      }
    }
    return { mins: DEFAULT_DRIVE_MIN, measured: false }
  }

  function gcalStamp(d) {
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  }

  /** A prefilled Google Calendar composer — the user still presses save. */
  function gcalTemplate(title, from, to, location, details) {
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
      '&text=' + encodeURIComponent(title) +
      '&dates=' + gcalStamp(from) + '/' + gcalStamp(to) +
      (location ? '&location=' + encodeURIComponent(location) : '') +
      (details ? '&details=' + encodeURIComponent(details) : '')
  }

  function travelBlocks(events) {
    var known = knownDriveTimes()
    var now = Date.now()
    var out = []
    ;(events || []).forEach(function (ev) {
      if (!isTravelWorthy(ev)) return
      var start = new Date(ev.start)
      var end = new Date(ev.end || ev.start)
      if (isNaN(start.getTime())) return
      if (start.getTime() < now) return
      var d = driveMinutes(ev, known)
      var ms = d.mins * 60000

      out.push({
        when: new Date(start.getTime() - ms),
        until: start,
        mins: d.mins,
        measured: d.measured,
        dir: 'to',
        event: ev,
      })
      if (!isNaN(end.getTime()) && end.getTime() > start.getTime()) {
        out.push({
          when: end,
          until: new Date(end.getTime() + ms),
          mins: d.mins,
          measured: d.measured,
          dir: 'from',
          event: ev,
        })
      }
    })
    out.sort(function (a, b) { return a.when - b.when })
    return out
  }

  function travelRowHtml(b) {
    var ev = b.event
    var title = (b.dir === 'to' ? 'Drive to ' : 'Drive home from ') + (ev.title || 'event')
    var href = gcalTemplate(
      '🚗 ' + title,
      b.when,
      b.until,
      ev.location || '',
      (b.measured ? 'Measured' : 'Estimated') + ' ' + b.mins + ' minutes each way · ' +
        'suggested by the Nexus daily digest',
    )
    return '<div class="plan-row">' +
      '<span class="plan-when mono">' + esc(timeLabel(b.when.toISOString(), false)) + '</span>' +
      '<span class="plan-drive"><b class="mono">' + b.mins + '</b><span class="plan-drive__u">min</span></span>' +
      '<span class="plan-main">' +
      '<span class="plan-title">' + esc(title) + '</span>' +
      '<span class="plan-meta">' + esc(ev.location || '') +
      ' · ' + (b.measured ? 'measured drive' : 'estimated drive') +
      ' · leave by ' + esc(timeLabel(b.when.toISOString(), false)) + '</span>' +
      '</span>' +
      '<a class="plan-add" href="' + esc(href) + '" target="_blank" rel="noopener"' +
      ' title="Open Google Calendar with this block prefilled">＋ Add</a>' +
      '</div>'
  }

  /**
   * Prep blocks and travel blocks are the same kind of thing — time the week
   * needs that is not yet on the calendar — so they share one section rather
   * than being a suggestion list and a logistics list you have to reconcile.
   */
  /**
   * Travel alone, with no slots for the sweep's markup. The prep table and the
   * logistics rows are MOVED rather than copied — one DOM node cannot be in
   * two panels — so the one-page view shows the derived half and leaves the
   * swept half to the Calendar tab.
   */
  function travelHtml(future) {
    var blocks = travelBlocks(future)
    return '<div class="section-head"><h3>🚗 Travel blocks</h3>' +
      '<span class="sub">' +
      (blocks.length
        ? blocks.length + ' drive' + (blocks.length === 1 ? '' : 's') +
          ' implied by events with an address, ' + DEFAULT_DRIVE_MIN +
          ' min assumed where no measured time exists'
        : 'No upcoming event carries an address to drive to') +
      '</span></div>' +
      (blocks.length
        ? '<div class="plan-list">' + blocks.map(travelRowHtml).join('') + '</div>'
        : '')
  }

  function planningHtml(future) {
    return '<div class="section-head"><h2>🧭 Suggested planning</h2>' +
      '<span class="sub">Prep and travel the week implies but has not been scheduled · ' +
      '＋ opens Google Calendar prefilled — nothing is written for you</span></div>' +
      '<div id="prep-slot"></div>' +
      travelHtml(future) +
      '<div class="section-head"><h3>📍 Logged stops</h3>' +
      '<span class="sub">Where you need to be, still ahead · drive times pulled out</span></div>' +
      '<div id="logi-slot"></div>'
  }

  /** Load balancing: where the hours actually go. */
  function loadHtml(future) {
    return calSelectorHtml(future) + hoursDashboardHtml(future)
  }

  // ---- the one-page dashboard ---------------------------------------------

  /**
   * Everything on one page, in the order you actually ask it: the calendar
   * first, because the day is already committed before any of the mail is
   * read, then the inbox.
   *
   * The calendar half is the same four views the Calendar tab offers, folded
   * into disclosures rather than a section picker — on a page you scroll, a
   * picker means the other three are invisible, and the point of a one-page
   * view is that nothing is.
   */
  var onePagePanel = null
  var OPEN_SECS_KEY = 'ak-digest-onepage-open'

  var OP_ALL_SECTIONS = ['deadlines', 'meetings', 'planning', 'load']

  function openSections() {
    try {
      var raw = JSON.parse(localStorage.getItem(OPEN_SECS_KEY) || 'null')
      if (Array.isArray(raw)) return raw
    } catch (e) {}
    // All of them, until you close one. A page whose detail is behind four
    // closed disclosures looks like a page with no detail.
    return OP_ALL_SECTIONS
  }

  function rememberSection(key, open) {
    var list = openSections().filter(function (k) { return k !== key })
    if (open) list.push(key)
    try {
      localStorage.setItem(OPEN_SECS_KEY, JSON.stringify(list))
    } catch (e) {}
  }

  /**
   * The punch list, compressed to one line each.
   *
   * A one-page dashboard that shows the calendar and the mail but not the work
   * is missing the thing the other two are usually about. Hardest first, and
   * within a severity the nearest deadline, which is the order you would work
   * them in.
   */
  var OP_ITEMS_MAX = 15
  var OP_SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 }

  function onePageItemsHtml() {
    var rows = []
    try {
      Object.keys(STATE.punchlist || {}).forEach(function (id) {
        var e = STATE.punchlist[id]
        if (!e || e.done || !entryPasses(e)) return
        var d = deadlineFrom(e.title)
        rows.push({
          id: id,
          title: e.title,
          sev: e.severity || 'low',
          cat: e.category || 'personal',
          status: statusOf(id),
          days: d ? d.days : null,
          href: (e.links && e.links[0] && e.links[0].href) || '',
        })
      })
    } catch (err) {}

    rows.sort(function (a, b) {
      var d = (OP_SEV_ORDER[a.sev] === undefined ? 9 : OP_SEV_ORDER[a.sev]) -
        (OP_SEV_ORDER[b.sev] === undefined ? 9 : OP_SEV_ORDER[b.sev])
      if (d !== 0) return d
      if (a.days === null && b.days === null) return 0
      if (a.days === null) return 1
      if (b.days === null) return -1
      return a.days - b.days
    })

    var mine = rows.filter(function (r) { return r.status === 'court' }).length
    var head = '<div class="section-head"><h2>📋 Items</h2>' +
      '<span class="sub">' +
      (rows.length
        ? rows.length + ' open · ' + mine + ' in your court · hardest first, then by deadline'
        : 'Nothing open — everything on the punch list is closed') +
      '</span></div>'
    if (!rows.length) return head

    return head + '<div class="op-items">' +
      rows.slice(0, OP_ITEMS_MAX).map(function (r) {
        var meta = CATEGORY_META[r.cat] || { icon: '📧', label: r.cat }
        return '<div class="op-item sev-' + esc(r.sev) + '">' +
          '<span class="op-item__due mono">' +
          (r.days === null ? '—' : r.days === 0 ? 'today' : r.days + 'd') + '</span>' +
          '<span class="op-item__t">' +
          (r.href
            ? '<a class="mail-link" href="' + esc(r.href) + '" target="_blank" rel="noopener">' + esc(r.title) + '</a>'
            : esc(r.title)) +
          '</span>' +
          '<span class="op-item__cat">' + meta.icon + ' ' + esc(meta.label) + '</span>' +
          '<span class="op-item__st">' + esc(statusText(r.status)) + '</span>' +
          '</div>'
      }).join('') +
      (rows.length > OP_ITEMS_MAX
        ? '<div class="note op-item__more">+' + (rows.length - OP_ITEMS_MAX) +
          ' more on the punch list</div>'
        : '') +
      '</div>'
  }

  /** The reader-facing name of a status code. */
  function statusText(code) {
    var out = code
    STATUS_SET_OPTS.forEach(function (pair) {
      if (pair[0] === code) out = pair[1]
    })
    return out
  }

  function opSection(key, label, body) {
    return '<details class="op-sec" data-op="' + esc(key) + '"' +
      (openSections().indexOf(key) !== -1 ? ' open' : '') + '>' +
      '<summary class="op-sec__head">' + label + '</summary>' +
      '<div class="op-sec__body">' + body + '</div></details>'
  }

  function buildOnePageTab(bridge) {
    if (onePagePanel) return
    var main = document.querySelector('main')
    var nav = document.querySelector('.masthead .tabs')
    if (!main || !nav || typeof panels !== 'object' || !panels) return

    onePagePanel = el('div', 'panel')
    onePagePanel.id = 'panel-onepage'
    onePagePanel.innerHTML =
      '<section id="onepage-items"></section>' +
      '<section id="onepage-cal" class="no-check"></section>' +
      '<section id="inbox-slot"></section>' +
      '<section id="onepage-mail"></section>'
    main.appendChild(onePagePanel)
    panels.onepage = onePagePanel

    var btn = el('button', 'tab-btn')
    btn.type = 'button'
    btn.setAttribute('role', 'tab')
    btn.dataset.panel = 'onepage'
    btn.setAttribute('aria-selected', 'false')
    // No count: this tab is every other tab at once, and no single number
    // says anything true about that.
    btn.innerHTML = '🗓️ ' + esc(todayLabel())
    btn.addEventListener('click', function () {
      if (typeof switchTab === 'function') switchTab('onepage')
    })
    // First, and where you land: it is the whole digest on one page, so it is
    // the answer to "what is going on" — the other tabs are where you go to
    // work on one part of it.
    nav.insertBefore(btn, nav.firstChild)

    // Remember which disclosures were open, so returning to the page does not
    // fold everything back up.
    onePagePanel.addEventListener('toggle', function (e) {
      var sec = e.target.closest('.op-sec')
      if (sec) rememberSection(sec.dataset.op, sec.open)
    }, true)
  }

  function renderOnePage(events, mail) {
    if (!onePagePanel) return
    var now = Date.now()
    var horizon = now + CAL_LOOKAHEAD_DAYS * 86400000
    var future = (events || []).filter(function (ev) {
      var t = new Date(ev.start).getTime()
      return isFinite(t) && t >= now && t <= horizon && eventPasses(ev)
    })

    var tabBtn = document.querySelector('.tab-btn[data-panel="onepage"]')
    if (tabBtn && tabBtn.textContent.trim() !== '🗓️ ' + todayLabel()) {
      tabBtn.textContent = '🗓️ ' + todayLabel()
    }

    document.getElementById('onepage-items').innerHTML = onePageItemsHtml()

    document.getElementById('onepage-cal').innerHTML =
      '<div class="section-head"><h2>📅 Calendar</h2>' +
      '<span class="sub">The next ' + CAL_LOOKAHEAD_DAYS +
      ' days · open any section for the detail the Calendar tab shows</span></div>' +
      keyDatesHtml(events) +
      opSection('deadlines', '⏱️ Deadlines', deadlinesHtml(future)) +
      opSection('meetings', '🤝 Meetings', meetingsHtml(future)) +
      opSection('planning', '🧭 Suggested planning', travelHtml(future)) +
      // The load view without its category picker: that picker drives the
      // Calendar tab's own render, and a second copy here would move a
      // selection the reader cannot see.
      opSection('load', '⚖️ Load balancing', hoursDashboardHtml(future))

    renderInbox(mail)

    // The same emails-by-category board the Inbox tab shows. It is the bulk of
    // what "today" actually consists of, so a page claiming to be today
    // without it is a summary of everything except the mail.
    var mailHostEl = document.getElementById('onepage-mail')
    if (mailHostEl) mailHostEl.innerHTML = mailByCategoryHtml(mail, false, [])
  }

  // ---- printable punch list ------------------------------------------------

  /**
   * A punch list you can put on paper.
   *
   * Printing the app itself gives you a dark screenshot with a sticky masthead
   * across the middle of it, so this composes a plain light document in a new
   * window instead: the open items, hardest first, with a box to tick, the
   * deadline, the category and who is holding it. Grouped by severity, because
   * on paper that is the order you work them in and there is no filter to
   * reach for.
   */
  function printableHtml() {
    var rows = []
    try {
      Object.keys(STATE.punchlist || {}).forEach(function (id) {
        var e = STATE.punchlist[id]
        if (!e || e.done) return
        var d = deadlineFrom(e.title)
        rows.push({
          title: e.title,
          sev: e.severity || 'low',
          cat: e.category || 'personal',
          status: statusText(statusOf(id)),
          days: d ? d.days : null,
          subs: (e.subs || []).slice(),
          added: e.addedAt || '',
        })
      })
    } catch (err) {}

    rows.sort(function (a, b) {
      var d = (OP_SEV_ORDER[a.sev] === undefined ? 9 : OP_SEV_ORDER[a.sev]) -
        (OP_SEV_ORDER[b.sev] === undefined ? 9 : OP_SEV_ORDER[b.sev])
      if (d !== 0) return d
      if (a.days === null && b.days === null) return 0
      if (a.days === null) return 1
      if (b.days === null) return -1
      return a.days - b.days
    })

    var GROUPS = [
      { key: 'critical', label: 'Critical' },
      { key: 'high', label: 'High' },
      { key: 'medium', label: 'Medium' },
      { key: 'low', label: 'Low' },
    ]

    var body = GROUPS.map(function (g) {
      var list = rows.filter(function (r) { return r.sev === g.key })
      if (!list.length) return ''
      return '<h2 class="grp grp--' + g.key + '">' + esc(g.label) +
        ' <span class="grp__n">' + list.length + '</span></h2>' +
        '<table><thead><tr>' +
        '<th class="c-box"></th><th class="c-due">Due</th><th>Item</th>' +
        '<th class="c-cat">Category</th><th class="c-st">Status</th>' +
        '</tr></thead><tbody>' +
        list.map(function (r) {
          var meta = CATEGORY_META[r.cat] || { label: r.cat }
          return '<tr>' +
            '<td class="c-box"><span class="box"></span></td>' +
            '<td class="c-due">' +
            (r.days === null ? '—' : r.days === 0 ? 'today' : 'in ' + r.days + 'd') +
            '</td>' +
            '<td class="c-item">' + esc(r.title) +
            (r.subs.length
              ? '<ul>' + r.subs.map(function (x) {
                  return '<li>' + esc(typeof x === 'string' ? x : (x && x.text) || '') + '</li>'
                }).join('') + '</ul>'
              : '') +
            '</td>' +
            '<td class="c-cat">' + esc(meta.label) + '</td>' +
            '<td class="c-st">' + esc(String(r.status).replace(/^[^A-Za-z]+/, '')) + '</td>' +
            '</tr>'
        }).join('') +
        '</tbody></table>'
    }).join('')

    var mine = rows.filter(function (r) { return /my court/i.test(r.status) }).length

    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<title>Punch list — ' + esc(todayLabel()) + '</title><style>' +
      '*{box-sizing:border-box}' +
      'body{margin:0;padding:28px 32px;font:13px/1.5 -apple-system,BlinkMacSystemFont,' +
      '"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111;background:#fff}' +
      'h1{margin:0 0 2px;font-size:21px}' +
      '.meta{margin:0 0 22px;color:#555;font-size:12px}' +
      '.grp{margin:22px 0 8px;font-size:13px;text-transform:uppercase;' +
      'letter-spacing:.08em;padding-bottom:4px;border-bottom:2px solid #111}' +
      '.grp--critical{border-color:#b91c1c;color:#b91c1c}' +
      '.grp--high{border-color:#b45309;color:#b45309}' +
      '.grp--medium{border-color:#1d4ed8;color:#1d4ed8}' +
      '.grp--low{border-color:#15803d;color:#15803d}' +
      '.grp__n{float:right;font-size:12px;color:#555}' +
      'table{width:100%;border-collapse:collapse;margin-bottom:6px}' +
      'th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.06em;' +
      'color:#666;padding:0 8px 5px;border-bottom:1px solid #ddd}' +
      'td{padding:8px;border-bottom:1px solid #eee;vertical-align:top}' +
      'tr{page-break-inside:avoid}' +
      '.c-box{width:26px}.c-due{width:62px;white-space:nowrap;color:#444}' +
      '.c-cat{width:120px;color:#444}.c-st{width:118px;color:#444}' +
      '.c-item{font-weight:600}' +
      '.c-item ul{margin:4px 0 0 16px;padding:0;font-weight:400;color:#444;font-size:12px}' +
      '.box{display:block;width:13px;height:13px;border:1.5px solid #333;border-radius:3px}' +
      '.none{color:#666;font-style:italic}' +
      '@page{margin:14mm}' +
      '@media print{body{padding:0}}' +
      '</style></head><body>' +
      '<h1>Punch list</h1>' +
      '<p class="meta">' + esc(todayLabel()) + ' · ' + rows.length +
      (rows.length === 1 ? ' open item' : ' open items') + ' · ' + mine +
      ' in your court</p>' +
      (body || '<p class="none">Nothing open — everything on the punch list is closed.</p>') +
      '</body></html>'
  }

  function printPunchList() {
    var w = window.open('', '_blank')
    if (!w) {
      setStatus('The browser blocked the print window — allow popups for this site', 'warn')
      return
    }
    w.document.write(printableHtml())
    w.document.close()
    // Let the new document lay out before the print dialog measures it.
    w.setTimeout(function () { w.focus(); w.print() }, 300)
  }

  // ---- Monitor tab: filters, thread timelines, history --------------------

  var STATUS_FILTERS = [
    ['', 'Any status'],
    ['done', '✅ Completed'],
    ['closed', '🚫 Closed — not needed'],
    ['waiting', '⏳ Waiting on reply'],
    ['court', '➡️ In their court'],
    ['fwd', '📤 Forwarded'],
    ['remind', '⏰ Reminder set'],
    ['none', '— not set (in my court)'],
  ]
  var STATUS_SET_OPTS = [
    ['court', '➡️ In my court'],
    ['done', '✅ Completed'],
    ['closed', '🚫 Closed — not needed'],
    ['waiting', '⏳ Waiting on reply'],
    ['fwd', '📤 Forwarded'],
    ['remind', '⏰ Reminder set'],
  ]
  var DONE_FILTERS = [
    ['open', 'Open only'],
    ['done', 'Completed or closed'],
    ['all', 'Everything'],
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

      '<select class="own-in own-in--sel mon-sev"><option value="">Any severity</option>' +
      optionsHtml(SEVERITY_OPTS, '_none_') + '</select>' +
      '<select class="own-in own-in--sel mon-done">' + optionsHtml(DONE_FILTERS, 'open') + '</select>' +
      '<button type="button" class="live-btn mon-clear">Clear</button>' +
      '<button type="button" class="live-btn mon-print" title="Open a clean, light-background copy of the open items and print it">🖨️ Printable version</button>' +
      '</div>' +
      '<div class="mon-count"></div>' +
      '<div class="mon-results"></div>'

    // Above the add-item form and the page's own grouped list.
    var form = document.getElementById('own-form')
    punch.insertBefore(monitorPanel, form || root)

    ;['.mon-q', '.mon-status', '.mon-sev', '.mon-done'].forEach(function (sel) {
      var node = monitorPanel.querySelector(sel)
      node.addEventListener(sel === '.mon-q' ? 'input' : 'change', function () {
        renderMonitor(bridge)
      })
    })
    monitorPanel.querySelector('.mon-clear').addEventListener('click', function () {
      monitorPanel.querySelector('.mon-q').value = ''
      monitorPanel.querySelector('.mon-status').value = ''
      monitorPanel.querySelector('.mon-sev').value = ''
      monitorPanel.querySelector('.mon-done').value = 'open'
      renderMonitor(bridge)
    })

    monitorPanel.querySelector('.mon-print').addEventListener('click', printPunchList)

    monitorPanel.addEventListener('click', function (e) {
      var toggle = e.target.closest('.mon-thread-toggle')
      if (toggle) { loadThread(bridge, toggle.dataset.id, toggle.dataset.email); return }

      var done = e.target.closest('.mon-done-btn')
      if (done) { setDone(bridge, done.dataset.id, done.dataset.state !== 'done', false); return }

      var shut = e.target.closest('.mon-close-btn')
      if (shut) { setDone(bridge, shut.dataset.id, true, true); return }

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
  function setDone(bridge, id, done, dismissed) {
    try {
      var e = STATE.punchlist[id]
      if (!e) return
      e.done = !!done
      e.dismissed = !!(done && dismissed)
      e.doneAt = done
        ? new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : null
      e.doneTs = done ? new Date().toISOString() : null
      var m2 = mailMeta[id]
      if (done && m2 && m2.threadId) e.threadId = m2.threadId
      persistPage()
      if (typeof renderPunchList === 'function') renderPunchList()
      // Completion hides the item wherever it appears, so reopening has to
      // bring it back — without this, closing is a one-way door.
      applyClosed()
      renderMonitor(bridge)
      renderStats(lastData.events, lastData.mail)
      renderTopActions()
      refreshTabCounts()
    } catch (err) {}
  }

  function setItemStatus(bridge, id, value) {
    try {
      // "Completed" is not a forward status — it is the done flag. Routing it
      // through setDone keeps one source of truth for completion, so an item
      // marked complete here also disappears from its band and stops counting.
      if (value === 'done') { setDone(bridge, id, true, false); return }
      if (value === 'closed') { setDone(bridge, id, true, true); return }
      if (isClosed(id)) setDone(bridge, id, false, false)
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
    if (isDismissed(id)) return 'closed'
    if (isClosed(id)) return 'done'
    return rawStatus(id) || DEFAULT_STATUS
  }

  function matches(id, entry, f) {
    if (f.q && String(entry.title || '').toLowerCase().indexOf(f.q) === -1) return false
    if (f.status === 'none' && rawStatus(id)) return false
    if (f.status && f.status !== 'none' && statusOf(id) !== f.status) return false
    if (f.sev && entry.severity !== f.sev) return false
    // Asking for Completed or Closed by status is already asking for items
    // that are off the list, so the open/done filter must not then hide them —
    // otherwise picking "🚫 Closed" reliably returns nothing.
    if (f.status === 'done' || f.status === 'closed') return true
    if (f.done === 'open' && entry.done) return false
    if (f.done === 'done' && !entry.done) return false
    return true
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
      sev: monitorPanel.querySelector('.mon-sev').value,
      done: monitorPanel.querySelector('.mon-done').value,
    }

    var entries = []
    try {
      Object.keys(STATE.punchlist || {}).forEach(function (id) {
        var entry = STATE.punchlist[id]
        if (entry && entryPasses(entry) && matches(id, entry, f)) entries.push([id, entry])
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
      (e.done ? '' :
        '<button type="button" class="mon-act mon-close-btn" data-id="' + esc(id) +
        '" title="Not needed — close this without marking it done">✕ Close</button>') +
      '<button type="button" class="mon-act mon-edit" data-id="' + esc(id) + '">✏️ Edit</button>' +
      '<select class="mon-act mon-status-set" data-id="' + esc(id) + '" title="Forward status">' +
      STATUS_SET_OPTS.map(function (o) {
        return '<option value="' + o[0] + '"' + (o[0] === st ? ' selected' : '') + '>' + esc(o[1]) + '</option>'
      }).join('') +
      '</select>' +
      (e.done
        ? '<span class="mon-chip mon-chip--done">' +
          (e.dismissed ? '🚫 closed ' : 'done ') + esc(e.doneAt || '') + '</span>'
        : '') +
      (own.items[id] ? '<span class="mon-chip">yours</span>' : '') +
      (e.reopenedAt && !e.done
        ? '<span class="mon-chip mon-chip--wait">↩︎ reopened — new reply</span>'
        : '') +
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

        indexMail(mailItems)
        var reopened = reopenOnReply(bridge, mailItems)
        autoDraft(bridge, mailItems, newMail)

        renderDaily(mailItems, mail.mock, newMail)
        refreshMailboxCounts(bridge)
        rewirePage()
        lastData = { events: eventItems, mail: mailItems }
        renderCalendar(eventItems)
        renderOnePage(eventItems, mailItems)
        renderMonitor(bridge)
        renderStats(eventItems, mailItems)
        refreshTabCounts()

        // Only a sync that actually reached both services should redefine the
        // baseline; recording a failed one would swallow the diff.
        if (!mail.error && !events.error) {
          saveSeen(mailIds, eventIds)
          writeStored(LAST_SYNC_KEY, new Date().toISOString())
        }
        renderSyncStamp(newMail, newEvents)

        syncScrollPadding()
        lastSyncAt = Date.now()

        renderSyncButton(bridge.status())

        // Tell the app's header which service is failing. A granted scope
        // whose API still errors is not "connected" in any sense the reader
        // cares about, and the chip is the only place they can act on it.
        try {
          if (window.parent && window.parent !== window) {
            window.parent.dispatchEvent(new CustomEvent('nexus:google-service-error', {
              detail: {
              gmail: mail.error || '',
              // A partial read is a problem you must be able to see: the
              // events on screen are real, and the ones missing look exactly
              // like a quiet fortnight.
              calendar: events.error || events.warning || '',
            },
            }))
          }
        } catch (e) {}

        // Folded into the final status line rather than set here: the
        // success branch below runs after this and would overwrite it.
        var reopenNote = reopened.length
          ? ' · ↩︎ ' + reopened.length + ' reopened by a reply'
          : ''

        // Report per-service failures against the service that failed, so a
        // working inbox is not hidden behind a calendar problem — and say
        // which KIND of failure it is, because that decides what to do about
        // it: signing in again fixes a refused scope and does nothing at all
        // for an API that is switched off in Google Cloud.
        var errors = []
        if (mail.error) errors.push('Gmail: ' + mail.error)
        if (events.error) errors.push('Calendar: ' + events.error)
        else if (events.warning) errors.push('Calendar: ' + events.warning)
        var config = [mail.error, events.error].some(function (e) {
          return e && errorKind(e) === 'config'
        })

        if (errors.length) {
          setStatus(
            errors.join(' · ') +
              (config
                ? ' — signing in again will not help; enable the API in Google Cloud, then Sync now'
                : ' — reconnect from the header to be asked for access again'),
            'warn',
          )
        } else if (mock) {
          setStatus(
            'Sample data · ' + syncedAt() + reopenNote +
              ' — add a Google Client ID in Nexus settings for live mail and calendar',
            'mock',
          )
        } else {
          setStatus(
            (mail.items || []).length + ' messages · ' +
              (events.items || []).length + ' events · ' + syncedAt() + autoNote() + reopenNote,
            reopenNote ? 'mock' : 'ok',
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
      if (syncBtn) syncBtn.hidden = true
      setStatus('Open this page inside Nexus for live Gmail and Calendar data', 'idle')
      if (rangeSel) rangeSel.disabled = true
      if (customDays) customDays.hidden = true
      return
    }

    // Connecting Google is the app top bar's job now; this frame only reports
    // what the connection is doing. But it has to LEARN when that happens:
    // moving the control out of here removed the click that used to trigger
    // the first sync, so listen for the grant the app broadcasts instead.
    try {
      if (window.parent && window.parent !== window) {
        window.parent.addEventListener('nexus:google-token', function () {
          renderSyncButton(bridge.status())
          startAutoSync(bridge)
          sync(bridge)
        })
      }
    } catch (e) {
      /* standalone page — nothing to listen to */
    }

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
      if (close) {
        closeItem(
          bridge,
          close.dataset.closeId,
          close.closest('[data-check-id]'),
          close.classList.contains('dismiss-btn'),
        )
        return
      }

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
      var read = e.target.closest('.live-read')
      if (read) { markRead(bridge, read.dataset.mid, read); return }

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
      toTop()
      renderStats(lastData.events, lastData.mail)
    })

    buildOnePageTab(bridge)
    // After the added tabs exist — renaming a button that has not been built
    // yet silently does nothing.
    retabs()
    buildOwnForm(bridge)
    buildMonitorTab(bridge)
    applyOwnItems()
    renderMonitor(bridge)
    renderSyncStamp([], [])
    renderStats([], [])
    publishDigestApi()
    hideOwnTabs()
    wirePrepBlocks()
    renderCalendar([])
    renderOnePage([], [])
    renderDrafts(bridge)
    renderTopActions()
    watchPunchList(bridge)

    // Land on the one-page view: it is the whole digest at once, so it is the
    // sensible thing to open on. Done after every tab exists, or switchTab
    // would be asked for a panel that has not been built.
    try {
      if (typeof switchTab === 'function') {
        switchTab('onepage')
        activeTab = 'onepage'
      }
    } catch (e) {}

    var st = bridge.status()
    renderSyncButton(st)

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
