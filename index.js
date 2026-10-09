// PolyTrack 0.6.3 signaling Worker for Cloudflare Workers + one Durable Object.
// The game still sends car states directly over PolyTrack's built-in WebRTC data channels.
const VERSION = "0.6.3";
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/api/health") {
      return Response.json(
        { ok: true, service: "polytrack-0.6.3-signaling-keyfix" },
        { headers: CORS_HEADERS }
      );
    }

    if (url.pathname === "/v6/iceServers" && request.method === "GET") {
      return Response.json(ICE_SERVERS, { headers: CORS_HEADERS });
    }

    if (
      url.pathname === "/v6/multiplayer/host" ||
      url.pathname === "/v6/multiplayer/join"
    ) {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", {
          status: 426,
          headers: CORS_HEADERS
        });
      }
      if (!env.ROOM) {
        return Response.json(
          { error: "Missing Durable Object binding ROOM" },
          { status: 500, headers: CORS_HEADERS }
        );
      }
      // One signaling Durable Object lets hosts and joiners find each other by invite code.
      const id = env.ROOM.idFromName("polytrack-0.6.3-signaling");
      return env.ROOM.get(id).fetch(request);
    }

    return Response.json(
      { error: "Not found", supported: ["/api/health", "/v6/iceServers", "/v6/multiplayer/host", "/v6/multiplayer/join"] },
      { status: 404, headers: CORS_HEADERS }
    );
  }
};

export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.pathname.endsWith("/host") ? "host" : "join";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ role, id: crypto.randomUUID(), inviteCode: null, session: null });
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  getSockets() {
    return this.state.getWebSockets();
  }

  getAttachment(socket) {
    try {
      return socket.deserializeAttachment() || {};
    } catch {
      return {};
    }
  }

  saveAttachment(socket, attachment) {
    try {
      socket.serializeAttachment(attachment);
    } catch {}
  }

  send(socket, data) {
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify({ version: VERSION, ...data }));
      return true;
    } catch {
      return false;
    }
  }

  findHost(inviteCode) {
    for (const socket of this.getSockets()) {
      const attachment = this.getAttachment(socket);
      if (attachment.role === "host" && attachment.inviteCode === inviteCode && socket.readyState === 1) {
        return socket;
      }
    }
    return null;
  }

  findJoiner(session) {
    for (const socket of this.getSockets()) {
      const attachment = this.getAttachment(socket);
      if (attachment.role === "join" && attachment.session === session && socket.readyState === 1) {
        return socket;
      }
    }
    return null;
  }

  makeInviteCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
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
    try {
      data = JSON.parse(rawMessage);
    } catch {
      try { socket.close(1007, "Invalid JSON"); } catch {}
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return;

    const attachment = this.getAttachment(socket);
    if (attachment.role === "host") {
      if (data.type === "createInvite") {
        // PolyTrack 0.6.3 starts with key:null. Its client requires the
        // server response to contain a STRING key, so issue one on first use
        // and reuse it on subsequent renewals.
        if (data.key !== null && typeof data.key !== "string") {
          this.send(socket, { type: "error", error: "MalformedClientData" });
          return;
        }
        const key = typeof data.key === "string"
          ? data.key
          : crypto.randomUUID().replaceAll("-", "");
        const inviteCode = this.makeInviteCode();
        this.saveAttachment(socket, { ...attachment, inviteCode, key });
        this.send(socket, {
          type: "createInvite",
          inviteCode,
          key,
          timeoutMilliseconds: null,
          censoredNickname: null
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
          // The join-side 0.6.3 client expects candidate without a session field.
          this.send(joiner, { type: "iceCandidate", candidate: data.candidate ?? null });
        } else {
          this.send(joiner, data);
        }
      }
      return;
    }

    if (attachment.role !== "join") return;

    // The join client starts with an offer packet; subsequent packets carry ICE candidates.
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
      this.saveAttachment(socket, { ...attachment, inviteCode, session });
      const hostAccepted = this.send(host, {
        type: "joinInvite",
        session,
        offer: data.offer,
        version: typeof data.version === "string" ? data.version : VERSION,
        mods: data.mods,
        isModsVanillaCompatible: data.isModsVanillaCompatible,
        nickname: data.nickname.slice(0, 50),
        countryCode: typeof data.countryCode === "string" ? data.countryCode : null,
        carStyle: data.carStyle,
        iceServers: ICE_SERVERS
      });
      if (!hostAccepted) {
        this.send(socket, { type: "error", error: "ExpiredInvite" });
        try { socket.close(1011, "Host disconnected"); } catch {}
      }
      return;
    }

    // Join-side ICE candidates have no type/session; the signaling server supplies both.
    if (Object.prototype.hasOwnProperty.call(data, "candidate")) {
      const host = this.findHost(attachment.inviteCode);
      if (host) {
        this.send(host, {
          type: "iceCandidate",
          session: attachment.session,
          candidate: data.candidate ?? null
        });
      }
    }
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
        const otherAttachment = this.getAttachment(other);
        if (otherAttachment.role === "join" && otherAttachment.inviteCode === attachment.inviteCode) {
          this.send(other, { type: "error", error: "ExpiredInvite" });
          try { other.close(1000, "Host disconnected"); } catch {}
        }
      }
    }
  }
}
