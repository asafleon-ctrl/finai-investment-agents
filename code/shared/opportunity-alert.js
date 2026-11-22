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
  function logStatus(alert, status, extra) {
    var log = read(LOG_KEY, []);
    var entry = { id: alert.id, version: alert.version, status: status, at: new Date().toISOString() };
    if (extra) Object.keys(extra).forEach(function (k) { entry[k] = extra[k]; });
    log.push(entry);
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

  /* ---------- sound: "קצ'ינגגג" – קופה רושמת, מסונתז ב-Web Audio ---------- */
  var ctx = null;
  function audio() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
    }
    return ctx;
  }
  // יוצרים את ההקשר כבר בטעינה: אם המשתמש לחץ בעמוד קודם באתר, הדפדפן מתיר צליל מיד.
  audio();

  // האם הדפדפן מתיר כרגע צליל בלי לחיצה נוספת
  function soundAllowed() {
    try {
      if (navigator.getAutoplayPolicy) return navigator.getAutoplayPolicy('audiocontext') === 'allowed';
    } catch (e) { /* ignore */ }
    var c = audio();
    return !!c && c.state === 'running';
  }

  // דפדפנים חוסמים צליל עד לאינטראקציה ראשונה בעמוד. בלחיצה הראשונה פותחים את ההקשר.
  var pendingSoundUntil = 0;     // התראה הגיעה לפני שהצליל אופשר – נשמיע בלחיצה הבאה
  var onUnlock = [];
  function unlock() {
    var c = audio();
    if (!c) return;
    var p = c.state === 'suspended' ? c.resume() : Promise.resolve();
    p.then(function () {
      if (pendingSoundUntil && Date.now() < pendingSoundUntil) {
        pendingSoundUntil = 0;
        playCashSound();
      }
      var q = onUnlock; onUnlock = [];
      q.forEach(function (fn) { fn(); });
    });
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  });
  function whenSoundAllowed(fn) {
    if (soundAllowed()) fn(); else onUnlock.push(fn);
  }
  function audioReady() { return !!ctx && ctx.state === 'running'; }

  function noiseBuffer(c, seconds) {
    var len = Math.floor(c.sampleRate * seconds);
    var buf = c.createBuffer(1, len, c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  function env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }
  function noiseHit(c, out, t, type, freq, q, peak, decay) {
    var src = c.createBufferSource();
    src.buffer = noiseBuffer(c, decay + 0.05);
    var f = c.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    var g = c.createGain();
    env(g, t, peak, 0.002, decay);
    src.connect(f).connect(g).connect(out);
    src.start(t);
  }
  function tone(c, out, t, freq, type, peak, attack, decay, detuneCents) {
    var o = c.createOscillator();
    var g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    if (detuneCents) o.detune.value = detuneCents;
    env(g, t, peak, attack, decay);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
  }

  // "קַ" – לחיצת מקש וקפיצת ידית הקופה: נקישה מתכתית + חבטה נמוכה
  function ka(c, out, t) {
    noiseHit(c, out, t, 'bandpass', 1800, 1.2, 0.9, 0.035);
    tone(c, out, t, 140, 'sine', 0.7, 0.002, 0.07);
    noiseHit(c, out, t + 0.055, 'bandpass', 3200, 2, 0.6, 0.03); // תפס המגירה
    tone(c, out, t + 0.055, 95, 'triangle', 0.5, 0.002, 0.09);
  }

  // "צ'ינגגג" – פעמון הקופה: "צ'" רעשי חד ואז פעמון מתכתי עם צלצול ארוך ורוטט
  function ching(c, out, t) {
    noiseHit(c, out, t, 'highpass', 6000, 0.7, 0.55, 0.09);   // צ'
    var f0 = 2350;
    // עליונים של פעמון קטן (יחסים לא-הרמוניים), כל אחד בזוג מעט מכוון-לא-נכון ליצירת "גגג" רוטט
    [[1, 0.55, 1.9], [1.5, 0.22, 1.2], [2.0, 0.28, 1.4], [2.76, 0.16, 0.8], [3.76, 0.09, 0.5], [5.4, 0.05, 0.3]]
      .forEach(function (p) {
        tone(c, out, t + 0.012, f0 * p[0], 'sine', p[1], 0.003, p[2], -6);
        tone(c, out, t + 0.012, f0 * p[0], 'sine', p[1] * 0.8, 0.003, p[2] * 0.9, 7);
      });
    // גוף נמוך יותר שנותן "בשר" לצלצול
    tone(c, out, t + 0.012, f0 / 2, 'triangle', 0.12, 0.004, 0.6);
  }

  // מטבעות שמתגלגלים במגירה
  function coins(c, out, t) {
    for (var i = 0; i < 9; i++) {
      var tt = t + i * 0.055 + Math.random() * 0.03;
      var f = 4200 + Math.random() * 2600;
      var peak = 0.12 * (1 - i / 11);
      tone(c, out, tt, f, 'sine', peak, 0.002, 0.09 + Math.random() * 0.08);
      tone(c, out, tt, f * 1.48, 'sine', peak * 0.4, 0.002, 0.06);
      noiseHit(c, out, tt, 'highpass', 7000, 0.7, peak * 0.6, 0.02);
    }
  }

  function playCashSound() {
    if (read(MUTE_KEY, false)) return false;
    var c = audio();
    if (!c) return false;
    if (c.state === 'suspended') c.resume();
    if (c.state !== 'running') return false;

    var master = c.createGain();
    master.gain.value = 0.5;
    var comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp).connect(c.destination);

    // מרחב קטן: השהיה קצרה עם משוב, כדי שהצלצול "יימרח" כמו בחדר
    var delay = c.createDelay(0.5);
    delay.delayTime.value = 0.09;
    var fb = c.createGain(); fb.gain.value = 0.28;
    var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5000;
    var wet = c.createGain(); wet.gain.value = 0.35;
    var bus = c.createGain();
    bus.connect(master);
    bus.connect(delay);
    delay.connect(lp).connect(fb).connect(delay);
    lp.connect(wet).connect(master);

    var t = c.currentTime + 0.02;
    ka(c, bus, t);              // קַ
    ching(c, bus, t + 0.13);    // צ'ינגגג
    coins(c, bus, t + 0.32);    // מטבעות
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
    '.finai-btn-reject{color:#ffb4ab;border-color:rgba(255,180,171,.4)}',
    '.finai-btn-reject:hover{background:rgba(147,0,10,.25)}',
    '.finai-reject{margin-block-start:12px;padding-block-start:12px;border-block-start:1px solid #3c4a42}',
    '.finai-reject[hidden]{display:none}',
    '.finai-reject-title{font-size:13px;font-weight:600;margin:0 0 8px}',
    '.finai-reasons{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:13px}',
    '.finai-reasons label{display:flex;align-items:center;gap:8px;cursor:pointer}',
    '.finai-reasons input{accent-color:#10b981}',
    '.finai-done{font-size:13px;line-height:1.5;color:#bbcabf}',
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
        '<button type="button" class="finai-btn finai-btn-reject" data-act="reject" aria-expanded="false">דחיית ההצעה</button>' +
      '</div>' +
      '<div class="finai-reject" hidden>' +
        '<p class="finai-reject-title">למה לדחות? (אופציונלי)</p>' +
        '<fieldset class="finai-reasons"><legend class="sr-only" style="position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip:rect(0 0 0 0)">סיבת הדחייה</legend>' +
          '<label><input type="radio" name="reason-' + esc(alert.id) + '" value="high_risk">סיכון גבוה</label>' +
          '<label><input type="radio" name="reason-' + esc(alert.id) + '" value="liquidity_need">צורך בנזילות</label>' +
          '<label><input type="radio" name="reason-' + esc(alert.id) + '" value="wrong_horizon">טווח לא מתאים</label>' +
          '<label><input type="radio" name="reason-' + esc(alert.id) + '" value="other">סיבה אחרת</label>' +
        '</fieldset>' +
        '<div class="finai-note">דחייה אינה משנה מגבלות סיכון, תקציב או מדיניות, ואינה מבצעת עסקה. אפשר לדלג על המשוב.</div>' +
        '<div class="finai-actions">' +
          '<button type="button" class="finai-btn finai-btn-reject" data-act="reject-confirm">דחייה</button>' +
          '<button type="button" class="finai-btn" data-act="reject-skip">דחייה בלי משוב</button>' +
          '<button type="button" class="finai-btn" data-act="reject-cancel">ביטול</button>' +
        '</div>' +
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
      } else if (act === 'reject' || act === 'reject-cancel') {
        var panel = el.querySelector('.finai-reject');
        var open = act === 'reject';
        panel.hidden = !open;
        el.querySelector('[data-act="reject"]').setAttribute('aria-expanded', String(open));
        if (open) { var first = panel.querySelector('input'); if (first) first.focus(); }
      } else if (act === 'reject-confirm' || act === 'reject-skip') {
        var chosen = el.querySelector('.finai-reasons input:checked');
        var reason = act === 'reject-confirm' && chosen ? chosen.value : null;
        // נרשם כ"נדחתה" בלבד: לא נפתחה לביצוע, לא בוצעה, ואין שינוי במגבלות
        logStatus(alert, 'rejected', { reason: reason });
        bumpBell(-1);
        el.innerHTML = '<div class="finai-done" role="status">ההצעה נדחתה. לא בוצעה עסקה ולא שונו מגבלות או מדיניות.</div>';
        setTimeout(dismiss, 2600);
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
   * ?demo-alert בכתובת – התראת הדגמה.
   * בדף הבית – התראת הדגמה אחת לכל סשן.
   * כדי שהצליל יישמע בדיוק כשההתראה קופצת, ההדגמה ממתינה עד שהדפדפן מתיר צליל
   * (מיד אם כבר לחצו בעמוד קודם באתר; אחרת אחרי הלחיצה הראשונה בעמוד).
   */
  function demoWithSound(delayMs) {
    setTimeout(function () {
      whenSoundAllowed(function () { setTimeout(demo, 1200); });
    }, delayMs);
  }
  function boot() {
    var params = new URLSearchParams(location.search);
    if (params.has('demo-alert')) { demoWithSound(300); return; }
    if (/02-home/.test(location.pathname)) {
      var seen = false;
      try { seen = sessionStorage.getItem(DEMO_KEY) === '1'; } catch (e) { /* ignore */ }
      if (!seen) {
        try { sessionStorage.setItem(DEMO_KEY, '1'); } catch (e) { /* ignore */ }
        demoWithSound(3800);
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
