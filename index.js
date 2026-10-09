// PolyTrack 0.6.3 signaling Worker.
// This version uses the standard Durable Object WebSocket API (server.accept
// + addEventListener) to avoid relying on the hibernation event callbacks.
// PolyTrack's car sync remains its built-in WebRTC data channel.

const VERSION = "0.6.3";
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/api/health") {
      return Response.json(
        { ok: true, service: "polytrack-0.6.3-signaling-standard-ws" },
        { headers: CORS_HEADERS },
      );
    }

    if (url.pathname === "/v6/iceServers" && request.method === "GET") {
      return Response.json(ICE_SERVERS, { headers: CORS_HEADERS });
    }

    if (
      url.pathname === "/v6/multiplayer/host" ||
      url.pathname === "/v6/multiplayer/join"
    ) {
      if (request.method !== "GET" || (request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426, headers: CORS_HEADERS });
      }
      if (!env.ROOM) {
        console.error("ROOM Durable Object binding is missing");
        return Response.json({ error: "Missing Durable Object binding ROOM" }, { status: 500, headers: CORS_HEADERS });
      }
      const id = env.ROOM.idFromName("polytrack-0.6.3-signaling");
      return env.ROOM.get(id).fetch(request);
    }

    return Response.json(
      { error: "Not found", supported: ["/api/health", "/v6/iceServers", "/v6/multiplayer/host", "/v6/multiplayer/join"] },
      { status: 404, headers: CORS_HEADERS },
    );
  },
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Standard WebSocket API pins this DO while clients are connected, so this
    // in-memory map stays available for the duration of active invite sessions.
    this.connections = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.pathname.endsWith("/host") ? "host" : "join";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    this.connections.set(server, {
      role,
      id: crypto.randomUUID(),
      inviteCode: null,
      session: null,
    });

    console.log("WebSocket connected", { role, path: url.pathname });
    server.addEventListener("message", (event) => {
      this.handleMessage(server, event.data);
    });
    server.addEventListener("close", () => this.handleClose(server));
    server.addEventListener("error", () => this.handleClose(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  attachment(socket) {
    return this.connections.get(socket) || null;
  }

  send(socket, data) {
    try {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({ version: VERSION, ...data }));
      return true;
    } catch (error) {
      console.error("WebSocket send failed", String(error));
      return false;
    }
  }

  findHost(code) {
    for (const [socket, client] of this.connections) {
      if (client.role === "host" && client.inviteCode === code && socket.readyState === WebSocket.OPEN) return socket;
    }
    return null;
  }

  findJoiner(session) {
    for (const [socket, client] of this.connections) {
      if (client.role === "join" && client.session === session && socket.readyState === WebSocket.OPEN) return socket;
    }
    return null;
  }

  makeInviteCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
      const code = String(n).padStart(6, "0");
      if (!this.findHost(code)) return code;
    }
    return String(Date.now() % 1000000).padStart(6, "0");
  }

  handleMessage(socket, raw) {
    if (typeof raw !== "string" || raw.length > 250000) {
      try { socket.close(1009, "Invalid message size"); } catch {}
      return;
    }

    let data;
    try { data = JSON.parse(raw); }
    catch {
      console.error("Invalid JSON received over WebSocket");
      try { socket.close(1007, "Invalid JSON"); } catch {}
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.type !== "string") return;

    const client = this.attachment(socket);
    if (!client) return;
    console.log("WebSocket message", { role: client.role, type: data.type });

    if (client.role === "host") {
      if (data.type === "createInvite") {
        if (typeof data.key !== "string") {
          this.send(socket, { type: "error", error: "MalformedClientData" });
          return;
        }
        const inviteCode = this.makeInviteCode();
        client.inviteCode = inviteCode;
        this.send(socket, {
          type: "createInvite",
          inviteCode,
          key: data.key,
          timeoutMilliseconds: null,
          censoredNickname: typeof data.nickname === "string" ? data.nickname : null,
        });
        return;
      }

      if (data.type === "ping") {
        this.send(socket, { type: "pong" });
        return;
      }

      if (["acceptJoin", "declineJoin", "iceCandidate"].includes(data.type) && typeof data.session === "string") {
        const joiner = this.findJoiner(data.session);
        if (!joiner) return;
        if (data.type === "iceCandidate") {
          this.send(joiner, { type: "iceCandidate", candidate: data.candidate ?? null });
        } else {
          this.send(joiner, data);
        }
      }
      return;
    }

    if (client.role !== "join") return;

    if (!client.session) {
      const inviteCode = typeof data.inviteCode === "string" ? data.inviteCode.trim().toUpperCase() : "";
      const host = inviteCode ? this.findHost(inviteCode) : null;
      if (!host) {
        this.send(socket, { type: "error", error: "ExpiredInvite" });
        try { socket.close(1000, "Invite not found"); } catch {}
        return;
      }
      if (
        typeof data.offer !== "string" ||
        typeof data.version !== "string" ||
        typeof data.nickname !== "string" ||
        typeof data.carStyle !== "string" ||
        !Array.isArray(data.mods) ||
        typeof data.isModsVanillaCompatible !== "boolean"
      ) {
        this.send(socket, { type: "error", error: "MalformedClientData" });
        try { socket.close(1007, "Malformed join request"); } catch {}
        return;
      }

      const session = crypto.randomUUID();
      client.inviteCode = inviteCode;
      client.session = session;
      const ok = this.send(host, {
        type: "joinInvite",
        session,
        offer: data.offer,
        version: data.version,
        mods: data.mods,
        isModsVanillaCompatible: data.isModsVanillaCompatible,
        nickname: data.nickname.slice(0, 50),
        countryCode: typeof data.countryCode === "string" ? data.countryCode : null,
        carStyle: data.carStyle,
        iceServers: ICE_SERVERS,
      });
      if (!ok) {
        this.send(socket, { type: "error", error: "ExpiredInvite" });
        try { socket.close(1011, "Host disconnected"); } catch {}
      }
      return;
    }

    if (Object.prototype.hasOwnProperty.call(data, "candidate")) {
      const host = this.findHost(client.inviteCode);
      if (host) this.send(host, { type: "iceCandidate", session: client.session, candidate: data.candidate ?? null });
    }
  }

  handleClose(socket) {
    const client = this.attachment(socket);
    if (!client) return;
    this.connections.delete(socket);

    if (client.role === "join" && client.session) {
      const host = this.findHost(client.inviteCode);
      if (host) this.send(host, { type: "joinDisconnect", session: client.session });
      return;
    }

    if (client.role === "host" && client.inviteCode) {
      for (const [other, otherClient] of this.connections) {
        if (otherClient.role === "join" && otherClient.inviteCode === client.inviteCode) {
          this.send(other, { type: "error", error: "ExpiredInvite" });
          try { other.close(1000, "Host disconnected"); } catch {}
        }
      }
    }
  }
}
