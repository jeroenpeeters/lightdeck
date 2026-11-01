/**
 * Plays an effect of the pipes on one strip of WLED over DDP, to see it and to hear what it needs
 * (Jeroen, 2026-10-31). No Home Assistant, no lightdeck server: it sends the pixels itself, at a tempo
 * given on the line, and measures how well that goes (frames sent, how late the timer was, how long a
 * frame took to make). When it stops, or on Ctrl-C, it sends black and stops: WLED goes back to what it
 * showed a moment later, by its own realtime timeout.
 *
 *   pnpm pipes 192.168.68.32 --effect shot --bpm 126 --colours '#00e5ff,#ff1fa8,#ff7a00'
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { readPaletteFields } from '../engine/palette.js';
import {
  findPipeEffect,
  PIPE_EFFECTS,
  type PipeColour,
  pipeColours,
  renderPipe,
  toBytes,
} from '../engine/pipeEffects.js';
import { DdpSender } from '../outputs/wled/ddp.js';

/**
 * The colours of the site of Dreamscape IV, The Alchemist's Shadow (dreamscapefestival.nl): the void of
 * the background, copper and amber, the cyan of verdigris, bone white and a rust red. Foreground,
 * background, accent, spare.
 */
const THEMES: Record<string, string[]> = {
  alchemist: ['#b8733d', '#2c6e78', '#d9a566', '#ece4d3'],
  verdigris: ['#4fd6e8', '#7a4d2a', '#ece4d3', '#d9a566'],
  transmutation: ['#d9a566', '#4fd6e8', '#ece4d3', '#b8733d'],
  rust: ['#e06a4a', '#2c6e78', '#d9a566', '#ece4d3'],
  bone: ['#ece4d3', '#5c2a1c', '#4fd6e8', '#b8733d'],
};

const USAGE = `usage: pnpm pipes <host> [options]

options:
  --effect <id>      ${PIPE_EFFECTS.map((effect) => effect.id).join(', ')} (default flow)
  --palette <id>     the colours of a palette of the show: slot 1 is the foreground, 2 the background, 3 an accent
  --show <file>      the show file to read the palette from (default show.yaml)
  --theme <name>     the colours of the festival: ${Object.keys(THEMES).join(', ')}
  --colours <list>   up to four colours as #rrggbb, comma separated: foreground, background, accent, spare
  --bpm <number>     tempo (default 126)
  --pace <number>    pace on top of the bpm: 0.25, 0.5, 1, 2 or 4 (default 1)
  --leds <number>    LEDs on the strip (default 300)
  --fps <number>     frames per second, 1 to 100 (default 40)
  --level <0..1>     brightness (default 1)
  --seconds <n>      how long to play (default 20, 0 is until Ctrl-C)
  --list             list the effects and exit`;

/** The colours of a palette of the show file, as the pipes show them. */
function showPalette(file: string, id: string): PipeColour[] {
  const data = parse(readFileSync(file, 'utf8')) as { palettes?: Record<string, unknown> } | null;
  const found = data?.palettes?.[id];
  if (!found) throw new Error(`${file} has no palette called "${id}"`);
  return pipeColours(readPaletteFields(found).colours);
}

function hex(value: string): PipeColour {
  const parsed = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
  if (!parsed) throw new Error(`"${value}" is not a colour like #00e5ff`);
  const [red = 0, green = 0, blue = 0] = parsed
    .slice(1)
    .map((part) => Number.parseInt(part, 16) / 255);
  return { red, green, blue };
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      effect: { type: 'string', default: 'flow' },
      colours: { type: 'string' },
      palette: { type: 'string' },
      show: { type: 'string', default: 'show.yaml' },
      theme: { type: 'string' },
      bpm: { type: 'string', default: '126' },
      pace: { type: 'string', default: '1' },
      leds: { type: 'string', default: '300' },
      fps: { type: 'string', default: '40' },
      level: { type: 'string', default: '1' },
      seconds: { type: 'string', default: '20' },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.list) {
    for (const effect of PIPE_EFFECTS) console.log(`${effect.id.padEnd(8)} ${effect.description}`);
    return;
  }
  const host = positionals[0];
  if (values.help || !host) {
    console.log(USAGE);
    process.exit(host || values.help ? 0 : 1);
  }
  const effect = findPipeEffect(values.effect ?? '');
  if (!effect) throw new Error(`no effect called "${values.effect}"`);
  let colours: PipeColour[];
  if (values.palette) colours = showPalette(values.show ?? 'show.yaml', values.palette);
  else if (values.theme) {
    const theme = THEMES[values.theme];
    if (!theme)
      throw new Error(`no theme called "${values.theme}", try ${Object.keys(THEMES).join(', ')}`);
    colours = theme.map(hex);
  } else
    colours = (values.colours ?? '#00e5ff,#ff1fa8,#ff7a00')
      .split(',')
      .filter(Boolean)
      .slice(0, 4)
      .map(hex);
  if (colours.length === 0) throw new Error('give at least one colour');
  const bpm = Number(values.bpm);
  const pace = Number(values.pace);
  const leds = Math.round(Number(values.leds));
  const fps = Math.round(Number(values.fps));
  const level = Number(values.level);
  const seconds = Number(values.seconds);
  if (!(bpm >= 30 && bpm <= 300)) throw new Error('bpm must be from 30 to 300');
  if (![0.25, 0.5, 1, 2, 4].includes(pace)) throw new Error('pace must be 0.25, 0.5, 1, 2 or 4');
  if (!(leds >= 1 && leds <= 2000)) throw new Error('leds must be from 1 to 2000');
  if (!(fps >= 1 && fps <= 100)) throw new Error('fps must be from 1 to 100');

  const sender = new DdpSender({ host });
  const picture = new Float32Array(leds * 3);
  const bytes = new Uint8Array(leds * 3);
  const started = performance.now();
  let next = started;
  let frames = 0;
  let late = 0;
  let lateMax = 0;
  let renderTotal = 0;
  let renderMax = 0;
  let stopping = false;

  const frame = () => {
    const now = performance.now();
    const elapsed = (now - started) / 1000;
    if (stopping || (seconds > 0 && elapsed >= seconds)) return finish();
    const behind = now - next;
    late += Math.max(0, behind);
    lateMax = Math.max(lateMax, behind);
    const t0 = performance.now();
    // Beat one of the bar is the start; a real tempo would say where it is.
    renderPipe(effect, (elapsed * bpm) / 60, bpm, pace, leds, colours, picture);
    toBytes(picture, level, bytes);
    sender.send(bytes);
    const took = performance.now() - t0;
    renderTotal += took;
    renderMax = Math.max(renderMax, took);
    frames++;
    next += 1000 / fps;
    // A timer that fell far behind does not try to catch up with a burst: it starts over from now.
    if (next < performance.now() - 250) next = performance.now();
    setTimeout(frame, Math.max(0, next - performance.now()));
  };

  const finish = () => {
    // Black for a moment, then let go: WLED shows its own state again after its realtime timeout.
    bytes.fill(0);
    for (let i = 0; i < 3; i++) sender.send(bytes);
    const total = (performance.now() - started) / 1000;
    console.log(
      [
        `${effect.id} on ${host}: ${leds} LEDs, ${bpm} bpm, pace ${pace}, ${fps} fps wanted`,
        `frames ${frames} in ${total.toFixed(1)} s = ${(frames / total).toFixed(1)} per second`,
        `packets ${sender.packets}, ${(sender.bytes / total / 1024).toFixed(1)} KiB/s, send errors ${sender.errors}${sender.lastError ? ` (${sender.lastError})` : ''}`,
        `making a frame: ${(renderTotal / Math.max(1, frames)).toFixed(3)} ms on average, ${renderMax.toFixed(3)} ms at most`,
        `timer: ${(late / Math.max(1, frames)).toFixed(2)} ms late on average, ${lateMax.toFixed(1)} ms at most`,
      ].join('\n'),
    );
    setTimeout(() => {
      sender.close();
      process.exit(0);
    }, 100);
  };

  process.on('SIGINT', () => {
    stopping = true;
  });
  console.log(
    `${effect.id} on ${host} for ${seconds > 0 ? `${seconds} s` : 'as long as you like (Ctrl-C)'}`,
  );
  frame();
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
