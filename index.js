const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

app.get('/client', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client.html')));
app.get('/taxi', (req, res) => res.sendFile(path.join(__dirname, 'public', 'taxi.html')));
app.get('/inscription-client', (req, res) => res.sendFile(path.join(__dirname, 'public', 'inscription-client.html')));
app.get('/inscription-taxi', (req, res) => res.sendFile(path.join(__dirname, 'public', 'inscription-taxi.html')));

const taxis = {};
const clients = {};

io.on('connection', (socket) => {

  socket.on('taxi-position', (data) => {
    if (taxis[socket.id]) {
      taxis[socket.id] = { ...taxis[socket.id], ...data };
    } else {
      taxis[socket.id] = { ...data, id: socket.id };
    }
    io.emit('update-taxis', Object.values(taxis));
  });

  socket.on('taxi-profil', (data) => {
    taxis[socket.id] = { ...data, id: socket.id };
    io.emit('update-taxis', Object.values(taxis));
  });

  socket.on('client-position', (data) => {
    if (clients[socket.id]) {
      clients[socket.id] = { ...clients[socket.id], ...data };
    } else {
      clients[socket.id] = { ...data, id: socket.id };
    }
    io.emit('update-clients', Object.values(clients));
  });

  socket.on('client-profil', (data) => {
    clients[socket.id] = { ...data, id: socket.id };
    io.emit('update-clients', Object.values(clients));
  });

  socket.on('client-demande-taxi', (data) => {
    io.emit('nouvelle-demande', {
      ...data,
      clientId: socket.id,
      nom: clients[socket.id]?.nom || 'Client',
      whatsapp: clients[socket.id]?.whatsapp || ''
    });
  });

  socket.on('taxi-accepte', (data) => {
    const taxi = taxis[socket.id];
    io.to(data.clientId).emit('taxi-en-route', {
      taxiId: socket.id,
      nom: taxi?.nom || 'Chauffeur',
      whatsapp: taxi?.whatsapp || ''
    });
  });

  socket.on('disconnect', () => {
    delete taxis[socket.id];
    delete clients[socket.id];
    io.emit('update-taxis', Object.values(taxis));
    io.emit('update-clients', Object.values(clients));
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('Yala démarré sur port ' + PORT));