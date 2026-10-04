const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { WebSocketServer, WebSocket } = require("ws");

const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || "0.0.0.0";
const capacity = 8;
const clients = new Map();
const rooms = new Map();
const signals = new Map();
let nextClientId = 1;

const publicFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/voxel_frontier_procedural_save.html", ["voxel_frontier_procedural_save.html", "text/html; charset=utf-8"]]
]);

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const publicFile = publicFiles.get(url.pathname);
  if (!publicFile) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const [fileName, contentType] = publicFile;
  const filePath = path.join(__dirname, fileName);
  fs.createReadStream(filePath)
    .on("error", (error) => {
      console.error(`Cannot read ${fileName}:`, error.message);
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Cannot load game");
    })
    .once("open", () => response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff"
    }))
    .pipe(response);
});

const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

server.on("upgrade", (request, socket, head) => {
  if (new URL(request.url, "http://localhost").pathname !== "/") {
    socket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit("connection", webSocket);
  });
});

function cleanText(value, fallback, maxLength) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maxLength);
  return cleaned || fallback;
}

function roomList() {
  return [...rooms.values()].map((room) => ({
    id: room.id,
    hostName: room.hostName,
    worldName: room.worldName,
    seed: room.seed,
    players: room.members.size,
    capacity
  }));
}

function send(client, packet) {
  if (client?.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(packet));
}

function broadcastRoom(room, packet, exceptId = null) {
  for (const memberId of room.members) {
    if (memberId !== exceptId) send(clients.get(memberId), packet);
  }
}

function leaveRoom(client) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  client.roomId = null;
  if (!room) return;
  if (room.hostId === client.id) {
    broadcastRoom(room, { type: "roomClosed" }, client.id);
    for (const memberId of room.members) {
      const member = clients.get(memberId);
      if (member) member.roomId = null;
    }
    rooms.delete(room.id);
    return;
  }
  room.members.delete(client.id);
  broadcastRoom(room, { type: "peerLeave", id: client.id });
}

function createRoomId() {
  let id;
  do id = Math.random().toString(36).slice(2, 7).toUpperCase();
  while (rooms.has(id));
  return id;
}

function createSignalCode() {
  let code;
  do code = Math.random().toString(36).slice(2, 8).toUpperCase();
  while (signals.has(code));
  return code;
}

function cleanExpiredSignals() {
  const now = Date.now();
  for (const [code, signal] of signals) if (signal.expiresAt <= now) signals.delete(code);
}

function handlePacket(client, packet) {
  if (!packet || typeof packet.type !== "string") return;
  if (packet.type === "list") {
    send(client, { type: "rooms", rooms: roomList() });
    return;
  }
  if (packet.type === "signalStore") {
    cleanExpiredSignals();
    const serialized = JSON.stringify(packet.payload);
    if (!packet.payload || serialized.length > 200000) {
      send(client, { type: "signalError", requestId: packet.requestId, message: "Signalizační data jsou neplatná." });
      return;
    }
    const code = createSignalCode();
    signals.set(code, { payload: packet.payload, expiresAt: Date.now() + 5 * 60 * 1000 });
    send(client, { type: "signalStored", requestId: packet.requestId, code });
    return;
  }
  if (packet.type === "signalLoad") {
    cleanExpiredSignals();
    const code = cleanText(packet.code, "", 6).toUpperCase();
    const signal = signals.get(code);
    if (!signal) {
      send(client, { type: "signalError", requestId: packet.requestId, message: "Kód neexistuje nebo vypršel." });
      return;
    }
    signals.delete(code);
    send(client, { type: "signalLoaded", requestId: packet.requestId, payload: signal.payload });
    return;
  }
  if (packet.type === "host") {
    leaveRoom(client);
    const room = {
      id: createRoomId(),
      hostId: client.id,
      hostName: cleanText(packet.name, "Host", 20),
      worldName: cleanText(packet.worldName, "Sdílený svět", 32),
      seed: cleanText(String(packet.seed ?? ""), "0", 40),
      members: new Set([client.id])
    };
    client.name = room.hostName;
    client.roomId = room.id;
    rooms.set(room.id, room);
    send(client, { type: "hosted", roomId: room.id });
    return;
  }
  if (packet.type === "join") {
    const room = rooms.get(String(packet.roomId || "").toUpperCase());
    if (!room) {
      send(client, { type: "error", message: "LAN místnost už neexistuje." });
      return;
    }
    if (room.members.size >= capacity) {
      send(client, { type: "error", message: "LAN místnost je plná." });
      return;
    }
    leaveRoom(client);
    client.name = cleanText(packet.name, "Hráč", 20);
    client.roomId = room.id;
    room.members.add(client.id);
    send(client, { type: "joined", roomId: room.id, hostId: room.hostId });
    broadcastRoom(room, { type: "peerJoined", id: client.id, name: client.name }, client.id);
    return;
  }
  const room = rooms.get(client.roomId);
  if (!room) {
    send(client, { type: "error", message: "Nejdřív vytvoř nebo vyber LAN místnost." });
    return;
  }
  if (!["player", "block", "snapshotRequest", "snapshot"].includes(packet.type)) return;
  const outgoing = { ...packet, from: client.id, name: client.name };
  if (packet.target) {
    if (room.members.has(packet.target)) send(clients.get(packet.target), outgoing);
    return;
  }
  broadcastRoom(room, outgoing, client.id);
}

webSocketServer.on("connection", (socket) => {
  const client = {
    id: `p${nextClientId++}`,
    name: "Hráč",
    roomId: null,
    socket
  };
  clients.set(client.id, client);
  send(client, { type: "welcome", id: client.id });
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    try {
      handlePacket(client, JSON.parse(data.toString()));
    } catch (error) {
      send(client, { type: "error", message: "Server odmítl neplatná data." });
      console.warn(`Invalid packet from ${client.id}:`, error.message);
    }
  });
  socket.on("close", () => {
    leaveRoom(client);
    clients.delete(client.id);
  });
  socket.on("error", (error) => console.warn(`WebSocket ${client.id}:`, error.message));
});

server.listen(port, host, () => {
  console.log(`Voxel Frontier LAN server běží na http://localhost:${port}`);
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const address of interfaces || []) {
      if (address.family === "IPv4" && !address.internal) console.log(`LAN adresa: http://${address.address}:${port}`);
    }
  }
});
