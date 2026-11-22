/*
 * FinAI – התראת "הזדמנות השקעה חדשה" + צליל כסף נכנס.
 *
 * קובץ עצמאי (ללא תלויות) שנטען בכל מסך:
 *   <script src="../shared/opportunity-alert.js" defer></script>
 *
 * API:
 *   FinAIAlerts.notifyNewOpportunity({ id, version, symbol, name, exchange,
 *                                      scope, amount, currency, createdAt })
 *   FinAIAlerts.setAvailability(true|false)   // לא זמין -> ההתראה נשמרת ומוצגת בחזרה
 *   FinAIAlerts.setMuted(true|false)
 *   FinAIAlerts.playCashSound()
 *   FinAIAlerts.demo()                        // התראת הדגמה
 *
 * כללי ה-PRD שנשמרים כאן:
 *  - פתיחת התראה מובילה למסך ההמלצה (בדיקה מחודשת), לעולם לא לביצוע.
 *  - מבחינים בין נשלחה / נפתחה / בוצעה (נרשם ב-localStorage).
 *  - כשהמשתמש לא זמין לא מוצגת הזדמנות שמחייבת תגובה; היא נשמרת לחזרה.
 *  - "כסף מדומה" מסומן בבירור, ומוצגת חותמת זמן להמלצה.
 *  - חלון תגובה עד שעה אינו הבטחת תוקף.
 */
(function () {
  'use strict';
  if (window.FinAIAlerts) return;

  var LOG_KEY = 'finai.notifications';
  var MUTE_KEY = 'finai.alerts.muted';
  var AVAIL_KEY = 'finai.availability';
  var QUEUE_KEY = 'finai.alerts.queue';
  var DEMO_KEY = 'finai.alerts.demoShown';
  var RECOMMENDATION_URL = '03-recommendation.html';

  /* ---------- storage (best effort) ---------- */
  function read(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }
  function logStatus(alert, status) {
    var log = read(LOG_KEY, []);
    log.push({ id: alert.id, version: alert.version, status: status, at: new Date().toISOString() });
    write(LOG_KEY, log.slice(-200));
  }

  /* ---------- formatting ---------- */
  var nf = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });
  function money(amount, currency) {
    var sign = currency === 'USD' ? '$' : '₪';
    return sign + nf.format(amount);
  }
  function hhmm(date) {
    return new Intl.DateTimeFormat('he-IL', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem'
    }).format(date);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- sound: "cha-ching" synthesized with Web Audio ---------- */
  var ctx = null;
  function audio() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    return ctx;
  }
  // דפדפנים חוסמים צליל עד לאינטראקציה ראשונה – פותחים את ההקשר בלחיצה הראשונה.
  var pendingSoundUntil = 0; // התראה הגיעה לפני שהצליל אופשר – נשמיע בלחיצה הבאה
  function unlock() {
    var c = audio();
    if (!c) return;
    var p = c.state === 'suspended' ? c.resume() : Promise.resolve();
    p.then(function () {
      if (pendingSoundUntil && Date.now() < pendingSoundUntil) {
        pendingSoundUntil = 0;
        playCashSound();
      }
    });
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  });
  function audioReady() { return !!ctx && ctx.state === 'running'; }

  function bell(c, out, t, freq, dur, gain) {
    // פעמון: תדר יסוד + עליונים לא-הרמוניים, דעיכה מהירה
    [[1, 1], [2.76, 0.45], [5.4, 0.22], [8.93, 0.1]].forEach(function (p) {
      var o = c.createOscillator();
      var g = c.createGain();
      o.type = 'sine';
      o.frequency.value = freq * p[0];
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain * p[1], t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur / p[0] * 1.5);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + dur + 0.05);
    });
  }
  function click(c, out, t, gain) {
    // "קליק" של מגירת קופה: פרץ רעש קצר מסונן
    var len = Math.floor(c.sampleRate * 0.04);
    var buf = c.createBuffer(1, len, c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    var src = c.createBufferSource();
    src.buffer = buf;
    var f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2500;
    var g = c.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(out);
    src.start(t);
  }
  function coins(c, out, t) {
    // צלצול מטבעות קטן אחרי הפעמון
    for (var i = 0; i < 6; i++) {
      bell(c, out, t + i * 0.045 + Math.random() * 0.02, 3200 + Math.random() * 1800, 0.12, 0.05);
    }
  }
  function playCashSound() {
    if (read(MUTE_KEY, false)) return false;
    var c = audio();
    if (!c) return false;
    if (c.state === 'suspended') c.resume();
    if (c.state !== 'running') return false;
    var master = c.createGain();
    master.gain.value = 0.35;
    master.connect(c.destination);
    var t = c.currentTime + 0.02;
    click(c, master, t, 0.9);              // צ׳-
    bell(c, master, t + 0.06, 1318.5, 0.35, 0.35); // -צ׳ינג (E6)
    bell(c, master, t + 0.17, 1760, 0.9, 0.45);    // (A6) צלצול ארוך
    coins(c, master, t + 0.3);
    return true;
  }

  /* ---------- styles ---------- */
  var css = [
    '.finai-alerts{position:fixed;inset-block-start:16px;inset-inline-end:16px;z-index:9999;display:flex;flex-direction:column;gap:12px;width:min(380px,calc(100vw - 32px));font-family:Rubik,system-ui,sans-serif;direction:rtl}',
    '.finai-alert{background:#1c1f29;color:#dfe2ef;border:1px solid #3c4a42;border-inline-start:4px solid #10b981;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.45);padding:14px 16px;animation:finai-in .28s ease-out}',
    '.finai-alert.finai-out{animation:finai-out .2s ease-in forwards}',
    '@keyframes finai-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}',
    '@keyframes finai-out{to{opacity:0;transform:translateY(-8px)}}',
    '@media (prefers-reduced-motion:reduce){.finai-alert,.finai-alert.finai-out{animation:none}}',
    '.finai-row{display:flex;align-items:center;gap:8px}',
    '.finai-head{justify-content:space-between;margin-block-end:8px}',
    '.finai-title{font-weight:700;font-size:15px;color:#4edea3;display:flex;align-items:center;gap:6px}',
    '.finai-badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:rgba(255,185,95,.14);color:#ffb95f;border:1px solid rgba(255,185,95,.4);white-space:nowrap}',
    '.finai-body{font-size:14px;line-height:1.5}',
    '.finai-body strong{color:#fff}',
    '.finai-num{font-variant-numeric:tabular-nums;direction:ltr;unicode-bidi:isolate}',
    '.finai-meta{font-size:12px;color:#bbcabf;margin-block-start:6px;line-height:1.5}',
    '.finai-note{font-size:11px;color:#86948a;margin-block-start:6px}',
    '.finai-actions{display:flex;gap:8px;margin-block-start:12px;flex-wrap:wrap}',
    '.finai-btn{font:inherit;font-size:13px;font-weight:600;border-radius:6px;padding:7px 12px;cursor:pointer;border:1px solid #3c4a42;background:transparent;color:#dfe2ef}',
    '.finai-btn:hover{background:#262a34}',
    '.finai-btn:focus-visible{outline:2px solid #4edea3;outline-offset:2px}',
    '.finai-btn-primary{background:#10b981;border-color:#10b981;color:#00422b}',
    '.finai-btn-primary:hover{background:#4edea3}',
    '.finai-icon-btn{font:inherit;background:none;border:0;color:#bbcabf;cursor:pointer;padding:2px;border-radius:4px;line-height:0}',
    '.finai-icon-btn:hover{color:#fff}',
    '.finai-icon-btn:focus-visible{outline:2px solid #4edea3}',
    '.finai-ms{font-family:"Material Symbols Outlined";font-size:18px;font-weight:normal;font-style:normal;line-height:1;letter-spacing:normal;text-transform:none;white-space:nowrap;direction:ltr;-webkit-font-feature-settings:"liga";font-feature-settings:"liga"}',
    '.finai-bell-count{position:absolute;inset-block-start:-2px;inset-inline-end:-4px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:#10b981;color:#00422b;font:700 10px/16px Rubik,sans-serif;text-align:center;font-variant-numeric:tabular-nums;pointer-events:none}',
    '.finai-bell-ring{animation:finai-ring .9s ease-in-out 2}',
    '@keyframes finai-ring{0%,100%{transform:rotate(0)}20%{transform:rotate(14deg)}40%{transform:rotate(-12deg)}60%{transform:rotate(8deg)}80%{transform:rotate(-4deg)}}',
    '@media (prefers-reduced-motion:reduce){.finai-bell-ring{animation:none}}'
  ].join('\n');

  function ensureUI() {
    if (!document.getElementById('finai-alert-style')) {
      var s = document.createElement('style');
      s.id = 'finai-alert-style';
      s.textContent = css;
      document.head.appendChild(s);
    }
    var box = document.querySelector('.finai-alerts');
    if (!box) {
      box = document.createElement('div');
      box.className = 'finai-alerts';
      box.setAttribute('role', 'region');
      box.setAttribute('aria-label', 'התראות');
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    return box;
  }

  /* ---------- bell icon in the header ---------- */
  function findBell() {
    var icons = document.querySelectorAll('.material-symbols-outlined');
    for (var i = 0; i < icons.length; i++) {
      var t = icons[i].textContent.trim();
      if (t === 'notifications' || t === 'notifications_active') {
        var host = icons[i].closest('button, a');
        if (host && !host.closest('nav, aside')) return host;
      }
    }
    return null;
  }
  var unread = 0;
  function bumpBell(delta) {
    unread = Math.max(0, unread + delta);
    var bell = findBell();
    if (!bell) return;
    if (getComputedStyle(bell).position === 'static') bell.style.position = 'relative';
    var badge = bell.querySelector('.finai-bell-count');
    if (!unread) { if (badge) badge.remove(); return; }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'finai-bell-count';
      bell.appendChild(badge);
    }
    badge.textContent = unread;
    bell.setAttribute('aria-label', 'התראות – ' + unread + ' חדשות');
    if (delta > 0) {
      var icon = bell.querySelector('.material-symbols-outlined');
      if (icon) {
        icon.classList.remove('finai-bell-ring');
        void icon.offsetWidth;
        icon.classList.add('finai-bell-ring');
      }
    }
  }

  /* ---------- the alert card ---------- */
  var SCOPE_LABEL = { short: 'טווח קצר', medium: 'טווח בינוני' };

  function render(alert) {
    var box = ensureUI();
    var el = document.createElement('div');
    el.className = 'finai-alert';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-label', 'הזדמנות השקעה חדשה');
    var created = new Date(alert.createdAt);
    var muted = read(MUTE_KEY, false);

    el.innerHTML =
      '<div class="finai-row finai-head">' +
        '<span class="finai-title"><span class="finai-ms" aria-hidden="true">savings</span>הזדמנות השקעה חדשה</span>' +
        '<span class="finai-row">' +
          '<span class="finai-badge">כסף מדומה</span>' +
          '<button type="button" class="finai-icon-btn" data-act="mute" aria-pressed="' + muted + '" title="' + (muted ? 'הפעלת צליל' : 'השתקת צליל') + '">' +
            '<span class="finai-ms" aria-hidden="true">' + (muted ? 'volume_off' : 'volume_up') + '</span></button>' +
          '<button type="button" class="finai-icon-btn" data-act="close" title="סגירה"><span class="finai-ms" aria-hidden="true">close</span></button>' +
        '</span>' +
      '</div>' +
      '<div class="finai-body">סוכן ד׳ ממליץ לשקול קנייה של <strong>' + esc(alert.name) + ' (' + esc(alert.symbol) + ')</strong>' +
        ' · ' + esc(alert.exchange) + '<br>סכום מוצע: <strong class="finai-num">' + money(alert.amount, alert.currency) + '</strong>' +
        ' · ' + esc(SCOPE_LABEL[alert.scope] || alert.scope) + '</div>' +
      '<div class="finai-meta">הופקה ב-<span class="finai-num">' + hhmm(created) + '</span> · ' +
        '<span class="finai-num">' + esc(alert.id) + '</span> גרסה <span class="finai-num">' + esc(alert.version) + '</span><br>' +
        'חלון תגובה עד שעה – אינו הבטחת תוקף.</div>' +
      '<div class="finai-note">פתיחה מציגה בדיקה מחודשת לפי נתונים עדכניים. אין ביצוע אוטומטי.</div>' +
      '<div class="finai-actions">' +
        '<button type="button" class="finai-btn finai-btn-primary" data-act="open">לצפייה בהמלצה</button>' +
        '<button type="button" class="finai-btn" data-act="later">אחר כך</button>' +
      '</div>';

    function dismiss() {
      el.classList.add('finai-out');
      setTimeout(function () { el.remove(); }, 220);
    }

    el.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'open') {
        logStatus(alert, 'opened');
        bumpBell(-1);
        // מסך ההמלצה (בדיקה מחודשת) – לא מסך הביצוע
        var url = RECOMMENDATION_URL + '?rec=' + encodeURIComponent(alert.id) + '&v=' + encodeURIComponent(alert.version);
        if (/03-recommendation\.html$/.test(location.pathname)) dismiss();
        else location.href = url;
      } else if (act === 'later' || act === 'close') {
        dismiss(); // נשאר לא נקרא בפעמון ובמרכז ההתראות
      } else if (act === 'mute') {
        var m = !read(MUTE_KEY, false);
        write(MUTE_KEY, m);
        btn.setAttribute('aria-pressed', String(m));
        btn.title = m ? 'הפעלת צליל' : 'השתקת צליל';
        btn.querySelector('.finai-ms').textContent = m ? 'volume_off' : 'volume_up';
        if (!m) playCashSound();
      }
    });

    box.prepend(el);
    return el;
  }

  /* ---------- public API ---------- */
  function normalize(a) {
    a = a || {};
    return {
      id: a.id || 'REC-' + Date.now(),
      version: a.version || 1,
      symbol: a.symbol || '',
      name: a.name || a.symbol || '',
      exchange: a.exchange || '',
      scope: a.scope || 'short',
      amount: Number(a.amount) || 0,
      currency: a.currency || 'ILS',
      createdAt: a.createdAt || new Date().toISOString()
    };
  }

  function show(alert) {
    logStatus(alert, 'sent');
    render(alert);
    bumpBell(1);
    if (!playCashSound() && !read(MUTE_KEY, false)) pendingSoundUntil = Date.now() + 30000;
  }

  function notifyNewOpportunity(raw) {
    var alert = normalize(raw);
    if (!read(AVAIL_KEY, true)) {
      // לא זמין: לא מציגים הזדמנות שמחייבת תגובה. שומרים להצגה בחזרה.
      var q = read(QUEUE_KEY, []);
      q.push(alert);
      write(QUEUE_KEY, q);
      return { shown: false, queued: true };
    }
    show(alert);
    return { shown: true, queued: false };
  }

  function setAvailability(available) {
    write(AVAIL_KEY, !!available);
    if (available) {
      var q = read(QUEUE_KEY, []);
      write(QUEUE_KEY, []);
      // בחזרה: ההמלצות שנשמרו יעברו בדיקה מחודשת במסך ההמלצה
      q.forEach(show);
    }
  }

  function demo() {
    return notifyNewOpportunity({
      id: 'REC-26-084', version: 2, symbol: 'NICE', name: 'נייס בע״מ',
      exchange: 'TASE', scope: 'short', amount: 3200, currency: 'ILS'
    });
  }

  window.FinAIAlerts = {
    notifyNewOpportunity: notifyNewOpportunity,
    setAvailability: setAvailability,
    setMuted: function (m) { write(MUTE_KEY, !!m); },
    playCashSound: playCashSound,
    audioReady: audioReady,
    demo: demo
  };

  /* ---------- demo trigger ----------
   * ?demo-alert בכתובת – מציג התראת הדגמה מיד.
   * בדף הבית – התראת הדגמה אחת לכל סשן, 5 שניות אחרי הטעינה.
   */
  function boot() {
    var params = new URLSearchParams(location.search);
    if (params.has('demo-alert')) { demo(); return; }
    if (/02-home/.test(location.pathname)) {
      var seen = false;
      try { seen = sessionStorage.getItem(DEMO_KEY) === '1'; } catch (e) { /* ignore */ }
      if (!seen) {
        setTimeout(function () {
          try { sessionStorage.setItem(DEMO_KEY, '1'); } catch (e) { /* ignore */ }
          demo();
        }, 5000);
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
