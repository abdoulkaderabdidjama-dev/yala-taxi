const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ✅ fonction distance corrigée
function distance(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;

  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;

  const x = dLat;
  const y = dLng * Math.cos((lat1 + lat2) / 2);

  return Math.sqrt(x * x + y * y) * R;
}

// ✅ stockage des courses
const courses = {};

app.use(express.json());
app.use(express.static('public'));

app.get('/client', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client.html')));
app.get('/taxi', (req, res) => res.sendFile(path.join(__dirname, 'public', 'taxi.html')));
app.get('/inscription-client', (req, res) => res.sendFile(path.join(__dirname, 'public', 'inscription-client.html')));
app.get('/inscription-taxi', (req, res) => res.sendFile(path.join(__dirname, 'public', 'inscription-taxi.html')));

const taxis = {};
const clients = {};

io.on('connection', (socket) => {

  // ✅ POSITION TAXI
  socket.on('taxi-position', (data) => {
    taxis[socket.id] = { ...taxis[socket.id], ...data, id: socket.id };
    io.emit('update-taxis', Object.values(taxis));
  });

  // ✅ PROFIL TAXI
  socket.on('taxi-profil', (data) => {
    taxis[socket.id] = { ...data, id: socket.id };
  });

  // ✅ POSITION CLIENT
  socket.on('client-position', (data) => {
    clients[socket.id] = { ...clients[socket.id], ...data, id: socket.id };
  });

  // ✅ PROFIL CLIENT
  socket.on('client-profil', (data) => {
    clients[socket.id] = { ...data, id: socket.id };
  });

  // ✅ DEMANDE TAXI (AVEC FILTRE PROXIMITÉ + COURSE)
  socket.on('client-demande-taxi', (data) => {
    const clientId = socket.id;

    // ✅ enregistrer course
    courses[clientId] = {
      status: "en_attente",
      taxiId: null
    };

    const client = clients[clientId];

    // ✅ envoyer seulement aux taxis proches
    Object.values(taxis).forEach(taxi => {
      if (!taxi.lat || !taxi.lng) return;

      const dist = distance(
        { lat: taxi.lat, lng: taxi.lng },
        { lat: data.lat, lng: data.lng }
      );

      if (dist < 2) { // 2 km
        io.to(taxi.id).emit('nouvelle-demande', {
          clientId,
          lat: data.lat,
          lng: data.lng,
          nom: client?.nom || 'Client',
          whatsapp: client?.whatsapp || ''
        });
      }
    });
  });

  // ✅ TAXI ACCEPTE (VERROUILLAGE)
  socket.on('taxi-accepte', (data) => {
    const course = courses[data.clientId];
    if (!course) return;

    if (course.status === "en_attente") {
      course.status = "acceptee";
      course.taxiId = socket.id;

      const taxi = taxis[socket.id];

      io.to(data.clientId).emit('taxi-en-route', {
        taxiId: socket.id,
        nom: taxi?.nom || 'Chauffeur',
        whatsapp: taxi?.whatsapp || ''
      });

      // ✅ annuler pour autres taxis
      Object.values(taxis).forEach(taxi => {
        if (taxi.id !== socket.id) {
          io.to(taxi.id).emit('course-annulee', data.clientId);
        }
      });
    }
  });

  // ✅ DECONNEXION
  socket.on('disconnect', () => {
    delete taxis[socket.id];
    delete clients[socket.id];
    delete courses[socket.id];

    io.emit('update-taxis', Object.values(taxis));
    io.emit('update-clients', Object.values(clients));
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('Yala démarré sur port ' + PORT));
