// PolyTrack 0.6.3 Multiplayer Signaling Worker
// Cloudflare Workers + Durable Object.
//
// PolyTrack uses WebRTC data channels for live car synchronization.
// This Worker handles invite creation, joining, and WebRTC signaling.

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
        service: "polytrack-0.6.3-signaling-nickname-fix"
      });
    }

    if (
      url.pathname === "/v6/iceServers" &&
      request.method === "GET"
    ) {
      return json(ICE_SERVERS);
    }

    const signalingPaths = [
      "/v6/multiplayer/host",
      "/v6/multiplayer/join"
    ];

    if (signalingPaths.includes(url.pathname)) {
      if (
        (request.headers.get("Upgrade") || "").toLowerCase() !==
        "websocket"
      ) {
        return new Response("WebSocket upgrade required", {
          status: 426,
          headers: CORS_HEADERS
        });
      }

      if (!env.ROOM) {
        return json({
          error: "Missing Durable Object binding ROOM"
        }, 500);
      }

      // Hosts and joiners must use the same signaling room.
      const id = env.ROOM.idFromName("polytrack-0.6.3-signaling");
      const room = env.ROOM.get(id);

      return room.fetch(request);
    }

    return json({
      error: "Not found",
      supported: [
        "/api/health",
        "/v6/iceServers",
        "/v6/multiplayer/host",
        "/v6/multiplayer/join"
      ]
    }, 404);
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
      (request.headers.get("Upgrade") || "").toLowerCase() !==
      "websocket"
    ) {
      return new Response("WebSocket upgrade required", {
        status: 426
      });
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
    if (!socket || socket.readyState !== 1) {
      return false;
    }

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

      if (!this.findHost(code)) {
        return code;
      }
    }

    return String(Date.now() % 1000000).padStart(6, "0");
  }

  webSocketMessage(socket, rawMessage) {
    if (
      typeof rawMessage !== "string" ||
      rawMessage.length > 250000
    ) {
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

    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      typeof data.type !== "string"
    ) {
      this.send(socket, {
        type: "error",
        error: "MalformedClientData"
      });
      return;
    }

    const attachment = this.getAttachment(socket);

    // ---------------------------------------------------------
    // HOST MESSAGES
    // ---------------------------------------------------------
    if (attachment.role === "host") {
      if (data.type === "createInvite") {
        if (
          data.key !== null &&
          data.key !== undefined &&
          typeof data.key !== "string"
        ) {
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

        // Preserve the host's name even when Renew omits nickname.
        const requestedNickname =
          typeof data.nickname === "string"
            ? data.nickname.trim()
            : "";

        const savedNickname =
          typeof attachment.nickname === "string"
            ? attachment.nickname.trim()
            : "";

        const nickname =
          requestedNickname || savedNickname || "Anonymous";

        // Always send a real string, never null, for this field.
        const censoredNickname = nickname;

        // Reuse the code for this host connection when renewing.
        const inviteCode =
          attachment.inviteCode || this.makeInviteCode();

        this.saveAttachment(socket, {
          ...attachment,
          key,
          inviteCode,
          nickname,
          censoredNickname
        });

        this.send(socket, {
          type: "createInvite",
          inviteCode,
          key,
          timeoutMilliseconds: null,
          censoredNickname
        });

        return;
      }

      if (data.type === "ping") {
        this.send(socket, { type: "pong" });
        return;
      }

      if (
        [
          "acceptJoin",
          "declineJoin",
          "iceCandidate"
        ].includes(data.type)
      ) {
        if (typeof data.session !== "string") {
          return;
        }

        const joiner = this.findJoiner(data.session);

        if (!joiner) {
          return;
        }

        if (data.type === "iceCandidate") {
          // Preserve the session identifier for the joiner's
          // WebRTC peer-connection lookup.
          this.send(joiner, {
            type: "iceCandidate",
            session: data.session,
            candidate: data.candidate ?? null
          });
        } else {
          this.send(joiner, data);
        }

        return;
      }

      return;
    }

    // ---------------------------------------------------------
    // JOINER MESSAGES
    // ---------------------------------------------------------
    if (attachment.role !== "join") {
      return;
    }

    // The first join message contains the invitation and SDP offer.
    if (!attachment.session) {
      const inviteCode =
        typeof data.inviteCode === "string"
          ? data.inviteCode.trim().toUpperCase()
          : "";

      const host = inviteCode
        ? this.findHost(inviteCode)
        : null;

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
        typeof data.nickname !== "string" ||
        typeof data.carStyle !== "string" ||
        !Array.isArray(data.mods) ||
        typeof data.isModsVanillaCompatible !== "boolean"
      ) {
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

      this.saveAttachment(socket, {
        ...attachment,
        inviteCode,
        session,
        nickname: data.nickname.slice(0, 50)
      });

      const hostAccepted = this.send(host, {
        type: "joinInvite",
        session,
        offer: data.offer,
        version:
          typeof data.version === "string"
            ? data.version
            : VERSION,
        mods: data.mods,
        isModsVanillaCompatible:
          data.isModsVanillaCompatible,
        nickname: data.nickname.slice(0, 50),
        countryCode:
          typeof data.countryCode === "string"
            ? data.countryCode
            : null,
        carStyle: data.carStyle,
        iceServers: ICE_SERVERS
      });

      if (!hostAccepted) {
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

    // Relay join-side ICE candidates to the correct host session.
    if (data.type === "iceCandidate") {
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

    if (
      attachment.role === "join" &&
      attachment.session
    ) {
      const host = this.findHost(attachment.inviteCode);

      if (host) {
        this.send(host, {
          type: "joinDisconnect",
          session: attachment.session
        });
      }

      return;
    }

    if (
      attachment.role === "host" &&
      attachment.inviteCode
    ) {
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
