/**
 * server.js
 * Serveur WebSocket JJContact Judge App.
 *
 * Protocole de messages (JSON) :
 *
 * CLIENT → SERVEUR
 * ─────────────────────────────────────────────────────────
 * { type: "CREATE_FIGHT", code, fighters: [string, string] }
 * { type: "RESET_FIGHT",  code }
 * { type: "CLOSE_FIGHT",  code }
 * { type: "JOIN",         code, judgeId }
 * { type: "SUBMIT_VOTE",  code, judgeId, vote: { method, winner, scoresA, scoresB } }
 *
 * SERVEUR → CLIENT
 * ─────────────────────────────────────────────────────────
 * { type: "FIGHT_CREATED",  code, fighters }
 * { type: "JOINED",         judgeId, fighters, judgeCount }
 * { type: "VOTE_RECEIVED",  judgeId, vote, voteCount }
 * { type: "ALL_VOTES_IN",   votes: [ {judgeId, vote}, ... ] }
 * { type: "FIGHT_RESET",    fighters }
 * { type: "JUDGE_JOINED",   judgeId, judgeCount }   (notif au host)
 * { type: "JUDGE_LEFT",     judgeId }               (notif au host)
 * { type: "ERROR",          message }
 */

const { WebSocketServer } = require('ws');
const {
  createRoom, joinRoom, submitVote,
  resetRoom, closeRoom, getRoomBySocket, removeJudge,
} = require('./rooms');

const PORT = process.env.PORT || 8080;

const wss = new WebSocketServer({ port: PORT });

console.log(`[server] JJContact WebSocket server démarré sur le port ${PORT}`);

// ─── Helpers ────────────────────────────────────────────────────────────────

function send(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(clients, payload) {
  for (const ws of clients) send(ws, payload);
}

// ─── Connexion ───────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { type: 'ERROR', message: 'Message JSON invalide.' });
    }

    handleMessage(ws, msg);
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', (err) => console.error('[ws] Erreur socket :', err.message));
});

// ─── Heartbeat (détection connexions zombies) ────────────────────────────────

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log('[server] Socket zombie détectée — fermeture.');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on('close', () => clearInterval(heartbeatInterval));

// ─── Routage des messages ────────────────────────────────────────────────────

function handleMessage(ws, msg) {
  const { type } = msg;

  switch (type) {

    // ── Responsable : créer un combat ────────────────────────────────────────
    case 'CREATE_FIGHT': {
      const { code, fighters } = msg;

      const { fmt } = msg;
      if (!code || !Array.isArray(fighters) || fighters.length !== 2) {
        return send(ws, { type: 'ERROR', message: 'CREATE_FIGHT : code et fighters[2] requis.' });
      }

      const result = createRoom(code, ws, fighters);
      if (!result.ok) {
        return send(ws, { type: 'ERROR', message: result.error });
      }
      // Stocker le format dans la salle
      result.room && (result.room.fmt = fmt || 'std');

      console.log(`[server] Salle créée : "${code.toUpperCase()}" | ${fighters[0]} vs ${fighters[1]} | fmt:${fmt||'std'}`);
      send(ws, { type: 'FIGHT_CREATED', code: code.toUpperCase(), fighters, fmt: fmt || 'std' });
      break;
    }

    // ── Responsable : ouvrir le vote (signal aux juges) ─────────────────────
    case 'START_VOTING': {
      const foundSV = getRoomBySocket(ws);
      if (!foundSV || foundSV.role !== 'host') {
        return send(ws, { type: 'ERROR', message: 'START_VOTING : hôte non reconnu.' });
      }
      const roomSV = foundSV.room;
      console.log(`[server] START_VOTING sur "${roomSV.code}" — ${roomSV.judges.size} juge(s)`);
      broadcast(roomSV.judges.values(), {
        type: 'START_VOTING',
        fighters: msg.fighters || roomSV.fighters,
        fmt: msg.fmt || 'std',
      });
      break;
    }

    // ── Responsable : lancer la prolongation ─────────────────────────────────
    case 'START_OVERTIME': {
      const foundOT = getRoomBySocket(ws);
      if (!foundOT || foundOT.role !== 'host') {
        return send(ws, { type: 'ERROR', message: 'START_OVERTIME : hôte non reconnu.' });
      }
      const roomOT = foundOT.room;
      console.log(`[server] START_OVERTIME sur "${roomOT.code}"`);
      broadcast(roomOT.judges.values(), {
        type: 'OVERTIME',
        fighters: roomOT.fighters,
        fmt: msg.fmt || 'std',
      });
      break;
    }

    // ── Responsable : remettre à zéro ────────────────────────────────────────
    case 'RESET_FIGHT': {
      const { code } = msg;
      const result = resetRoom(code);
      if (!result.ok) {
        return send(ws, { type: 'ERROR', message: result.error });
      }

      const { room } = result;
      console.log(`[server] Salle "${code.toUpperCase()}" réinitialisée.`);

      // Notifier les juges connectés
      broadcast(room.judges.values(), { type: 'FIGHT_RESET', fighters: room.fighters });
      send(ws, { type: 'FIGHT_RESET', fighters: room.fighters });
      break;
    }

    // ── Responsable : fermer le combat ───────────────────────────────────────
    case 'CLOSE_FIGHT': {
      const { code } = msg;
      const result = closeRoom(code);
      if (!result.ok) {
        return send(ws, { type: 'ERROR', message: result.error });
      }
      console.log(`[server] Salle "${code.toUpperCase()}" fermée.`);
      break;
    }

    // ── Juge : rejoindre une salle ───────────────────────────────────────────
    case 'JOIN': {
      const { code, judgeId } = msg;

      if (!code || !judgeId) {
        return send(ws, { type: 'ERROR', message: 'JOIN : code et judgeId requis.' });
      }

      const result = joinRoom(code, judgeId, ws);
      if (!result.ok) {
        return send(ws, { type: 'ERROR', message: result.error });
      }

      const { room } = result;
      const judgeCount = room.judges.size;

      console.log(`[server] ${judgeId} a rejoint "${code.toUpperCase()}" (${judgeCount}/3 juges)`);

      // Confirmer au juge
      send(ws, {
        type: 'JOINED',
        judgeId,
        fighters: room.fighters,
        fmt: room.fmt || 'std',
        judgeCount,
      });

      // Notifier le responsable
      send(room.host, { type: 'JUDGE_JOINED', judgeId, judgeCount });
      break;
    }

    // ── Juge : soumettre son vote ─────────────────────────────────────────────
    case 'SUBMIT_VOTE': {
      const { code, judgeId, vote } = msg;

      if (!code || !judgeId || !vote) {
        return send(ws, { type: 'ERROR', message: 'SUBMIT_VOTE : code, judgeId et vote requis.' });
      }

      const result = submitVote(code, judgeId, vote);
      if (!result.ok) {
        return send(ws, { type: 'ERROR', message: result.error });
      }

      const { room, allIn } = result;
      const voteCount = room.votes.size;

      console.log(`[server] Vote reçu de ${judgeId} sur "${code.toUpperCase()}" (${voteCount}/3)`);

      // Confirmer au juge
      send(ws, { type: 'VOTE_CONFIRMED', judgeId });

      // Envoyer le vote au responsable
      send(room.host, { type: 'VOTE_RECEIVED', judgeId, vote, voteCount });

      // Si les 3 votes sont là → envoyer le paquet complet au responsable
      if (allIn) {
        const allVotes = Array.from(room.votes.values());
        send(room.host, { type: 'ALL_VOTES_IN', votes: allVotes });
        console.log(`[server] Tous les votes reçus pour "${code.toUpperCase()}".`);
      }
      break;
    }

    default:
      send(ws, { type: 'ERROR', message: `Type de message inconnu : "${type}".` });
  }
}

// ─── Déconnexion ─────────────────────────────────────────────────────────────

function handleDisconnect(ws) {
  const found = getRoomBySocket(ws);
  if (!found) return;

  const { room, role, judgeId } = found;

  if (role === 'host') {
    // Le responsable s'est déconnecté : notifier les juges
    console.log(`[server] Responsable déconnecté — salle "${room.code}" orpheline.`);
    broadcast(room.judges.values(), {
      type: 'ERROR',
      message: 'Le responsable de table s\'est déconnecté.',
    });
    closeRoom(room.code);
  } else {
    // Un juge s'est déconnecté
    console.log(`[server] ${judgeId} déconnecté de "${room.code}".`);
    removeJudge(room, judgeId);
    send(room.host, { type: 'JUDGE_LEFT', judgeId });
  }
}
