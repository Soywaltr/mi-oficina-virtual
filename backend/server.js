const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const players = {}; 

io.on('connection', (socket) => {
  console.log(`🟢 Conectado al servidor: ${socket.id}`);

  socket.on('joinOffice', (userData) => {
    console.log(`👤 ${userData.userName} ha entrado a la oficina.`);
    players[socket.id] = {
      playerId: socket.id,
      x: 300, y: 300,
      direction: 'down',
      currentAction: 'idle', // 🚨 ESTADO NUEVO: Qué está haciendo el jugador
      avatar: userData.avatar,
      userName: userData.userName, 
      peerId: userData.peerId 
    };

    socket.emit('currentPlayers', players);
    socket.broadcast.emit('newPlayer', players[socket.id]);
  });

  socket.on('playerMovement', (movementData) => {
    if (players[socket.id]) {
      players[socket.id].x = movementData.x;
      players[socket.id].y = movementData.y;
      players[socket.id].direction = movementData.direction;
      players[socket.id].currentAction = movementData.currentAction; // 🚨 Sincronizar la acción
      players[socket.id].avatar = movementData.avatar;
      socket.broadcast.emit('playerMoved', players[socket.id]);
    }
  });

  socket.on('estadoCamara', (estado) => socket.broadcast.emit('actualizarCamara', { playerId: socket.id, videoHabilitado: estado }));
  socket.on('chatMessage', (msg) => io.emit('chatMessage', { playerId: socket.id, msg }));
  socket.on('reaction', (emoji) => io.emit('reaction', { playerId: socket.id, emoji }));

  socket.on('disconnect', () => {
    console.log(`🔴 Desconectado: ${socket.id}`);
    const peerId = players[socket.id]?.peerId;
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id); 
    if (peerId) io.emit('peerDisconnected', peerId); 
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => { console.log(`🚀 Motor backend escuchando en puerto ${PORT}`); });