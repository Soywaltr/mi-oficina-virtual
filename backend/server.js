const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// 1. Defensas básicas y configuración de JSON
app.use(helmet()); 
app.use(cors());
app.use(express.json()); // Necesario para leer el JSON del login

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- RUTA DE LOGIN SEGURA ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 5, 
  message: "Demasiados intentos. Inténtalo de nuevo en 15 minutos."
});

// Función placeholder: Aquí debes conectar tu Base de Datos real
async function findUser(username) {
  // EJEMPLO: return await User.findOne({ username });
  // Por ahora esto devolverá null, debes implementar tu lógica de DB aquí
  return null; 
}

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  
  const user = await findUser(username); 
  if (!user) return res.status(401).json({ error: "Credenciales inválidas" });

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) return res.status(401).json({ error: "Credenciales inválidas" });

  // Asegúrate de tener JWT_SECRET en las variables de entorno de Render
  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET || 'clave_temporal_segura', { expiresIn: '1h' });
  
  res.json({ token });
});
// ----------------------------

const players = {}; 

io.on('connection', (socket) => {
  console.log(`🟢 Conectado al servidor: ${socket.id}`);

  socket.on('joinOffice', (userData) => {
    console.log(`👤 ${userData.userName} ha entrado a la oficina.`);
    players[socket.id] = {
      playerId: socket.id,
      x: 300, y: 300,
      direction: 'down',
      currentAction: 'idle',
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
      players[socket.id].currentAction = movementData.currentAction;
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