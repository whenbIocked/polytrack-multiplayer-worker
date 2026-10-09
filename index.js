
// PolyTrack 0.6.3 signaling Worker for Cloudflare Workers + Durable Objects.
// PolyTrack sends car states over its own WebRTC data channels.

const VERSION = "0.6.3";
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" }
];

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store"
};

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: CORS_HEADERS
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "polytrack-0.6.3-signaling-join-fix"
      });
    }

    if (url.pathname === "/v6/iceServers" && request.method === "GET") {
      return json(ICE_SERVERS);
    }

    if (
      url.pathname === "/v6/multiplayer/host" ||
      url.pathname === "/v6/multiplayer/join"
    ) {
      if (
        (request.headers.get("Upgrade") || "").toLowerCase() !== "websocket"
      ) {
        return new Response("WebSocket upgrade required", {
          status: 426,
          headers: CORS_HEADERS
        });
      }

      if (!env.ROOM) {
        return json({ error: "Missing Durable Object binding ROOM" }, 500);
      }

      const id = env.ROOM.idFromName("polytrack-0.6.3-signaling");
      return env.ROOM.get(id).fetch(request);
    }

    return json({ error: "Not found" }, 404);
  }
};

export class Room {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.pathname.endsWith("/host") ? "host" : "join";

    if (
      (request.headers.get("Upgrade") || "").toLowerCase() !== "websocket"
    ) {
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
      nickname: null
    });

    this.state.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
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
    socket.serializeAttachment(attachment);
  }

  send(socket, data) {
    if (!socket || socket.readyState !== 1) return false;

    try {
      socket.send(JSON.stringify({
        ...data,
        version: VERSION
      }));
      return true;
    } catch (error) {
      console.error("WebSocket send failed:", error);
      return false;
    }
  }

  findHost(inviteCode) {
    return this.getSockets().find(socket => {
      const a = this.getAttachment(socket);

      return (
        a.role === "host" &&
        a.inviteCode === inviteCode &&
        socket.readyState === 1
      );
    }) || null;
  }

  findJoiner(session) {
    return this.getSockets().find(socket => {
      const a = this.getAttachment(socket);

      return (
        a.role === "join" &&
        a.session === session &&
        socket.readyState === 1
      );
    }) || null;
  }

  makeInviteCode() {
    for (let i = 0; i < 100; i++) {
      const number =
        crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
      const code = String(number).padStart(6, "0");

      if (!this.findHost(code)) return code;
    }

    return String(Date.now() % 1000000).padStart(6, "0");
  }

  webSocketMessage(socket, rawMessage) {
    if (typeof rawMessage !== "string" || rawMessage.length > 250000) {
      try {
        socket.close(1009, "Invalid message size");
      } catch {}
      return;
    }

    let data;

    try {
      data = JSON.parse(rawMessage);
    } catch {
      this.send(socket, {
        type: "error",
        error: "MalformedClientData"
      });
      try {
        socket.close(1007, "Invalid JSON");
      } catch {}
      return;
    }

    // Do NOT require data.type here!
    // PolyTrack's first join packet and its ICE candidate messages
    // do not include a "type" property.
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return;
    }

    const attachment = this.getAttachment(socket);

    // ---------------- HOST ----------------
    if (attachment.role === "host") {
      if (typeof data.type !== "string") return;

      if (data.type === "createInvite") {
        if (data.key != null && typeof data.key !== "string") {
          this.send(socket, {
            type: "error",
            error: "MalformedClientData"
          });
          return;
        }

        const key =
          typeof data.key === "string" && data.key.length > 0
            ? data.key
            : crypto.randomUUID().replaceAll("-", "");

        const nickname =
          typeof data.nickname === "string" && data.nickname.trim()
            ? data.nickname.trim()
            : (attachment.nickname || "Anonymous");

        const inviteCode =
          attachment.inviteCode || this.makeInviteCode();

        this.saveAttachment(socket, {
          ...attachment,
          key,
          inviteCode,
          nickname
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

      if (
        ["acceptJoin", "declineJoin", "iceCandidate"].includes(data.type) &&
        typeof data.session === "string"
      ) {
        const joiner = this.findJoiner(data.session);
        if (!joiner) return;

        if (data.type === "iceCandidate") {
          this.send(joiner, {
            type: "iceCandidate",
            session: data.session,
            candidate: data.candidate ?? null
          });
        } else {
          // Forward the host's WebRTC answer or rejection.
          this.send(joiner, data);
        }
      }

      return;
    }

    // ---------------- JOIN ----------------
    if (attachment.role !== "join") return;

    // First join message has no "type": it contains the offer and invite code.
    if (!attachment.session) {
      const inviteCode =
        typeof data.inviteCode === "string"
          ? data.inviteCode.trim().toUpperCase()
          : "";

      const host = inviteCode ? this.findHost(inviteCode) : null;

      if (!host) {
        this.send(socket, {
          type: "error",
          error: "ExpiredInvite"
        });

        try {
          socket.close(1000, "Invite not found");
        } catch {}
        return;
      }

      if (
        typeof data.offer !== "string" ||
        (
          typeof data.nickname !== "string" &&
          data.nickname !== null &&
          data.nickname !== undefined
        ) ||
        typeof data.carStyle !== "string" ||
        !Array.isArray(data.mods) ||
        typeof data.isModsVanillaCompatible !== "boolean"
      ) {
        console.warn("Malformed PolyTrack join offer", {
          hasOffer: typeof data.offer === "string",
          nicknameType: typeof data.nickname,
          carStyleType: typeof data.carStyle,
          modsIsArray: Array.isArray(data.mods),
          compatibilityType: typeof data.isModsVanillaCompatible
        });

        this.send(socket, {
          type: "error",
          error: "MalformedClientData"
        });

        try {
          socket.close(1007, "Malformed join request");
        } catch {}
        return;
      }

      const session = crypto.randomUUID();

      const nickname =
        typeof data.nickname === "string" && data.nickname.trim()
          ? data.nickname.slice(0, 50)
          : "Anonymous";

      this.saveAttachment(socket, {
        ...attachment,
        inviteCode,
        session,
        nickname
      });

      const accepted = this.send(host, {
        type: "joinInvite",
        session,
        offer: data.offer,
        version:
          typeof data.version === "string" ? data.version : VERSION,
        mods: data.mods,
        isModsVanillaCompatible: data.isModsVanillaCompatible,
        nickname,
        countryCode:
          typeof data.countryCode === "string"
            ? data.countryCode
            : null,
        carStyle: data.carStyle,
        iceServers: ICE_SERVERS
      });

      if (!accepted) {
        this.send(socket, {
          type: "error",
          error: "ExpiredInvite"
        });

        try {
          socket.close(1011, "Host disconnected");
        } catch {}
      }

      return;
    }

    // Subsequent join-side ICE messages are {version, candidate}.
    // They have NO type and NO session, so use this socket's saved session.
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

    if (data.type === "ping") {
      this.send(socket, { type: "pong" });
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

      if (host) {
        this.send(host, {
          type: "joinDisconnect",
          session: attachment.session
        });
      }

      return;
    }

    if (attachment.role === "host" && attachment.inviteCode) {
      for (const other of this.getSockets()) {
        const a = this.getAttachment(other);

        if (
          a.role === "join" &&
          a.inviteCode === attachment.inviteCode
        ) {
          this.send(other, {
            type: "error",
            error: "ExpiredInvite"
          });

          try {
            other.close(1000, "Host disconnected");
          } catch {}
        }
      }
    }
  }
}
