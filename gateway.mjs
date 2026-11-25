import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

const publicOrigin = process.env.PUBLIC_ORIGIN || 'https://moneytrailrun.github.io';
const port = Number(process.env.PORT || 10000);
const gamePort = Number(process.env.MONEYTRAIL_SOCKET_PORT || 43532);
const clientLimit = 48;
const game = spawn(process.env.GODOT_BIN || 'godot', [
  '--headless', '--main-pack', process.env.GAME_PACK || 'game/index.pck', '--', '--public-server',
], {
  env: { ...process.env, MONEYTRAIL_SOCKET_PORT: String(gamePort) },
  stdio: ['ignore', 'pipe', 'inherit'],
});

let ready = false;
let stopping = false;
const players = new Set();

createInterface({ input: game.stdout }).on('line', (line) => {
  console.log(line);
  if (line === `Money Trail public server ready on ${gamePort}`) ready = true;
});

const server = createServer({ maxHeaderSize: 8192, requestTimeout: 8000 }, (request, response) => {
  if (request.url !== '/healthz' || request.method !== 'GET') {
    response.writeHead(404).end();
    return;
  }
  if (request.headers.origin === publicOrigin) {
    response.setHeader('Access-Control-Allow-Origin', publicOrigin);
  }
  response.writeHead(ready ? 200 : 503, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  }).end(ready ? 'ready\n' : 'starting\n');
});

function deny(socket, status) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

server.on('upgrade', (request, socket, head) => {
  socket.on('error', () => socket.destroy());
  const headers = request.headers;
  if (request.method !== 'GET' || request.url !== '/play') {
    deny(socket, '404 Not Found');
    return;
  }
  if (headers.origin !== publicOrigin) {
    deny(socket, '403 Forbidden');
    return;
  }
  if (headers.upgrade?.toLowerCase() !== 'websocket' ||
      headers['sec-websocket-version'] !== '13' ||
      !/^[A-Za-z0-9+/]{22}==$/.test(headers['sec-websocket-key'] || '')) {
    deny(socket, '400 Bad Request');
    return;
  }
  if (!ready || players.size >= clientLimit) {
    deny(socket, '503 Service Unavailable');
    return;
  }

  socket.pause();
  socket.setNoDelay(true);
  const backend = connect({ host: '127.0.0.1', port: gamePort });
  players.add(socket);
  const close = () => {
    players.delete(socket);
    socket.destroy();
    backend.destroy();
  };
  socket.on('close', close);
  backend.on('close', close);
  backend.on('error', close);
  backend.setTimeout(4000, close);
  backend.on('connect', () => {
    backend.setTimeout(0);
    backend.setNoDelay(true);
    const handshake = [
      'GET /play HTTP/1.1',
      `Host: 127.0.0.1:${gamePort}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${headers['sec-websocket-key']}`,
    ];
    if (headers['sec-websocket-protocol']) {
      handshake.push(`Sec-WebSocket-Protocol: ${headers['sec-websocket-protocol']}`);
    }
    backend.write(handshake.join('\r\n') + '\r\n\r\n');
    if (head.length) backend.write(head);
    backend.pipe(socket).pipe(backend);
  });
});

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  ready = false;
  for (const player of players) player.destroy();
  server.close();
  game.kill();
  process.exitCode = code;
}

game.on('error', (error) => {
  console.error(error.message);
  shutdown(1);
});
game.on('exit', () => shutdown(1));
server.on('error', (error) => {
  console.error(error.message);
  shutdown(1);
});
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
server.listen(port, '0.0.0.0');
