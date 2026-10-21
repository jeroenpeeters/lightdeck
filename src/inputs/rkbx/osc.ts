/**
 * Open Sound Control 1.0, the part that rkbx_link speaks: messages with the argument types
 * i, f, s, d, h, T, F, N, I, b and t, alone in a datagram or in bundles. Pure: bytes in,
 * messages out, no sockets, so it can be tested without a network.
 */

export type OscArg = number | string | boolean | null | Uint8Array;

export interface OscMessage {
  address: string;
  args: OscArg[];
}

/** A packet that is not OSC, or is cut short. */
export class OscError extends Error {}

/** Bundles inside bundles are legal; this many levels is far more than anything sends. */
const MAX_BUNDLE_DEPTH = 8;
const BUNDLE_TAG = '#bundle';

/** The messages of a packet. A bundle is flattened; its time tag is not used. */
export function parseOsc(packet: Uint8Array): OscMessage[] {
  const bytes = Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength);
  const messages: OscMessage[] = [];
  readPacket(bytes, messages, 0);
  return messages;
}

function readPacket(bytes: Buffer, into: OscMessage[], depth: number): void {
  if (bytes.length > 0 && bytes[0] === 0x23) {
    // '#': a bundle. 8 bytes of tag, 8 of time, then elements with a size in front.
    if (depth >= MAX_BUNDLE_DEPTH) throw new OscError('bundles are nested too deeply');
    if (bytes.length < 16 || bytes.toString('latin1', 0, BUNDLE_TAG.length) !== BUNDLE_TAG) {
      throw new OscError('not a bundle');
    }
    let at = 16;
    while (at < bytes.length) {
      if (at + 4 > bytes.length) throw new OscError('bundle element cut short');
      const size = bytes.readInt32BE(at);
      at += 4;
      if (size < 0 || at + size > bytes.length) throw new OscError('bundle element cut short');
      readPacket(bytes.subarray(at, at + size), into, depth + 1);
      at += size;
    }
    return;
  }
  into.push(readMessage(bytes));
}

function readMessage(bytes: Buffer): OscMessage {
  const cursor = { at: 0 };
  const address = readString(bytes, cursor);
  if (!address.startsWith('/')) throw new OscError(`address does not start with /: "${address}"`);

  // Very old senders leave the type tags out; there is nothing to read then.
  if (cursor.at >= bytes.length) return { address, args: [] };
  const tags = readString(bytes, cursor);
  if (!tags.startsWith(',')) throw new OscError('type tags do not start with a comma');

  const args: OscArg[] = [];
  for (const tag of tags.slice(1)) {
    switch (tag) {
      case 'i':
        args.push(take(bytes, cursor, 4).readInt32BE(0));
        break;
      case 'f':
        args.push(take(bytes, cursor, 4).readFloatBE(0));
        break;
      case 'd':
        args.push(take(bytes, cursor, 8).readDoubleBE(0));
        break;
      case 'h':
        args.push(Number(take(bytes, cursor, 8).readBigInt64BE(0)));
        break;
      case 't':
        args.push(Number(take(bytes, cursor, 8).readBigUInt64BE(0)));
        break;
      case 's':
        args.push(readString(bytes, cursor));
        break;
      case 'b': {
        const size = take(bytes, cursor, 4).readInt32BE(0);
        if (size < 0) throw new OscError('negative blob size');
        const blob = take(bytes, cursor, size);
        cursor.at += padding(size);
        args.push(new Uint8Array(blob));
        break;
      }
      case 'T':
        args.push(true);
        break;
      case 'F':
        args.push(false);
        break;
      case 'N':
        args.push(null);
        break;
      case 'I':
        args.push(true);
        break;
      default:
        throw new OscError(`unknown argument type "${tag}"`);
    }
  }
  return { address, args };
}

/** Bytes needed to bring a length up to a multiple of four. */
function padding(length: number): number {
  return (4 - (length % 4)) % 4;
}

function take(bytes: Buffer, cursor: { at: number }, length: number): Buffer {
  if (cursor.at + length > bytes.length) throw new OscError('message cut short');
  const part = bytes.subarray(cursor.at, cursor.at + length);
  cursor.at += length;
  return part;
}

/** A string ends in a zero byte, and the whole is padded with zeros to a multiple of four. */
function readString(bytes: Buffer, cursor: { at: number }): string {
  const end = bytes.indexOf(0, cursor.at);
  if (end < 0) throw new OscError('string without an end');
  const text = bytes.toString('utf8', cursor.at, end);
  const used = end - cursor.at + 1;
  cursor.at += used + padding(used);
  if (cursor.at > bytes.length) throw new OscError('message cut short');
  return text;
}

/**
 * A message as bytes. Numbers go as float32 (the way rkbx_link sends bpm), unless they are
 * written `{ int: n }`. For tests and stand-ins; lightdeck itself only receives.
 */
export function encodeOsc(message: {
  address: string;
  args: (OscArg | { int: number })[];
}): Buffer {
  const parts: Buffer[] = [];
  const text = (value: string): Buffer => {
    const raw = Buffer.from(`${value}\0`, 'utf8');
    return Buffer.concat([raw, Buffer.alloc(padding(raw.length))]);
  };
  parts.push(text(message.address));
  let tags = ',';
  const data: Buffer[] = [];
  for (const arg of message.args) {
    if (typeof arg === 'number') {
      tags += 'f';
      const b = Buffer.alloc(4);
      b.writeFloatBE(arg);
      data.push(b);
    } else if (typeof arg === 'string') {
      tags += 's';
      data.push(text(arg));
    } else if (typeof arg === 'boolean') {
      tags += arg ? 'T' : 'F';
    } else if (arg === null) {
      tags += 'N';
    } else if (arg instanceof Uint8Array) {
      tags += 'b';
      const size = Buffer.alloc(4);
      size.writeInt32BE(arg.length);
      data.push(size, Buffer.from(arg), Buffer.alloc(padding(arg.length)));
    } else {
      tags += 'i';
      const b = Buffer.alloc(4);
      b.writeInt32BE(arg.int);
      data.push(b);
    }
  }
  parts.push(text(tags), ...data);
  return Buffer.concat(parts);
}
