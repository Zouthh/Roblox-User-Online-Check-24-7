// monitor.js — Monitor 24/7 para un juego de Roblox
// Checa si el juego se cae y cuándo se conectan jugadores específicos.

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
const userInfoCache = new Map(); // userId -> { name, displayName }

// ====== UTIL: resolver username + nickname (displayName) de cada userId ======
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
      userInfoCache.set(user.id, { name: user.name, displayName: user.displayName });
    }
    console.log("Info de usuarios cargada:", Array.from(userInfoCache.entries()));
  } catch (err) {
    console.error("Fallo al cargar info de usuarios:", err.message);
  }
}

function formatPlayer(userId) {
  const info = userInfoCache.get(userId);
  if (!info) return `ID ${userId}`;
  return `${info.displayName} (@${info.name}, ID ${userId})`;
}

// ====== UTIL: mandar alerta a Discord ======
async function alert(message) {
  console.log(`[ALERTA] ${new Date().toISOString()} - ${message}`);
  if (!CONFIG.discordWebhook) return;
  try {
    await fetch(CONFIG.discordWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `@everyone ${message}`,
        allowed_mentions: { parse: ["everyone"] },
      }),
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
        await alert(`🟢 ${formatPlayer(userId)} se conectó a jugar: ${gameName}`);
      } else if (!isInGame && wasInGame) {
        await alert(`⚪ ${formatPlayer(userId)} se desconectó.`);
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
