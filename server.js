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

// ─── Device ID Hash ─────────────────────────────────────────────
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

    // ── Send Alert to visitor ──
    socket.on("admin:send_alert", ({ targetSocketId, deviceId }) => {
      const visitor = activeVisitorData.get(deviceId);
      if (!visitor) return;

      // Safety check — bot/desktop/datacenter blocked
      if (visitor.isBot || visitor.isDesktop || visitor.isDatacenter) return;

      const widgetHTML = buildWidgetHTML(targetSocketId, deviceId);
      io.to(targetSocketId).emit("lc:render", { html: widgetHTML });

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

    // ── Admin: reconnect visitor after refresh ──
    socket.on("admin:reconnect_visitor", ({ sessionId }) => {
      const session = sessions[sessionId];
      if (!session || !session.visitorSocketId) return;
      // Tell visitor to reopen chat with history
      io.to(session.visitorSocketId).emit("chat:reopen", {
        sessionId,
        messages: session.messages,
      });
      session.status = "active";
      socket.emit("admin:session_reconnected", { sessionId });
    });
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

  // ── Visitor: service selected → start chat ──
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

  // ── Visitor: restore session after refresh ──────────────────
  socket.on("visitor:restore", ({ sessionId: sid }) => {
    const session = sessions[sid];
    if (!session || session.status === "closed") {
      socket.emit("visitor:restore_failed");
      return;
    }
    // Update socket ID only — don't reopen chat
    session.visitorSocketId = socket.id;
    session.status = "away";
    socket.sessionId = sid;

    socket.emit("visitor:restore_ok", { sessionId: sid });

    // Notify admin — show Reconnect button
    if (adminSocketId) {
      io.to(adminSocketId).emit("admin:visitor_refreshed", {
        sessionId: sid,
        deviceId,
      });
    }
    console.log("Visitor refreshed page, session kept:", sid);
  });

  // ── Visitor: closed chat window ─────────────────────────────
  socket.on("visitor:chat_closed", ({ sessionId: sid }) => {
    if (adminSocketId) {
      io.to(adminSocketId).emit("admin:visitor_closed_chat", { sessionId: sid });
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

  socket.on("lc:dismissed", ({ deviceId: dId }) => {
    if (adminSocketId) io.to(adminSocketId).emit("admin:lc_dismissed", { deviceId: dId });
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

// ─── Widget Card Builder ──────────────────────────────────────────
function buildWidgetHTML(socketId, deviceId) {
  const services = [
    { emoji: "📡", label: "Satellite Radio Not Activating" },
    { emoji: "📶", label: "Signal / Reception Issues"      },
    { emoji: "💳", label: "Billing & Subscription"         },
    { emoji: "🔄", label: "Plan Change / Upgrade"          },
    { emoji: "❓", label: "General Support"                },
  ];

  const items = services.map(s => `
    <div class="lc-card-item" data-service="${s.label.replace(/"/g, '&quot;')}">
      <div class="lc-card-left">
        <span class="lc-card-emoji">${s.emoji}</span>
        <span class="lc-card-text">${s.label}</span>
      </div>
      <svg class="lc-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1a56db" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
  `).join("");

  
  const html = `
    <div id="lc-card-overlay">
      <div id="lc-card-box">
        <div id="lc-card-header">
          <div id="lc-card-live"><span id="lc-card-dot"></span> Live Support</div>
          <button id="lc-card-close" aria-label="Dismiss">&#x2715;</button>
        </div>
        <div id="lc-card-intro">To get started, please select the issue you are experiencing.</div>
        <div id="lc-card-list">${items}</div>
        <div id="lc-card-dismiss">
          <a href="#" id="lc-card-no">No thanks, dismiss</a>
        </div>
      </div>
    </div>
    <style>
      #lc-card-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:16px;animation:lcFadeIn .2s ease}
      @keyframes lcFadeIn{from{opacity:0}to{opacity:1}}
      #lc-card-box{background:#fff;width:100%;max-width:420px;border-radius:16px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.2);animation:lcScaleIn .25s ease;font-family:-apple-system,'Segoe UI',system-ui,sans-serif}
      @keyframes lcScaleIn{from{transform:scale(.94);opacity:0}to{transform:scale(1);opacity:1}}
      #lc-card-header{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 12px}
      #lc-card-live{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:700;color:#1a1a2e}
      #lc-card-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;animation:lcDotBlink 1.4s infinite}
      @keyframes lcDotBlink{0%,100%{opacity:1}50%{opacity:.3}}
      #lc-card-close{background:none;border:none;font-size:18px;color:#9ca3af;cursor:pointer;padding:4px;line-height:1;-webkit-tap-highlight-color:transparent}
      #lc-card-intro{margin:0 16px 12px;padding:12px 16px;font-size:13px;font-weight:600;color:#1e3a5f;line-height:1.5;background:#eff6ff;border-radius:10px}
      #lc-card-list{padding:0 12px}
      .lc-card-item{display:flex;align-items:center;justify-content:space-between;padding:14px 8px;border-bottom:1px solid #f1f5f9;cursor:pointer;-webkit-tap-highlight-color:transparent;border-radius:8px}
      .lc-card-item:last-child{border-bottom:none}
      .lc-card-left{display:flex;align-items:center;gap:14px;pointer-events:none}
      .lc-card-emoji{font-size:22px;width:32px;text-align:center;flex-shrink:0;pointer-events:none}
      .lc-card-text{font-size:14px;color:#1e293b;font-weight:500;line-height:1.3;pointer-events:none}
      .lc-card-arrow{flex-shrink:0;opacity:.6;pointer-events:none}
      #lc-card-dismiss{text-align:center;padding:14px 0 18px}
      #lc-card-no{font-size:12px;color:#94a3b8;text-decoration:none}
    </style>
    <lcdata id="lc-meta" data-did="${deviceId}" data-sid="v_${Math.random().toString(36).substr(2,9)}${Date.now().toString(36)}"></lcdata>
  `;

  return html;
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
