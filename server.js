const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
require('./server-icons')(app);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'yalatxi-secret-2024';
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connecté'))
  .catch(err => console.error('❌ MongoDB erreur:', err));

const UserSchema = new mongoose.Schema({
  nom: { type: String, required: true },
  whatsapp: { type: String, required: true, unique: true },
  role: { type: String, enum: ['client', 'chauffeur'], required: true },
  password_hash: { type: String, required: true },
  plaque: { type: String, default: null },
  note: { type: Number, default: 5.0 },
  note_count: { type: Number, default: 0 },
}, { timestamps: true });

const CourseSchema = new mongoose.Schema({
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  chauffeurId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  statut: { type: String, enum: ['en_attente','acceptee','refusee','annulee','terminee'], default: 'en_attente' },
  clientLat: Number, clientLng: Number,
  acceptedAt: Date, finishedAt: Date,
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);
const Course = mongoose.model('Course', CourseSchema);

const drivers = {};
const clients = {};

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token invalide' }); }
}

async function hasCourseActive(userId) {
  return !!(await Course.findOne({
    $or: [{ clientId: userId }, { chauffeurId: userId }],
    statut: { $in: ['en_attente', 'acceptee'] }
  }));
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function getDriversList(clientLat, clientLng) {
  const freeIds = Object.entries(drivers).filter(([,d]) => d.statut==='libre' && d.lat && d.lng).map(([id])=>id);
  const users = await User.find({ _id: { $in: freeIds }, role: 'chauffeur' });
  return users.map(u => {
    const d = drivers[u._id.toString()];
    const dist = clientLat && clientLng ? distanceKm(clientLat, clientLng, d.lat, d.lng) : null;
    return { id: u._id.toString(), nom: u.nom, whatsapp: u.whatsapp, plaque: u.plaque, note: u.note, lat: d.lat, lng: d.lng, distanceKm: dist ? Math.round(dist*10)/10 : null };
  }).sort((a,b) => (a.distanceKm||999)-(b.distanceKm||999));
}

app.post('/api/inscription', async (req, res) => {
  const { nom, whatsapp, role, password, plaque } = req.body;
  if (!nom||!whatsapp||!role||!password) return res.status(400).json({ error: 'Champs manquants' });
  if (!['client','chauffeur'].includes(role)) return res.status(400).json({ error: 'Role invalide' });
  if (role==='chauffeur'&&!plaque) return res.status(400).json({ error: 'Plaque requise' });
  try {
    if (await User.findOne({ whatsapp })) return res.status(409).json({ error: 'Numero WhatsApp deja utilise' });
    const password_hash = await bcrypt.hash(password, 10);
    const user = await User.create({ nom, whatsapp, role, password_hash, plaque: plaque||null });
    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id.toString(), nom, whatsapp, role, plaque, note: 5.0 } });
  } catch(err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/connexion', async (req, res) => {
  const { whatsapp, password } = req.body;
  try {
    const user = await User.findOne({ whatsapp });
    if (!user) return res.status(404).json({ error: 'Numero WhatsApp introuvable' });
    if (!await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Mot de passe incorrect' });
    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id.toString(), nom: user.nom, whatsapp: user.whatsapp, role: user.role, plaque: user.plaque, note: user.note } });
  } catch(err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post("/api/reset-password", async (req, res) => {
  const { whatsapp, nouveau_password } = req.body;
  if (!whatsapp || !nouveau_password) return res.status(400).json({ error: "Champs requis" });
  if (nouveau_password.length < 6) return res.status(400).json({ error: "Mot de passe trop court" });
  try {
    const user = await User.findOne({ whatsapp });
    if (!user) return res.status(404).json({ error: "Compte introuvable" });
    user.password_hash = await bcrypt.hash(nouveau_password, 10);
    await user.save();
    res.json({ ok: true, message: "Mot de passe mis a jour !" });
  } catch(err) { res.status(500).json({ error: "Erreur serveur" }); }
});

app.post('/api/chauffeur/position', authMiddleware, async (req, res) => {
  if (req.user.role!=='chauffeur') return res.status(403).json({ error: 'Reserve aux chauffeurs' });
  const { lat, lng } = req.body;
  if (!lat||!lng) return res.status(400).json({ error: 'Position requise' });
  const id = req.user.id;
  if (!drivers[id]) drivers[id] = { statut: 'libre', socketId: null };
  drivers[id].lat = lat;
  drivers[id].lng = lng;
  if (!drivers[id].statut || drivers[id].statut === 'hors_ligne') {
    drivers[id].statut = 'libre';
  }
  io.emit('drivers_updated', await getDriversList());
  res.json({ ok: true });
});

app.post('/api/chauffeur/statut', authMiddleware, async (req, res) => {
  if (req.user.role!=='chauffeur') return res.status(403).json({ error: 'Reserve aux chauffeurs' });
  const { statut } = req.body;
  if (!['libre','occupe','hors_ligne'].includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
  const id = req.user.id;
  if (statut==='hors_ligne' && await hasCourseActive(id)) return res.status(409).json({ error: 'Terminez la course en cours' });
  if (!drivers[id]) drivers[id] = { lat: null, lng: null, socketId: null };
  drivers[id].statut = statut;
  io.emit('drivers_updated', await getDriversList());
  res.json({ ok: true, statut });
});

app.get('/api/chauffeurs', authMiddleware, async (req, res) => {
  const { lat, lng } = req.query;
  res.json(await getDriversList(parseFloat(lat), parseFloat(lng)));
});

app.post('/api/course/demander', authMiddleware, async (req, res) => {
  if (req.user.role!=='client') return res.status(403).json({ error: 'Reserve aux clients' });
  const clientId = req.user.id;
  if (await hasCourseActive(clientId)) return res.status(409).json({ error: 'Vous avez deja une course en cours' });
  const { chauffeurId, lat, lng } = req.body;
  if (!chauffeurId) return res.status(400).json({ error: 'Chauffeur requis' });
  const driver = drivers[chauffeurId];
  if (!driver||driver.statut!=='libre') return res.status(409).json({ error: 'Chauffeur non disponible' });
  try {
    const course = await Course.create({ clientId, chauffeurId, statut: 'en_attente', clientLat: lat, clientLng: lng });
    drivers[chauffeurId].statut = 'occupe';
    const clientUser = await User.findById(clientId);
    const chauffeurSocket = drivers[chauffeurId]?.socketId;
    if (chauffeurSocket) io.to(chauffeurSocket).emit('nouvelle_demande', {
      courseId: course._id.toString(),
      client: { id: clientId, nom: clientUser?.nom, whatsapp: clientUser?.whatsapp, lat, lng }
    });
    io.emit('drivers_updated', await getDriversList());
    res.json({ courseId: course._id.toString(), statut: 'en_attente' });
  } catch(err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/course/repondre', authMiddleware, async (req, res) => {
  if (req.user.role!=='chauffeur') return res.status(403).json({ error: 'Reserve aux chauffeurs' });
  const { courseId, decision } = req.body;
  try {
    const course = await Course.findOne({ _id: courseId, chauffeurId: req.user.id, statut: 'en_attente' });
    if (!course) return res.status(404).json({ error: 'Course introuvable' });
    if (decision==='accepter') {
      course.statut = 'acceptee'; course.acceptedAt = new Date(); await course.save();
      const chauffeurUser = await User.findById(req.user.id);
      const clientSocket = clients[course.clientId.toString()]?.socketId;
      // ✅ Notifier le client que le chauffeur a accepte
      if (clientSocket) io.to(clientSocket).emit('course_acceptee', {
        courseId: course._id.toString(),
        chauffeur: { nom: chauffeurUser?.nom, whatsapp: chauffeurUser?.whatsapp, plaque: chauffeurUser?.plaque }
      });
    } else {
      course.statut = 'refusee'; await course.save();
      if (drivers[req.user.id]) drivers[req.user.id].statut = 'libre';
      const clientSocket = clients[course.clientId.toString()]?.socketId;
      if (clientSocket) io.to(clientSocket).emit('course_refusee', { courseId });
      io.emit('drivers_updated', await getDriversList());
    }
    res.json({ ok: true, statut: course.statut });
  } catch(err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/course/annuler', authMiddleware, async (req, res) => {
  const { courseId } = req.body;
  try {
    const course = await Course.findOne({
      _id: courseId,
      $or: [{ clientId: req.user.id }, { chauffeurId: req.user.id }],
      statut: { $in: ['en_attente','acceptee'] }
    });
    if (!course) return res.status(404).json({ error: 'Course introuvable' });
    if (req.user.role==='client' && course.statut==='acceptee') {
      const elapsed = (Date.now() - new Date(course.acceptedAt).getTime()) / 60000;
      if (elapsed > 2) return res.status(409).json({ error: 'Delai annulation depasse (2 min). Contactez le chauffeur sur WhatsApp.' });
    }
    course.statut = 'annulee'; await course.save();
    const chauffeurId = course.chauffeurId.toString();
    if (drivers[chauffeurId]) drivers[chauffeurId].statut = 'libre';
    // ✅ Notifier les deux parties
    if (req.user.role==='client') {
      const s = drivers[chauffeurId]?.socketId;
      if (s) io.to(s).emit('course_annulee', { courseId, par: 'client' });
    } else {
      const s = clients[course.clientId.toString()]?.socketId;
      if (s) io.to(s).emit('course_annulee', { courseId, par: 'chauffeur' });
    }
    io.emit('drivers_updated', await getDriversList());
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/course/terminer', authMiddleware, async (req, res) => {
  if (req.user.role!=='chauffeur') return res.status(403).json({ error: 'Reserve aux chauffeurs' });
  const { courseId } = req.body;
  try {
    const course = await Course.findOne({ _id: courseId, chauffeurId: req.user.id, statut: 'acceptee' });
    if (!course) return res.status(404).json({ error: 'Course introuvable' });
    course.statut = 'terminee'; course.finishedAt = new Date(); await course.save();
    const chauffeurId = req.user.id;
    if (drivers[chauffeurId]) drivers[chauffeurId].statut = 'libre';
    const s = clients[course.clientId.toString()]?.socketId;
    if (s) io.to(s).emit('course_terminee', { courseId });
    io.emit('drivers_updated', await getDriversList());
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/mes-courses', authMiddleware, async (req, res) => {
  try {
    const courses = await Course.find({ $or: [{ clientId: req.user.id }, { chauffeurId: req.user.id }] })
      .sort({ createdAt: -1 }).limit(20)
      .populate('clientId', 'nom whatsapp')
      .populate('chauffeurId', 'nom whatsapp plaque');
    res.json(courses.map(c => ({
      id: c._id, statut: c.statut, createdAt: c.createdAt,
      clientNom: c.clientId?.nom, chauffeurNom: c.chauffeurId?.nom,
      chauffeurWhatsapp: c.chauffeurId?.whatsapp, plaque: c.chauffeurId?.plaque,
    })));
  } catch(err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

io.on('connection', (socket) => {
  socket.on('register', ({ userId, role }) => {
    if (role==='chauffeur') {
      if (!drivers[userId]) drivers[userId] = { lat: null, lng: null, statut: 'hors_ligne' };
      drivers[userId].socketId = socket.id;
    } else {
      if (!clients[userId]) clients[userId] = { lat: null, lng: null };
      clients[userId].socketId = socket.id;
    }
  });

  socket.on('position_update', async ({ userId, lat, lng, role }) => {
    if (role==='chauffeur') {
      if (!drivers[userId]) drivers[userId] = { statut: 'libre', socketId: null };
      drivers[userId].lat = lat;
      drivers[userId].lng = lng;
      if (!drivers[userId].statut || drivers[userId].statut === 'hors_ligne') {
        drivers[userId].statut = 'libre';
      }
      io.emit('drivers_updated', await getDriversList());
    } else if (role==='client' && clients[userId]) {
      clients[userId].lat = lat; clients[userId].lng = lng;
    }
  });

  socket.on('disconnect', async () => {
    for (const [id, d] of Object.entries(drivers)) {
      if (d.socketId===socket.id) {
        if (d.statut!=='occupe') d.statut = 'hors_ligne';
        d.socketId = null;
        io.emit('drivers_updated', await getDriversList());
        break;
      }
    }
    for (const [id, c] of Object.entries(clients)) {
      if (c.socketId===socket.id) { c.socketId = null; break; }
    }
  });
});

server.listen(PORT, () => console.log(`✅ YalaTaxi on port ${PORT}`));
