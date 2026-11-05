// NexusForge Relay Server
// Cloud-hosted WebSocket relay — no port forwarding required for players.
// Deploy to Render, Railway, Fly.io, etc. Clients connect via wss://.

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

const rooms = new Map();
const roomState = new Map();

const ROASTS = [
  "Wow, you missed that shot. Impressive.",
  "Your connection is faster than your reflexes.",
  "This room misses you when you're not here. Just kidding, it doesn't.",
  "Are you playing Pong or just waving at the ball?",
  "Even the AI would have blocked that. You didn't.",
  "Your paddle is basically a suggestion at this point.",
  "I've seen rocks with better reaction time.",
  "Congratulations, you found a new way to lose.",
  "The ball is not your friend. Stop ignoring it.",
  "Your score is so low it looped back to impressive."
];

function genId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
}

function send(ws, packet) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(packet));
}

function broadcast(room, packet, excludeId) {
  const roomClients = rooms.get(room);
  if (!roomClients) return;
  const data = JSON.stringify(packet);
  for (const [id, client] of roomClients) {
    if (id === excludeId) continue;
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}

function getRoomSnapshot(room) {
  const st = roomState.get(room);
  if (!st) return null;
  return {
    ballPos: st.ballPos,
    paddleA: st.paddleA,
    paddleB: st.paddleB,
    scoreA: st.scoreA,
    scoreB: st.scoreB,
    objects: st.objects || []
  };
}

function saveRoomSnapshot(room) {
  const st = getRoomSnapshot(room);
  if (!st) return;
  try {
    const dir = path.join(__dirname, 'snapshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, room + '.json'), JSON.stringify(st, null, 2));
  } catch (e) {
    console.error('[NexusForge] snapshot save failed', e.message);
  }
}

function initRoomState(room) {
  if (!roomState.has(room)) {
    roomState.set(room, {
      ballPos: [0, 0, 0],
      paddleA: 0,
      paddleB: 0,
      scoreA: 0,
      scoreB: 0,
      objects: []
    });
  }
}

const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const id = genId();
  console.log('[NexusForge] client connected', id);
  let currentRoom = null;
  let roastTimer = null;

  function scheduleRoast() {
    roastTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN && currentRoom) {
        const roast = ROASTS[Math.floor(Math.random() * ROASTS.length)];
        send(ws, { t: 'roast', roastText: roast, room: currentRoom });
      }
      scheduleRoast();
    }, 30000 + Math.random() * 30000);
  }
  scheduleRoast();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }

    const { t, room, user } = msg;

    if (t === 'join') {
      if (!room) {
        send(ws, { t: 'error', error: 'room required' });
        return;
      }
      if (!rooms.has(room)) rooms.set(room, new Map());
      const roomClients = rooms.get(room);
      roomClients.set(id, { ws, user: user || 'Anonymous' });
      currentRoom = room;

      initRoomState(room);

      const users = [];
      for (const [uid, c] of roomClients) {
        users.push({ id: uid, user: c.user });
      }
      const snap = getRoomSnapshot(room);
      send(ws, {
        t: 'joined',
        id,
        room,
        users,
        snapshot: snap ? JSON.stringify(snap) : ''
      });

      broadcast(room, { t: 'user_joined', id, user: user || 'Anonymous' }, id);
      return;
    }

    if (!currentRoom) {
      send(ws, { t: 'error', error: 'not in a room' });
      return;
    }

    msg.id = id;

    switch (t) {
      case 'transform':
      case 'spawn':
      case 'destroy':
      case 'rpc':
      case 'chat':
        broadcast(currentRoom, msg, id);
        break;

      case 'pong_state': {
        const st = roomState.get(currentRoom);
        if (st) {
          if (msg.pos) st.ballPos = msg.pos;
          if (msg.scoreA !== undefined) st.scoreA = msg.scoreA;
          if (msg.scoreB !== undefined) st.scoreB = msg.scoreB;
          if (msg.paddleA !== undefined) st.paddleA = msg.paddleA;
          if (msg.paddleB !== undefined) st.paddleB = msg.paddleB;
        }
        broadcast(currentRoom, msg, id);
        saveRoomSnapshot(currentRoom);
        break;
      }

      case 'pong_input':
        broadcast(currentRoom, msg, id);
        break;

      case 'roast':
        broadcast(currentRoom, msg, id);
        break;

      case 'session_save':
        send(ws, { t: 'session_save', snapshot: msg.snapshot, id });
        break;

      case 'leave':
      default:
        break;
    }
  });

  ws.on('close', () => {
    if (roastTimer) clearTimeout(roastTimer);
    for (const [r, rc] of rooms) {
      if (rc.has(id)) {
        const user = rc.get(id).user;
        rc.delete(id);
        broadcast(r, { t: 'user_left', id, user }, id);
        saveRoomSnapshot(r);
        if (rc.size === 0) rooms.delete(r);
        break;
      }
    }
    console.log('[NexusForge] client disconnected', id);
  });

  ws.on('error', (e) => {
    console.error('[NexusForge] socket error', e.message);
  });
});

server.listen(PORT, () => {
  console.log('[NexusForge] relay listening on port ' + PORT);
});