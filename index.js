// PolyTrack 0.6.3 signaling Worker + public lobby directory.
// Actual car states continue to travel over PolyTrack's WebRTC data channels.

const VERSION = "0.6.3";
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store"
};
const SIGNALING_ROOM = "polytrack-0.6.3-signaling";

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "polytrack-0.6.3-signaling-public-lobbies" });
    }

    if (url.pathname === "/v6/iceServers" && request.method === "GET") {
      return json(ICE_SERVERS);
    }

    if (url.pathname === "/api/public-lobbies" && ["GET", "POST"].includes(request.method)) {
      if (!env.ROOM) return json({ error: "Missing Durable Object binding ROOM" }, 500);
      const id = env.ROOM.idFromName(SIGNALING_ROOM);
      return env.ROOM.get(id).fetch(request);
    }

    if (
      url.pathname === "/v6/multiplayer/host" ||
      url.pathname === "/v6/multiplayer/join"
    ) {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426, headers: CORS_HEADERS });
      }
      if (!env.ROOM) return json({ error: "Missing Durable Object binding ROOM" }, 500);
      const id = env.ROOM.idFromName(SIGNALING_ROOM);
      return env.ROOM.get(id).fetch(request);
    }

    return json({
      error: "Not found",
      supported: ["/api/health", "/api/public-lobbies", "/v6/iceServers", "/v6/multiplayer/host", "/v6/multiplayer/join"]
    }, 404);
  }
};

export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Live public lobby directory. Entries only exist while their host socket is online.
    if (url.pathname === "/api/public-lobbies" && request.method === "GET") {
      const sockets = this.getSockets();
      const hosts = sockets.filter(socket => {
        const a = this.getAttachment(socket);
        return socket.readyState === 1 && a.role === "host" && a.isPublic === true && typeof a.inviteCode === "string";
      });
      const lobbies = hosts.map(socket => {
        const a = this.getAttachment(socket);
        const connectedPlayers = sockets.reduce((count, other) => {
          const b = this.getAttachment(other);
          return count + (other.readyState === 1 && b.role === "join" && b.inviteCode === a.inviteCode ? 1 : 0);
        }, 0);
        return {
          inviteCode: a.inviteCode,
          name: typeof a.lobbyName === "string" && a.lobbyName.trim()
            ? a.lobbyName.trim().slice(0, 48)
            : `${a.nickname || "Player"}'s lobby`,
          nickname: a.nickname || "Anonymous",
          players: connectedPlayers + 1,
          maxPlayers: Number.isInteger(a.maxPlayers) ? a.maxPlayers : null,
          createdAt: Number.isFinite(a.createdAt) ? a.createdAt : 0
        };
      }).sort((a, b) => a.createdAt - b.createdAt);
      return json({ ok: true, lobbies });
    }

    // Host-authenticated publish/unpublish action. A guest can't change another host's listing.
    if (url.pathname === "/api/public-lobbies" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }

      const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode.trim().toUpperCase() : "";
      const key = typeof body.key === "string" ? body.key : "";
      if (!inviteCode || !key || typeof body.isPublic !== "boolean") {
        return json({ error: "inviteCode, key, and isPublic are required" }, 400);
      }

      const host = this.findHost(inviteCode);
      if (!host) return json({ error: "Host invite is not active" }, 404);
      const attachment = this.getAttachment(host);
      if (!attachment.key || attachment.key !== key) {
        return json({ error: "Only the host can change public listing" }, 403);
      }

      const lobbyName = typeof body.lobbyName === "string"
        ? body.lobbyName.replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 48)
        : "";
      const maxPlayersValue = Number(body.maxPlayers);
      const maxPlayers = Number.isInteger(maxPlayersValue) && maxPlayersValue >= 2 && maxPlayersValue <= 16
        ? maxPlayersValue
        : attachment.maxPlayers ?? null;

      this.saveAttachment(host, {
        ...attachment,
        isPublic: body.isPublic,
        lobbyName: lobbyName || attachment.lobbyName || `${attachment.nickname || "Player"}'s lobby`,
        maxPlayers,
        createdAt: attachment.createdAt || Date.now()
      });

      return json({ ok: true, isPublic: body.isPublic, inviteCode });
    }

    const role = url.pathname.endsWith("/host") ? "host" : "join";
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      role,
      id: crypto.randomUUID(),
      inviteCode: null,
      session: null,
      key: null,
      nickname: null,
      isPublic: false,
      lobbyName: null,
      maxPlayers: null,
      createdAt: Date.now()
    });
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  getSockets() {
    return this.state.getWebSockets();
  }

  getAttachment(socket) {
    try { return socket.deserializeAttachment() || {}; }
    catch { return {}; }
  }

  saveAttachment(socket, attachment) {
    try { socket.serializeAttachment(attachment); }
    catch (error) { console.error("Could not save socket attachment:", error); }
  }

  send(socket, data) {
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify({ ...data, version: VERSION }));
      return true;
    } catch (error) {
      console.error("WebSocket send failed:", error);
      return false;
    }
  }

  findHost(inviteCode) {
    return this.getSockets().find(socket => {
      const a = this.getAttachment(socket);
      return a.role === "host" && a.inviteCode === inviteCode && socket.readyState === 1;
    }) || null;
  }

  findJoiner(session) {
    return this.getSockets().find(socket => {
      const a = this.getAttachment(socket);
      return a.role === "join" && a.session === session && socket.readyState === 1;
    }) || null;
  }

  makeInviteCode() {
    for (let i = 0; i < 100; i++) {
      const number = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
      const code = String(number).padStart(6, "0");
      if (!this.findHost(code)) return code;
    }
    return String(Date.now() % 1000000).padStart(6, "0");
  }

  webSocketMessage(socket, rawMessage) {
    if (typeof rawMessage !== "string" || rawMessage.length > 250000) {
      try { socket.close(1009, "Invalid message size"); } catch {}
      return;
    }

    let data;
    try { data = JSON.parse(rawMessage); }
    catch {
      this.send(socket, { type: "error", error: "MalformedClientData" });
      try { socket.close(1007, "Invalid JSON"); } catch {}
      return;
    }
    // PolyTrack initial join/ICE packets may not include a type property.
    if (!data || typeof data !== "object" || Array.isArray(data)) return;

    const attachment = this.getAttachment(socket);

    if (attachment.role === "host") {
      if (typeof data.type !== "string") return;

      if (data.type === "createInvite") {
        if (data.key != null && typeof data.key !== "string") {
          this.send(socket, { type: "error", error: "MalformedClientData" });
          return;
        }
        const key = typeof data.key === "string" && data.key.length > 0
          ? data.key
          : crypto.randomUUID().replaceAll("-", "");
        const nickname = typeof data.nickname === "string" && data.nickname.trim()
          ? data.nickname.trim().slice(0, 50)
          : (attachment.nickname || "Anonymous");
        const inviteCode = attachment.inviteCode || this.makeInviteCode();
        this.saveAttachment(socket, {
          ...attachment,
          key,
          inviteCode,
          nickname,
          createdAt: attachment.createdAt || Date.now()
        });
        this.send(socket, {
          type: "createInvite",
          inviteCode,
          key,
          timeoutMilliseconds: null,
          censoredNickname: nickname
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
          this.send(joiner, { type: "iceCandidate", session: data.session, candidate: data.candidate ?? null });
        } else {
          this.send(joiner, data);
        }
      }
      return;
    }

    if (attachment.role !== "join") return;

    if (!attachment.session) {
      const inviteCode = typeof data.inviteCode === "string" ? data.inviteCode.trim().toUpperCase() : "";
      const host = inviteCode ? this.findHost(inviteCode) : null;
      if (!host) {
        this.send(socket, { type: "error", error: "ExpiredInvite" });
        try { socket.close(1000, "Invite not found"); } catch {}
        return;
      }
      if (
        typeof data.offer !== "string" ||
        (typeof data.nickname !== "string" && data.nickname !== null && data.nickname !== undefined) ||
        typeof data.carStyle !== "string" ||
        !Array.isArray(data.mods) ||
        typeof data.isModsVanillaCompatible !== "boolean"
      ) {
        this.send(socket, { type: "error", error: "MalformedClientData" });
        try { socket.close(1007, "Malformed join request"); } catch {}
        return;
      }
      const session = crypto.randomUUID();
      const nickname = typeof data.nickname === "string" && data.nickname.trim()
        ? data.nickname.slice(0, 50)
        : "Anonymous";
      this.saveAttachment(socket, { ...attachment, inviteCode, session, nickname });
      const accepted = this.send(host, {
        type: "joinInvite",
        session,
        offer: data.offer,
        version: typeof data.version === "string" ? data.version : VERSION,
        mods: data.mods,
        isModsVanillaCompatible: data.isModsVanillaCompatible,
        nickname,
        countryCode: typeof data.countryCode === "string" ? data.countryCode : null,
        carStyle: data.carStyle,
        iceServers: ICE_SERVERS
      });
      if (!accepted) {
        this.send(socket, { type: "error", error: "ExpiredInvite" });
        try { socket.close(1011, "Host disconnected"); } catch {}
      }
      return;
    }

    // Joining clients send ICE messages without type/session.
    if (Object.prototype.hasOwnProperty.call(data, "candidate")) {
      const host = this.findHost(attachment.inviteCode);
      if (host) {
        this.send(host, {
          type: "iceCandidate",
          session: attachment.session,
          candidate: data.candidate ?? null
        });
      }
      return;
    }

    if (data.type === "ping") this.send(socket, { type: "pong" });
  }

  webSocketClose(socket) {
    this.handleClosedSocket(socket);
  }

  webSocketError(socket) {
    this.handleClosedSocket(socket);
  }

  handleClosedSocket(socket) {
    const attachment = this.getAttachment(socket);
    if (attachment.role === "join" && attachment.session) {
      const host = this.findHost(attachment.inviteCode);
      if (host) this.send(host, { type: "joinDisconnect", session: attachment.session });
      return;
    }
    if (attachment.role === "host" && attachment.inviteCode) {
      for (const other of this.getSockets()) {
        const a = this.getAttachment(other);
        if (a.role === "join" && a.inviteCode === attachment.inviteCode) {
          this.send(other, { type: "error", error: "ExpiredInvite" });
          try { other.close(1000, "Host disconnected"); } catch {}
        }
      }
    }
  }
}
