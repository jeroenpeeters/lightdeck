#!/usr/bin/env node
// LR512 / Nicolaudie DasNet unicast probe.
//
// Sends the vendor's own PingDatagram (opcode 0x63) straight to the device by IP
// on UDP 2430 (and to the subnet broadcast), and also tries TCP 2430, then dumps
// whatever the device replies. Purpose: characterise the DasNet handshake from
// Linux directly, without broadcast discovery or the Android library.
//
// Packet layout (from libXHardwareLibrary, little-endian):
//   [0x00:8] device id (ASCII, e.g. "SIUDI10A")
//   [0x08:2] opcode        (Ping = 0x63, Nop = 0x64)
//   [0x0a:8] stamp (u64)
//   [0x12:2] 0
//   [0x14:2] total size = 0x16 + payloadLen
//   [0x16: ] payload
//
// Usage: node tools/lr512-probe.mjs [host] [id]
//   host default 192.168.68.150, id default "SIUDI10A"
import dgram from 'node:dgram';
import net from 'node:net';

const HOST = process.argv[2] || '192.168.68.150';
const ID = (process.argv[3] || 'SIUDI10A').slice(0, 8).padEnd(8, '\0');
const PORT = 2430;
const BROADCAST = HOST.replace(/\.\d+$/, '.255');

const hex = (b) => b.toString('hex').replace(/(..)/g, '$1 ').trim();
const ascii = (b) => Array.from(b).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('');
function dump(label, b) {
  console.log(`${label} (${b.length} bytes)`);
  for (let i = 0; i < b.length; i += 16) {
    const chunk = b.subarray(i, i + 16);
    console.log(`  ${i.toString(16).padStart(4, '0')}  ${hex(chunk).padEnd(48)}  ${ascii(chunk)}`);
  }
  if (b.length >= 10) {
    console.log(`  parsed: id="${ascii(b.subarray(0, 8))}" opcode=0x${b.readUInt16LE(8).toString(16)}`
      + (b.length >= 0x16 ? ` stamp=${b.readBigUInt64LE(0xa)} size=${b.readUInt16LE(0x14)}` : ''));
  }
}

function datagram(opcode, stamp = 0n, payload = Buffer.alloc(0)) {
  const buf = Buffer.alloc(0x16 + payload.length);
  buf.write(ID, 0, 'latin1');
  buf.writeUInt16LE(opcode, 8);
  buf.writeBigUInt64LE(BigInt(stamp), 0xa);
  buf.writeUInt16LE(0, 0x12);
  buf.writeUInt16LE(0x16 + payload.length, 0x14);
  payload.copy(buf, 0x16);
  return buf;
}

console.log(`Probing ${HOST} (id "${ascii(Buffer.from(ID, 'latin1'))}") on UDP/TCP ${PORT}`);
console.log(`Broadcast target ${BROADCAST}\n`);

// ---- UDP ----
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let udpReplies = 0;
udp.on('message', (msg, rinfo) => {
  udpReplies++;
  dump(`UDP reply from ${rinfo.address}:${rinfo.port}`, msg);
});
udp.on('error', (e) => console.log('UDP error:', e.message));
udp.bind(PORT, () => {
  try { udp.setBroadcast(true); } catch {}
  const attempts = [
    ['Ping 0x63 unicast', datagram(0x63, 1n), HOST],
    ['Nop  0x64 unicast', datagram(0x64, 2n), HOST],
    ['Ping 0x63 broadcast', datagram(0x63, 3n), BROADCAST],
  ];
  let i = 0;
  const sendNext = () => {
    if (i >= attempts.length) return;
    const [label, buf, dst] = attempts[i++];
    dump(`--> sending ${label} to ${dst}:${PORT}`, buf);
    udp.send(buf, PORT, dst, (e) => e && console.log('send err:', e.message));
    setTimeout(sendNext, 800);
  };
  sendNext();
});

// ---- TCP ----
setTimeout(() => {
  console.log(`\n--- TCP ${HOST}:${PORT} ---`);
  const sock = net.connect({ host: HOST, port: PORT }, () => {
    const buf = datagram(0x63, 10n);
    dump('--> TCP send Ping 0x63', buf);
    sock.write(buf);
  });
  sock.setTimeout(3000);
  sock.on('data', (d) => dump('TCP reply', d));
  sock.on('timeout', () => { console.log('TCP: no reply within 3s'); sock.destroy(); });
  sock.on('error', (e) => console.log('TCP error:', e.message));
  sock.on('close', () => finish());
}, 3000);

function finish() {
  setTimeout(() => {
    console.log(`\nDone. UDP replies received: ${udpReplies}.`);
    try { udp.close(); } catch {}
    process.exit(0);
  }, 500);
}
setTimeout(finish, 9000);
