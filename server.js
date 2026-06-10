const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

// ─── Static files (public folder) ───────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ─── Admin panel route ───────────────────────────────────────────
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ─── Widget route ────────────────────────────────────────────────
app.get("/widget.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "public", "widget.js"));
});

// In-memory store (Railway pe persist nahi hoga restart ke baad, lekin kaam chalega)
const sessions = {}; // sessionId -> { id, name, messages[], status, connectedAt, visitorSocketId }
let adminSocketId = null;

// ─── Health check ───────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "LiveChat server running 🟢" }));

// ─── Socket.io ──────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  // ── ADMIN connects ──────────────────────────────────────────
  socket.on("admin:join", ({ username, password }) => {
    const ADMIN_USER = process.env.ADMIN_USERNAME || "admin";
    const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin123";
    if (username !== ADMIN_USER || password !== ADMIN_PASS) {
      socket.emit("admin:auth_failed");
      return;
    }
    adminSocketId = socket.id;
    socket.emit("admin:auth_success");

    // Send all existing sessions to admin
    socket.emit("admin:all_sessions", Object.values(sessions));
    console.log("Admin connected:", socket.id);
  });

  // ── VISITOR connects ─────────────────────────────────────────
  socket.on("visitor:join", ({ sessionId, name, page, referrer, device, utmSource, utmMedium, utmCampaign, gclid, userAgent }) => {
    let session = sessions[sessionId];

    if (!session) {
      // New visitor
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
      // Returning visitor
      session.visitorSocketId = socket.id;
      session.status = "active";
    }

    socket.sessionId = session.id;
    socket.emit("visitor:session", { sessionId: session.id });

    // Notify admin
    if (adminSocketId) {
      io.to(adminSocketId).emit("admin:new_session", session);
    }

    console.log(`Visitor joined: ${session.name} (${session.id})`);
  });

  // ── VISITOR sends message ────────────────────────────────────
  socket.on("visitor:message", ({ sessionId, text }) => {
    const session = sessions[sessionId];
    if (!session) return;

    const msg = {
      id: crypto.randomUUID(),
      from: "visitor",
      text,
      time: new Date().toISOString(),
    };
    session.messages.push(msg);

    // Forward to admin
    if (adminSocketId) {
      io.to(adminSocketId).emit("admin:message", { sessionId, msg });
    }
  });

  // ── ADMIN sends message ──────────────────────────────────────
  socket.on("admin:message", ({ sessionId, text }) => {
    const session = sessions[sessionId];
    if (!session) return;

    const msg = {
      id: crypto.randomUUID(),
      from: "admin",
      text,
      time: new Date().toISOString(),
    };
    session.messages.push(msg);

    // Send to visitor
    if (session.visitorSocketId) {
      io.to(session.visitorSocketId).emit("chat:message", msg);
    }

    // Echo back to admin
    socket.emit("admin:message_sent", { sessionId, msg });
  });

  // ── ADMIN: get session history ───────────────────────────────
  socket.on("admin:get_session", ({ sessionId }) => {
    const session = sessions[sessionId];
    if (session) {
      socket.emit("admin:session_detail", session);
    }
  });

  // ── ADMIN: close session ─────────────────────────────────────
  socket.on("admin:close_session", ({ sessionId }) => {
    const session = sessions[sessionId];
    if (session) {
      session.status = "closed";
      if (session.visitorSocketId) {
        io.to(session.visitorSocketId).emit("chat:closed");
      }
      socket.emit("admin:session_closed", { sessionId });
    }
  });

  // ── Typing indicators ────────────────────────────────────────
  socket.on("visitor:typing", ({ sessionId }) => {
    if (adminSocketId) io.to(adminSocketId).emit("admin:visitor_typing", { sessionId });
  });

  socket.on("admin:typing", ({ sessionId }) => {
    const session = sessions[sessionId];
    if (session?.visitorSocketId) {
      io.to(session.visitorSocketId).emit("chat:admin_typing");
    }
  });

  // ── Disconnect ───────────────────────────────────────────────
  socket.on("disconnect", () => {
    if (socket.id === adminSocketId) {
      adminSocketId = null;
      console.log("Admin disconnected");
    }
    // Mark visitor session as away
    if (socket.sessionId && sessions[socket.sessionId]) {
      sessions[socket.sessionId].status = "away";
      if (adminSocketId) {
        io.to(adminSocketId).emit("admin:visitor_left", { sessionId: socket.sessionId });
      }
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
