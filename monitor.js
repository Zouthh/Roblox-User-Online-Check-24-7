// monitor.js — Monitor 24/7 para un juego de Roblox
// Checa si el juego se cae y cuándo se conectan jugadores específicos.
// Corre con: node monitor.js   (o mejor con pm2, ver README)

const fetch = global.fetch || require("node-fetch");

// ====== CONFIG ======
const CONFIG = {
  // userIds de jugadores que quieres trackear
  watchedUserIds: (process.env.WATCHED_USER_IDS || "").split(",").filter(Boolean).map(Number),
  discordWebhook: process.env.DISCORD_WEBHOOK || "", // URL del webhook de Discord
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 30000), // cada 30s por default
};

// ====== ESTADO ======
const playerOnlineState = new Map(); // userId -> bool (si está en el juego)
const userInfoCache = new Map(); // userId -> { name, displayName, avatarUrl, created, friendsCount, verified }
const connectTimestamps = new Map(); // userId -> Date en que se conectó (para calcular duración)
const dailyConnectCount = new Map(); // userId -> { date: 'YYYY-MM-DD', count: n }

// ====== UTIL: resolver username + nickname + avatar + cuenta creada + amigos ======
async function loadUserInfo() {
  if (CONFIG.watchedUserIds.length === 0) return;
  try {
    const res = await fetch("https://users.roblox.com/v1/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify({ userIds: CONFIG.watchedUserIds, excludeBannedUsers: false }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    for (const user of data.data) {
      const existing = userInfoCache.get(user.id) || {};
      userInfoCache.set(user.id, {
        ...existing,
        name: user.name,
        displayName: user.displayName,
      });
    }

    // Avatar (todos en una sola llamada)
    const ids = CONFIG.watchedUserIds.join(",");
    const avatarRes = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar?userIds=${ids}&size=420x420&format=Png`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (avatarRes.ok) {
      const avatarData = await avatarRes.json();
      for (const item of avatarData.data || []) {
        const existing = userInfoCache.get(item.targetId) || {};
        userInfoCache.set(item.targetId, { ...existing, avatarUrl: item.imageUrl });
      }
    }

    // Detalles individuales: fecha de creación, insignia verificada, amigos, bio, grupos
    for (const userId of CONFIG.watchedUserIds) {
      try {
        const detailRes = await fetch(`https://users.roblox.com/v1/users/${userId}`, {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        const detail = detailRes.ok ? await detailRes.json() : {};

        const friendsRes = await fetch(`https://friends.roblox.com/v1/users/${userId}/friends/count`, {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        const friendsData = friendsRes.ok ? await friendsRes.json() : {};

        const followersRes = await fetch(`https://friends.roblox.com/v1/users/${userId}/followers/count`, {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        const followersData = followersRes.ok ? await followersRes.json() : {};

        const groupsRes = await fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`, {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        const groupsData = groupsRes.ok ? await groupsRes.json() : {};
        const groupNames = (groupsData.data || []).map((g) => g.group.name);

        const existing = userInfoCache.get(userId) || {};
        userInfoCache.set(userId, {
          ...existing,
          created: detail.created || null,
          verified: detail.hasVerifiedBadge || false,
          friendsCount: friendsData.count ?? null,
          followersCount: followersData.count ?? null,
          bio: detail.description && detail.description.trim() ? detail.description.trim() : null,
          groupNames,
        });
      } catch (err) {
        console.error(`Fallo sacando detalle de ${userId}:`, err.message);
      }
    }

    console.log("Info de usuarios cargada:", Array.from(userInfoCache.keys()));
  } catch (err) {
    console.error("Fallo al cargar info de usuarios:", err.message);
  }
}

function formatPlayer(userId) {
  const info = userInfoCache.get(userId);
  if (!info) return `ID ${userId}`;
  return `${info.displayName} (@${info.name}, ID ${userId})`;
}

function formatAccountAge(createdIso) {
  if (!createdIso) return null;
  const created = new Date(createdIso);
  const days = Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));
  const years = Math.floor(days / 365);
  return years > 0 ? `${years} años (${days} días)` : `${days} días`;
}

function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}min`;
  return `${minutes}min`;
}

// Emoji según palabras clave en el nombre del juego
function guessEmoji(gameName) {
  const name = (gameName || "").toLowerCase();
  if (name.includes("horror") || name.includes("doors")) return "👻";
  if (name.includes("simulator")) return "🎮";
  if (name.includes("tycoon")) return "🏭";
  if (name.includes("murder") || name.includes("duels") || name.includes("battle")) return "🔪";
  if (name.includes("obby")) return "🧗";
  if (name.includes("racing") || name.includes("race")) return "🏎️";
  if (name.includes("fish")) return "🎣";
  return "🕹️";
}

// Contador de conexiones del día (se resetea solo cuando cambia la fecha)
function bumpDailyConnectCount(userId) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const entry = dailyConnectCount.get(userId);
  if (!entry || entry.date !== today) {
    dailyConnectCount.set(userId, { date: today, count: 1 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

// ====== UTIL: armar links de "ir al juego" y "unirse a ese server exacto" ======
function buildJoinLinks(presence) {
  const links = [];
  if (presence.placeId) {
    links.push({ label: "Página del juego", url: `https://www.roblox.com/games/${presence.placeId}` });
  }
  // Deep link: abre el cliente de Roblox directo en ESE server (si su privacidad lo permite)
  if (presence.placeId && presence.gameId) {
    links.push({
      label: "Unirse a su server",
      url: `https://www.roblox.com/games/start?placeId=${presence.placeId}&gameInstanceId=${presence.gameId}`,
    });
  }
  return links;
}

// Cache de placeId -> { universeId, iconUrl } para no repetir la búsqueda cada vez
const gameInfoCache = new Map();

async function getGameIcon(placeId) {
  if (!placeId) return null;
  if (gameInfoCache.has(placeId)) return gameInfoCache.get(placeId).iconUrl;

  try {
    const uniRes = await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!uniRes.ok) return null;
    const uniData = await uniRes.json();
    const universeId = uniData.universeId;

    const iconRes = await fetch(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&size=512x512&format=Png`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const iconData = iconRes.ok ? await iconRes.json() : {};
    const iconUrl = iconData.data && iconData.data[0] ? iconData.data[0].imageUrl : null;

    gameInfoCache.set(placeId, { universeId, iconUrl });
    return iconUrl;
  } catch (err) {
    console.error("Fallo sacando ícono del juego:", err.message);
    return null;
  }
}

// Busca el server exacto (gameId) en la lista pública de servers del place, paginando varias páginas
async function getServerPlayerCount(placeId, gameId) {
  if (!placeId || !gameId) return null;
  try {
    let cursor = "";
    const maxPages = 5; // solo pa' sacar el dato extra de "jugadores en su server", nada más

    for (let page = 0; page < maxPages; page++) {
      const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) return null;

      const data = await res.json();
      const server = (data.data || []).find((s) => s.id === gameId);
      if (server) return { found: true, playing: server.playing, maxPlayers: server.maxPlayers };

      if (!data.nextPageCursor) break; // ya no hay más páginas
      cursor = data.nextPageCursor;
    }

    // No lo encontramos tras revisar varias páginas: puede ser privado, o simplemente
    // un juego con muchísimos servers activos donde no alcanzamos a cubrir todo.
    return { found: false, inconclusive: true };
  } catch (err) {
    console.error("Fallo sacando info del server:", err.message);
    return null;
  }
}

// ====== UTIL: mandar alerta a Discord (con embed y botones opcionales) ======
async function alert(message, embed = null, buttons = null) {
  console.log(`[ALERTA] ${new Date().toISOString()} - ${message}`);
  if (!CONFIG.discordWebhook) return;
  try {
    const body = {
      content: `@everyone ${message}`,
      allowed_mentions: { parse: ["everyone"] },
    };
    if (embed) body.embeds = [embed];
    if (buttons && buttons.length) {
      body.components = [
        {
          type: 1, // action row
          components: buttons.map((b) => ({
            type: 2, // button
            style: 5, // link style (no requiere manejar interacciones)
            label: b.label,
            url: b.url,
          })),
        },
      ];
    }

    await fetch(CONFIG.discordWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("No se pudo mandar el webhook:", err.message);
  }
}

// ====== CHECK: ¿se conectaron jugadores específicos a CUALQUIER juego? ======
async function checkWatchedPlayers() {
  if (CONFIG.watchedUserIds.length === 0) return;

  try {
    const res = await fetch("https://presence.roblox.com/v1/presence/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify({ userIds: CONFIG.watchedUserIds }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    for (const presence of data.userPresences) {
      const userId = presence.userId;
      // userPresenceType: 0 = Offline, 1 = Online (web), 2 = In-game, 3 = In-Studio
      const isInGame = presence.userPresenceType === 2;
      const gameName = presence.lastLocation || "un juego"; // Roblox regresa el nombre aquí

      const wasInGame = playerOnlineState.get(userId) || false;

      if (isInGame && !wasInGame) {
        connectTimestamps.set(userId, Date.now());
        const connectCount = bumpDailyConnectCount(userId);
        const emoji = guessEmoji(gameName);
        const buttons = buildJoinLinks(presence);
        const info = userInfoCache.get(userId) || {};

        const [gameIconUrl, serverInfo] = await Promise.all([
          getGameIcon(presence.placeId),
          getServerPlayerCount(presence.placeId, presence.gameId),
        ]);

        let serverField = null;
        if (serverInfo && serverInfo.found) {
          serverField = { name: "Jugadores en su server", value: `${serverInfo.playing}/${serverInfo.maxPlayers}`, inline: true };
        }
        // Nota: si no lo encontramos, no significa que no se pueda unir — el botón/link de
        // "Unirse a su server" funciona vía join-by-presence, independiente de este dato extra.

        const embed = {
          color: 0x57f287,
          description: info.bio ? info.bio.slice(0, 300) : undefined,
          thumbnail: info.avatarUrl ? { url: info.avatarUrl } : undefined,
          image: gameIconUrl ? { url: gameIconUrl } : undefined,
          fields: [
            info.created ? { name: "Cuenta creada", value: formatAccountAge(info.created), inline: true } : null,
            info.friendsCount != null ? { name: "Amigos", value: String(info.friendsCount), inline: true } : null,
            info.followersCount != null ? { name: "Seguidores", value: String(info.followersCount), inline: true } : null,
            info.verified ? { name: "Verificado", value: "✅", inline: true } : null,
            { name: "Conexiones hoy", value: String(connectCount), inline: true },
            serverField,
            info.groupNames && info.groupNames.length
              ? { name: `Grupos (${info.groupNames.length})`, value: info.groupNames.slice(0, 10).join(", ").slice(0, 1000), inline: false }
              : null,
          ].filter(Boolean),
        };

        await alert(
          `${emoji} ${formatPlayer(userId)} se conectó a jugar: ${gameName}`,
          embed,
          buttons
        );
      } else if (!isInGame && wasInGame) {
        const connectedAt = connectTimestamps.get(userId);
        const duration = connectedAt ? ` (estuvo ${formatDuration(Date.now() - connectedAt)})` : "";
        connectTimestamps.delete(userId);
        await alert(`⚪ ${formatPlayer(userId)} se desconectó.${duration}`);
      }

      playerOnlineState.set(userId, isInGame);
    }
  } catch (err) {
    console.error("Fallo al checar presencia de jugadores:", err.message);
  }
}

// ====== LOOP PRINCIPAL ======
async function tick() {
  await checkWatchedPlayers();
}

console.log("Monitor de Roblox iniciado. Trackeando userIds:", CONFIG.watchedUserIds);
loadUserInfo().then(() => {
  tick();
  setInterval(tick, CONFIG.pollIntervalMs);
});
