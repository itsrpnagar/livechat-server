/**
 * LiveChat Widget — Mobile Optimized
 */
(function () {
  const scriptTag = document.currentScript;
  const SERVER_URL = (window.LiveChatConfig?.server) || scriptTag?.getAttribute('data-server') || 'https://api.satradiozone.online';
  const BOT_NAME   = (window.LiveChatConfig?.name)   || scriptTag?.getAttribute('data-name')   || 'Support';
  const THEME      = (window.LiveChatConfig?.color)  || scriptTag?.getAttribute('data-color')  || '#6c63ff';

  let sessionId = localStorage.getItem('lc_session_id');
  if (!sessionId) {
    sessionId = 'v_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('lc_session_id', sessionId);
  }

  let socket = null, connected = false, typingTimer, isOpen = false, unreadCount = 0;
  const isMobile = () => window.innerWidth <= 768;

  // ─── iOS keyboard fix ────────────────────────────────────────
  function fixViewport() {
    if (!isOpen || !isMobile()) return;
    const vv = window.visualViewport;
    const w = document.getElementById('lc-widget');
    if (!vv || !w) return;
    // Position widget exactly within the visible viewport
    w.style.top    = vv.pageTop + 'px';
    w.style.left   = vv.pageLeft + 'px';
    w.style.width  = vv.width + 'px';
    w.style.height = vv.height + 'px';
    scrollBottom();
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fixViewport);
    window.visualViewport.addEventListener('scroll', fixViewport);
  }

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
        sessionId, name: 'Visitor',
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
    }
    #lc-btn:active { opacity: 0.85; }
    #lc-badge {
      position: absolute; top: -2px; right: -2px; background: #ef4444;
      color: #fff; border-radius: 50%; width: 18px; height: 18px;
      font-size: 10px; font-weight: 700; display: none;
      align-items: center; justify-content: center; border: 2px solid #fff;
    }

    /* Widget container */
    #lc-widget {
      position: fixed; bottom: 88px; right: 20px; z-index: 2147483646;
      width: 340px; height: 500px;
      display: none; flex-direction: column;
      background: #fff; border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,.2);
      font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
      overflow: hidden;
    }

    /* Mobile: full screen fixed */
    @media (max-width: 768px) {
      #lc-widget {
        position: fixed !important;
        top: 0 !important; left: 0 !important;
        right: 0 !important; bottom: 0 !important;
        width: 100% !important;
        height: 100% !important;
        height: 100dvh !important;
        border-radius: 0 !important;
        box-shadow: none !important;
      }
      #lc-btn { bottom: 16px; right: 16px; }
    }

    /* Header — always fixed at top */
    #lc-header {
      flex-shrink: 0;
      padding: 14px 16px;
      background: ${THEME};
      display: flex; align-items: center; gap: 10px;
      position: sticky; top: 0; z-index: 10;
    }
    @media (max-width: 768px) {
      #lc-header {
        padding-top: max(16px, env(safe-area-inset-top));
        padding-bottom: 14px;
      }
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
      flex-shrink: 0;
      width: 32px; height: 32px; border-radius: 50%;
      background: rgba(255,255,255,.2); border: none;
      color: #fff; font-size: 16px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      -webkit-tap-highlight-color: transparent;
    }
    #lc-close-btn:active { background: rgba(255,255,255,.4); }

    /* Messages — scrollable area */
    #lc-messages {
      flex: 1;
      overflow-y: auto; overflow-x: hidden;
      -webkit-overflow-scrolling: touch;
      padding: 14px 12px;
      display: flex; flex-direction: column; gap: 8px;
      background: #f5f6f8;
    }
    @media (max-width: 768px) {
      #lc-messages { padding: 16px 14px; gap: 10px; }
    }

    .lc-msg {
      max-width: 80%; padding: 10px 13px;
      border-radius: 16px; font-size: 14px;
      line-height: 1.5; word-break: break-word;
    }
    @media (max-width: 768px) {
      .lc-msg { font-size: 15px; max-width: 85%; }
    }
    .lc-msg.from-admin {
      background: #fff; border: 1px solid #e8eaed;
      border-bottom-left-radius: 4px;
      align-self: flex-start; color: #1a1a2e;
    }
    .lc-msg.from-visitor {
      background: ${THEME}; color: #fff;
      border-bottom-right-radius: 4px;
      align-self: flex-end;
    }

    #lc-typing {
      flex-shrink: 0;
      padding: 0 14px 4px;
      font-size: 12px; color: #9ca3af;
      font-style: italic; min-height: 20px;
      background: #f5f6f8;
    }

    /* Footer — always fixed at bottom */
    #lc-footer {
      flex-shrink: 0;
      padding: 10px 12px;
      padding-bottom: max(10px, env(safe-area-inset-bottom));
      background: #fff;
      border-top: 1px solid #e8eaed;
      display: flex; gap: 8px; align-items: center;
    }
    @media (max-width: 768px) {
      #lc-footer {
        padding: 10px 14px;
        padding-bottom: max(12px, env(safe-area-inset-bottom));
        gap: 10px;
      }
    }

    #lc-input {
      flex: 1; min-width: 0;
      border: 1.5px solid #e8eaed; border-radius: 22px;
      padding: 10px 16px;
      font-size: 15px; line-height: 1.4;
      resize: none; outline: none;
      font-family: inherit;
      background: #f5f6f8; color: #1a1a2e;
      max-height: 90px; min-height: 42px;
      transition: border-color .2s;
      -webkit-appearance: none;
      display: block;
    }
    #lc-input:focus { border-color: ${THEME}; background: #fff; }
    #lc-input::placeholder { color: #aaa; }
    @media (max-width: 768px) {
      #lc-input { font-size: 16px; }
    }

    #lc-send {
      flex-shrink: 0;
      width: 42px; height: 42px;
      background: ${THEME}; color: #fff;
      border: none; border-radius: 50%;
      cursor: pointer; font-size: 18px;
      display: flex; align-items: center; justify-content: center;
      -webkit-tap-highlight-color: transparent;
      transition: opacity .15s;
    }
    #lc-send:active { opacity: 0.8; }
    #lc-send:disabled { opacity: 0.4; }

    .lc-status-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #22c55e; display: inline-block; flex-shrink: 0;
    }
    .lc-status-dot.away { background: #f59e0b; }
    .lc-status-dot.offline { background: #9ca3af; }

    #lc-messages::-webkit-scrollbar { width: 3px; }
    #lc-messages::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ─── Build UI ───────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.id = 'lc-btn';
  btn.setAttribute('aria-label', 'Open chat');
  btn.innerHTML = `💬<span id="lc-badge"></span>`;
  document.body.appendChild(btn);

  const widget = document.createElement('div');
  widget.id = 'lc-widget';
  widget.innerHTML = `
    <div id="lc-header">
      <div id="lc-avatar">👋</div>
      <div class="lc-info">
        <div class="lc-title">${BOT_NAME}</div>
        <div class="lc-sub">
          <span class="lc-status-dot" id="lc-dot"></span>
          <span id="lc-status-text">Online</span>
        </div>
      </div>
      <button id="lc-close-btn" aria-label="Close chat">✕</button>
    </div>
    <div id="lc-messages">
      <div class="lc-msg from-admin">Hi! 👋 How can we help you today?</div>
    </div>
    <div id="lc-typing"></div>
    <div id="lc-footer">
      <textarea id="lc-input" placeholder="Type your message..." rows="1" autocomplete="off" spellcheck="true"></textarea>
      <button id="lc-send" aria-label="Send">↑</button>
    </div>
  `;
  document.body.appendChild(widget);

  // ─── Scroll ─────────────────────────────────────────────────
  function scrollBottom() {
    const box = document.getElementById('lc-messages');
    if (!box) return;
    box.scrollTop = box.scrollHeight;
    setTimeout(() => { box.scrollTop = box.scrollHeight; }, 100);
  }

  // ─── Toggle ─────────────────────────────────────────────────
  btn.onclick = () => toggleWidget();
  document.getElementById('lc-close-btn').onclick = () => toggleWidget(false);

  function toggleWidget(force) {
    isOpen = force !== undefined ? force : !isOpen;

    if (isOpen) {
      widget.style.display = 'flex';
      if (isMobile()) {
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.width = '100%';
        // Apply immediately
        const vv = window.visualViewport;
        if (vv) {
          widget.style.top    = vv.pageTop + 'px';
          widget.style.left   = vv.pageLeft + 'px';
          widget.style.width  = vv.width + 'px';
          widget.style.height = vv.height + 'px';
        }
      }
      btn.style.display = 'none';
      unreadCount = 0;
      const badge = document.getElementById('lc-badge');
      if (badge) badge.style.display = 'none';
      scrollBottom();
      setTimeout(() => {
        document.getElementById('lc-input')?.focus();
        scrollBottom();
      }, 400);
      if (!socket) loadSocket(() => initSocket());
    } else {
      widget.style.display = 'none';
      widget.style.top = '';
      widget.style.height = '';
      if (isMobile()) {
        document.body.style.overflow = '';
        document.body.style.position = '';
        document.body.style.width = '';
      }
      btn.style.display = 'flex';
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
    if (show) scrollBottom();
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
    inp.focus();
    scrollBottom();
  }

  document.getElementById('lc-send').onclick = sendMsg;

  document.getElementById('lc-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isMobile()) {
      e.preventDefault();
      sendMsg();
    }
  });

  document.getElementById('lc-input').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 90) + 'px';
    if (socket && connected) socket.emit('visitor:typing', { sessionId });
  });

})();
