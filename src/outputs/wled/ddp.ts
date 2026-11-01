/**
 * DDP, the way lightdeck sends pixels straight to a strip of WLED over UDP (Jeroen, 2026-10-31:
 * "let us render all the effects ourselves from lightdeck"), without Home Assistant between.
 *
 * A frame is the RGB bytes of every pixel in a row. DDP has a header of 10 bytes and at most 1440 bytes
 * of pixels per packet, so up to 480 LEDs go in one packet and more LEDs in a few; the last packet
 * carries the push flag, which makes WLED show the frame. WLED takes DDP on UDP port 4048 whenever it
 * hears it (a realtime source) and goes back to its own state a moment after the packets stop (its
 * "realtime timeout", 2.5 s by default), so nothing is left on a strip when lightdeck stops.
 *
 * Header, as WLED reads it: byte 0 `0x40` (version 1) plus `0x01` for push, byte 1 a sequence number of
 * 1 to 15, byte 2 the data type (0, RGB), byte 3 the destination (1, the display), bytes 4 to 7 the
 * offset in bytes and bytes 8 and 9 the number of bytes, both big-endian.
 *
 * Nothing here knows an effect or a tempo: it sends the bytes it is given, and says how many went.
 */

import { createSocket, type Socket } from 'node:dgram';

export const DDP_PORT = 4048;
/** The most bytes of pixels in one packet: 480 RGB pixels, under the size of an Ethernet frame. */
export const DDP_MAX_PAYLOAD = 1440;
const HEADER = 10;
const VERSION_1 = 0x40;
const PUSH = 0x01;

/** What a datagram socket does for us, so that a test can listen instead. */
export interface DatagramLike {
  send(data: Uint8Array, port: number, host: string, done?: (error: Error | null) => void): void;
  close(): void;
  on?(event: 'error', listener: (error: Error) => void): unknown;
}

export interface DdpOptions {
  host: string;
  port?: number;
  /** A socket to send with. Tests pass their own. */
  socket?: DatagramLike;
}

/** The packets of one frame, as bytes, for a row of `pixels` (RGB, three bytes each) and a sequence number. */
export function ddpPackets(pixels: Uint8Array, sequence: number): Uint8Array[] {
  const packets: Uint8Array[] = [];
  const number = (sequence % 15) + 1;
  for (let offset = 0; offset < pixels.length || offset === 0; offset += DDP_MAX_PAYLOAD) {
    const length = Math.min(DDP_MAX_PAYLOAD, pixels.length - offset);
    const last = offset + length >= pixels.length;
    const packet = new Uint8Array(HEADER + length);
    const view = new DataView(packet.buffer);
    packet[0] = VERSION_1 | (last ? PUSH : 0);
    packet[1] = number;
    packet[2] = 0;
    packet[3] = 1;
    view.setUint32(4, offset);
    view.setUint16(8, length);
    packet.set(pixels.subarray(offset, offset + length), HEADER);
    packets.push(packet);
    if (pixels.length === 0) break;
  }
  return packets;
}

/** Sends frames of pixels to one strip. */
export class DdpSender {
  private readonly socket: DatagramLike;
  private readonly host: string;
  private readonly port: number;
  private sequence = 0;
  /** Frames handed to the socket, the packets they made, the bytes, and the sends that failed. */
  frames = 0;
  packets = 0;
  bytes = 0;
  errors = 0;
  /** The last error the socket gave, for the log. */
  lastError: string | undefined;

  constructor(options: DdpOptions) {
    this.host = options.host;
    this.port = options.port ?? DDP_PORT;
    this.socket = options.socket ?? (createSocket('udp4') as Socket);
    // A socket that fails must not take lightdeck with it: UDP has no connection to lose.
    this.socket.on?.('error', (error) => this.failed(error));
  }

  /** Sends one frame: the RGB bytes of the whole row. */
  send(pixels: Uint8Array): void {
    this.frames++;
    for (const packet of ddpPackets(pixels, this.sequence)) {
      this.packets++;
      this.bytes += packet.length;
      this.socket.send(packet, this.port, this.host, (error) => {
        if (error) this.failed(error);
      });
    }
    this.sequence = (this.sequence + 1) % 15;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }

  private failed(error: Error): void {
    this.errors++;
    this.lastError = error.message;
  }
}
