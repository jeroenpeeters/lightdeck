// A bridge in its own process: takes frames over a WebSocket and records when each arrived (wall clock, ms).
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const [, , port, out, firstChannel = '1', lastChannel = '43'] = process.argv;
const a = Number(firstChannel), b = Number(lastChannel);
const wall = () => performance.timeOrigin + performance.now();
const frames = [];
const server = createServer((socket) => {
  let buffer = Buffer.alloc(0); let upgraded = false;
  socket.setNoDelay(true);
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    const at = wall();
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      const key = /sec-websocket-key:\s*(.+)\r\n/i.exec(buffer.toString('latin1'))[1].trim();
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const status = Buffer.from('{"type":"status","device":"open","universes":2,"channels":[512,0]}');
      socket.write(Buffer.concat([Buffer.from([0x81, status.length]), status]));
      buffer = buffer.subarray(end + 4); upgraded = true;
    }
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f; const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f; let offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      const maskOffset = offset; if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskOffset + (i & 3)];
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x2) frames.push({ t: at, universe: payload[0], ch: Array.from(payload.subarray(1 + a - 1, 1 + b)) });
    }
  });
});
server.listen(Number(port), '127.0.0.1', () => console.log('recorder listening'));
const finish = () => { writeFileSync(out, JSON.stringify({ firstChannel: a, frames })); process.exit(0); };
process.on('SIGTERM', finish); process.on('SIGINT', finish);
