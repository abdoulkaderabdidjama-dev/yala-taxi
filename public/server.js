const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'yalatxi-secret-2024';
const PORT = process.env.PORT || 3000;

// ─── BASE DE DONNÉES EN MÉMOIRE ────────────────────────────────────────────
// (Remplace par SQLite ou MongoDB en production)

const db = {
  users: [],       // { id, nom, whatsapp, role, password_hash, plaque, note, note_count }
  sessions: [],    // { userId, token }
  drivers: {},     // { userId → { lat, lng, statut:'libre'|'occupé', socketId } }
  clients: {},     // { userId → { lat, lng, socketId, courseId } }
  courses: [],     // { id, clientId, chauffeurId, statut, createdAt, acceptedAt }
};

let nextId = 1;

// ─── HELPERS ──────────────────────────────────────────────────────────────

function genId() { return String(nextId++); }

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}

function hasCourseActive(userId) {
  return db.courses.some(c =>
    (c.clientId === userId || c.chauffeurId === userId) &&
    ['en_attente', 'acceptée'].includes(c.statut)
  );
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
    Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─── AUTH ──────────────────────────────────────────────────────────────────

// Inscription
app.post('/api/inscription', async (req, res) => {
  const { nom, whatsapp, role, password, plaque } = req.body;

  if (!nom || !whatsapp || !role || !password)
    return res.status(400).json({ error: 'Champs manquants' });

  if (!['client', 'chauffeur'].includes(role))
    return res.status(400).json({ error: 'Rôle invalide' });

  if (db.users.find(u => u.whatsapp === whatsapp))
    return res.status(409).json({ error: 'Ce numéro WhatsApp est déjà utilisé' });

  if (role === 'chauffeur' && !plaque)
    return res.status(400).json({ error: 'Plaque requise pour les chauffeurs' });

  const password_hash = await bcrypt.hash(password, 10);
  const user = { id: genId(), nom, whatsapp, role, password_hash, plaque: plaque || null, note: 5.0, note_count: 0 };
  db.users.push(user);

  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, nom, whatsapp, role, plaque, note: 5.0 } });
});

// Connexion
app.post('/api/connexion', async (req, res) => {
  const { whatsapp, password } = req.body;
  const user = db.users.find(u => u.whatsapp === whatsapp);

  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Mot de passe incorrect' });

  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, nom: user.nom, whatsapp: user.whatsapp, role: user.role, plaque: user.plaque, note: user.note } });
});

// ─── CHAUFFEURS ────────────────────────────────────────────────────────────

// Mettre à jour position + statut chauffeur
app.post('/api/chauffeur/position', authMiddleware, (req, res) => {
  if (req.user.role !== 'chauffeur')
    return res.status(403).json({ error: 'Accès réservé aux chauffeurs' });

  const { lat, lng, statut } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'Position requise' });

  db.drivers[req.user.id] = {
    ...db.drivers[req.user.id],
    lat, lng,
    statut: statut || db.drivers[req.user.id]?.statut || 'libre',
    socketId: db.drivers[req.user.id]?.socketId || null,
    userId: req.user.id,
  };

  // Notifier les clients qui cherchent
  io.emit('drivers_updated', getDriversList());
  res.json({ ok: true });
});

// Changer statut (libre / hors-ligne)
app.post('/api/chauffeur/statut', authMiddleware, (req, res) => {
  if (req.user.role !== 'chauffeur')
    return res.status(403).json({ error: 'Accès réservé aux chauffeurs' });

  const { statut } = req.body;
  if (!['libre', 'occupé', 'hors_ligne'].includes(statut))
    return res.status(400).json({ error: 'Statut invalide' });

  if (hasCourseActive(req.user.id) && statut === 'hors_ligne')
    return res.status(409).json({ error: 'Vous avez une course en cours, terminez-la d\'abord' });

  if (!db.drivers[req.user.id])
    db.drivers[req.user.id] = { userId: req.user.id, lat: null, lng: null, socketId: null };

  db.drivers[req.user.id].statut = statut;
  io.emit('drivers_updated', getDriversList());
  res.json({ ok: true, statut });
});

// Liste des chauffeurs libres (filtrée par distance)
function getDriversList(clientLat, clientLng, maxKm = 5) {
  return Object.entries(db.drivers)
    .filter(([id, d]) => d.statut === 'libre' && d.lat && d.lng)
    .map(([id, d]) => {
      const user = db.users.find(u => u.id === id);
      const dist = clientLat && clientLng ? distanceKm(clientLat, clientLng, d.lat, d.lng) : null;
      return {
        id,
        nom: user?.nom,
        whatsapp: user?.whatsapp,
        plaque: user?.plaque,
        note: user?.note,
        lat: d.lat,
        lng: d.lng,
        distanceKm: dist ? Math.round(dist * 10) / 10 : null,
      };
    })
    .filter(d => !clientLat || !d.distanceKm || d.distanceKm <= maxKm)
    .sort((a, b) => (a.distanceKm || 999) - (b.distanceKm || 999));
}

app.get('/api/chauffeurs', authMiddleware, (req, res) => {
  const { lat, lng } = req.query;
  res.json(getDriversList(parseFloat(lat), parseFloat(lng)));
});

// ─── COURSES ───────────────────────────────────────────────────────────────

// Client demande une course
app.post('/api/course/demander', authMiddleware, (req, res) => {
  if (req.user.role !== 'client')
    return res.status(403).json({ error: 'Réservé aux clients' });

  if (hasCourseActive(req.user.id))
    return res.status(409).json({ error: 'Vous avez déjà une course en cours. Terminez-la avant d\'en demander une autre.' });

  const { chauffeurId, lat, lng } = req.body;
  if (!chauffeurId) return res.status(400).json({ error: 'Chauffeur requis' });

  const driver = db.drivers[chauffeurId];
  if (!driver || driver.statut !== 'libre')
    return res.status(409).json({ error: 'Ce chauffeur n\'est plus disponible' });

  const course = {
    id: genId(),
    clientId: req.user.id,
    chauffeurId,
    statut: 'en_attente',
    createdAt: new Date().toISOString(),
    acceptedAt: null,
    clientLat: lat,
    clientLng: lng,
  };
  db.courses.push(course);

  // Bloquer le chauffeur immédiatement
  db.drivers[chauffeurId].statut = 'occupé';

  // Notifier le chauffeur via socket
  const chauffeurSocket = db.drivers[chauffeurId]?.socketId;
  if (chauffeurSocket) {
    const clientUser = db.users.find(u => u.id === req.user.id);
    io.to(chauffeurSocket).emit('nouvelle_demande', {
      courseId: course.id,
      client: { id: req.user.id, nom: clientUser?.nom, whatsapp: clientUser?.whatsapp, lat, lng },
    });
  }

  io.emit('drivers_updated', getDriversList());
  res.json({ courseId: course.id, statut: 'en_attente' });
});

// Chauffeur accepte ou refuse
app.post('/api/course/repondre', authMiddleware, (req, res) => {
  if (req.user.role !== 'chauffeur')
    return res.status(403).json({ error: 'Réservé aux chauffeurs' });

  const { courseId, decision } = req.body; // decision: 'accepter' | 'refuser'
  const course = db.courses.find(c => c.id === courseId && c.chauffeurId === req.user.id);

  if (!course) return res.status(404).json({ error: 'Course introuvable' });
  if (course.statut !== 'en_attente') return res.status(409).json({ error: 'Course déjà traitée' });

  if (decision === 'accepter') {
    course.statut = 'acceptée';
    course.acceptedAt = new Date().toISOString();

    const chauffeurUser = db.users.find(u => u.id === req.user.id);
    const clientSocket = db.clients[course.clientId]?.socketId;
    if (clientSocket) {
      io.to(clientSocket).emit('course_acceptée', {
        courseId,
        chauffeur: { nom: chauffeurUser?.nom, whatsapp: chauffeurUser?.whatsapp, plaque: chauffeurUser?.plaque },
      });
    }
  } else {
    course.statut = 'refusée';
    db.drivers[req.user.id].statut = 'libre';
    const clientSocket = db.clients[course.clientId]?.socketId;
    if (clientSocket) io.to(clientSocket).emit('course_refusée', { courseId });
    io.emit('drivers_updated', getDriversList());
  }

  res.json({ ok: true, statut: course.statut });
});

// Annuler une course (client ou chauffeur)
app.post('/api/course/annuler', authMiddleware, (req, res) => {
  const { courseId } = req.body;
  const userId = req.user.id;

  const course = db.courses.find(c =>
    c.id === courseId &&
    (c.clientId === userId || c.chauffeurId === userId) &&
    ['en_attente', 'acceptée'].includes(c.statut)
  );

  if (!course) return res.status(404).json({ error: 'Course introuvable ou déjà terminée' });

  // Délai d'annulation : 2 minutes max après acceptation pour le client
  if (req.user.role === 'client' && course.statut === 'acceptée') {
    const elapsed = (Date.now() - new Date(course.acceptedAt).getTime()) / 1000 / 60;
    if (elapsed > 2) {
      return res.status(409).json({ error: 'Délai d\'annulation dépassé (2 min). Contactez le chauffeur sur WhatsApp.' });
    }
  }

  course.statut = 'annulée';

  // Libérer le chauffeur
  if (db.drivers[course.chauffeurId]) db.drivers[course.chauffeurId].statut = 'libre';

  // Notifier l'autre partie
  if (req.user.role === 'client') {
    const chauffeurSocket = db.drivers[course.chauffeurId]?.socketId;
    if (chauffeurSocket) io.to(chauffeurSocket).emit('course_annulée', { courseId, par: 'client' });
  } else {
    const clientSocket = db.clients[course.clientId]?.socketId;
    if (clientSocket) io.to(clientSocket).emit('course_annulée', { courseId, par: 'chauffeur' });
  }

  io.emit('drivers_updated', getDriversList());
  res.json({ ok: true });
});

// Terminer une course (chauffeur uniquement)
app.post('/api/course/terminer', authMiddleware, (req, res) => {
  if (req.user.role !== 'chauffeur')
    return res.status(403).json({ error: 'Réservé aux chauffeurs' });

  const { courseId } = req.body;
  const course = db.courses.find(c => c.id === courseId && c.chauffeurId === req.user.id && c.statut === 'acceptée');
  if (!course) return res.status(404).json({ error: 'Course introuvable' });

  course.statut = 'terminée';
  course.finishedAt = new Date().toISOString();

  // Libérer le chauffeur
  db.drivers[req.user.id].statut = 'libre';

  // Notifier le client
  const clientSocket = db.clients[course.clientId]?.socketId;
  if (clientSocket) io.to(clientSocket).emit('course_terminée', { courseId });

  io.emit('drivers_updated', getDriversList());
  res.json({ ok: true });
});

// Historique des courses
app.get('/api/mes-courses', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const courses = db.courses
    .filter(c => c.clientId === userId || c.chauffeurId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20)
    .map(c => {
      const client = db.users.find(u => u.id === c.clientId);
      const chauffeur = db.users.find(u => u.id === c.chauffeurId);
      return { ...c, clientNom: client?.nom, chauffeurNom: chauffeur?.nom, chauffeurWhatsapp: chauffeur?.whatsapp };
    });
  res.json(courses);
});

// ─── SOCKETS TEMPS RÉEL ────────────────────────────────────────────────────

io.on('connection', (socket) => {
  // Enregistrer socket selon rôle
  socket.on('register', ({ userId, role }) => {
    if (role === 'chauffeur') {
      if (!db.drivers[userId]) db.drivers[userId] = { userId, lat: null, lng: null, statut: 'hors_ligne' };
      db.drivers[userId].socketId = socket.id;
    } else {
      if (!db.clients[userId]) db.clients[userId] = { userId, lat: null, lng: null };
      db.clients[userId].socketId = socket.id;
    }
  });

  // Mise à jour position en temps réel
  socket.on('position_update', ({ userId, lat, lng, role }) => {
    if (role === 'chauffeur' && db.drivers[userId]) {
      db.drivers[userId].lat = lat;
      db.drivers[userId].lng = lng;
      io.emit('drivers_updated', getDriversList());
    } else if (role === 'client' && db.clients[userId]) {
      db.clients[userId].lat = lat;
      db.clients[userId].lng = lng;
    }
  });

  socket.on('disconnect', () => {
    // Mettre le chauffeur hors ligne si déconnecté
    for (const [id, d] of Object.entries(db.drivers)) {
      if (d.socketId === socket.id) {
        if (d.statut !== 'occupé') d.statut = 'hors_ligne';
        d.socketId = null;
        io.emit('drivers_updated', getDriversList());
        break;
      }
    }
    // Nettoyer socket client
    for (const [id, c] of Object.entries(db.clients)) {
      if (c.socketId === socket.id) { c.socketId = null; break; }
    }
  });
});

// ─── DÉMARRAGE ─────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`✅ YalaTaxi server running on port ${PORT}`);
});
