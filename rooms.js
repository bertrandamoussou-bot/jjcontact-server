/**
 * rooms.js
 * Gestion des salles actives en mémoire.
 * Une salle = un tapis, identifiée par un code texte libre (ex: "TAPIS1").
 * Durée de vie : création par le responsable → clôture manuelle ou timeout.
 */

const rooms = new Map();

// Durée de vie max d'une salle : 4 heures (sécurité anti-fuite mémoire)
const ROOM_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * Crée une salle.
 * @param {string} code        - Identifiant du tapis (ex: "TAPIS1")
 * @param {WebSocket} hostWs   - Socket du responsable de table
 * @param {string[]} fighters  - [nomA, nomB]
 * @param {string} fmt         - Format du combat : 'std' (Tournoi) ou 'gala' (Super Fight)
 * @returns {{ ok: boolean, error?: string }}
 */
function createRoom(code, hostWs, fighters, fmt) {
  const key = normalizeCode(code);
  if (rooms.has(key)) {
    return { ok: false, error: `La salle "${code}" existe déjà.` };
  }

  const room = {
    code: key,
    host: hostWs,
    fighters,                      // ["Athlete A", "Athlete B"]
    fmt: fmt || 'std',             // FIX : stocker le format dès la création
    judges: new Map(),             // judgeId → WebSocket
    votes: new Map(),              // judgeId → VoteObject
    createdAt: Date.now(),
    expiresAt: Date.now() + ROOM_TTL_MS,
  };

  rooms.set(key, room);

  // Auto-nettoyage après TTL
  setTimeout(() => {
    if (rooms.has(key)) {
      rooms.delete(key);
      console.log(`[rooms] Salle "${key}" expirée et supprimée.`);
    }
  }, ROOM_TTL_MS);

  return { ok: true };
}

/**
 * Un juge rejoint une salle existante.
 * @param {string} code
 * @param {string} judgeId   - Identifiant choisi par le juge (ex: "Juge 1")
 * @param {WebSocket} ws
 * @returns {{ ok: boolean, room?: object, error?: string }}
 */
function joinRoom(code, judgeId, ws) {
  const key = normalizeCode(code);
  const room = rooms.get(key);

  if (!room) {
    return { ok: false, error: `Code tapis "${code}" introuvable.` };
  }
  if (room.judges.size >= 3 && !room.judges.has(judgeId)) {
    return { ok: false, error: `La salle "${code}" a déjà 3 juges.` };
  }
  if (room.votes.has(judgeId)) {
    return { ok: false, error: `Le juge "${judgeId}" a déjà soumis son vote.` };
  }

  room.judges.set(judgeId, ws);
  return { ok: true, room };
}

/**
 * Enregistre le vote d'un juge et le retourne.
 * @param {string} code
 * @param {string} judgeId
 * @param {object} vote   - { method, winner, scoresA, scoresB, round? }
 * @returns {{ ok: boolean, room?: object, allIn?: boolean, error?: string }}
 */
function submitVote(code, judgeId, vote) {
  const key = normalizeCode(code);
  const room = rooms.get(key);

  if (!room) {
    return { ok: false, error: `Salle "${code}" introuvable.` };
  }
  if (!room.judges.has(judgeId)) {
    return { ok: false, error: `Juge "${judgeId}" non reconnu dans cette salle.` };
  }
  if (room.votes.has(judgeId)) {
    return { ok: false, error: `Vote déjà enregistré pour "${judgeId}".` };
  }

  room.votes.set(judgeId, { ...vote, judgeId, timestamp: Date.now() });

  const allIn = room.votes.size === 3;
  return { ok: true, room, allIn };
}

/**
 * Remet à zéro les votes d'une salle (nouveau round ou nouveau combat).
 */
function resetRoom(code) {
  const key = normalizeCode(code);
  const room = rooms.get(key);
  if (!room) return { ok: false, error: `Salle "${code}" introuvable.` };

  room.votes.clear();
  return { ok: true, room };
}

/**
 * Ferme et supprime une salle.
 */
function closeRoom(code) {
  const key = normalizeCode(code);
  const existed = rooms.delete(key);
  return { ok: existed, error: existed ? undefined : `Salle "${code}" introuvable.` };
}

/**
 * Retourne la salle associée à une WebSocket (host ou juge).
 * Utilisé pour nettoyer lors d'une déconnexion.
 */
function getRoomBySocket(ws) {
  for (const room of rooms.values()) {
    if (room.host === ws) return { room, role: 'host' };
    for (const [judgeId, judgeWs] of room.judges.entries()) {
      if (judgeWs === ws) return { room, role: 'judge', judgeId };
    }
  }
  return null;
}

/**
 * Retire un juge d'une salle (déconnexion).
 */
function removeJudge(room, judgeId) {
  room.judges.delete(judgeId);
}

// Normalise le code : majuscules, trim, supprime espaces multiples
function normalizeCode(code) {
  return String(code).trim().toUpperCase().replace(/\s+/g, ' ');
}

module.exports = {
  createRoom,
  joinRoom,
  submitVote,
  resetRoom,
  closeRoom,
  getRoomBySocket,
  removeJudge,
};
