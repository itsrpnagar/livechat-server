const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const cors     = require("cors");
const crypto   = require("crypto");
const path     = require("path");
const fs       = require("fs");
const UAParser = require("ua-parser-js");

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingInterval: 10000,
  pingTimeout:  5000,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Bot / Crawler Detection ─────────────────────────────────────
const BANNED_KEYWORDS = [
  // Google
  "googlebot", "adsbot", "mediapartners", "lighthouse",
  // Headless / Automated
  "headless", "phantomjs", "selenium", "puppeteer", "playwright",
  // Search crawlers
  "bingbot", "slurp", "duckduckbot", "baiduspider",
  "yandexbot", "applebot",
  // Social crawlers
  "facebookexternalhit", "twitterbot",
  // SEO tools
  "semrushbot", "ahrefsbot", "mj12bot"
];

// ─── Visitor Tracking ────────────────────────────────────────────
const activeSockets     = new Map(); // socketId → deviceId
const deviceConnections = new Map(); // deviceId → count
const activeVisitorData = new Map(); // deviceId → visitorData
const alertedDevices    = new Set(); // deviceId → already alerted

// ─── Stats ───────────────────────────────────────────────────────
let stats = { activeVisitors: 0, alertsSent: 0, chatsStarted: 0 };

// ─── Simple Hash (no base64) ─────────────────────────────────────
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// ─── Transcripts ────────────────────────────────────────────────
const DATA_DIR        = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
const TRANSCRIPTS_DIR = path.join(DATA_DIR, "transcripts");
if (!fs.existsSync(TRANSCRIPTS_DIR)) fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

function loadAllTranscripts() {
  try {
    return fs.readdirSync(TRANSCRIPTS_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(TRANSCRIPTS_DIR, f), "utf8")); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ─── Routes ──────────────────────────────────────────────────────
app.get("/",          (req, res) => res.json({ status: "LiveChat server running 🟢" }));
app.get("/admin",     (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/widget.js", (req, res) => { res.setHeader("Content-Type", "application/javascript"); res.sendFile(path.join(__dirname, "public", "widget.js")); });

// ─── Transcripts API ─────────────────────────────────────────────
app.get("/api/transcripts", (req, res) => {
  const t = loadAllTranscripts(); t.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt)); res.json(t);
});
app.get("/api/transcripts/:id", (req, res) => {
  const fp = path.join(TRANSCRIPTS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" });
  res.json(JSON.parse(fs.readFileSync(fp, "utf8")));
});
app.post("/api/transcripts/save", (req, res) => {
  try {
    const { sessionId, customerName } = req.body;
    const session = sessions[sessionId];
    if (!session) return res.status(404).json({ error: "Session not found" });
    const id   = crypto.randomUUID();
    const data = { id, customerName: customerName || session.name, sessionId: session.id, page: session.page, referrer: session.referrer, device: session.device, utmSource: session.utmSource, utmMedium: session.utmMedium, utmCampaign: session.utmCampaign, gclid: session.gclid, connectedAt: session.connectedAt, savedAt: new Date().toISOString(), messages: session.messages };
    fs.writeFileSync(path.join(TRANSCRIPTS_DIR, `${id}.json`), JSON.stringify(data, null, 2));
    res.json({ success: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete("/api/transcripts/:id", (req, res) => {
  try { const fp = path.join(TRANSCRIPTS_DIR, `${req.params.id}.json`); if (fs.existsSync(fp)) fs.unlinkSync(fp); res.json({ success: true }); }
  catch { res.status(500).json({ error: "Delete failed" }); }
});

// ─── In-memory chat sessions ─────────────────────────────────────
const sessions    = {};
let adminSocketId = null;

// ─── Socket.io ───────────────────────────────────────────────────
io.on("connection", (socket) => {

  const role = socket.handshake.query.role;

  // ════════════════════════════════════════════════════════════════
  // ADMIN
  // ════════════════════════════════════════════════════════════════
  if (role === "admin") {

    socket.on("admin:join", ({ username, password }) => {
      const ADMIN_USER = process.env.ADMIN_USERNAME || "admin";
      const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin123";
      if (username !== ADMIN_USER || password !== ADMIN_PASS) { socket.emit("admin:auth_failed"); return; }

      adminSocketId = socket.id;
      socket.emit("admin:auth_success");
      socket.emit("admin:all_sessions", Object.values(sessions));
      socket.emit("admin:all_visitors", Array.from(activeVisitorData.values()));
      socket.emit("update_stats", stats);
      console.log("Admin connected:", socket.id);
    });

    // ── Send Alert (popup) to visitor ──
    socket.on("admin:send_alert", ({ targetSocketId, deviceId }) => {
      const visitor = activeVisitorData.get(deviceId);
      if (!visitor) return;

      // Safety check — bot/desktop/datacenter blocked
      if (visitor.isBot || visitor.isDesktop || visitor.isDatacenter) return;

      const popupHTML = buildPopupHTML(targetSocketId, deviceId);
      io.to(targetSocketId).emit("show_popup", { html: popupHTML });

      alertedDevices.add(deviceId);
      stats.alertsSent++;
      io.to(adminSocketId).emit("update_stats", stats);
      socket.emit("admin:alert_sent", { deviceId });
    });

    // ── Chat messages ──
    socket.on("admin:message", ({ sessionId, text }) => {
      const session = sessions[sessionId];
      if (!session) return;
      const msg = { id: crypto.randomUUID(), from: "admin", text, time: new Date().toISOString() };
      session.messages.push(msg);
      if (session.visitorSocketId) io.to(session.visitorSocketId).emit("chat:message", msg);
      socket.emit("admin:message_sent", { sessionId, msg });
    });

    socket.on("admin:get_session",    ({ sessionId }) => { const s = sessions[sessionId]; if (s) socket.emit("admin:session_detail", s); });
    socket.on("admin:close_session",  ({ sessionId }) => {
      const s = sessions[sessionId];
      if (s) { s.status = "closed"; if (s.visitorSocketId) io.to(s.visitorSocketId).emit("chat:closed"); socket.emit("admin:session_closed", { sessionId }); }
    });
    socket.on("admin:typing", ({ sessionId }) => {
      const s = sessions[sessionId];
      if (s?.visitorSocketId) io.to(s.visitorSocketId).emit("chat:admin_typing");
    });
    socket.on("reset_stats", () => {
      stats = { activeVisitors: deviceConnections.size, alertsSent: 0, chatsStarted: 0 };
      io.emit("update_stats", stats);
    });

    socket.on("disconnect", () => {
      if (socket.id === adminSocketId) { adminSocketId = null; console.log("Admin disconnected"); }
    });

    return;
  }

  // ════════════════════════════════════════════════════════════════
  // VISITOR
  // ════════════════════════════════════════════════════════════════
  const ua       = (socket.handshake.headers["user-agent"] || "").toLowerCase();
  const parser   = new UAParser(ua);
  const device   = parser.getDevice();
  const isBot    = BANNED_KEYWORDS.some(k => ua.includes(k));
  const isDesktop = !device.type || !["mobile","tablet","wearable"].includes(device.type);
  const ip       = (socket.handshake.headers["x-forwarded-for"] || "").split(",")[0].trim() || socket.handshake.address || "";
  const deviceId = simpleHash(ip + (parser.getOS().name || "") + (parser.getBrowser().name || ""));

  activeSockets.set(socket.id, deviceId);
  deviceConnections.set(deviceId, (deviceConnections.get(deviceId) || 0) + 1);
  stats.activeVisitors = deviceConnections.size;

  // ── Emit visitor to admin ──
  const emitVisitor = (ispName, isDatacenter, countryCode) => {
    const flag = countryCode
      ? countryCode.toUpperCase().replace(/./g, c => String.fromCodePoint(c.charCodeAt(0) + 127397))
      : "🌐";

    const visitorData = {
      socketId:    socket.id,
      deviceId,
      os:          parser.getOS().name      || "Unknown",
      browser:     parser.getBrowser().name || "Unknown",
      isp:         ispName,
      isDatacenter,
      isBot,
      isDesktop,
      flag,
      country:     countryCode || "",
      alerted:     alertedDevices.has(deviceId),
      page:        socket.handshake.query.page || "/",
      connectedAt: new Date().toISOString(),
    };

    activeVisitorData.set(deviceId, visitorData);
    if (adminSocketId) io.to(adminSocketId).emit("admin:visitor_update", visitorData);
    io.to(adminSocketId || "").emit("update_stats", stats);
  };

  emitVisitor("Loading...", false, "");

  // IP Lookup
  if (ip && ip !== "::1" && ip !== "127.0.0.1") {
    fetch(`http://ip-api.com/json/${ip}?fields=isp,org,hosting,countryCode`)
      .then(r => r.json())
      .then(d => emitVisitor(d.isp || d.org || "Unknown", d.hosting === true, d.countryCode || ""))
      .catch(() => emitVisitor("Unknown ISP", false, ""));
  } else {
    emitVisitor("Localhost", false, "US");
  }

  // ── Visitor: service selected from popup → start chat ──
  socket.on("visitor:service_selected", ({ service, sessionId: sid }) => {
    let session = sessions[sid];
    if (!session) {
      session = {
        id: sid, name: "Visitor", page: socket.handshake.query.page || "/",
        referrer: "", device: isDesktop ? "Desktop" : parser.getDevice().type || "Mobile",
        utmSource: "", utmMedium: "", utmCampaign: "", gclid: "",
        messages: [], status: "active",
        connectedAt: new Date().toISOString(),
        visitorSocketId: socket.id,
        service,
      };
      sessions[sid] = session;
    }
    socket.sessionId = sid;
    socket.emit("visitor:session", { sessionId: sid });

    // Auto greeting with selected service
    const greeting = `Hi! I see you need help with "${service}". A live agent will be with you shortly.`;
    const msg = { id: crypto.randomUUID(), from: "admin", text: greeting, time: new Date().toISOString() };
    session.messages.push(msg);
    socket.emit("chat:message", msg);

    stats.chatsStarted++;
    if (adminSocketId) {
      io.to(adminSocketId).emit("admin:new_session", session);
      io.to(adminSocketId).emit("update_stats", stats);
    }
  });

  // ── Visitor: join existing chat ──
  socket.on("visitor:join", ({ sessionId, name, page, referrer, device: dev, utmSource, utmMedium, utmCampaign, gclid }) => {
    let session = sessions[sessionId];
    if (!session) {
      session = { id: sessionId || crypto.randomUUID(), name: name || "Visitor", page: page || "/", referrer: referrer || "", device: dev || "Mobile", utmSource: utmSource || "", utmMedium: utmMedium || "", utmCampaign: utmCampaign || "", gclid: gclid || "", messages: [], status: "active", connectedAt: new Date().toISOString(), visitorSocketId: socket.id };
      sessions[session.id] = session;
    } else { session.visitorSocketId = socket.id; session.status = "active"; }
    socket.sessionId = session.id;
    socket.emit("visitor:session", { sessionId: session.id });
    if (adminSocketId) io.to(adminSocketId).emit("admin:new_session", session);
  });

  socket.on("visitor:message", ({ sessionId, text }) => {
    const session = sessions[sessionId];
    if (!session) return;
    const msg = { id: crypto.randomUUID(), from: "visitor", text, time: new Date().toISOString() };
    session.messages.push(msg);
    if (adminSocketId) io.to(adminSocketId).emit("admin:message", { sessionId, msg });
  });

  socket.on("visitor:typing", ({ sessionId }) => {
    if (adminSocketId) io.to(adminSocketId).emit("admin:visitor_typing", { sessionId });
  });

  socket.on("popup:dismissed", ({ deviceId: dId }) => {
    if (adminSocketId) io.to(adminSocketId).emit("admin:popup_dismissed", { deviceId: dId });
  });

  socket.on("disconnect", () => {
    const dId = activeSockets.get(socket.id);
    activeSockets.delete(socket.id);
    if (dId) {
      const count = (deviceConnections.get(dId) || 1) - 1;
      if (count <= 0) { deviceConnections.delete(dId); activeVisitorData.delete(dId); if (adminSocketId) io.to(adminSocketId).emit("admin:visitor_disconnect", dId); }
      else deviceConnections.set(dId, count);
    }
    if (socket.sessionId && sessions[socket.sessionId]) {
      sessions[socket.sessionId].status = "away";
      if (adminSocketId) io.to(adminSocketId).emit("admin:visitor_left", { sessionId: socket.sessionId });
    }
    stats.activeVisitors = deviceConnections.size;
    if (adminSocketId) io.to(adminSocketId).emit("update_stats", stats);
  });
});

// ─── Popup HTML Builder ──────────────────────────────────────────
function buildPopupHTML(socketId, deviceId) {
  const services = [
    { emoji: "📡", label: "Satellite Radio Not Activating" },
    { emoji: "📶", label: "Signal / Reception Issues"      },
    { emoji: "💳", label: "Billing & Subscription"         },
    { emoji: "🔄", label: "Plan Change / Upgrade"          },
    { emoji: "❓", label: "General Support"                },
  ];

  const items = services.map(s => `
    <div class="lc-pop-item" onclick="lcSelectService('${s.label}')">
      <div class="lc-pop-left">
        <span class="lc-pop-emoji">${s.emoji}</span>
        <span class="lc-pop-text">${s.label}</span>
      </div>
      <svg class="lc-pop-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6c63ff" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
  `).join("");

  return `
    <div id="lc-pop-overlay">
      <div id="lc-pop-box">
        <div id="lc-pop-header">
          <div id="lc-pop-live"><span id="lc-pop-dot"></span> Live Support</div>
          <button id="lc-pop-close" onclick="lcDismissPopup()" aria-label="Dismiss">&#x2715;</button>
        </div>
        <div id="lc-pop-intro">To get started, please select the issue you are experiencing.</div>
        <div id="lc-pop-list">${items}</div>
        <div id="lc-pop-dismiss">
          <a href="#" onclick="lcDismissPopup(); return false;">No thanks, dismiss</a>
        </div>
      </div>
    </div>

    <style>
      #lc-pop-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483646;display:flex;align-items:flex-end;justify-content:center;padding-bottom:0;animation:lcPopFade .25s ease}
      @keyframes lcPopFade{from{opacity:0}to{opacity:1}}
      #lc-pop-box{background:#fff;width:100%;max-width:480px;border-radius:20px 20px 0 0;overflow:hidden;box-shadow:0 -4px 30px rgba(0,0,0,.15);animation:lcPopUp .3s ease}
      @keyframes lcPopUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
      #lc-pop-header{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 0}
      #lc-pop-live{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:#1a1a2e}
      #lc-pop-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;animation:lcBlink 1.4s infinite}
      @keyframes lcBlink{0%,100%{opacity:1}50%{opacity:.4}}
      #lc-pop-close{background:none;border:none;font-size:18px;color:#9ca3af;cursor:pointer;padding:4px;line-height:1}
      #lc-pop-intro{padding:12px 18px 8px;font-size:14px;font-weight:600;color:#1a1a2e;line-height:1.4;background:#f0f4ff;margin:12px 18px;border-radius:10px}
      #lc-pop-list{padding:4px 14px 0}
      .lc-pop-item{display:flex;align-items:center;justify-content:space-between;padding:14px 6px;border-bottom:1px solid #f3f4f6;cursor:pointer;transition:background .15s;border-radius:8px;-webkit-tap-highlight-color:transparent}
      .lc-pop-item:last-child{border-bottom:none}
      .lc-pop-item:active{background:#f5f3ff}
      .lc-pop-left{display:flex;align-items:center;gap:12px}
      .lc-pop-emoji{font-size:20px;width:28px;text-align:center}
      .lc-pop-text{font-size:14px;color:#1a1a2e;font-weight:500}
      .lc-pop-arrow{flex-shrink:0}
      #lc-pop-dismiss{text-align:center;padding:12px 0 20px}
      #lc-pop-dismiss a{font-size:12px;color:#9ca3af;text-decoration:none}
    </style>

    <script>
      var _lcDeviceId = '${deviceId}';
      var _lcSessionId = 'v_' + Math.random().toString(36).substr(2,9);

      function lcSelectService(service) {
        document.getElementById('lc-pop-overlay').remove();
        if (window._lcSocket) {
          window._lcSocket.emit('visitor:service_selected', { service: service, sessionId: _lcSessionId });
        }
        if (typeof window.lcOpenChat === 'function') window.lcOpenChat(service, _lcSessionId);
      }

      function lcDismissPopup() {
        var el = document.getElementById('lc-pop-overlay');
        if (el) el.remove();
        if (window._lcSocket) window._lcSocket.emit('popup:dismissed', { deviceId: _lcDeviceId });
      }
    <\/script>
  `;
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
