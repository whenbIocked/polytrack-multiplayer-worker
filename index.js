// PolyTrack 0.6.3 Community Worker
// Includes multiplayer signaling, public lobbies, community tracks,
// and an unverified community leaderboard.

const VERSION = "0.6.3";
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store"
};

const SIGNALING_ROOM = "polytrack-0.6.3-signaling";
const LEADERBOARD_ROOM = "polytrack-community-leaderboard-v1";
const COMMUNITY_TRACKS_ROOM = "polytrack-community-tracks-v1";

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
      return json({
        ok: true,
        service: "polytrack-community-suite-leaderboard-v1"
      });
    }

    if (url.pathname === "/v6/iceServers" && request.method === "GET") {
      return json(ICE_SERVERS);
    }

    if (
      url.pathname === "/api/public-lobbies" &&
      ["GET", "POST"].includes(request.method)
    ) {
      if (!env.ROOM) {
        return json({ error: "Missing Durable Object binding ROOM" }, 500);
      }

      const id = env.ROOM.idFromName(SIGNALING_ROOM);
      return env.ROOM.get(id).fetch(request);
    }

    if (
      (url.pathname === "/api/community-tracks" ||
        url.pathname.startsWith("/api/community-tracks/")) &&
      ["GET", "POST", "DELETE"].includes(request.method)
    ) {
      if (!env.ROOM) {
        return json({ error: "Missing Durable Object binding ROOM" }, 500);
      }

      const id = env.ROOM.idFromName(COMMUNITY_TRACKS_ROOM);
      return env.ROOM.get(id).fetch(request);
    }

    const leaderboardRoutes =
      url.pathname.startsWith("/v6/leaderboard") ||
      [
        "/v6/recordings",
        "/v6/user",
        "/v6/verifyRecordings",
        "/v6/trackOfTheWeek"
      ].includes(url.pathname) ||
      url.pathname.startsWith("/v6/admin/");

    if (leaderboardRoutes) {
      if (!env.ROOM) {
        return json({ error: "Missing Durable Object binding ROOM" }, 500);
      }

      const id = env.ROOM.idFromName(LEADERBOARD_ROOM);
      return env.ROOM.get(id).fetch(request);
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

      const id = env.ROOM.idFromName(SIGNALING_ROOM);
      return env.ROOM.get(id).fetch(request);
    }

    return json({
      error: "Not found",
      supported: [
        "/api/health",
        "/api/public-lobbies",
        "/api/community-tracks",
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

    if (
      url.pathname === "/api/community-tracks" ||
      url.pathname.startsWith("/api/community-tracks/")
    ) {
      return this.handleCommunityTracksApi(request, url);
    }

    if (
      url.pathname.startsWith("/v6/") &&
      (request.headers.get("Upgrade") || "").toLowerCase() !== "websocket"
    ) {
      return this.handleLeaderboardApi(request, url);
    }

    // Public lobby directory: only active host sockets are listed.
    if (
      url.pathname === "/api/public-lobbies" &&
      request.method === "GET"
    ) {
      const sockets = this.getSockets();

      const hosts = sockets.filter(socket => {
        const a = this.getAttachment(socket);
        return socket.readyState === 1 &&
          a.role === "host" &&
          a.isPublic === true &&
          typeof a.inviteCode === "string";
      });

      const lobbies = hosts.map(socket => {
        const a = this.getAttachment(socket);

        const connectedPlayers = sockets.reduce((count, other) => {
          const b = this.getAttachment(other);
          return count + (
            other.readyState === 1 &&
            b.role === "join" &&
            b.inviteCode === a.inviteCode ? 1 : 0
          );
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

    // Only the host's key can publish/unpublish their lobby.
    if (
      url.pathname === "/api/public-lobbies" &&
      request.method === "POST"
    ) {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }

      const inviteCode =
        typeof body.inviteCode === "string"
          ? body.inviteCode.trim().toUpperCase()
          : "";

      const key = typeof body.key === "string" ? body.key : "";

      if (!inviteCode || !key || typeof body.isPublic !== "boolean") {
        return json({
          error: "inviteCode, key, and isPublic are required"
        }, 400);
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
      const maxPlayers =
        Number.isInteger(maxPlayersValue) &&
        maxPlayersValue >= 2 &&
        maxPlayersValue <= 16
          ? maxPlayersValue
          : attachment.maxPlayers ?? null;

      this.saveAttachment(host, {
        ...attachment,
        isPublic: body.isPublic,
        lobbyName: lobbyName ||
          attachment.lobbyName ||
          `${attachment.nickname || "Player"}'s lobby`,
        maxPlayers,
        createdAt: attachment.createdAt || Date.now()
      });

      return json({
        ok: true,
        isPublic: body.isPublic,
        inviteCode
      });
    }

    // WebSocket multiplayer signaling.
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
      nickname: null,
      isPublic: false,
      lobbyName: null,
      maxPlayers: null,
      createdAt: Date.now()
    });

    this.state.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async sha256Hex(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return Array.from(new Uint8Array(digest), b =>
      b.toString(16).padStart(2, "0")
    ).join("");
  }

  trackKey(trackId) {
    return Array.from(new TextEncoder().encode(String(trackId)), b =>
      b.toString(16).padStart(2, "0")
    ).join("").slice(0, 240) || "empty";
  }

  cleanNickname(value) {
    const cleaned = String(value ?? "Anonymous")
      .replace(/[<>\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 50);

    return cleaned || "Anonymous";
  }

  async listTrackEntries(trackKey) {
    const stored = await this.state.storage.list({
      prefix: `lb:entry:${trackKey}:`
    });

    return [...stored.values()].filter(v => v && typeof v === "object");
  }

  sortEntries(entries) {
    return entries.sort((a, b) =>
      a.frames - b.frames ||
      Date.parse(a.time) - Date.parse(b.time) ||
      a.id - b.id
    );
  }

  async handleCommunityTracksApi(request, url) {
    const base = "/api/community-tracks";
    const tail = url.pathname.slice(base.length).replace(/^\/+|\/+$/g, "");

    const clean = (value, max) => String(value ?? "")
      .replace(/[<>\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, max);

    if (!tail && request.method === "GET") {
      const ownerToken = url.searchParams.get("ownerToken") || "";
      const ownerHash = ownerToken ? await this.sha256Hex(ownerToken) : "";
      const stored = await this.state.storage.list({ prefix: "ct:track:" });

      const tracks = [...stored.values()]
        .filter(item =>
          item &&
          typeof item === "object" &&
          typeof item.id === "string"
        )
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .map(item => ({
          id: item.id,
          name: item.name,
          author: item.author,
          createdAt: item.createdAt,
          bytes: item.bytes,
          downloads: item.downloads || 0,
          isOwner: !!ownerHash && item.ownerHash === ownerHash
        }));

      return json({ ok: true, tracks });
    }

    if (!tail && request.method === "POST") {
      const raw = await request.text();
      if (raw.length > 800000) {
        return json({ error: "Track upload is too large (max 800 KB)" }, 413);
      }

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      const name = clean(body.name, 48);
      const author = clean(body.author || "Anonymous", 32) || "Anonymous";
      const code = typeof body.code === "string" ? body.code.trim() : "";
      const ownerToken =
        typeof body.ownerToken === "string" ? body.ownerToken : "";

      if (!name) return json({ error: "Track name is required" }, 400);
      if (!code) return json({ error: "Track export code is required" }, 400);
      if (code.length > 700000) {
        return json({ error: "Track code is too large (max 700 KB)" }, 413);
      }
      if (ownerToken.length < 8 || ownerToken.length > 256) {
        return json({ error: "Invalid owner token" }, 400);
      }

      const all = await this.state.storage.list({ prefix: "ct:track:" });
      if (all.size >= 500) {
        return json({ error: "Community track storage is full for now" }, 507);
      }

      const ownerHash = await this.sha256Hex(ownerToken);
      const ownedCount = [...all.values()].filter(
        item => item && item.ownerHash === ownerHash
      ).length;

      if (ownedCount >= 20) {
        return json({
          error: "Limit is 20 published tracks per browser profile"
        }, 429);
      }

      const id = crypto.randomUUID().replaceAll("-", "");

      const track = {
        id,
        name,
        author,
        code,
        ownerHash,
        createdAt: Date.now(),
        bytes: new TextEncoder().encode(code).length,
        downloads: 0
      };

      await this.state.storage.put(`ct:track:${id}`, track);

      return json({
        ok: true,
        track: {
          id,
          name,
          author,
          createdAt: track.createdAt,
          bytes: track.bytes,
          downloads: 0,
          isOwner: true
        }
      }, 201);
    }

    if (tail) {
      const id = tail.split("/")[0];

      if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) {
        return json({ error: "Invalid track id" }, 400);
      }

      const key = `ct:track:${id}`;
      const track = await this.state.storage.get(key);

      if (!track) return json({ error: "Community track not found" }, 404);

      if (request.method === "GET") {
        track.downloads = (track.downloads || 0) + 1;
        await this.state.storage.put(key, track);

        return json({
          ok: true,
          track: {
            id: track.id,
            name: track.name,
            author: track.author,
            createdAt: track.createdAt,
            bytes: track.bytes,
            downloads: track.downloads,
            code: track.code
          }
        });
      }

      if (request.method === "DELETE") {
        let body;

        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid JSON body" }, 400);
        }

        const ownerToken =
          typeof body.ownerToken === "string" ? body.ownerToken : "";

        if (!ownerToken) return json({ error: "Owner token required" }, 401);

        const ownerHash = await this.sha256Hex(ownerToken);

        if (!track.ownerHash || track.ownerHash !== ownerHash) {
          return json({
            error: "Only the uploader can delete this track"
          }, 403);
        }

        await this.state.storage.delete(key);
        return json({ ok: true, deleted: id });
      }
    }

    return json({ error: "Method not allowed" }, 405);
  }

  async handleLeaderboardApi(request, url) {
    const path = url.pathname;

    // Read a track's community leaderboard.
    if (path === "/v6/leaderboard" && request.method === "GET") {
      const trackId = url.searchParams.get("trackId") || "";
      const trackKey = this.trackKey(trackId);
      const skip = Math.max(
        0,
        Math.min(
          1000000,
          Number.parseInt(url.searchParams.get("skip") || "0", 10) || 0
        )
      );

      const amount = Math.max(
        1,
        Math.min(
          50,
          Number.parseInt(url.searchParams.get("amount") || "20", 10) || 20
        )
      );

      const onlyVerified = url.searchParams.get("onlyVerified") === "true";
      const userTokenHash = url.searchParams.get("userTokenHash") || "";

      let entries = this.sortEntries(await this.listTrackEntries(trackKey));

      if (onlyVerified) {
        entries = entries.filter(entry => entry.verifiedState === 1);
      }

      const total = entries.length;

      const page = entries.slice(skip, skip + amount).map(entry => ({
        id: entry.id,
        userId: entry.userId,
        nickname: entry.nickname,
        countryCode: entry.countryCode,
        frames: entry.frames,
        time: entry.time,
        carStyle: entry.carStyle,
        verifiedState: entry.verifiedState
      }));

      let userEntry = null;

      if (userTokenHash) {
        const index = entries.findIndex(
          entry => entry.userId === userTokenHash
        );

        if (index >= 0) {
          const entry = entries[index];
          userEntry = {
            position: index + 1,
            frames: entry.frames,
            id: entry.id
          };
        }
      }

      return json({ total, entries: page, userEntry });
    }

    if (
      path === "/v6/leaderboardUserEntry" &&
      request.method === "GET"
    ) {
      if (url.searchParams.get("onlyVerified") === "true") {
        return json(null);
      }

      const trackKey = this.trackKey(url.searchParams.get("trackId") || "");
      const userHash = url.searchParams.get("userTokenHash") || "";
      const entries = this.sortEntries(await this.listTrackEntries(trackKey));

      const index = entries.findIndex(entry => entry.userId === userHash);

      if (index < 0) return json(null);

      const entry = entries[index];

      return json({
        position: index + 1,
        frames: entry.frames,
        id: entry.id
      });
    }

    // Accept a completed run from the game.
    if (path === "/v6/leaderboard" && request.method === "POST") {
      const bodyText = await request.text();

      if (bodyText.length > 300000) {
        return json({ error: "Submission too large" }, 413);
      }

      const form = new URLSearchParams(bodyText);
      const token = form.get("userToken") || "";
      const nickname = this.cleanNickname(form.get("nickname"));
      const rawCountry = (form.get("countryCode") || "").toUpperCase();

      const countryCode = /^[A-Z]{2}$/.test(rawCountry)
        ? rawCountry
        : null;

      const carStyle = form.get("carStyle") || "";
      const trackId = form.get("trackId") || "";
      const frames = Number(form.get("frames"));
      const recording = form.get("recording") || "";

      if (
        !token ||
        token.length > 512 ||
        !trackId ||
        trackId.length > 500 ||
        !carStyle ||
        carStyle.length > 30000 ||
        !Number.isSafeInteger(frames) ||
        frames < 1 ||
        frames > 5999999 ||
        recording.length < 1 ||
        recording.length >= 10000
      ) {
        return json({ error: "Invalid leaderboard submission" }, 400);
      }

      const userId = await this.sha256Hex(token);
      const trackKey = this.trackKey(trackId);
      const userKey = `lb:user:${trackKey}:${userId}`;
      const oldId = await this.state.storage.get(userKey);

      const oldEntry = Number.isSafeInteger(oldId)
        ? await this.state.storage.get(`lb:entry:${trackKey}:${oldId}`)
        : null;

      const entriesBefore = this.sortEntries(
        await this.listTrackEntries(trackKey)
      );

      const previousIndex = entriesBefore.findIndex(
        entry => entry.userId === userId
      );

      const previousPosition = previousIndex < 0 ? 0 : previousIndex + 1;

      // Keep the player's best time for each track.
      if (oldEntry && oldEntry.frames <= frames) {
        return json({
          uploadId: oldEntry.id,
          previousPosition,
          newPosition: previousPosition
        });
      }

      let id = (await this.state.storage.get("lb:next-id")) || 1;

      if (!Number.isSafeInteger(id) || id < 1) id = 1;

      await this.state.storage.put("lb:next-id", id + 1);

      if (oldEntry) {
        await this.state.storage.delete(
          `lb:entry:${trackKey}:${oldEntry.id}`
        );

        await this.state.storage.delete(`lb:recording:${oldEntry.id}`);
      }

      const entry = {
        id,
        userId,
        nickname,
        countryCode,
        frames,
        time: new Date().toISOString(),
        carStyle,
        // Community scores remain pending/unverified.
        verifiedState: 0
      };

      await this.state.storage.put(`lb:entry:${trackKey}:${id}`, entry);

      await this.state.storage.put(`lb:recording:${id}`, {
        recording,
        verifiedState: 0,
        frames,
        carStyle
      });

      await this.state.storage.put(userKey, id);

      let entriesAfter = this.sortEntries(
        await this.listTrackEntries(trackKey)
      );

      // Bound storage growth to 500 leaderboard entries per track.
      for (const stale of entriesAfter.slice(500)) {
        await this.state.storage.delete(
          `lb:entry:${trackKey}:${stale.id}`
        );

        await this.state.storage.delete(`lb:recording:${stale.id}`);

        const staleUserKey = `lb:user:${trackKey}:${stale.userId}`;

        if (await this.state.storage.get(staleUserKey) === stale.id) {
          await this.state.storage.delete(staleUserKey);
        }
      }

      entriesAfter = entriesAfter.slice(0, 500);

      const newPosition = Math.max(
        0,
        entriesAfter.findIndex(entry => entry.id === id) + 1
      );

      return json({ uploadId: id, previousPosition, newPosition });
    }

    if (path === "/v6/user" && request.method === "GET") {
      const token = url.searchParams.get("userToken") || "";

      if (!token) return json(null);

      const hash = await this.sha256Hex(token);
      const profile = await this.state.storage.get(`lb:profile:${hash}`);

      return json(profile || null);
    }

    if (path === "/v6/user" && request.method === "POST") {
      const bodyText = await request.text();

      if (bodyText.length > 50000) {
        return json({ error: "Profile too large" }, 413);
      }

      const form = new URLSearchParams(bodyText);
      const token = form.get("userToken") || "";

      if (!token || token.length > 512) {
        return json({ error: "Invalid user token" }, 400);
      }

      const hash = await this.sha256Hex(token);
      const rawCountry = (form.get("countryCode") || "").toUpperCase();

      const profile = {
        nickname: this.cleanNickname(form.get("nickname")),
        countryCode: /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : null,
        carStyle: form.get("carStyle") || "",
        isVerifier: false
      };

      await this.state.storage.put(`lb:profile:${hash}`, profile);

      return new Response("", {
        status: 200,
        headers: CORS_HEADERS
      });
    }

    if (path === "/v6/recordings" && request.method === "GET") {
      const ids = (url.searchParams.get("ids") || "")
        .split(",")
        .filter(Boolean)
        .slice(0, 100)
        .map(Number);

      const records = [];

      for (const id of ids) {
        if (!Number.isSafeInteger(id) || id < 1) {
          records.push(null);
          continue;
        }

        records.push(
          await this.state.storage.get(`lb:recording:${id}`) || null
        );
      }

      return json(records);
    }

    if (path === "/v6/verifyRecordings" && request.method === "POST") {
      // This community Worker does not have official score verification.
      return json({
        unverifiedRecordings: [],
        exhaustive: true,
        estimatedRemaining: 0
      });
    }

    if (path === "/v6/trackOfTheWeek" && request.method === "GET") {
      return json({
        serverTime: new Date().toISOString(),
        current: null
      });
    }

    if (path === "/v6/admin/trackOfTheWeekList" && request.method === "GET") {
      return json({ currentEpoch: 0, list: [] });
    }

    if (path === "/v6/admin/trackOfTheWeek" && request.method === "POST") {
      return json({
        error: "Community Worker does not expose admin track publishing"
      }, 403);
    }

    return json({
      error: "Unsupported community API endpoint",
      path
    }, 404);
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
    } catch (error) {
      console.error("Could not save socket attachment:", error);
    }
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

    // PolyTrack's initial join and ICE packets may not have a type field.
    if (!data || typeof data !== "object" || Array.isArray(data)) return;

    const attachment = this.getAttachment(socket);

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
          this.send(joiner, data);
        }
      }

      return;
    }

    if (attachment.role !== "join") return;

    // First join message contains the invite code and offer.
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
        (typeof data.nickname !== "string" &&
          data.nickname !== null &&
          data.nickname !== undefined) ||
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
        version: typeof data.version === "string" ? data.version : VERSION,
        mods: data.mods,
        isModsVanillaCompatible: data.isModsVanillaCompatible,
        nickname,
        countryCode:
          typeof data.countryCode === "string" ? data.countryCode : null,
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
