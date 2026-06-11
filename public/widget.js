/**
 * LiveChat Widget v1.0
 * Industry standard pattern — same as Intercom, Crisp, Tawk.to

 */
(function (w, d) {
  'use strict';

  // ─── Config — read from window.LiveChatConfig (set before this script) ───
  var cfg       = w.LiveChatConfig || {};
  var SERVER    = cfg.server || 'https://api.satradiozone.online';
  var BOT_NAME  = cfg.name   || 'Support';
  var THEME     = cfg.color  || '#6c63ff';

  // ─── Session ID (localStorage) ───────────────────────────────
  var sessionId = localStorage.getItem('lc_sid');
  if (!sessionId) {
    sessionId = 'v_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    localStorage.setItem('lc_sid', sessionId);
  }

  // ─── State ───────────────────────────────────────────────────
  var socket = null, connected = false, typingTimer;
  var isOpen = false, unreadCount = 0;
  var hasActiveSession = localStorage.getItem('lc_active') === '1';

  function isMobile() { return w.innerWidth <= 768; }

  // ─── Load Socket.io lazily (only when chat opens) ────────────
  function loadSocket(cb) {
    if (w.io) { cb(); return; }
    var s = d.createElement('script');
    s.src = SERVER + '/socket.io/socket.io.js';
    s.onload = cb;
    d.head.appendChild(s);
  }

  // ─── Init Socket ─────────────────────────────────────────────
  function initSocket() {
    socket = w.io(SERVER, { transports: ['websocket', 'polling'] });

    socket.on('connect', function () {
      connected = true;

      // ── Try restore if active session exists ──
      if (hasActiveSession && sessionId) {
        socket.emit('visitor:restore', { sessionId: sessionId });
        return;
      }

      var ua = navigator.userAgent;
      var device = 'Desktop';
      if (/iPhone|iPod/.test(ua))                        device = 'iOS';
      else if (/iPad/.test(ua))                          device = 'Tablet';
      else if (/Android/.test(ua) && /Mobile/.test(ua)) device = 'Android';
      else if (/Android/.test(ua))                       device = 'Tablet';
      else if (/Macintosh/.test(ua))                     device = 'Mac';
      else if (/Windows/.test(ua))                       device = 'Windows';

      var p = new URLSearchParams(w.location.search);
      socket.emit('visitor:join', {
        sessionId   : sessionId,
        name        : 'Visitor',
        page        : w.location.href,
        referrer    : d.referrer || '',
        device      : device,
        userAgent   : ua,
        utmSource   : p.get('utm_source')   || '',
        utmMedium   : p.get('utm_medium')   || '',
        utmCampaign : p.get('utm_campaign') || '',
        gclid       : p.get('gclid')        || ''
      });
      setStatus('online');
    });

    // ── Restore OK — session kept silently ──
    socket.on('visitor:restore_ok', function (data) {
      sessionId = data.sessionId;
      localStorage.setItem('lc_sid', sessionId);
      setStatus('online');
    });

    // ── Restore failed — fresh start ──
    socket.on('visitor:restore_failed', function () {
      localStorage.removeItem('lc_active');
      hasActiveSession = false;
      var ua = navigator.userAgent;
      var device = 'Desktop';
      if (/iPhone|iPod/.test(ua)) device = 'iOS';
      else if (/iPad/.test(ua)) device = 'Tablet';
      else if (/Android/.test(ua) && /Mobile/.test(ua)) device = 'Android';
      var p = new URLSearchParams(w.location.search);
      socket.emit('visitor:join', {
        sessionId: sessionId, name: 'Visitor',
        page: w.location.href, referrer: d.referrer || '',
        device: device, userAgent: ua,
        utmSource: p.get('utm_source') || '',
        utmMedium: p.get('utm_medium') || '',
        utmCampaign: p.get('utm_campaign') || '',
        gclid: p.get('gclid') || ''
      });
      setStatus('online');
    });

    socket.on('visitor:session', function (data) {
      sessionId = data.sessionId;
      localStorage.setItem('lc_sid', sessionId);
    });

    socket.on('chat:message', function (msg) {
      appendMsg(msg.text, 'admin');
    });

    // ── Admin Reconnect → reopen chat window ──
    socket.on('chat:reopen', function (data) {
      sessionId = data.sessionId;
      localStorage.setItem('lc_sid', data.sessionId);
      localStorage.setItem('lc_active', '1');
      hasActiveSession = true;
      setStatus('online');

      // Open widget
      toggleWidget(true);

      // Restore messages
      if (data.messages && data.messages.length) {
        var box = d.getElementById('lc-messages');
        if (box) {
          while (box.firstChild) box.removeChild(box.firstChild);
          for (var i = 0; i < data.messages.length; i++) {
            appendMsg(data.messages[i].text, data.messages[i].from);
          }
        }
      }
    });

    socket.on('chat:admin_typing', function () {
      showTyping(true);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(function () { showTyping(false); }, 2000);
    });

    socket.on('chat:closed', function () {
      appendMsg('This chat has ended. Thank you! 👋', 'admin');
      var inp = d.getElementById('lc-input');
      var snd = d.getElementById('lc-send');
      if (inp) { inp.disabled = true; inp.placeholder = 'Chat ended'; }
      if (snd) snd.disabled = true;
      setStatus('offline');
    });

    socket.on('disconnect', function () {
      connected = false;
      setStatus('away');
    });
  }

  // ─── Inject CSS ──────────────────────────────────────────────
  var css = [
    '#lc-btn{position:fixed;bottom:20px;right:20px;z-index:2147483647;',
    'width:56px;height:56px;border-radius:50%;background:' + THEME + ';',
    'border:none;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.3);',
    'display:flex;align-items:center;justify-content:center;',
    'font-size:22px;-webkit-tap-highlight-color:transparent;transition:transform .15s}',
    '#lc-btn:active{transform:scale(0.9)}',

    '#lc-badge{position:absolute;top:-2px;right:-2px;background:#ef4444;color:#fff;',
    'border-radius:50%;width:18px;height:18px;font-size:10px;font-weight:700;',
    'display:none;align-items:center;justify-content:center;border:2px solid #fff}',

    '#lc-widget{position:fixed;bottom:88px;right:20px;z-index:2147483646;',
    'width:340px;height:500px;display:none;flex-direction:column;',
    'background:#fff;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.2);',
    'font-family:-apple-system,"Segoe UI",system-ui,sans-serif;overflow:hidden;',
    'transition:height .15s ease}',

    '#lc-widget.lc-mobile{position:fixed!important;left:0!important;right:0!important;',
    'width:100%!important;border-radius:0!important;box-shadow:none!important;',
    'transition:height .15s ease!important}',

    '#lc-header{flex-shrink:0;padding:14px 16px;background:' + THEME + ';',
    'display:flex;align-items:center;gap:10px}',

    '#lc-avatar{width:36px;height:36px;border-radius:50%;',
    'background:rgba(255,255,255,.25);display:flex;align-items:center;',
    'justify-content:center;font-size:18px;flex-shrink:0}',

    '.lc-info{flex:1;min-width:0}',
    '.lc-title{color:#fff;font-weight:700;font-size:15px}',
    '.lc-sub{color:rgba(255,255,255,.85);font-size:12px;display:flex;',
    'align-items:center;gap:5px;margin-top:2px}',

    '#lc-close-btn{flex-shrink:0;width:32px;height:32px;border-radius:50%;',
    'background:rgba(255,255,255,.2);border:none;color:#fff;font-size:16px;',
    'cursor:pointer;display:flex;align-items:center;justify-content:center;',
    '-webkit-tap-highlight-color:transparent}',
    '#lc-close-btn:active{background:rgba(255,255,255,.4)}',

    '#lc-messages{flex:1;overflow-y:auto;overflow-x:hidden;',
    '-webkit-overflow-scrolling:touch;padding:14px 12px;',
    'display:flex;flex-direction:column;gap:8px;background:#f5f6f8}',

    '.lc-msg{max-width:80%;padding:10px 13px;border-radius:16px;',
    'font-size:15px;line-height:1.5;word-break:break-word}',
    '.lc-msg.from-admin{background:#fff;border:1px solid #e8eaed;',
    'border-bottom-left-radius:4px;align-self:flex-start;color:#1a1a2e}',
    '.lc-msg.from-visitor{background:' + THEME + ';color:#fff;',
    'border-bottom-right-radius:4px;align-self:flex-end}',

    '#lc-typing{flex-shrink:0;padding:0 14px 4px;font-size:12px;',
    'color:#9ca3af;font-style:italic;min-height:20px;background:#f5f6f8}',

    '#lc-footer{flex-shrink:0;padding:10px 12px;background:#fff;',
    'border-top:1px solid #e8eaed;display:flex;gap:8px;align-items:center}',

    '#lc-input{flex:1;min-width:0;border:1.5px solid #e8eaed;border-radius:22px;',
    'padding:10px 16px;font-size:16px;line-height:1.4;resize:none;outline:none;',
    'font-family:inherit;background:#f5f6f8;color:#1a1a2e;',
    'max-height:90px;min-height:42px;-webkit-appearance:none;transition:border-color .2s}',
    '#lc-input:focus{border-color:' + THEME + ';background:#fff}',
    '#lc-input::placeholder{color:#aaa}',

    '#lc-send{flex-shrink:0;width:42px;height:42px;background:' + THEME + ';',
    'color:#fff;border:none;border-radius:50%;cursor:pointer;font-size:18px;',
    'display:flex;align-items:center;justify-content:center;',
    '-webkit-tap-highlight-color:transparent}',
    '#lc-send:active{opacity:.8}',
    '#lc-send:disabled{opacity:.4}',

    '.lc-dot{width:7px;height:7px;border-radius:50%;background:#22c55e;',
    'display:inline-block;flex-shrink:0}',
    '.lc-dot.away{background:#f59e0b}',
    '.lc-dot.offline{background:#9ca3af}',
    '#lc-messages::-webkit-scrollbar{width:3px}',
    '#lc-messages::-webkit-scrollbar-thumb{background:#ddd;border-radius:2px}'
  ].join('');

  var style = d.createElement('style');
  style.textContent = css;
  d.head.appendChild(style);

  // ─── Build Button ────────────────────────────────────────────
  var btn = d.createElement('button');
  btn.id = 'lc-btn';
  btn.setAttribute('aria-label', 'Open live chat');
  var btnIcon  = d.createTextNode('💬');
  var btnBadge = d.createElement('span');
  btnBadge.id = 'lc-badge';
  btnBadge.setAttribute('aria-hidden', 'true');
  btn.appendChild(btnIcon);
  btn.appendChild(btnBadge);
  d.body.appendChild(btn);

  // ─── Build Widget ────────────────────────────────────────────
  var widget = d.createElement('div');
  widget.id = 'lc-widget';
  widget.setAttribute('role', 'dialog');
  widget.setAttribute('aria-label', 'Live chat support');

  // Header
  var header  = d.createElement('div'); header.id = 'lc-header';
  var avatar  = d.createElement('div'); avatar.id = 'lc-avatar'; avatar.setAttribute('aria-hidden','true'); avatar.textContent = '👋';
  var info    = d.createElement('div'); info.className = 'lc-info';
  var title   = d.createElement('div'); title.className = 'lc-title'; title.textContent = BOT_NAME;
  var sub     = d.createElement('div'); sub.className = 'lc-sub';
  var dot     = d.createElement('span'); dot.className = 'lc-dot'; dot.id = 'lc-dot'; dot.setAttribute('aria-hidden','true');
  var statusTxt = d.createElement('span'); statusTxt.id = 'lc-status-text'; statusTxt.textContent = 'Online';
  sub.appendChild(dot); sub.appendChild(statusTxt);
  info.appendChild(title); info.appendChild(sub);
  var closeBtn = d.createElement('button'); closeBtn.id = 'lc-close-btn'; closeBtn.setAttribute('aria-label','Close chat'); closeBtn.textContent = '\u2715';
  header.appendChild(avatar); header.appendChild(info); header.appendChild(closeBtn);

  // Messages
  var messages = d.createElement('div'); messages.id = 'lc-messages'; messages.setAttribute('role','log'); messages.setAttribute('aria-live','polite'); messages.setAttribute('aria-label','Chat messages');
  // No default greeting — service selection drives the first message

  // Typing
  var typing = d.createElement('div'); typing.id = 'lc-typing'; typing.setAttribute('aria-live','polite');

  // Footer
  var footer  = d.createElement('div'); footer.id = 'lc-footer';
  var input   = d.createElement('textarea'); input.id = 'lc-input'; input.placeholder = 'Type your message...'; input.rows = 1; input.setAttribute('autocomplete','off'); input.setAttribute('spellcheck','true'); input.setAttribute('aria-label','Type a message');
  var sendBtn = d.createElement('button'); sendBtn.id = 'lc-send'; sendBtn.setAttribute('aria-label','Send message'); sendBtn.textContent = '\u2191';
  footer.appendChild(input); footer.appendChild(sendBtn);

  widget.appendChild(header);
  widget.appendChild(messages);
  widget.appendChild(typing);
  widget.appendChild(footer);
  d.body.appendChild(widget);

  // ─── Viewport fix (iOS keyboard) ─────────────────────────────
  function setWidgetSize() {
    if (!isOpen || !isMobile()) return;
    var vv = w.visualViewport;
    var h  = vv ? vv.height    : w.innerHeight;
    var t  = vv ? vv.pageTop   : 0;
    widget.style.top    = t + 'px';
    widget.style.height = h + 'px';
    scrollBottom();
  }

  if (w.visualViewport) {
    w.visualViewport.addEventListener('resize', setWidgetSize);
    w.visualViewport.addEventListener('scroll', setWidgetSize);
  }
  w.addEventListener('resize', setWidgetSize);

  // ─── Scroll to latest message ─────────────────────────────────
  function scrollBottom() {
    var box = d.getElementById('lc-messages');
    if (!box) return;
    box.scrollTop = box.scrollHeight;
    setTimeout(function () { box.scrollTop = box.scrollHeight; }, 80);
    setTimeout(function () { box.scrollTop = box.scrollHeight; }, 200);
  }

  // ─── Public API: reopen chat after admin reconnects ──────────
  w.lcReopenChat = function (data) {
    if (data.sessionId) {
      sessionId = data.sessionId;
      localStorage.setItem('lc_sid', data.sessionId);
    }
    localStorage.setItem('lc_active', '1');
    hasActiveSession = true;

    toggleWidget(true);

    var box = d.getElementById('lc-messages');
    if (box) while (box.firstChild) box.removeChild(box.firstChild);

    // messages.length > 1 means real chat happened — restore history
    // messages.length <= 1 means only greeting or nothing — fresh start
    if (data.messages && data.messages.length > 1) {
      // Option A — restore history
      for (var i = 0; i < data.messages.length; i++) {
        appendMsg(data.messages[i].text, data.messages[i].from);
      }
    } else {
      // Option B — fresh greeting
      appendMsg('Welcome back! A live agent is here to help you.', 'admin');
    }

    if (!socket) {
      if (w._lcSocket && w._lcSocket.connected) {
        socket = w._lcSocket;
        connected = true;
        setStatus('online');
      } else {
        loadSocket(function () { initSocket(); });
      }
    } else {
      setStatus('online');
    }
  };

  // ─── Public API: called from ui-metrics after service selected ──
  w.lcInitChat = function (service, newSessionId) {
    if (newSessionId) {
      sessionId = newSessionId;
      localStorage.setItem('lc_sid', newSessionId);
    }
    localStorage.setItem('lc_active', '1');
    hasActiveSession = true;
    toggleWidget(true);

    // Show default greeting immediately
    if (service) {
      appendMsg('Hi! I see you need help with "' + service + '". A live agent will be with you shortly.', 'admin');
    }

    if (!socket) {
      loadSocket(function () { initSocket(); });
    }
  };

  // ─── Open / Close ─────────────────────────────────────────────
  btn.onclick = function () { toggleWidget(); };
  d.getElementById('lc-close-btn').onclick = function () {
    // Notify server visitor closed chat
    if (socket && connected && sessionId) {
      socket.emit('visitor:chat_closed', { sessionId: sessionId });
    }
    toggleWidget(false);
  };

  function toggleWidget(force) {
    isOpen = (force !== undefined) ? force : !isOpen;

    if (isOpen) {
      // Mark session as active in localStorage
      localStorage.setItem('lc_active', '1');

      if (isMobile()) {
        widget.classList.add('lc-mobile');
        d.body.style.overflow = 'hidden';
        d.body.style.position = 'fixed';
        d.body.style.width    = '100%';
      }
      widget.style.display = 'flex';
      btn.style.display    = 'none';
      setWidgetSize();

      unreadCount = 0;
      var badge = d.getElementById('lc-badge');
      if (badge) badge.style.display = 'none';
      scrollBottom();

      setTimeout(function () {
        var inp = d.getElementById('lc-input');
        if (inp) inp.focus({ preventScroll: true });
        scrollBottom();
      }, 300);

      if (!socket) loadSocket(initSocket);

    } else {
      // Clear active session flag when visitor closes chat
      localStorage.removeItem('lc_active');

      widget.style.display = 'none';
      widget.style.top     = '';
      widget.style.height  = '';
      widget.classList.remove('lc-mobile');
      d.body.style.overflow = '';
      d.body.style.position = '';
      d.body.style.width    = '';
      btn.style.display = 'flex';
    }
  }

  // ─── Append message ───────────────────────────────────────────
  function appendMsg(text, from) {
    var box = d.getElementById('lc-messages');
    if (!box) return;
    var div = d.createElement('div');
    div.className = 'lc-msg from-' + from;
    div.textContent = text;
    box.appendChild(div);
    scrollBottom();
    if (from === 'admin' && !isOpen) {
      unreadCount++;
      var badge = d.getElementById('lc-badge');
      if (badge) { badge.textContent = unreadCount; badge.style.display = 'flex'; }
    }
  }

  function showTyping(show) {
    var el = d.getElementById('lc-typing');
    if (el) el.textContent = show ? 'Support is typing...' : '';
    if (show) scrollBottom();
  }

  function setStatus(s) {
    var dot = d.getElementById('lc-dot');
    var txt = d.getElementById('lc-status-text');
    if (!dot || !txt) return;
    dot.className = 'lc-dot' + (s === 'online' ? '' : s === 'away' ? ' away' : ' offline');
    txt.textContent = s === 'online' ? 'Online' : s === 'away' ? 'Away' : 'Offline';
  }

  // ─── Send message ─────────────────────────────────────────────
  function sendMsg() {
    var inp  = d.getElementById('lc-input');
    if (!inp || !inp.value.trim()) return;
    var text = inp.value.trim();
    appendMsg(text, 'visitor');
    if (socket && connected) socket.emit('visitor:message', { sessionId: sessionId, text: text });
    inp.value = '';
    inp.style.height = 'auto';
    inp.focus({ preventScroll: true });
    scrollBottom();
  }

  d.getElementById('lc-send').onclick = sendMsg;

  d.getElementById('lc-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !isMobile()) {
      e.preventDefault();
      sendMsg();
    }
  });

  d.getElementById('lc-input').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 90) + 'px';
    if (socket && connected) socket.emit('visitor:typing', { sessionId: sessionId });
  });

}(window, document));
