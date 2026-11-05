// What the page for a tablet works out from the state, with nothing of the browser in it, so that it
// can have a test: the number in the name of a look, which look a sequence sets next, how a part of
// the evening shows its bars, which chips of the tray are on or are the look's own, and what the
// tiles of the group rail show of a fixture. Plain functions.

import { lensColour, readSpider } from './spiderPose.js';

/** "4 Creeping in" is the look Creeping in with the number 4 in front of it. */
export function splitNumber(label) {
  const parts = /^(\d+)\s+(.+)$/.exec(label);
  return parts ? { no: parts[1], name: parts[2] } : { no: '', name: label };
}

/** How long the steps of a sequence are: "32 bars each" when they all are, else "8–16 bars". */
export function partInfo(sequence) {
  const lengths = sequence.steps.map((step) => step.bars);
  const low = Math.min(...lengths);
  const high = Math.max(...lengths);
  const steps = `${lengths.length} ${lengths.length === 1 ? 'step' : 'steps'}`;
  return low === high ? `${steps} · ${low} bars each` : `${steps} · ${low}–${high} bars`;
}

/**
 * Several sequences run at once, one per group: the server's state is `{ runs: [{ id, step,
 * barsLeft, held, ... }] }`. This is the run of the sequence with this id, or undefined.
 */
export function runOf(state, id) {
  return state?.runs?.find((run) => run.id === id);
}

/**
 * The run of the sequence that sets this group, or undefined: what Next and Hold act on while the
 * tab of the group is on screen. `sequences` are those of the show.
 */
export function runForGroup(state, sequences, groupId) {
  return state?.runs?.find((run) =>
    sequences.some(
      (sequence) =>
        sequence.id === run.id && sequence.steps.some((step) => groupId in (step.looks ?? {})),
    ),
  );
}

/**
 * The sequences by category, for the pages (Jeroen, 2026-11-05): `[{ id, label, sequences }]` in the
 * order the categories first appear in the show. Sequences with no category come last as "Other"
 * (id ''), and when no sequence has one there is a single category without a label. A category is
 * only for looking: which sequences replace each other is decided by their groups.
 */
export function sequenceCategories(sequences) {
  const made = [];
  const byId = new Map();
  let anyNamed = false;
  for (const sequence of sequences) {
    const id = sequence.category ?? '';
    if (id !== '') anyNamed = true;
    let category = byId.get(id);
    if (!category) {
      category = { id, label: id, sequences: [] };
      byId.set(id, category);
      made.push(category);
    }
    category.sequences.push(sequence);
  }
  const rest = byId.get('');
  if (rest && anyNamed) {
    rest.label = 'Other';
    made.splice(made.indexOf(rest), 1);
    made.push(rest);
  }
  return made;
}

/** The category with a sequence that sets this group, or undefined: the one to show with its tab. */
export function categoryOfGroup(categories, groupId) {
  return categories.find((category) =>
    category.sequences.some((sequence) =>
      sequence.steps.some((step) => groupId in (step.looks ?? {})),
    ),
  );
}

/**
 * The segments of the bar under a part: while it runs one per bar of the step that is on (`done`
 * for the bars gone, `now` for this one), else one per step, all empty. `run` is the run of the
 * sequence the server tells, `{ id, step, barsLeft }`, where `barsLeft` counts this bar.
 */
export function partBars(sequence, run) {
  if (run?.id !== sequence.id) return sequence.steps.map(() => '');
  const total = sequence.steps[run.step]?.bars ?? 0;
  const done = Math.min(total, Math.max(0, total - run.barsLeft));
  return Array.from({ length: total }, (_, index) =>
    index < done ? 'done' : index === done ? 'now' : '',
  );
}

/** "1/10 · bar 19/24" for the part that runs. */
export function partPlace(sequence, run) {
  const total = sequence.steps[run.step]?.bars ?? 0;
  const bar = Math.min(total, Math.max(1, total - run.barsLeft + 1));
  return `${run.step + 1}/${sequence.steps.length} · bar ${bar}/${total}`;
}

/**
 * The look that a running sequence sets next in a group, and in how many bars. A step that does
 * not name the group, or names the look that is on, leaves it as it is, so the search goes on to
 * the step after. Nothing when the sequence does not run or never changes the group again.
 * `run` is the run of that sequence.
 */
export function nextLook(sequence, run, groupId, lookOn) {
  if (!sequence || run?.id !== sequence.id) return null;
  const count = sequence.steps.length;
  let bars = run.barsLeft;
  for (let ahead = 1; ahead < count; ahead += 1) {
    const step = sequence.steps[(run.step + ahead) % count];
    const look = step?.looks?.[groupId];
    if (look !== undefined && look !== lookOn) return { look, bars };
    bars += step?.bars ?? 0;
  }
  return null;
}

/**
 * A chip of the tray, by its id: `on` when it is what the lane has on now, `own` when it is what
 * the look that is on sets there. Both can be true, and then the look is as it was stored.
 */
export function chipMarks(id, onId, ownId) {
  return { on: onId !== undefined && onId === id, own: ownId !== undefined && ownId === id };
}

const byte = (part) => Math.round(Math.min(1, Math.max(0, part)) * 255);

/** A colour as CSS, or '' for dark. White is added to all three, as it is on the lens. */
function rgb({ r, g, b, w = 0 }, level = 1) {
  const mix = (part) => Math.min(1, part + w) * level;
  const [red, green, blue] = [mix(r), mix(g), mix(b)].map(byte);
  return red + green + blue === 0 ? '' : `rgb(${red} ${green} ${blue})`;
}

/**
 * The colours the lenses of a spider show for these bytes, bar after bar, as CSS (an empty string is
 * a dark lens). `fixture` is the spider as /api/state describes it.
 */
export function spiderLenses(dmx, fixture) {
  const layout = fixture.details?.layout;
  if (!dmx || !layout || !fixture.controls) return [];
  const spider = readSpider(dmx, fixture.controls, layout);
  return spider.bars.flatMap((bar) =>
    bar.cells.map((cell) => {
      const seen = lensColour(cell, spider.dimmer);
      return rgb(seen);
    }),
  );
}

/** Whether the laser is open: its mode channel is not in the range that is called off. */
export function laserOpen(dmx, fixture) {
  const mode = fixture.controls?.find((control) => control.name === 'mode');
  if (!dmx || !mode) return false;
  const value = dmx[mode.channel - 1] ?? 0;
  const closed = mode.ranges?.find((range) => range.key === 'off');
  return closed ? value > closed.to : value > 0;
}

/**
 * What a rail of the room shows: per zone how bright it is (the level of its lights times the dimmer
 * and the switch of the zone, the brightest light counting) and the colour of that light. `state`
 * is the state of the room fixture and `zones` its `details.zones`.
 */
export function roomRails(state, zones) {
  if (!state) return [];
  return zones.map((zone) => {
    let best = { level: 0, colour: '' };
    for (const lamp of zone.lamps) {
      const level = state.levels?.[lamp] ?? 0;
      if (level <= best.level) continue;
      const shown = state.shown?.[lamp];
      // The room says red, green, blue and white in full; the lenses of a spider say r, g, b and w.
      best = {
        level,
        colour: shown ? rgb({ r: shown.red, g: shown.green, b: shown.blue, w: shown.white }) : '',
      };
    }
    const switched = (state.zones?.[zone.id] ?? 1) > 0 ? 1 : 0;
    return {
      id: zone.id,
      level: best.level * (state.dimmer ?? 1) * switched,
      colour: best.colour,
    };
  });
}

// ---- the decor: switches that no scene keeps ----

/** The fixtures of a group that are switches of the decor. `fixtures` is what /api/state lists. */
export function decorOf(fixtures, group) {
  if (!group) return [];
  return group.fixtures
    .map((id) => fixtures.find((fixture) => fixture.id === id))
    .filter((fixture) => fixture?.kind === 'decor');
}

/** Whether a group is the decor: it has fixtures and every one of them is a decor fixture. */
export function isDecorGroup(fixtures, group) {
  return (
    Boolean(group) &&
    group.fixtures.length > 0 &&
    decorOf(fixtures, group).length === group.fixtures.length
  );
}

/** How long a switch may differ from what Home Assistant says before it is called a difference. */
export const DIFFERS_MS = 5000;

/**
 * What one switch of the decor shows: whether it is on (set on, and not dark), the word for it
 * (On, Off, or Blackout when it is set on and dark), whether it follows the blackout of the console,
 * and what Home Assistant says as a line, with `warn` when that is a problem (a refused command, an
 * unavailable switch, or a difference that has lasted `DIFFERS_MS`). `consoleDark` is the blackout of
 * the console, `now` a clock in ms and `since` by switch the moment its difference began.
 */
export function switchView(state, id, consoleDark, now = 0, since = {}) {
  const set = state?.on?.[id] === true;
  const follows = state?.follows?.[id] === true;
  const dark = state?.blackout === true || (consoleDark && follows);
  const on = set && !dark;
  const reported = state?.reported?.[id] ?? null;
  const problem = state?.problems?.[id] ?? null;
  let note = '';
  let warn = false;
  if (problem) {
    note = problem;
    warn = true;
  } else if (reported === null) {
    note = 'Home Assistant: nothing yet';
  } else if (!reported.available) {
    note = 'Home Assistant: unavailable';
    warn = true;
  } else if (reported.on !== on) {
    // A switch takes a moment to report: a difference counts after a few seconds.
    warn = now - (since[id] ?? now) >= DIFFERS_MS;
    note = warn ? `Home Assistant says ${reported.on ? 'on' : 'off'}` : '';
  } else {
    note = `Home Assistant: ${reported.on ? 'on' : 'off'}`;
  }
  return {
    set,
    follows,
    on,
    dark: set && dark,
    word: set && dark ? 'Blackout' : on ? 'On' : 'Off',
    note,
    warn,
    differs: Boolean(reported?.available && reported.on !== on),
  };
}

// ---- the strips of WLED in the decor ----

/** The colours a strip can be given with one press: the liquid in the pipe. Name and `#rrggbb`. */
export const STRIP_COLOURS = [
  { name: 'White', hex: '#ffffff' },
  { name: 'Cyan', hex: '#00e5ff' },
  { name: 'Blue', hex: '#1f4bff' },
  { name: 'Violet', hex: '#8a2bff' },
  { name: 'Magenta', hex: '#ff1fa8' },
  { name: 'Red', hex: '#ff1a1a' },
  { name: 'Orange', hex: '#ff7a00' },
  { name: 'Green', hex: '#27ff5a' },
];

/** The colour of `#rrggbb` as `{ red, green, blue }`, each 0..1. */
export function hexColour(hex) {
  const parsed = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  const [red = 0, green = 0, blue = 0] = (parsed ? parsed.slice(1) : []).map(
    (part) => Number.parseInt(part, 16) / 255,
  );
  return { red, green, blue };
}

/** A colour of a strip as CSS, brightest channel at full: the colour and not its brightness. */
export function colourCss({ red, green, blue }) {
  const peak = Math.max(red, green, blue, 1e-9);
  const part = (value) => Math.round(Math.min(1, value / peak) * 255);
  return `rgb(${part(red)} ${part(green)} ${part(blue)})`;
}

/** Whether two strip colours are the same colour, as the strip would show it (direction, a little slack). */
export function sameColour(a, b) {
  const unit = (colour) => {
    const peak = Math.max(colour.red, colour.green, colour.blue, 1e-9);
    return [colour.red / peak, colour.green / peak, colour.blue / peak];
  };
  const [x, y] = [unit(a), unit(b)];
  return x.every((value, index) => Math.abs(value - (y[index] ?? 0)) < 0.04);
}

/** The ids a target means: one strip, or `all` of them. A strip that is gone falls back to all. */
export function targetIds(target, ids) {
  return target !== 'all' && ids.includes(target) ? [target] : ids;
}

/** What every item of the list has in common: the value when all are the same, else undefined. */
export function commonValue(values, same = Object.is) {
  const [first, ...rest] = values;
  return values.length > 0 && rest.every((value) => same(value, first)) ? first : undefined;
}

/**
 * The effects of WLED that look like something flowing, for the first of the list. Which of them a
 * strip has is up to its firmware: only the ones it lists are kept, in this order.
 */
export const LIQUID_EFFECTS = [
  'Flow',
  'Drip',
  'Lake',
  'Pacifica',
  'Colorwaves',
  'Stream',
  'Aurora',
  'Ripple',
  'Running',
  'Chase',
  'Plasma',
  'Sinelon',
  'Meteor Smooth',
  'Fire Flicker',
];

/** The effects a strip lists as `{ liquid, rest }`: the flowing ones first, then every other, without Solid. */
export function effectGroups(list) {
  const named = (list ?? []).filter((name) => name !== 'Solid');
  const liquid = LIQUID_EFFECTS.filter((name) => named.includes(name));
  return { liquid, rest: named.filter((name) => !liquid.includes(name)) };
}

/**
 * What one strip shows: what a switch shows, and its effect (`Solid` for none) and its colour as CSS.
 */
export function stripView(state, id, consoleDark, now = 0, since = {}) {
  const base = switchView(state, id, consoleDark, now, since);
  const colour = state?.colour?.[id] ?? { red: 1, green: 1, blue: 1 };
  return {
    ...base,
    effect: state?.effect?.[id] ?? null,
    effectName: state?.effect?.[id] ?? 'Solid',
    colour,
    css: colourCss(colour),
    level: state?.level?.[id] ?? 1,
  };
}

/** The paces on top of the bpm, as the console has its speeds, with the words on the keys. */
export const PACES = [
  { value: 0.25, name: '÷4' },
  { value: 0.5, name: '÷2' },
  { value: 1, name: '×1' },
  { value: 2, name: '×2' },
  { value: 4, name: '×4' },
];

/** Palettes of WLED that make a good pair or trio of colours, shown first when a strip lists them. */
export const COMMON_PALETTES = [
  'Default',
  '* Color 1',
  '* Colors 1&2',
  'Ocean',
  'Lava',
  'Party',
  'Icefire',
  'Sunset',
  'Red & Blue',
  'Orange & Teal',
  'Yelmag',
  'Yelblu',
  'Magred',
  'Toxy Reaf',
  'Tiamat',
  'Cyane',
  'Splash',
  'Aurora',
  'Rainbow',
];

/** The palettes a strip lists as `{ common, rest }`: the usual ones first, in this order. */
export function paletteGroups(list) {
  const named = list ?? [];
  const common = COMMON_PALETTES.filter((name) => named.includes(name));
  return { common, rest: named.filter((name) => !common.includes(name)) };
}

/**
 * Whether a look of the pipes is what the strips show: every strip has its effect, palette (Default when it
 * says none), intensity (128), pace (1) and, when it names one, its colour. `states` is a list of
 * `{ effect, palette, intensity, pace, colour }` of the strips the look is for.
 */
export function lookIsOn(look, states) {
  if (states.length === 0) return false;
  return states.every(
    (strip) =>
      (strip.effect ?? null) === (look.effect ?? null) &&
      (strip.palette ?? null) === (look.palette ?? 'Default') &&
      (strip.intensity ?? null) === (look.intensity ?? 128) &&
      (strip.pace ?? 1) === (look.pace ?? 1) &&
      (look.colour === undefined || sameColour(strip.colour, hexColour(look.colour))),
  );
}
