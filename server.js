const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const dgram = require("dgram");
const childProcess = require("child_process");
const { WebSocketServer, WebSocket } = require("ws");

const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || "0.0.0.0";
const capacity = 8;
const clients = new Map();
const rooms = new Map();
const signals = new Map();
const discoveredServers = new Map();
const serverId = Math.random().toString(36).slice(2);
const discoveryPort = 41234;
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
  const localRooms = [...rooms.values()].map((room) => ({
    id: room.id,
    hostName: room.hostName,
    worldName: room.worldName,
    seed: room.seed,
    players: room.members.size,
    capacity
  }));
  const now = Date.now();
  const remoteRooms = [];
  for (const [id, server] of discoveredServers) {
    if (now - server.seenAt > 5000) {
      discoveredServers.delete(id);
      continue;
    }
    for (const room of server.rooms) remoteRooms.push({ ...room, remoteUrl: server.url });
  }
  return [...localRooms, ...remoteRooms];
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
  if (process.env.OPEN_BROWSER === "1") {
    const url = `http://127.0.0.1:${port}`;
    const command = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin" ? ["open", [url]]
        : ["xdg-open", [url]];
    const opener = childProcess.spawn(command[0], command[1], { detached: true, stdio: "ignore" });
    opener.unref();
  }
});

const discoverySocket = dgram.createSocket({ type: "udp4", reuseAddr: true });

function localRoomAnnouncements() {
  return [...rooms.values()].map((room) => ({
    id: room.id,
    hostName: room.hostName,
    worldName: room.worldName,
    seed: room.seed,
    players: room.members.size,
    capacity
  }));
}

function announceRooms(targetAddress = "255.255.255.255", targetPort = discoveryPort) {
  const message = Buffer.from(JSON.stringify({
    app: "voxel-frontier",
    version: 1,
    type: "announce",
    serverId,
    port,
    rooms: localRoomAnnouncements()
  }));
  discoverySocket.send(message, targetPort, targetAddress, (error) => {
    if (error && error.code !== "EACCES" && error.code !== "ENETUNREACH") {
      console.warn("LAN discovery:", error.message);
    }
  });
}

discoverySocket.on("message", (message, remote) => {
  let packet;
  try {
    packet = JSON.parse(message.toString());
  } catch {
    return;
  }
  if (packet.app !== "voxel-frontier" || packet.version !== 1) return;
  if (packet.type === "discover") {
    announceRooms(remote.address, remote.port);
    return;
  }
  if (packet.type !== "announce" || packet.serverId === serverId || !Array.isArray(packet.rooms)) return;
  const remotePort = Number(packet.port);
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) return;
  discoveredServers.set(packet.serverId, {
    seenAt: Date.now(),
    url: `http://${remote.address}:${remotePort}`,
    rooms: packet.rooms.slice(0, 32).map((room) => ({
      id: cleanText(room.id, "", 12),
      hostName: cleanText(room.hostName, "Host", 20),
      worldName: cleanText(room.worldName, "Sdílený svět", 32),
      seed: cleanText(String(room.seed ?? ""), "0", 40),
      players: Math.max(1, Math.min(capacity, Number(room.players) || 1)),
      capacity
    })).filter((room) => room.id)
  });
});

discoverySocket.on("error", (error) => console.warn("LAN discovery socket:", error.message));
discoverySocket.bind(discoveryPort, "0.0.0.0", () => {
  discoverySocket.setBroadcast(true);
  announceRooms();
  setInterval(announceRooms, 1500).unref();
});
