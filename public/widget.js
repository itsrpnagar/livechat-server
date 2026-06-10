(function () {
  const SERVER_URL = (window.LiveChatConfig?.server) || document.currentScript?.getAttribute('data-server') || 'https://api.satradiozone.online';
  const BOT_NAME   = (window.LiveChatConfig?.name)   || document.currentScript?.getAttribute('data-name')   || 'Support';
  const THEME      = (window.LiveChatConfig?.color)  || document.currentScript?.getAttribute('data-color')  || '#6c63ff';

  let sessionId = localStorage.getItem('lc_session_id') || ('v_' + Math.random().toString(36).substr(2,9));
  localStorage.setItem('lc_session_id', sessionId);

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
      if (/iPhone|iPod/.test(ua)) device = 'iOS';
      else if (/iPad/.test(ua)) device = 'Tablet';
      else if (/Android/.test(ua) && /Mobile/.test(ua)) device = 'Android';
      else if (/Android/.test(ua)) device = 'Tablet';
      else if (/Mac/.test(ua)) device = 'Mac';
      else if (/Windows/.test(ua)) device = 'Windows';
      const p = new URLSearchParams(window.location.search);
      socket.emit('visitor:join', {
        sessionId, name: 'Visitor',
        page: window.location.href,
        referrer: document.referrer || '',
        device, userAgent: ua,
        utmSource: p.get('utm_source') || '',
        utmMedium: p.get('utm_medium') || '',
        utmCampaign: p.get('utm_campaign') || '',
        gclid: p.get('gclid') || '',
      });
      setStatus('online');
    });
    socket.on('visitor:session', ({ sessionId: sid }) => {
      sessionId = sid; localStorage.setItem('lc_session_id', sid);
    });
    socket.on('chat:message', (msg) => { appendMsg(msg.text, 'admin'); });
    socket.on('chat:admin_typing', () => {
      showTyping(true);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => showTyping(false), 2000);
    });
    socket.on('chat:closed', () => {
      appendMsg('This chat has ended. Thank you! 👋', 'admin');
      const inp = document.getElementById('lc-input');
      const snd = document.getElementById('lc-send');
      if (inp) { inp.disabled = true; inp.placeholder = 'Chat ended'; }
      if (snd) snd.disabled = true;
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
      font-size: 22px; -webkit-tap-highlight-color: transparent;
      transition: transform .15s;
    }
    #lc-btn:active { transform: scale(0.9); }
    #lc-badge {
      position: absolute; top: -2px; right: -2px;
      background: #ef4444; color: #fff; border-radius: 50%;
      width: 18px; height: 18px; font-size: 10px; font-weight: 700;
      display: none; align-items: center; justify-content: center;
      border: 2px solid #fff;
    }

    /* Desktop widget */
    #lc-widget {
      position: fixed; bottom: 88px; right: 20px; z-index: 2147483646;
      width: 340px; height: 500px;
      display: none; flex-direction: column;
      background: #fff; border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,.2);
      font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
      overflow: hidden;
      transition: height 0.15s ease;
    }

    /* Mobile: JS sets exact position/size dynamically */
    #lc-widget.lc-mobile {
      position: fixed !important;
      left: 0 !important; right: 0 !important;
      width: 100% !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      transition: height 0.15s ease !important;
    }

    /* Header always on top */
    #lc-header {
      flex-shrink: 0; z-index: 2;
      padding: 14px 16px; background: ${THEME};
      display: flex; align-items: center; gap: 10px;
    }
    #lc-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: rgba(255,255,255,.25);
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; flex-shrink: 0;
    }
    .lc-info { flex: 1; min-width: 0; }
    .lc-title { color: #fff; font-weight: 700; font-size: 15px; }
    .lc-sub { color: rgba(255,255,255,.85); font-size: 12px; display: flex; align-items: center; gap: 5px; margin-top: 2px; }
    #lc-close-btn {
      flex-shrink: 0; width: 32px; height: 32px; border-radius: 50%;
      background: rgba(255,255,255,.2); border: none; color: #fff;
      font-size: 16px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      -webkit-tap-highlight-color: transparent;
    }
    #lc-close-btn:active { background: rgba(255,255,255,.4); }

    /* Messages scrollable */
    #lc-messages {
      flex: 1; overflow-y: auto; overflow-x: hidden;
      -webkit-overflow-scrolling: touch;
      padding: 14px 12px;
      display: flex; flex-direction: column; gap: 8px;
      background: #f5f6f8;
    }
    .lc-msg {
      max-width: 80%; padding: 10px 13px; border-radius: 16px;
      font-size: 15px; line-height: 1.5; word-break: break-word;
    }
    .lc-msg.from-admin {
      background: #fff; border: 1px solid #e8eaed;
      border-bottom-left-radius: 4px;
      align-self: flex-start; color: #1a1a2e;
    }
    .lc-msg.from-visitor {
      background: ${THEME}; color: #fff;
      border-bottom-right-radius: 4px; align-self: flex-end;
    }

    #lc-typing {
      flex-shrink: 0; padding: 0 14px 4px;
      font-size: 12px; color: #9ca3af; font-style: italic;
      min-height: 20px; background: #f5f6f8;
    }

    /* Footer always at bottom */
    #lc-footer {
      flex-shrink: 0;
      padding: 10px 12px 10px;
      background: #fff; border-top: 1px solid #e8eaed;
      display: flex; gap: 8px; align-items: center;
    }
    #lc-input {
      flex: 1; min-width: 0;
      border: 1.5px solid #e8eaed; border-radius: 22px;
      padding: 10px 16px; font-size: 16px; line-height: 1.4;
      resize: none; outline: none; font-family: inherit;
      background: #f5f6f8; color: #1a1a2e;
      max-height: 90px; min-height: 42px;
      -webkit-appearance: none;
      transition: border-color .2s;
    }
    #lc-input:focus { border-color: ${THEME}; background: #fff; }
    #lc-input::placeholder { color: #aaa; }
    #lc-send {
      flex-shrink: 0; width: 42px; height: 42px;
      background: ${THEME}; color: #fff; border: none;
      border-radius: 50%; cursor: pointer; font-size: 18px;
      display: flex; align-items: center; justify-content: center;
      -webkit-tap-highlight-color: transparent;
    }
    #lc-send:active { opacity: 0.8; }
    #lc-send:disabled { opacity: 0.4; }

    .lc-status-dot { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; display: inline-block; flex-shrink: 0; }
    .lc-status-dot.away { background: #f59e0b; }
    .lc-status-dot.offline { background: #9ca3af; }
    #lc-messages::-webkit-scrollbar { width: 3px; }
    #lc-messages::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }
  `;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ─── Build HTML ──────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.id = 'lc-btn';
  btn.innerHTML = `💬<span id="lc-badge"></span>`;
  document.body.appendChild(btn);

  const widget = document.createElement('div');
  widget.id = 'lc-widget';
  widget.innerHTML = `
    <div id="lc-header">
      <div id="lc-avatar">👋</div>
      <div class="lc-info">
        <div class="lc-title">${BOT_NAME}</div>
        <div class="lc-sub"><span class="lc-status-dot" id="lc-dot"></span><span id="lc-status-text">Online</span></div>
      </div>
      <button id="lc-close-btn">✕</button>
    </div>
    <div id="lc-messages">
      <div class="lc-msg from-admin">Hi! 👋 How can we help you today?</div>
    </div>
    <div id="lc-typing"></div>
    <div id="lc-footer">
      <textarea id="lc-input" placeholder="Type your message..." rows="1" autocomplete="off" spellcheck="true"></textarea>
      <button id="lc-send">↑</button>
    </div>
  `;
  document.body.appendChild(widget);

  // ─── KEY FUNCTION: Set widget size from visualViewport ───────
  function setWidgetSize() {
    if (!isOpen || !isMobile()) return;
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    const t = vv ? vv.pageTop : 0;
    widget.style.top    = t + 'px';
    widget.style.height = h + 'px';
    scrollBottom();
  }

  // Listen to viewport changes (keyboard open/close)
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setWidgetSize);
    window.visualViewport.addEventListener('scroll', setWidgetSize);
  }
  // Fallback for older browsers
  window.addEventListener('resize', setWidgetSize);

  // ─── Scroll ──────────────────────────────────────────────────
  function scrollBottom() {
    const box = document.getElementById('lc-messages');
    if (!box) return;
    box.scrollTop = box.scrollHeight;
    setTimeout(() => { box.scrollTop = box.scrollHeight; }, 80);
    setTimeout(() => { box.scrollTop = box.scrollHeight; }, 200);
  }

  // ─── Toggle ──────────────────────────────────────────────────
  btn.onclick = () => toggleWidget();
  document.getElementById('lc-close-btn').onclick = () => toggleWidget(false);

  function toggleWidget(force) {
    isOpen = force !== undefined ? force : !isOpen;

    if (isOpen) {
      // Add mobile class
      if (isMobile()) {
        widget.classList.add('lc-mobile');
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.width    = '100%';
      }
      widget.style.display = 'flex';
      btn.style.display = 'none';

      // Set size immediately
      setWidgetSize();

      unreadCount = 0;
      const badge = document.getElementById('lc-badge');
      if (badge) badge.style.display = 'none';

      scrollBottom();
      // Focus input after animation
      setTimeout(() => {
        const inp = document.getElementById('lc-input');
        if (inp) inp.focus({ preventScroll: true });
        scrollBottom();
      }, 300);

      if (!socket) loadSocket(() => initSocket());

    } else {
      widget.style.display = 'none';
      widget.style.top = '';
      widget.style.height = '';
      widget.classList.remove('lc-mobile');
      document.body.style.overflow  = '';
      document.body.style.position  = '';
      document.body.style.width     = '';
      btn.style.display = 'flex';
    }
  }

  // ─── Messages ────────────────────────────────────────────────
  function appendMsg(text, from) {
    const box = document.getElementById('lc-messages');
    if (!box) return;
    const d = document.createElement('div');
    d.className = 'lc-msg from-' + from;
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
    if (show) scrollBottom();
  }

  function setStatus(s) {
    const dot = document.getElementById('lc-dot');
    const txt = document.getElementById('lc-status-text');
    if (!dot || !txt) return;
    dot.className = 'lc-status-dot' + (s === 'online' ? '' : s === 'away' ? ' away' : ' offline');
    txt.textContent = s === 'online' ? 'Online' : s === 'away' ? 'Away' : 'Offline';
  }

  // ─── Send ─────────────────────────────────────────────────────
  function sendMsg() {
    const inp = document.getElementById('lc-input');
    if (!inp || !inp.value.trim()) return;
    const text = inp.value.trim();
    appendMsg(text, 'visitor');
    if (socket && connected) socket.emit('visitor:message', { sessionId, text });
    inp.value = '';
    inp.style.height = 'auto';
    inp.focus({ preventScroll: true });
    scrollBottom();
  }

  document.getElementById('lc-send').onclick = sendMsg;
  document.getElementById('lc-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isMobile()) { e.preventDefault(); sendMsg(); }
  });
  document.getElementById('lc-input').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 90) + 'px';
    if (socket && connected) socket.emit('visitor:typing', { sessionId });
  });

})();
