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

const BANNED_KEYWORDS = [
  "googlebot", "adsbot", "mediapartners", "lighthouse",
  "headless", "phantomjs", "selenium", "puppeteer", "playwright",
  "bingbot", "slurp", "duckduckbot", "baiduspider",
  "yandexbot", "applebot", "facebookexternalhit", "twitterbot",
  "semrushbot", "ahrefsbot", "mj12bot"
];

const activeSockets     = new Map();
const deviceConnections = new Map();
const activeVisitorData = new Map();
const alertedDevices    = new Set();

let stats = { activeVisitors: 0, alertsSent: 0, chatsStarted: 0 };

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

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

app.get("/",          (req, res) => res.json({ status: "LiveChat server running 🟢" }));
app.get("/admin",     (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/widget.js", (req, res) => { res.setHeader("Content-Type", "application/javascript"); res.sendFile(path.join(__dirname, "public", "widget.js")); });

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
    const id = crypto.randomUUID();
    const data = { id, customerName: customerName || session.name, sessionId: session.id, page: session.page, referrer: session.referrer, device: session.device, utmSource: session.utmSource, utmMedium: session.utmMedium, utmCampaign: session.utmCampaign, gclid: session.gclid, connectedAt: session.connectedAt, savedAt: new Date().toISOString(), messages: session.messages };
    fs.writeFileSync(path.join(TRANSCRIPTS_DIR, `${id}.json`), JSON.stringify(data, null, 2));
    res.json({ success: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete("/api/transcripts/:id", (req, res) => {
  try { const fp = path.join(TRANSCRIPTS_DIR, `${req.params.id}.json`); if (fs.existsSync(fp)) fs.unlinkSync(fp); res.json({ success: true }); }
  catch { res.status(500).json({ error: "Delete failed" }); }
});

const sessions    = {};
let adminSocketId = null;

io.on("connection", (socket) => {
  const role = socket.handshake.query.role;

  // ── ADMIN ──
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
    });

    socket.on("admin:send_alert", ({ targetSocketId, deviceId }) => {
      const visitor = activeVisitorData.get(deviceId);
      if (!visitor) return;
      if (visitor.isBot || visitor.isDesktop || visitor.isDatacenter) return;
      // Send simple trigger — landing page handles its own UI
      io.to(targetSocketId).emit("lc:trigger");
      alertedDevices.add(deviceId);
      stats.alertsSent++;
      io.to(adminSocketId).emit("update_stats", stats);
      socket.emit("admin:alert_sent", { deviceId });
    });

    socket.on("admin:message", ({ sessionId, text }) => {
      const session = sessions[sessionId];
      if (!session) return;
      const msg = { id: crypto.randomUUID(), from: "admin", text, time: new Date().toISOString() };
      session.messages.push(msg);
      if (session.visitorSocketId) io.to(session.visitorSocketId).emit("chat:message", msg);
      socket.emit("admin:message_sent", { sessionId, msg });
    });

    socket.on("admin:reconnect_visitor", ({ sessionId }) => {
      const session = sessions[sessionId];
      if (!session || !session.visitorSocketId) return;
      io.to(session.visitorSocketId).emit("chat:reopen", { sessionId, messages: session.messages });
      session.status = "active";
      session._reconnectable = false;
      socket.emit("admin:session_reconnected", { sessionId });
    });

    // ── Reset alert — remove from alertedDevices so Send Alert re-enables ──
    socket.on("admin:reset_alert", ({ deviceId }) => {
      alertedDevices.delete(deviceId);
      socket.emit("admin:alert_reset", { deviceId });
    });

    socket.on("admin:get_session",   ({ sessionId }) => { const s = sessions[sessionId]; if (s) socket.emit("admin:session_detail", s); });
    socket.on("admin:close_session", ({ sessionId }) => {
      const s = sessions[sessionId];
      if (s) { s.status = "closed"; s._reconnectable = false; if (s.visitorSocketId) io.to(s.visitorSocketId).emit("chat:closed"); socket.emit("admin:session_closed", { sessionId }); }
    });
    socket.on("admin:typing", ({ sessionId }) => {
      const s = sessions[sessionId];
      if (s?.visitorSocketId) io.to(s.visitorSocketId).emit("chat:admin_typing");
    });
    socket.on("reset_stats", () => {
      stats = { activeVisitors: deviceConnections.size, alertsSent: 0, chatsStarted: 0 };
      io.emit("update_stats", stats);
    });
    socket.on("disconnect", () => { if (socket.id === adminSocketId) adminSocketId = null; });
    return;
  }

  // ── VISITOR ──
  const ua        = (socket.handshake.headers["user-agent"] || "").toLowerCase();
  const parser    = new UAParser(ua);
  const device    = parser.getDevice();
  const isBot     = BANNED_KEYWORDS.some(k => ua.includes(k));
  const isDesktop = !device.type || !["mobile","tablet","wearable"].includes(device.type);
  const ip        = (socket.handshake.headers["x-forwarded-for"] || "").split(",")[0].trim() || socket.handshake.address || "";
  const deviceId  = simpleHash(ip + (parser.getOS().name || "") + (parser.getBrowser().name || ""));

  activeSockets.set(socket.id, deviceId);
  deviceConnections.set(deviceId, (deviceConnections.get(deviceId) || 0) + 1);
  stats.activeVisitors = deviceConnections.size;

  const emitVisitor = (ispName, isDatacenter, countryCode) => {
    const flag = countryCode
      ? countryCode.toUpperCase().replace(/./g, c => String.fromCodePoint(c.charCodeAt(0) + 127397))
      : "🌐";
    const visitorData = {
      socketId: socket.id, deviceId,
      os: parser.getOS().name || "Unknown",
      browser: parser.getBrowser().name || "Unknown",
      isp: ispName, isDatacenter, isBot, isDesktop, flag,
      country: countryCode || "",
      alerted: alertedDevices.has(deviceId),
      page: socket.handshake.query.page || "/",
      connectedAt: new Date().toISOString(),
    };
    activeVisitorData.set(deviceId, visitorData);
    if (adminSocketId) {
      io.to(adminSocketId).emit("admin:visitor_update", visitorData);
      io.to(adminSocketId).emit("update_stats", stats);
    }
  };

  emitVisitor("Loading...", false, "");

  if (ip && ip !== "::1" && ip !== "127.0.0.1") {
    fetch(`http://ip-api.com/json/${ip}?fields=isp,org,hosting,countryCode`)
      .then(r => r.json())
      .then(d => emitVisitor(d.isp || d.org || "Unknown", d.hosting === true, d.countryCode || ""))
      .catch(() => emitVisitor("Unknown ISP", false, ""));
  } else {
    emitVisitor("Localhost", false, "US");
  }

  socket.on("visitor:service_selected", ({ service, sessionId: sid }) => {
    if (sessions[sid]) {
      socket.sessionId = sid;
      sessions[sid].visitorSocketId = socket.id;
      sessions[sid].status = "active";
      socket.emit("visitor:session", { sessionId: sid });
      return;
    }

    // Close any old active sessions for same device
    Object.values(sessions).forEach(s => {
      if (s._deviceId === deviceId && s.status !== "closed" && s.id !== sid) {
        s.status = "closed";
        if (adminSocketId) io.to(adminSocketId).emit("admin:session_closed", { sessionId: s.id });
      }
    });

    const greeting = `Hi! I see you need help with "${service}". A live agent will be with you shortly.`;
    const msg = { id: crypto.randomUUID(), from: "admin", text: greeting, time: new Date().toISOString() };
    const session = {
      id: sid, name: "Visitor",
      page: socket.handshake.query.page || "/",
      referrer: "", device: isDesktop ? "Desktop" : parser.getDevice().type || "Mobile",
      utmSource: "", utmMedium: "", utmCampaign: "", gclid: "",
      messages: [msg], status: "active",
      connectedAt: new Date().toISOString(),
      visitorSocketId: socket.id,
      service, _reconnectable: false,
      _deviceId: deviceId,
    };
    sessions[sid] = session;
    socket.sessionId = sid;
    socket.emit("visitor:session", { sessionId: sid });
    stats.chatsStarted++;
    if (adminSocketId) {
      io.to(adminSocketId).emit("admin:new_session", session);
      io.to(adminSocketId).emit("update_stats", stats);
    }
  });

  socket.on("visitor:restore", ({ sessionId: sid }) => {
    const session = sessions[sid];
    if (!session || session.status === "closed") {
      socket.emit("visitor:restore_failed");
      return;
    }
    session.visitorSocketId = socket.id;
    session.status = "away";
    session._deviceId = deviceId;
    // Note: _reconnectable NOT set here — only set when visitor closes chat
    socket.sessionId = sid;
    socket.emit("visitor:restore_ok", { sessionId: sid });
    if (adminSocketId) {
      const vData = activeVisitorData.get(deviceId);
      if (vData) {
        vData.socketId = socket.id;
        activeVisitorData.set(deviceId, vData);
        io.to(adminSocketId).emit("admin:visitor_update", vData);
      }
      io.to(adminSocketId).emit("admin:visitor_refreshed", { sessionId: sid, deviceId });
    }
  });

  socket.on("visitor:chat_closed", ({ sessionId: sid }) => {
    const session = sessions[sid];
    if (session) {
      session.status = "away";
      session._reconnectable = true;
      session._deviceId = deviceId;
    }
    if (adminSocketId) {
      io.to(adminSocketId).emit("admin:visitor_closed_chat", { sessionId: sid, deviceId });
    }
  });

  socket.on("visitor:join", ({ sessionId, name, page, referrer, device: dev, utmSource, utmMedium, utmCampaign, gclid }) => {
    let session = sessions[sessionId];
    if (!session) {
      session = { id: sessionId || crypto.randomUUID(), name: name || "Visitor", page: page || "/", referrer: referrer || "", device: dev || "Mobile", utmSource: utmSource || "", utmMedium: utmMedium || "", utmCampaign: utmCampaign || "", gclid: gclid || "", messages: [], status: "active", connectedAt: new Date().toISOString(), visitorSocketId: socket.id, _reconnectable: false };
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
      if (count <= 0) {
        deviceConnections.delete(dId);
        activeVisitorData.delete(dId);
        if (adminSocketId) io.to(adminSocketId).emit("admin:visitor_disconnect", dId);
      } else {
        deviceConnections.set(dId, count);
      }
    }
    if (socket.sessionId && sessions[socket.sessionId]) {
      sessions[socket.sessionId].status = "away";
      if (adminSocketId) io.to(adminSocketId).emit("admin:visitor_left", { sessionId: socket.sessionId });
    }
    stats.activeVisitors = deviceConnections.size;
    if (adminSocketId) io.to(adminSocketId).emit("update_stats", stats);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
