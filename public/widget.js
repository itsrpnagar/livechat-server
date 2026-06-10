/**
 * LiveChat Widget — Mobile Optimized
 * Usage:
 *   window.LiveChatConfig = { server: 'https://api.satradiozone.online', name: 'Support', color: '#6c63ff' };
 */
(function () {
  const scriptTag = document.currentScript;
  const SERVER_URL = (window.LiveChatConfig?.server) || scriptTag?.getAttribute('data-server') || 'https://api.satradiozone.online';
  const BOT_NAME   = (window.LiveChatConfig?.name)   || scriptTag?.getAttribute('data-name')   || 'Support';
  const THEME      = (window.LiveChatConfig?.color)  || scriptTag?.getAttribute('data-color')  || '#6c63ff';

  // ─── Session ────────────────────────────────────────────────
  let sessionId = localStorage.getItem('lc_session_id');
  if (!sessionId) {
    sessionId = 'v_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('lc_session_id', sessionId);
  }

  let socket = null, connected = false, typingTimer, isOpen = false, unreadCount = 0;
  const isMobile = () => window.innerWidth <= 768;

  // ─── Socket ─────────────────────────────────────────────────
  function loadSocket(cb) {
    if (window.io) { cb(); return; }
    const s = document.createElement('script');
    s.src = SERVER_URL + '/socket.io/socket.io.js';
    s.onload = cb;
    document.head.appendChild(s);
  }

  function initSocket() {
    socket = window.io(SERVER_URL, { transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      connected = true;
      const ua = navigator.userAgent;
      let device = 'Desktop';
      if (/iPad|Tablet/i.test(ua)) device = 'Tablet';
      else if (/iPhone|iPod/.test(ua)) device = 'iOS';
      else if (/Android/.test(ua) && /Mobile/.test(ua)) device = 'Android';
      else if (/Android/.test(ua)) device = 'Tablet';
      else if (/Macintosh|MacIntel/.test(ua)) device = 'Mac';
      else if (/Windows/.test(ua)) device = 'Windows';

      const urlParams = new URLSearchParams(window.location.search);
      socket.emit('visitor:join', {
        sessionId,
        name: 'Visitor',
        page: window.location.href,
        referrer: document.referrer || '',
        device,
        utmSource:   urlParams.get('utm_source')   || '',
        utmMedium:   urlParams.get('utm_medium')   || '',
        utmCampaign: urlParams.get('utm_campaign') || '',
        gclid:       urlParams.get('gclid')        || '',
        userAgent: ua,
      });
      setStatus('online');
    });

    socket.on('visitor:session', ({ sessionId: sid }) => {
      sessionId = sid;
      localStorage.setItem('lc_session_id', sid);
    });

    socket.on('chat:message', (msg) => {
      appendMsg(msg.text, 'admin');
      scrollBottom();
    });

    socket.on('chat:admin_typing', () => {
      showTyping(true);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => showTyping(false), 2000);
    });

    socket.on('chat:closed', () => {
      appendMsg('This chat has ended. Thank you! 👋', 'admin');
      const inp = document.getElementById('lc-input');
      const btn = document.getElementById('lc-send');
      if (inp) { inp.disabled = true; inp.placeholder = 'Chat ended'; }
      if (btn) btn.disabled = true;
      setStatus('offline');
    });

    socket.on('disconnect', () => { connected = false; setStatus('away'); });
  }

  // ─── CSS ────────────────────────────────────────────────────
  const css = `
    #lc-btn {
      position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
      width: 56px; height: 56px; border-radius: 50%; background: ${THEME};
      border: none; cursor: pointer; box-shadow: 0 4px 20px rgba(0,0,0,.3);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; transition: transform .2s;
      -webkit-tap-highlight-color: transparent;
    }
    #lc-btn:active { transform: scale(0.92); }
    #lc-badge {
      position: absolute; top: -2px; right: -2px; background: #ef4444;
      color: #fff; border-radius: 50%; width: 18px; height: 18px;
      font-size: 10px; font-weight: 700; display: none;
      align-items: center; justify-content: center;
      border: 2px solid #fff;
    }

    /* DESKTOP */
    #lc-widget {
      position: fixed; bottom: 88px; right: 20px; z-index: 2147483646;
      width: 340px; height: 500px;
      background: #fff; border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,.18);
      display: none; flex-direction: column; overflow: hidden;
      font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
      animation: lcSlide .25s ease;
    }

    /* MOBILE — full screen */
    @media (max-width: 768px) {
      #lc-widget {
        position: fixed !important;
        top: 0 !important; left: 0 !important;
        right: 0 !important; bottom: 0 !important;
        width: 100% !important; height: 100% !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        animation: lcSlideUp .25s ease !important;
      }
      #lc-btn { bottom: 16px; right: 16px; width: 52px; height: 52px; }
    }

    @keyframes lcSlide { from { opacity:0; transform: translateY(16px); } to { opacity:1; transform:translateY(0); } }
    @keyframes lcSlideUp { from { opacity:0; transform: translateY(100%); } to { opacity:1; transform:translateY(0); } }

    #lc-header {
      padding: 14px 16px; background: ${THEME};
      display: flex; align-items: center; gap: 10px;
      flex-shrink: 0;
    }
    @media (max-width: 768px) {
      #lc-header { padding: 16px 16px; padding-top: max(16px, env(safe-area-inset-top)); }
    }
    #lc-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: rgba(255,255,255,.25);
      display: flex; align-items: center; justify-content: center; font-size: 18px;
      flex-shrink: 0;
    }
    #lc-header .lc-info .lc-title { color: #fff; font-weight: 700; font-size: 15px; }
    #lc-header .lc-info .lc-sub { color: rgba(255,255,255,.85); font-size: 12px; display: flex; align-items: center; gap: 4px; margin-top: 1px; }
    #lc-close-btn {
      margin-left: auto; background: rgba(255,255,255,.2); border: none;
      color: #fff; cursor: pointer; font-size: 16px; line-height: 1;
      width: 32px; height: 32px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      -webkit-tap-highlight-color: transparent;
    }
    #lc-close-btn:active { background: rgba(255,255,255,.35); }

    #lc-messages {
      flex: 1; overflow-y: auto; overflow-x: hidden;
      padding: 14px 12px; display: flex;
      flex-direction: column; gap: 8px;
      background: #f5f6f8;
      -webkit-overflow-scrolling: touch;
    }
    @media (max-width: 768px) {
      #lc-messages { padding: 16px 14px; gap: 10px; }
    }

    .lc-msg {
      max-width: 80%; padding: 10px 13px;
      border-radius: 16px; font-size: 14px; line-height: 1.5;
      word-break: break-word; word-wrap: break-word;
    }
    @media (max-width: 768px) { .lc-msg { font-size: 15px; max-width: 85%; padding: 11px 14px; } }
    .lc-msg.from-admin {
      background: #fff; border: 1px solid #e8eaed;
      border-bottom-left-radius: 4px; align-self: flex-start; color: #1a1a2e;
    }
    .lc-msg.from-visitor {
      background: ${THEME}; color: #fff;
      border-bottom-right-radius: 4px; align-self: flex-end;
    }

    #lc-typing {
      padding: 0 14px 6px; font-size: 12px;
      color: #9ca3af; font-style: italic; min-height: 22px;
      flex-shrink: 0;
    }

    #lc-footer {
      padding: 10px 12px;
      padding-bottom: max(10px, env(safe-area-inset-bottom));
      background: #fff; border-top: 1px solid #e8eaed;
      display: flex; gap: 8px; align-items: flex-end;
      flex-shrink: 0;
    }
    @media (max-width: 768px) { #lc-footer { padding: 12px 14px; padding-bottom: max(14px, env(safe-area-inset-bottom)); gap: 10px; } }

    #lc-input {
      flex: 1; border: 1.5px solid #e8eaed; border-radius: 22px;
      padding: 10px 16px; font-size: 15px;
      resize: none; outline: none;
      font-family: inherit; line-height: 1.4;
      background: #f5f6f8; color: #1a1a2e;
      max-height: 100px; min-height: 42px;
      transition: border-color .2s;
      -webkit-appearance: none;
    }
    #lc-input:focus { border-color: ${THEME}; background: #fff; }
    #lc-input::placeholder { color: #9ca3af; }
    @media (max-width: 768px) {
      #lc-input { font-size: 16px; padding: 11px 16px; min-height: 44px; }
    }

    #lc-send {
      width: 42px; height: 42px; min-width: 42px;
      background: ${THEME}; color: #fff; border: none;
      border-radius: 50%; cursor: pointer; font-size: 18px;
      display: flex; align-items: center; justify-content: center;
      transition: opacity .2s, transform .1s;
      -webkit-tap-highlight-color: transparent;
      flex-shrink: 0;
    }
    #lc-send:active { transform: scale(0.92); opacity: .85; }
    #lc-send:disabled { opacity: 0.4; cursor: not-allowed; }

    #lc-messages::-webkit-scrollbar { width: 3px; }
    #lc-messages::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }
    .lc-status-dot { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; display: inline-block; flex-shrink: 0; }
    .lc-status-dot.away { background: #f59e0b; }
    .lc-status-dot.offline { background: #9ca3af; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ─── Button ────────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.id = 'lc-btn';
  btn.setAttribute('aria-label', 'Open chat');
  btn.innerHTML = `💬<span id="lc-badge"></span>`;
  document.body.appendChild(btn);

  // ─── Widget ────────────────────────────────────────────────
  const widget = document.createElement('div');
  widget.id = 'lc-widget';
  widget.setAttribute('role', 'dialog');
  widget.setAttribute('aria-label', 'Live chat');
  widget.innerHTML = `
    <div id="lc-header">
      <div id="lc-avatar">👋</div>
      <div class="lc-info">
        <div class="lc-title">${BOT_NAME}</div>
        <div class="lc-sub"><span class="lc-status-dot" id="lc-dot"></span><span id="lc-status-text">Online</span></div>
      </div>
      <button id="lc-close-btn" aria-label="Close chat">✕</button>
    </div>
    <div id="lc-messages">
      <div class="lc-msg from-admin">Hi! 👋 How can we help you today?</div>
    </div>
    <div id="lc-typing"></div>
    <div id="lc-footer">
      <textarea id="lc-input" placeholder="Type your message..." rows="1" autocomplete="off" autocorrect="on" spellcheck="true"></textarea>
      <button id="lc-send" aria-label="Send message">↑</button>
    </div>
  `;
  document.body.appendChild(widget);

  // ─── Keyboard handling (mobile) ─────────────────────────────
  // Jab keyboard open ho to messages scroll ho jaye
  function scrollBottom() {
    const box = document.getElementById('lc-messages');
    if (box) setTimeout(() => { box.scrollTop = box.scrollHeight; }, 50);
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (!isOpen || !isMobile()) return;
      const footer = document.getElementById('lc-footer');
      const msgs = document.getElementById('lc-messages');
      if (!footer || !msgs) return;
      const gap = window.innerHeight - window.visualViewport.height;
      widget.style.height = window.visualViewport.height + 'px';
      widget.style.top = window.visualViewport.offsetTop + 'px';
      scrollBottom();
    });
  }

  // ─── Toggle ────────────────────────────────────────────────
  btn.onclick = () => toggleWidget();
  document.getElementById('lc-close-btn').onclick = () => toggleWidget(false);

  function toggleWidget(force) {
    isOpen = force !== undefined ? force : !isOpen;
    widget.style.display = isOpen ? 'flex' : 'none';

    if (isOpen) {
      // Mobile pe body scroll band
      if (isMobile()) {
        document.body.style.overflow = 'hidden';
        widget.style.height = window.innerHeight + 'px';
      }
      btn.innerHTML = `✕<span id="lc-badge"></span>`;
      btn.setAttribute('aria-label', 'Close chat');
      unreadCount = 0;
      const badge = document.getElementById('lc-badge');
      if (badge) badge.style.display = 'none';
      scrollBottom();
      setTimeout(() => document.getElementById('lc-input')?.focus(), 300);
      if (!socket) loadSocket(() => { initSocket(); });
    } else {
      if (isMobile()) document.body.style.overflow = '';
      widget.style.height = '';
      widget.style.top = '';
      btn.innerHTML = `💬<span id="lc-badge"></span>`;
      btn.setAttribute('aria-label', 'Open chat');
    }
  }

  // ─── Messages ───────────────────────────────────────────────
  function appendMsg(text, from) {
    const box = document.getElementById('lc-messages');
    if (!box) return;
    const d = document.createElement('div');
    d.className = `lc-msg from-${from}`;
    d.textContent = text;
    box.appendChild(d);
    scrollBottom();

    if (from === 'admin' && !isOpen) {
      unreadCount++;
      const badge = document.getElementById('lc-badge');
      if (badge) { badge.textContent = unreadCount; badge.style.display = 'flex'; }
    }
  }

  function showTyping(show) {
    const el = document.getElementById('lc-typing');
    if (el) el.textContent = show ? 'Support is typing...' : '';
  }

  function setStatus(s) {
    const dot = document.getElementById('lc-dot');
    const txt = document.getElementById('lc-status-text');
    if (!dot || !txt) return;
    dot.className = 'lc-status-dot' + (s === 'online' ? '' : s === 'away' ? ' away' : ' offline');
    txt.textContent = s === 'online' ? 'Online' : s === 'away' ? 'Away' : 'Offline';
  }

  // ─── Send ───────────────────────────────────────────────────
  function sendMsg() {
    const inp = document.getElementById('lc-input');
    if (!inp || !inp.value.trim()) return;
    const text = inp.value.trim();
    appendMsg(text, 'visitor');
    if (socket && connected) socket.emit('visitor:message', { sessionId, text });
    inp.value = '';
    inp.style.height = 'auto';
    scrollBottom();
  }

  document.getElementById('lc-send').onclick = sendMsg;

  document.getElementById('lc-input').addEventListener('keydown', (e) => {
    // Mobile pe Enter = new line, desktop pe Enter = send
    if (e.key === 'Enter' && !e.shiftKey && !isMobile()) {
      e.preventDefault();
      sendMsg();
    }
  });

  document.getElementById('lc-input').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    if (socket && connected) socket.emit('visitor:typing', { sessionId });
  });

})();
