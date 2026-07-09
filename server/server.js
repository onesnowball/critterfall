const cors = require("cors");
const express = require("express");
const http = require("http");
const os = require("os");
const path = require("path");
const { Server } = require("socket.io");
const {
  createRoom,
  discardCard,
  joinRoom,
  newGame,
  playCard,
  removePlayerFromRoom,
  sanitizeRoomForPlayer,
  skipTurn,
  startGame
} = require("./gameEngine");

const PORT = Number(process.env.PORT || 3001);
const publicOrigin = process.env.PUBLIC_ORIGIN || "";
const allowedOrigins = publicOrigin
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : "*",
    methods: ["GET", "POST"]
  }
});

const rooms = new Map();
const clientDistPath = path.join(__dirname, "..", "client", "dist");

app.set("trust proxy", 1);
app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : "*"
  })
);
app.use(express.json());

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.use(express.static(clientDistPath));

app.get("/", (_request, response) => {
  response.sendFile(path.join(clientDistPath, "index.html"), (error) => {
    if (error) {
      response.json({
        name: "Critterfall server",
        status: "ok",
        client: "Run `npm --workspace client run build` or open the Vite client on port 5173."
      });
    }
  });
});

app.get("*", (request, response, next) => {
  if (request.path.startsWith("/socket.io")) {
    next();
    return;
  }

  response.sendFile(path.join(clientDistPath, "index.html"), (error) => {
    if (error) {
      next();
    }
  });
});

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  while (code.length < 4) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return code;
}

function getAvailableRoomCode() {
  let code = generateRoomCode();

  while (rooms.has(code)) {
    code = generateRoomCode();
  }

  return code;
}

function getRoomForSocket(socket) {
  const roomCode = socket.data.roomCode;
  return roomCode ? rooms.get(roomCode) || null : null;
}

function requireRoomForSocket(socket) {
  const room = getRoomForSocket(socket);

  if (!room) {
    throw new Error("Join or create a room first.");
  }

  return room;
}

function emitRoomState(room) {
  room.players.forEach((player) => {
    io.to(player.id).emit("stateUpdate", sanitizeRoomForPlayer(room, player.id));
  });
}

function removeSocketFromCurrentRoom(socket, options = {}) {
  const roomCode = socket.data.roomCode;

  if (!roomCode) {
    return;
  }

  const room = rooms.get(roomCode);

  if (options.leave !== false) {
    socket.leave(roomCode);
  }

  socket.data.roomCode = null;

  if (!room) {
    return;
  }

  const result = removePlayerFromRoom(room, socket.id);

  if (result.deleted) {
    rooms.delete(roomCode);
    return;
  }

  emitRoomState(room);
}

function respond(ack, payload) {
  if (typeof ack === "function") {
    ack(payload);
  }
}

function handleAction(socket, ack, action) {
  try {
    const payload = action();
    respond(ack, { ok: true, ...payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    socket.emit("actionError", message);
    respond(ack, { ok: false, message });
  }
}

function getLocalNetworkAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  Object.values(interfaces).forEach((iface) => {
    (iface || []).forEach((entry) => {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    });
  });

  return [...new Set(addresses)];
}

io.on("connection", (socket) => {
  socket.on("createRoom", (payload = {}, ack) => {
    handleAction(socket, ack, () => {
      removeSocketFromCurrentRoom(socket);

      const code = getAvailableRoomCode();
      const room = createRoom(code, socket.id, payload.name);

      rooms.set(code, room);
      socket.join(code);
      socket.data.roomCode = code;

      emitRoomState(room);
      return { code };
    });
  });

  socket.on("joinRoom", (payload = {}, ack) => {
    handleAction(socket, ack, () => {
      const code = String(payload.code || "").trim().toUpperCase();
      const room = rooms.get(code);

      if (!room) {
        throw new Error("That room code was not found.");
      }

      removeSocketFromCurrentRoom(socket);
      joinRoom(room, socket.id, payload.name);

      socket.join(code);
      socket.data.roomCode = code;

      emitRoomState(room);
      return { code };
    });
  });

  socket.on("startGame", (_payload = {}, ack) => {
    handleAction(socket, ack, () => {
      const room = requireRoomForSocket(socket);
      startGame(room, socket.id);
      emitRoomState(room);
      return {};
    });
  });

  socket.on("playCard", (payload = {}, ack) => {
    handleAction(socket, ack, () => {
      const room = requireRoomForSocket(socket);
      playCard(room, socket.id, payload.cardInstanceId);
      emitRoomState(room);
      return {};
    });
  });

  socket.on("skipTurn", (_payload = {}, ack) => {
    handleAction(socket, ack, () => {
      const room = requireRoomForSocket(socket);
      skipTurn(room, socket.id);
      emitRoomState(room);
      return {};
    });
  });

  socket.on("discardCard", (payload = {}, ack) => {
    handleAction(socket, ack, () => {
      const room = requireRoomForSocket(socket);
      discardCard(room, socket.id, payload.cardInstanceId);
      emitRoomState(room);
      return {};
    });
  });

  socket.on("newGame", (_payload = {}, ack) => {
    handleAction(socket, ack, () => {
      const room = requireRoomForSocket(socket);
      newGame(room, socket.id);
      emitRoomState(room);
      return {};
    });
  });

  socket.on("disconnect", () => {
    removeSocketFromCurrentRoom(socket, { leave: false });
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Critterfall server listening on http://0.0.0.0:${PORT}`);
  console.log("Open the client locally at http://localhost:5173");
  console.log(`Or open the built single-port app at http://localhost:${PORT}`);

  if (publicOrigin) {
    console.log(`Public origin configured at ${publicOrigin}`);
  }

  getLocalNetworkAddresses().forEach((address) => {
    console.log(`Open the client on your network at http://${address}:5173`);
    console.log(`Open the built single-port app on your network at http://${address}:${PORT}`);
  });
});
