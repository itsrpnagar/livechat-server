/**
 * LiveChat Widget
 * Apni website pe paste karo
 * 
 * Usage:
 *   window.LiveChatConfig = { server: 'https://api.satradiozone.online', name: 'Support' };
 */
(function () {
  // ─── CONFIG ──────────────────────────────────────────────────
  const scriptTag = document.currentScript;
  const SERVER_URL = (window.LiveChatConfig?.server) || scriptTag?.getAttribute('data-server') || 'https://api.satradiozone.online';
  const BOT_NAME   = (window.LiveChatConfig?.name) || scriptTag?.getAttribute('data-name') || 'Support';
  const THEME      = (window.LiveChatConfig?.color) || scriptTag?.getAttribute('data-color') || '#6c63ff';

  // ─── SESSION ─────────────────────────────────────────────────
  let sessionId = localStorage.getItem('lc_session_id');
  if (!sessionId) {
    sessionId = 'v_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('lc_session_id', sessionId);
  }

  const visitorName = localStorage.getItem('lc_visitor_name') || 'Visitor';

  // ─── SOCKET ──────────────────────────────────────────────────
  let socket = null;
  let connected = false;
  let typingTimer;

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
      socket.emit('visitor:join', {
        sessionId,
        name: visitorName,
        page: window.location.pathname,
      });
      setStatus('online');
    });

    socket.on('visitor:session', ({ sessionId: sid }) => {
      sessionId = sid;
      localStorage.setItem('lc_session_id', sid);
    });

    socket.on('chat:message', (msg) => {
      appendMsg(msg.text, 'admin');
    });

    socket.on('chat:admin_typing', () => {
      showTyping(true);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => showTyping(false), 2000);
    });

    socket.on('chat:closed', () => {
      appendMsg('Chat band ho gayi hai. Shukriya! 🙏', 'admin');
      setStatus('offline');
    });

    socket.on('disconnect', () => {
      connected = false;
      setStatus('away');
    });
  }

  // ─── BUILD UI ─────────────────────────────────────────────────
  const css = `
    #lc-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 99999;
      width: 56px; height: 56px; border-radius: 50%; background: ${THEME};
      border: none; cursor: pointer; box-shadow: 0 4px 20px rgba(0,0,0,.25);
      display: flex; align-items: center; justify-content: center;
      font-size: 24px; transition: transform .2s, box-shadow .2s;
    }
    #lc-btn:hover { transform: scale(1.1); box-shadow: 0 6px 28px rgba(0,0,0,.3); }
    #lc-badge {
      position: absolute; top: -3px; right: -3px; background: #ef4444;
      color: #fff; border-radius: 50%; width: 18px; height: 18px;
      font-size: 10px; font-weight: 700; display: flex; align-items: center;
      justify-content: center; display: none;
    }
    #lc-widget {
      position: fixed; bottom: 92px; right: 24px; z-index: 99999;
      width: 340px; height: 480px; background: #fff; border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,.18); display: none;
      flex-direction: column; overflow: hidden; font-family: 'Segoe UI', system-ui, sans-serif;
      animation: lcSlide .25s ease;
    }
    @keyframes lcSlide { from { opacity:0; transform: translateY(20px); } to { opacity:1; transform:translateY(0); } }
    #lc-header {
      padding: 14px 16px; background: ${THEME};
      display: flex; align-items: center; gap: 10px;
    }
    #lc-header .avatar {
      width: 34px; height: 34px; border-radius: 50%; background: rgba(255,255,255,.25);
      display: flex; align-items: center; justify-content: center; font-size: 16px;
    }
    #lc-header .info .title { color: #fff; font-weight: 700; font-size: 14px; }
    #lc-header .info .sub { color: rgba(255,255,255,.8); font-size: 11px; }
    #lc-close-btn {
      margin-left: auto; background: none; border: none; color: rgba(255,255,255,.8);
      cursor: pointer; font-size: 18px; line-height: 1;
    }
    #lc-messages {
      flex: 1; overflow-y: auto; padding: 14px; display: flex;
      flex-direction: column; gap: 8px; background: #f8f9fb;
    }
    .lc-msg { max-width: 82%; padding: 9px 12px; border-radius: 12px; font-size: 13px; line-height: 1.5; word-break: break-word; }
    .lc-msg.from-admin { background: #fff; border: 1px solid #e5e7eb; border-bottom-left-radius: 3px; align-self: flex-start; color: #1f2937; }
    .lc-msg.from-visitor { background: ${THEME}; color: #fff; border-bottom-right-radius: 3px; align-self: flex-end; }
    #lc-typing { padding: 2px 14px 6px; font-size: 11px; color: #9ca3af; font-style: italic; min-height: 20px; }
    #lc-footer { padding: 10px 12px; background: #fff; border-top: 1px solid #e5e7eb; display: flex; gap: 8px; }
    #lc-input {
      flex: 1; border: 1px solid #e5e7eb; border-radius: 10px; padding: 9px 12px;
      font-size: 13px; resize: none; outline: none; font-family: inherit;
      max-height: 80px; transition: border-color .2s;
    }
    #lc-input:focus { border-color: ${THEME}; }
    #lc-send {
      padding: 9px 14px; background: ${THEME}; color: #fff; border: none;
      border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 600;
      transition: opacity .2s;
    }
    #lc-send:hover { opacity: .85; }
    #lc-messages::-webkit-scrollbar { width: 4px; }
    #lc-messages::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 2px; }
    .lc-status-dot { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; display: inline-block; margin-right: 4px; }
    .lc-status-dot.away { background: #f59e0b; }
    .lc-status-dot.offline { background: #9ca3af; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // Button
  const btn = document.createElement('button');
  btn.id = 'lc-btn';
  btn.innerHTML = `💬<span id="lc-badge"></span>`;
  document.body.appendChild(btn);

  // Widget
  const widget = document.createElement('div');
  widget.id = 'lc-widget';
  widget.innerHTML = `
    <div id="lc-header">
      <div class="avatar">👋</div>
      <div class="info">
        <div class="title">${BOT_NAME}</div>
        <div class="sub"><span class="lc-status-dot" id="lc-dot"></span><span id="lc-status-text">Online</span></div>
      </div>
      <button id="lc-close-btn">✕</button>
    </div>
    <div id="lc-messages">
      <div class="lc-msg from-admin">Namaste! 👋 Koi bhi sawaal poochh sakte hain, hum yahan hain.</div>
    </div>
    <div id="lc-typing"></div>
    <div id="lc-footer">
      <textarea id="lc-input" placeholder="Apna message likho..." rows="1"></textarea>
      <button id="lc-send">↑</button>
    </div>
  `;
  document.body.appendChild(widget);

  let isOpen = false;
  let unreadCount = 0;

  btn.onclick = () => toggleWidget();
  document.getElementById('lc-close-btn').onclick = () => toggleWidget(false);

  function toggleWidget(force) {
    isOpen = force !== undefined ? force : !isOpen;
    widget.style.display = isOpen ? 'flex' : 'none';
    btn.innerHTML = isOpen ? `✕<span id="lc-badge"></span>` : `💬<span id="lc-badge"></span>`;

    if (isOpen) {
      unreadCount = 0;
      document.getElementById('lc-badge').style.display = 'none';
      document.getElementById('lc-input')?.focus();
      if (!socket) {
        loadSocket(() => { initSocket(); });
      }
    }
  }

  function appendMsg(text, from) {
    const box = document.getElementById('lc-messages');
    const d = document.createElement('div');
    d.className = `lc-msg from-${from}`;
    d.textContent = text;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;

    if (from === 'admin' && !isOpen) {
      unreadCount++;
      const badge = document.getElementById('lc-badge');
      badge.textContent = unreadCount;
      badge.style.display = 'flex';
    }
  }

  function showTyping(show) {
    const el = document.getElementById('lc-typing');
    if (el) el.textContent = show ? '...likh raha hai' : '';
  }

  function setStatus(s) {
    const dot = document.getElementById('lc-dot');
    const txt = document.getElementById('lc-status-text');
    if (!dot || !txt) return;
    dot.className = 'lc-status-dot' + (s === 'online' ? '' : s === 'away' ? ' away' : ' offline');
    txt.textContent = s === 'online' ? 'Online' : s === 'away' ? 'Busy' : 'Offline';
  }

  function sendMsg() {
    const inp = document.getElementById('lc-input');
    if (!inp || !inp.value.trim()) return;
    const text = inp.value.trim();
    appendMsg(text, 'visitor');
    if (socket && connected) {
      socket.emit('visitor:message', { sessionId, text });
    }
    inp.value = '';
    inp.style.height = 'auto';
  }

  document.getElementById('lc-send').onclick = sendMsg;
  document.getElementById('lc-input').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
  };
  document.getElementById('lc-input').oninput = function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 80) + 'px';
    if (socket && connected) socket.emit('visitor:typing', { sessionId });
  };

})();
