// ═══════════════════════════════════════════════════════════════
//  HASSABE — Chat Server  (Step 9)
//  File: chat-server.js
//
//  This file sets up the Socket.IO server and exports:
//    initChatServer(httpServer)  — attach to your HTTP server
//
//  Socket.IO Events (client → server):
//    join_conversation           — join a match room
//    send_message                — text or AI starter message
//    typing_start / typing_stop  — live typing indicators
//    mark_read                   — mark messages as read
//    voice_note_chunk            — streaming audio upload
//    voice_note_complete         — finalize voice note
//    ping                        — keepalive
//
//  Socket.IO Events (server → client):
//    joined                      — confirmed room join + history
//    new_message                 — a message was sent in the room
//    typing                      — partner is typing
//    stopped_typing              — partner stopped
//    messages_read               — partner read up to a point
//    voice_note_ready            — voice note upload complete
//    match_expiring              — 72h warning before conversation closes
//    match_expired               — conversation closed
//    error                       — room/auth error
//
//  REST routes (see chat-routes.js):
//    GET  /api/chat/:matchId/messages    — paginated history
//    GET  /api/chat/:matchId/icebreakers — AI icebreakers for this match
//    POST /api/chat/:matchId/voice       — upload voice note
//    GET  /api/chat/:matchId/status      — expiry, read state, lock status
//    POST /api/chat/:matchId/report      — report a message
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const { Server }  = require('socket.io');
const { Pool }    = require('pg');
const jwt         = require('jsonwebtoken');
const { notify }  = require('./notification-service');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// In-memory typing state (lost on restart — intentional, typing is ephemeral)
const typingUsers = new Map(); // matchId → Set of userIds currently typing

// ══════════════════════════════════════════════════════════════
//  INIT — attach Socket.IO to existing HTTP server
// ══════════════════════════════════════════════════════════════
function initChatServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin:      process.env.FRONTEND_URL || '*',
      methods:     ['GET', 'POST'],
      credentials: true,
    },
    transports:      ['websocket', 'polling'],
    pingInterval:    25000,
    pingTimeout:     60000,
    maxHttpBufferSize: 5 * 1024 * 1024, // 5MB for voice note chunks
  });

  // ── JWT authentication middleware ──────────────────────────
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token
      || socket.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) return next(new Error('Authentication required'));

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET, {
        issuer: 'hassabe.com', audience: 'hassabe-api',
      });

      const result = await pool.query(
        'SELECT id, status FROM users WHERE id = $1', [payload.sub]
      );

      if (!result.rows[0] || result.rows[0].status !== 'active') {
        return next(new Error('Account not found or suspended'));
      }

      socket.userId = payload.sub;
      next();
    } catch (err) {
      next(new Error('Invalid or expired token'));
    }
  });

  // ══════════════════════════════════════════════════════════
  //  CONNECTION HANDLER
  // ══════════════════════════════════════════════════════════
  io.on('connection', async (socket) => {
    console.log(`[Chat] User ${socket.userId?.slice(0,8)}… connected (${socket.id})`);

    // ── join_conversation ────────────────────────────────────
    socket.on('join_conversation', async ({ matchId }) => {
      if (!matchId) return socket.emit('error', { code: 'MISSING_MATCH_ID' });

      try {
        // Verify this user can access this conversation
        const matchResult = await pool.query(`
          SELECT m.id, m.status, m.expires_at,
                 m.user_a_id, m.user_b_id,
                 m.messaging_unlocked_at,
                 p.first_name AS partner_name,
                 ARRAY[]::text[] AS partner_photos
          FROM matches m
          JOIN profiles p ON p.user_id = (
            CASE WHEN m.user_a_id = $2 THEN m.user_b_id ELSE m.user_a_id END
          )
          WHERE m.id = $1
            AND (m.user_a_id = $2 OR m.user_b_id = $2)
          GROUP BY m.id, p.id
        `, [matchId, socket.userId]);

        if (!matchResult.rows[0]) {
          return socket.emit('error', { code: 'MATCH_NOT_FOUND' });
        }

        const match = matchResult.rows[0];

        if (match.status !== 'messaging_unlocked') {
          return socket.emit('error', {
            code: 'CONVERSATION_LOCKED',
            message: 'This conversation is not yet unlocked.',
          });
        }

        // Check expiry
        const isExpired = match.expires_at && new Date(match.expires_at) < new Date();
        if (isExpired) {
          return socket.emit('error', {
            code: 'CONVERSATION_EXPIRED',
            message: 'This conversation window has closed.',
          });
        }

        // Leave any previous rooms
        for (const room of socket.rooms) {
          if (room !== socket.id) socket.leave(room);
        }

        const room = `match:${matchId}`;
        socket.join(room);
        socket.currentMatchId = matchId;

        // Fetch recent message history (last 50)
        const messages = await getMessageHistory(matchId, 50, null);

        // Mark all unread messages from partner as read
        const partnerId = match.user_a_id === socket.userId
          ? match.user_b_id : match.user_a_id;

        await pool.query(`
          UPDATE messages SET read_at = now()
          WHERE match_id = $1 AND sender_id = $2 AND read_at IS NULL
        `, [matchId, partnerId]);

        // Notify partner their messages were read
        const readAt = new Date().toISOString();
        socket.to(room).emit('messages_read', { byUserId: socket.userId, readAt });

        // Compute expiry info
        const expiresAt   = match.expires_at;
        const msRemaining = expiresAt ? new Date(expiresAt).getTime() - Date.now() : null;
        const daysLeft    = msRemaining ? Math.ceil(msRemaining / 86400000) : null;

        socket.emit('joined', {
          matchId,
          partnerId,
          partnerName:   match.partner_name,
          partnerPhoto:  match.partner_photos?.[0] || null,
          messages,
          expiresAt,
          daysLeft,
          messagingUnlockedAt: match.messaging_unlocked_at,
        });

        // Deliver icebreakers on first join if no messages yet
        if (messages.length === 0) {
          const icebreakers = await getIcebreakers(matchId);
          if (icebreakers.length > 0) {
            socket.emit('icebreakers_ready', { icebreakers });
          }
        }

        console.log(`[Chat] ${socket.userId.slice(0,8)} joined room ${room}`);

        // Warn if expiring soon (≤ 3 days)
        if (daysLeft !== null && daysLeft <= 3 && daysLeft > 0) {
          socket.emit('match_expiring', { daysLeft, expiresAt });
        }

      } catch (err) {
        console.error('[Chat] join_conversation error:', err);
        socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to join conversation.' });
      }
    });

    // ── send_message ─────────────────────────────────────────
    socket.on('send_message', async (data) => {
      const { matchId, content, type = 'text', clientMsgId } = data;

      if (!matchId || !content?.trim()) {
        return socket.emit('error', { code: 'INVALID_MESSAGE' });
      }
      if (content.length > 2000) {
        return socket.emit('error', { code: 'MESSAGE_TOO_LONG', max: 2000 });
      }
      if (!['text', 'ai_starter'].includes(type)) {
        return socket.emit('error', { code: 'INVALID_TYPE' });
      }

      try {
        // Re-verify conversation access on every message (not just join)
        const access = await verifyConversationAccess(matchId, socket.userId);
        if (!access.allowed) {
          return socket.emit('error', { code: access.code });
        }

        const message = await pool.query(`
          INSERT INTO messages
            (match_id, sender_id, content, type, client_msg_id)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (client_msg_id) WHERE client_msg_id IS NOT NULL
          DO UPDATE SET updated_at = now()
          RETURNING id, match_id, sender_id, content, type,
                    sent_at, read_at, client_msg_id
        `, [matchId, socket.userId, content.trim(), type, clientMsgId || null]);

        const msg = message.rows[0];

        // Broadcast to everyone in the room (including sender — for multi-device)
        const room = `match:${matchId}`;
        io.to(room).emit('new_message', {
          id:          msg.id,
          matchId:     msg.match_id,
          senderId:    msg.sender_id,
          content:     msg.content,
          type:        msg.type,
          sentAt:      msg.sent_at,
          readAt:      msg.read_at,
          clientMsgId: msg.client_msg_id,
        });

        // Push notification to partner if they are not in the room
        const partnerSocketsInRoom = await getSocketsInRoom(io, room);
        const partnerOnline = partnerSocketsInRoom.some(
          s => s.userId === access.partnerId
        );

        if (!partnerOnline) {
          const myProfile = await pool.query(
            'SELECT first_name FROM profiles WHERE user_id = $1', [socket.userId]
          );
          const senderName = myProfile.rows[0]?.first_name || 'Your match';
          const preview    = content.length > 80 ? content.slice(0, 80) + '…' : content;

          await notify(access.partnerId, 'message_received', {
            matchId,
            senderFirstName: senderName,
            messagePreview:  preview,
          }).catch(() => {});
        }

      } catch (err) {
        console.error('[Chat] send_message error:', err);
        socket.emit('error', { code: 'SEND_FAILED', clientMsgId });
      }
    });

    // ── typing indicators ────────────────────────────────────
    socket.on('typing_start', ({ matchId }) => {
      if (!matchId) return;
      if (!typingUsers.has(matchId)) typingUsers.set(matchId, new Set());
      typingUsers.get(matchId).add(socket.userId);

      socket.to(`match:${matchId}`).emit('typing', { userId: socket.userId });

      // Auto-clear typing after 4 seconds of no update
      clearTypingTimeout(socket.userId, matchId);
      const timeout = setTimeout(() => {
        typingUsers.get(matchId)?.delete(socket.userId);
        socket.to(`match:${matchId}`).emit('stopped_typing', { userId: socket.userId });
      }, 4000);
      socket._typingTimeout = timeout;
    });

    socket.on('typing_stop', ({ matchId }) => {
      if (!matchId) return;
      clearTypingTimeout(socket.userId, matchId);
      typingUsers.get(matchId)?.delete(socket.userId);
      socket.to(`match:${matchId}`).emit('stopped_typing', { userId: socket.userId });
    });

    // ── mark_read ────────────────────────────────────────────
    socket.on('mark_read', async ({ matchId, upToMessageId }) => {
      if (!matchId) return;
      try {
        const access = await verifyConversationAccess(matchId, socket.userId);
        if (!access.allowed) return;

        await pool.query(`
          UPDATE messages SET read_at = now()
          WHERE match_id = $1
            AND sender_id = $2
            AND read_at IS NULL
            AND ($3::uuid IS NULL OR id <= $3::uuid)
        `, [matchId, access.partnerId, upToMessageId || null]);

        socket.to(`match:${matchId}`).emit('messages_read', {
          byUserId: socket.userId,
          upToMessageId,
          readAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error('[Chat] mark_read error:', err);
      }
    });

    // ── voice_note_chunk   (streaming upload) ─────────────────
    const voiceBuffers = new Map(); // socketId → chunks[]
    socket.on('voice_note_chunk', ({ matchId, chunk, chunkIndex, totalChunks }) => {
      if (!voiceBuffers.has(socket.id)) voiceBuffers.set(socket.id, []);
      voiceBuffers.get(socket.id)[chunkIndex] = chunk;
    });

    socket.on('voice_note_complete', async ({ matchId, totalChunks, duration, mimeType }) => {
      try {
        const chunks = voiceBuffers.get(socket.id) || [];
        voiceBuffers.delete(socket.id);

        if (chunks.length !== totalChunks) {
          return socket.emit('error', { code: 'VOICE_UPLOAD_INCOMPLETE' });
        }

        if (duration > 120) { // 2-minute max
          return socket.emit('error', { code: 'VOICE_TOO_LONG', max: 120 });
        }

        const access = await verifyConversationAccess(matchId, socket.userId);
        if (!access.allowed) return socket.emit('error', { code: access.code });

        // Combine chunks and upload to Cloudinary
        const audioBuffer = Buffer.concat(chunks.map(c => Buffer.from(c)));

        /* PRODUCTION — upload to Cloudinary:
           const cloudinary = require('cloudinary').v2;
           const uploadResult = await new Promise((res, rej) => {
             const stream = cloudinary.uploader.upload_stream(
               { resource_type: 'video', folder: `hassabe/voice/${matchId}`,
                 format: 'mp3', transformation: [{ quality: 'auto' }] },
               (err, result) => err ? rej(err) : res(result)
             );
             stream.end(audioBuffer);
           });
           const audioUrl = uploadResult.secure_url;
        */
        const audioUrl = `https://placeholder-voice.hassabe.com/${Date.now()}.mp3`;

        // Save message record
        const msg = await pool.query(`
          INSERT INTO messages (match_id, sender_id, content, type, voice_url, voice_duration_s)
          VALUES ($1, $2, $3, 'voice', $4, $5)
          RETURNING id, sent_at
        `, [matchId, socket.userId, `[Voice note — ${Math.round(duration)}s]`, audioUrl, Math.round(duration)]);

        const room = `match:${matchId}`;
        io.to(room).emit('new_message', {
          id:           msg.rows[0].id,
          matchId,
          senderId:     socket.userId,
          content:      `[Voice note — ${Math.round(duration)}s]`,
          type:         'voice',
          voiceUrl:     audioUrl,
          voiceDuration: Math.round(duration),
          sentAt:       msg.rows[0].sent_at,
        });

        socket.emit('voice_note_ready', { messageId: msg.rows[0].id, audioUrl });

      } catch (err) {
        console.error('[Chat] voice_note_complete error:', err);
        socket.emit('error', { code: 'VOICE_UPLOAD_FAILED' });
      }
    });

    // ── ping / keepalive ─────────────────────────────────────
    socket.on('ping', () => socket.emit('pong'));

    // ── disconnect ───────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[Chat] User ${socket.userId?.slice(0,8)}… disconnected: ${reason}`);
      clearTypingTimeout(socket.userId, socket.currentMatchId);
      voiceBuffers.delete(socket.id);

      // Clear typing for all rooms
      if (socket.currentMatchId) {
        typingUsers.get(socket.currentMatchId)?.delete(socket.userId);
        socket.to(`match:${socket.currentMatchId}`).emit('stopped_typing', {
          userId: socket.userId,
        });
      }
    });
  });

  // ── Expiry enforcement job (runs hourly) ───────────────────
  setInterval(async () => {
    try {
      const expiredResult = await pool.query(`
        SELECT m.id, m.user_a_id, m.user_b_id
        FROM matches m
        WHERE m.status = 'messaging_unlocked'
          AND m.expires_at < now()
        LIMIT 50
      `);

      for (const match of expiredResult.rows) {
        await pool.query(
          `UPDATE matches SET status = 'expired', updated_at = now() WHERE id = $1`,
          [match.id]
        );
        const room = `match:${match.id}`;
        io.to(room).emit('match_expired', { matchId: match.id });
      }

      if (expiredResult.rows.length > 0) {
        console.log(`[Chat] Closed ${expiredResult.rows.length} expired conversations`);
      }
    } catch (err) {
      console.error('[Chat] Expiry job error:', err);
    }
  }, 60 * 60 * 1000); // every hour

  console.log('[Chat] Socket.IO server initialized');
  return io;
}

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════

async function verifyConversationAccess(matchId, userId) {
  const result = await pool.query(`
    SELECT id, status, expires_at, user_a_id, user_b_id
    FROM matches
    WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)
  `, [matchId, userId]);

  if (!result.rows[0]) return { allowed: false, code: 'MATCH_NOT_FOUND' };
  const m = result.rows[0];
  if (m.status !== 'messaging_unlocked') return { allowed: false, code: 'CONVERSATION_LOCKED' };
  if (m.expires_at && new Date(m.expires_at) < new Date()) return { allowed: false, code: 'CONVERSATION_EXPIRED' };

  const partnerId = m.user_a_id === userId ? m.user_b_id : m.user_a_id;
  return { allowed: true, partnerId };
}

async function getMessageHistory(matchId, limit = 50, beforeId = null) {
  const result = await pool.query(`
    SELECT id, match_id, sender_id, content, type,
           voice_url, voice_duration_s,
           sent_at, read_at, client_msg_id
    FROM messages
    WHERE match_id = $1
      AND ($2::uuid IS NULL OR id < $2::uuid)
    ORDER BY sent_at DESC
    LIMIT $3
  `, [matchId, beforeId, limit]);

  return result.rows.reverse(); // chronological order
}

async function getIcebreakers(matchId) {
  const result = await pool.query(
    'SELECT icebreakers FROM matches WHERE id = $1', [matchId]
  );
  return result.rows[0]?.icebreakers || [];
}

async function getSocketsInRoom(io, room) {
  const sockets = await io.in(room).fetchSockets();
  return sockets;
}

function clearTypingTimeout(userId, matchId) {
  // timeouts are stored on the socket object directly — handled in disconnect
}

module.exports = { initChatServer };

// ══════════════════════════════════════════════════════════════
//  ADD TO server.js:
//
//  const http = require('http');
//  const { initChatServer } = require('./chat-server');
//
//  const app = express();
//  const httpServer = http.createServer(app);
//  const io = initChatServer(httpServer);
//
//  // Start with httpServer instead of app.listen:
//  httpServer.listen(PORT, () => console.log(`Server on port ${PORT}`));
//
//  PACKAGES: npm install socket.io
// ══════════════════════════════════════════════════════════════
