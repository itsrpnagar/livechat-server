const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Transcripts directory ───────────────────────────────────────
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
const TRANSCRIPTS_DIR = path.join(DATA_DIR, "transcripts");
if (!fs.existsSync(TRANSCRIPTS_DIR)) fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

function loadAllTranscripts() {
  try {
    const files = fs.readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith(".json"));
    return files.map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(TRANSCRIPTS_DIR, f), "utf8")); }
      catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// ─── Routes ─────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "LiveChat server running 🟢" }));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/widget.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "public", "widget.js"));
});

// ─── Transcripts API ─────────────────────────────────────────────
app.get("/api/transcripts", (req, res) => {
  const transcripts = loadAllTranscripts();
  transcripts.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  res.json(transcripts);
});

app.get("/api/transcripts/:id", (req, res) => {
  const filepath = path.join(TRANSCRIPTS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: "Not found" });
  res.json(JSON.parse(fs.readFileSync(filepath, "utf8")));
});

// ─── Manual save transcript ──────────────────────────────────────
app.post("/api/transcripts/save", (req, res) => {
  try {
    const { sessionId, customerName } = req.body;
    const session = sessions[sessionId];
    if (!session) return res.status(404).json({ error: "Session not found" });

    const id = crypto.randomUUID();
    const data = {
      id,
      customerName: customerName || session.name,
      sessionId: session.id,
      page: session.page,
      referrer: session.referrer,
      device: session.device,
      utmSource: session.utmSource,
      utmMedium: session.utmMedium,
      utmCampaign: session.utmCampaign,
      gclid: session.gclid,
      connectedAt: session.connectedAt,
      savedAt: new Date().toISOString(),
      messages: session.messages,
    };
    fs.writeFileSync(path.join(TRANSCRIPTS_DIR, `${id}.json`), JSON.stringify(data, null, 2));
    console.log(`Transcript saved: ${customerName}`);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete transcript ───────────────────────────────────────────
app.delete("/api/transcripts/:id", (req, res) => {
  try {
    const filepath = path.join(TRANSCRIPTS_DIR, `${req.params.id}.json`);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Delete failed" }); }
});

// ─── In-memory sessions ──────────────────────────────────────────
const sessions = {};
let adminSocketId = null;

// ─── Socket.io ──────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  socket.on("admin:join", ({ username, password }) => {
    const ADMIN_USER = process.env.ADMIN_USERNAME || "admin";
    const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin123";
    if (username !== ADMIN_USER || password !== ADMIN_PASS) { socket.emit("admin:auth_failed"); return; }
    adminSocketId = socket.id;
    socket.emit("admin:auth_success");
    socket.emit("admin:all_sessions", Object.values(sessions));
    console.log("Admin connected:", socket.id);
  });

  socket.on("visitor:join", ({ sessionId, name, page, referrer, device, utmSource, utmMedium, utmCampaign, gclid }) => {
    let session = sessions[sessionId];
    if (!session) {
      session = {
        id: sessionId || crypto.randomUUID(),
        name: name || "Visitor",
        page: page || "/",
        referrer: referrer || "",
        device: device || "Desktop",
        utmSource: utmSource || "",
        utmMedium: utmMedium || "",
        utmCampaign: utmCampaign || "",
        gclid: gclid || "",
        messages: [],
        status: "active",
        connectedAt: new Date().toISOString(),
        visitorSocketId: socket.id,
      };
      sessions[session.id] = session;
    } else {
      session.visitorSocketId = socket.id;
      session.status = "active";
    }
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

  socket.on("admin:message", ({ sessionId, text }) => {
    const session = sessions[sessionId];
    if (!session) return;
    const msg = { id: crypto.randomUUID(), from: "admin", text, time: new Date().toISOString() };
    session.messages.push(msg);
    if (session.visitorSocketId) io.to(session.visitorSocketId).emit("chat:message", msg);
    socket.emit("admin:message_sent", { sessionId, msg });
  });

  socket.on("admin:get_session", ({ sessionId }) => {
    const session = sessions[sessionId];
    if (session) socket.emit("admin:session_detail", session);
  });

  socket.on("admin:close_session", ({ sessionId }) => {
    const session = sessions[sessionId];
    if (session) {
      session.status = "closed";
      if (session.visitorSocketId) io.to(session.visitorSocketId).emit("chat:closed");
      socket.emit("admin:session_closed", { sessionId });
    }
  });

  socket.on("visitor:typing", ({ sessionId }) => {
    if (adminSocketId) io.to(adminSocketId).emit("admin:visitor_typing", { sessionId });
  });

  socket.on("admin:typing", ({ sessionId }) => {
    const session = sessions[sessionId];
    if (session?.visitorSocketId) io.to(session.visitorSocketId).emit("chat:admin_typing");
  });

  socket.on("disconnect", () => {
    if (socket.id === adminSocketId) { adminSocketId = null; }
    if (socket.sessionId && sessions[socket.sessionId]) {
      sessions[socket.sessionId].status = "away";
      if (adminSocketId) io.to(adminSocketId).emit("admin:visitor_left", { sessionId: socket.sessionId });
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
