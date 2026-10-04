package cz.voxelfrontier.lan;

import android.content.Context;
import fi.iki.elonen.NanoHTTPD;
import fi.iki.elonen.NanoWSD;
import fi.iki.elonen.NanoWSD.WebSocket;
import fi.iki.elonen.NanoWSD.WebSocketFrame;
import java.io.IOException;
import java.io.InputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class VoxelLanServer extends NanoWSD {
    private static final int CAPACITY = 8;
    private static final int DISCOVERY_PORT = 41234;
    private final Context context;
    private final int httpPort;
    private final String serverId = UUID.randomUUID().toString();
    private final AtomicInteger nextClientId = new AtomicInteger(1);
    private final Map<String, ClientSocket> clients = new ConcurrentHashMap<>();
    private final Map<String, Room> rooms = new ConcurrentHashMap<>();
    private final Map<String, Signal> signals = new ConcurrentHashMap<>();
    private final Map<String, RemoteServer> remoteServers = new ConcurrentHashMap<>();
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(2);
    private DatagramSocket discoverySocket;
    private volatile boolean discoveryRunning;

    VoxelLanServer(Context context, int port) {
        super(port);
        this.context = context.getApplicationContext();
        this.httpPort = port;
        startDiscovery();
    }

    @Override
    protected Response serveHttp(IHTTPSession session) {
        if (!"/".equals(session.getUri()) && !"/index.html".equals(session.getUri())) {
            return NanoHTTPD.newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain; charset=utf-8", "Not found");
        }
        try {
            InputStream game = context.getAssets().open("index.html");
            Response response = NanoHTTPD.newChunkedResponse(Response.Status.OK, "text/html; charset=utf-8", game);
            response.addHeader("Cache-Control", "no-cache");
            response.addHeader("X-Content-Type-Options", "nosniff");
            return response;
        } catch (IOException error) {
            return NanoHTTPD.newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain; charset=utf-8", "Cannot load game");
        }
    }

    @Override
    protected WebSocket openWebSocket(IHTTPSession handshake) {
        return new ClientSocket(handshake);
    }

    @Override
    public void stop() {
        discoveryRunning = false;
        if (discoverySocket != null) discoverySocket.close();
        scheduler.shutdownNow();
        super.stop();
    }

    private final class ClientSocket extends WebSocket {
        final String id = "p" + nextClientId.getAndIncrement();
        volatile String name = "Hráč";
        volatile String roomId;

        ClientSocket(IHTTPSession handshake) {
            super(handshake);
        }

        @Override
        protected void onOpen() {
            clients.put(id, this);
            sendPacket(this, json("type", "welcome", "id", id));
        }

        @Override
        protected void onClose(WebSocketFrame.CloseCode code, String reason, boolean remote) {
            leaveRoom(this);
            clients.remove(id);
        }

        @Override
        protected void onMessage(WebSocketFrame message) {
            try {
                handlePacket(this, new JSONObject(message.getTextPayload()));
            } catch (JSONException error) {
                sendPacket(this, json("type", "error", "message", "Server odmítl neplatná data."));
            }
        }

        @Override
        protected void onPong(WebSocketFrame pong) {
        }

        @Override
        protected void onException(IOException error) {
            leaveRoom(this);
            clients.remove(id);
        }
    }

    private static final class Room {
        String id;
        String hostId;
        String hostName;
        String worldName;
        String seed;
        final Set<String> members = ConcurrentHashMap.newKeySet();
    }

    private record Signal(JSONObject payload, long expiresAt) {
    }

    private record RemoteServer(long seenAt, String url, JSONArray rooms) {
    }

    private void handlePacket(ClientSocket client, JSONObject packet) throws JSONException {
        String type = packet.optString("type");
        if ("list".equals(type)) {
            sendPacket(client, json("type", "rooms", "rooms", roomList()));
            return;
        }
        if ("signalStore".equals(type)) {
            cleanSignals();
            JSONObject payload = packet.optJSONObject("payload");
            if (payload == null || payload.toString().length() > 200000) {
                sendPacket(client, json("type", "signalError", "requestId", packet.optString("requestId"), "message", "Signalizační data jsou neplatná."));
                return;
            }
            String code = randomCode(6);
            signals.put(code, new Signal(payload, System.currentTimeMillis() + 300000));
            sendPacket(client, json("type", "signalStored", "requestId", packet.optString("requestId"), "code", code));
            return;
        }
        if ("signalLoad".equals(type)) {
            cleanSignals();
            String code = clean(packet.optString("code"), "", 6).toUpperCase();
            Signal signal = signals.remove(code);
            if (signal == null) {
                sendPacket(client, json("type", "signalError", "requestId", packet.optString("requestId"), "message", "Kód neexistuje nebo vypršel."));
                return;
            }
            sendPacket(client, json("type", "signalLoaded", "requestId", packet.optString("requestId"), "payload", signal.payload()));
            return;
        }
        if ("host".equals(type)) {
            leaveRoom(client);
            Room room = new Room();
            room.id = randomCode(5);
            room.hostId = client.id;
            room.hostName = clean(packet.optString("name"), "Host", 20);
            room.worldName = clean(packet.optString("worldName"), "Sdílený svět", 32);
            room.seed = clean(packet.optString("seed"), "0", 40);
            room.members.add(client.id);
            rooms.put(room.id, room);
            client.name = room.hostName;
            client.roomId = room.id;
            sendPacket(client, json("type", "hosted", "roomId", room.id));
            announce();
            return;
        }
        if ("join".equals(type)) {
            Room room = rooms.get(packet.optString("roomId").toUpperCase());
            if (room == null) {
                sendPacket(client, json("type", "error", "message", "LAN místnost už neexistuje."));
                return;
            }
            if (room.members.size() >= CAPACITY) {
                sendPacket(client, json("type", "error", "message", "LAN místnost je plná."));
                return;
            }
            leaveRoom(client);
            client.name = clean(packet.optString("name"), "Hráč", 20);
            client.roomId = room.id;
            room.members.add(client.id);
            sendPacket(client, json("type", "joined", "roomId", room.id, "hostId", room.hostId));
            broadcast(room, json("type", "peerJoined", "id", client.id, "name", client.name), client.id);
            announce();
            return;
        }
        Room room = rooms.get(client.roomId);
        if (room == null) {
            sendPacket(client, json("type", "error", "message", "Nejdřív vytvoř nebo vyber LAN místnost."));
            return;
        }
        if (!Set.of("player", "block", "snapshotRequest", "snapshot").contains(type)) return;
        packet.put("from", client.id);
        packet.put("name", client.name);
        String target = packet.optString("target");
        if (!target.isEmpty()) {
            if (room.members.contains(target)) sendPacket(clients.get(target), packet);
        } else {
            broadcast(room, packet, client.id);
        }
    }

    private JSONArray roomList() throws JSONException {
        JSONArray list = localRooms();
        long now = System.currentTimeMillis();
        for (Map.Entry<String, RemoteServer> entry : new ArrayList<>(remoteServers.entrySet())) {
            RemoteServer remote = entry.getValue();
            if (now - remote.seenAt() > 5000) {
                remoteServers.remove(entry.getKey());
                continue;
            }
            for (int index = 0; index < remote.rooms().length(); index++) {
                JSONObject room = new JSONObject(remote.rooms().getJSONObject(index).toString());
                room.put("remoteUrl", remote.url());
                list.put(room);
            }
        }
        return list;
    }

    private JSONArray localRooms() throws JSONException {
        JSONArray list = new JSONArray();
        for (Room room : rooms.values()) {
            list.put(json(
                "id", room.id,
                "hostName", room.hostName,
                "worldName", room.worldName,
                "seed", room.seed,
                "players", room.members.size(),
                "capacity", CAPACITY
            ));
        }
        return list;
    }

    private void leaveRoom(ClientSocket client) {
        if (client.roomId == null) return;
        Room room = rooms.get(client.roomId);
        client.roomId = null;
        if (room == null) return;
        if (room.hostId.equals(client.id)) {
            broadcast(room, json("type", "roomClosed"), client.id);
            for (String memberId : room.members) {
                ClientSocket member = clients.get(memberId);
                if (member != null) member.roomId = null;
            }
            rooms.remove(room.id);
        } else {
            room.members.remove(client.id);
            broadcast(room, json("type", "peerLeave", "id", client.id), null);
        }
        announce();
    }

    private void broadcast(Room room, JSONObject packet, String exceptId) {
        for (String memberId : room.members) {
            if (!memberId.equals(exceptId)) sendPacket(clients.get(memberId), packet);
        }
    }

    private void sendPacket(ClientSocket client, JSONObject packet) {
        if (client == null) return;
        try {
            client.send(packet.toString());
        } catch (IOException ignored) {
        }
    }

    private void cleanSignals() {
        long now = System.currentTimeMillis();
        signals.entrySet().removeIf(entry -> entry.getValue().expiresAt() <= now);
    }

    private String randomCode(int length) {
        String code;
        do code = UUID.randomUUID().toString().replace("-", "").substring(0, length).toUpperCase();
        while (rooms.containsKey(code) || signals.containsKey(code));
        return code;
    }

    private static String clean(String value, String fallback, int maxLength) {
        String cleaned = value == null ? "" : value.replaceAll("[\\x00-\\x1f\\x7f]", "").trim();
        if (cleaned.isEmpty()) return fallback;
        return cleaned.substring(0, Math.min(cleaned.length(), maxLength));
    }

    private static JSONObject json(Object... values) {
        JSONObject result = new JSONObject();
        try {
            for (int index = 0; index < values.length; index += 2) result.put(String.valueOf(values[index]), values[index + 1]);
        } catch (JSONException ignored) {
        }
        return result;
    }

    private void startDiscovery() {
        try {
            discoverySocket = new DatagramSocket(null);
            discoverySocket.setReuseAddress(true);
            discoverySocket.setBroadcast(true);
            discoverySocket.bind(new InetSocketAddress(DISCOVERY_PORT));
            discoverySocket.setSoTimeout(1500);
            discoveryRunning = true;
            scheduler.execute(this::discoveryLoop);
            scheduler.scheduleAtFixedRate(this::announce, 0, 1500, TimeUnit.MILLISECONDS);
        } catch (SocketException error) {
            throw new IllegalStateException("LAN discovery nelze spustit", error);
        }
    }

    private void discoveryLoop() {
        byte[] buffer = new byte[65507];
        while (discoveryRunning) {
            DatagramPacket datagram = new DatagramPacket(buffer, buffer.length);
            try {
                discoverySocket.receive(datagram);
                JSONObject packet = new JSONObject(new String(datagram.getData(), 0, datagram.getLength(), StandardCharsets.UTF_8));
                if (!"voxel-frontier".equals(packet.optString("app")) || packet.optInt("version") != 1) continue;
                if ("discover".equals(packet.optString("type"))) {
                    announce(datagram.getAddress(), datagram.getPort());
                    continue;
                }
                if (!"announce".equals(packet.optString("type")) || serverId.equals(packet.optString("serverId"))) continue;
                int remotePort = packet.optInt("port");
                JSONArray remoteRooms = packet.optJSONArray("rooms");
                if (remotePort < 1 || remotePort > 65535 || remoteRooms == null) continue;
                remoteServers.put(packet.optString("serverId"), new RemoteServer(
                    System.currentTimeMillis(),
                    "http://" + datagram.getAddress().getHostAddress() + ":" + remotePort,
                    remoteRooms
                ));
            } catch (Exception ignored) {
            }
        }
    }

    private void announce() {
        try {
            announce(InetAddress.getByName("255.255.255.255"), DISCOVERY_PORT);
        } catch (IOException ignored) {
        }
    }

    private void announce(InetAddress address, int targetPort) {
        if (discoverySocket == null || discoverySocket.isClosed()) return;
        try {
            JSONObject packet = json(
                "app", "voxel-frontier",
                "version", 1,
                "type", "announce",
                "serverId", serverId,
                "port", httpPort,
                "rooms", localRooms()
            );
            byte[] bytes = packet.toString().getBytes(StandardCharsets.UTF_8);
            discoverySocket.send(new DatagramPacket(bytes, bytes.length, address, targetPort));
        } catch (Exception ignored) {
        }
    }
}
