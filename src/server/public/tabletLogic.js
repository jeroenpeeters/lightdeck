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
 * The segments of the bar under a part: while it runs one per bar of the step that is on (`done`
 * for the bars gone, `now` for this one), else one per step, all empty. `state` is the sequence
 * the server says runs: `{ running, step, barsLeft }`, where `barsLeft` counts this bar.
 */
export function partBars(sequence, state) {
  if (state?.running !== sequence.id) return sequence.steps.map(() => '');
  const total = sequence.steps[state.step]?.bars ?? 0;
  const done = Math.min(total, Math.max(0, total - state.barsLeft));
  return Array.from({ length: total }, (_, index) =>
    index < done ? 'done' : index === done ? 'now' : '',
  );
}

/** "1/10 · bar 19/24" for the part that runs. */
export function partPlace(sequence, state) {
  const total = sequence.steps[state.step]?.bars ?? 0;
  const bar = Math.min(total, Math.max(1, total - state.barsLeft + 1));
  return `${state.step + 1}/${sequence.steps.length} · bar ${bar}/${total}`;
}

/**
 * The look that the sequence that runs sets next in a group, and in how many bars. A step that does
 * not name the group, or names the look that is on, leaves it as it is, so the search goes on to
 * the step after. Nothing when the sequence does not run or never changes the group again.
 */
export function nextLook(sequence, state, groupId, lookOn) {
  if (!sequence || state?.running !== sequence.id) return null;
  const count = sequence.steps.length;
  let bars = state.barsLeft;
  for (let ahead = 1; ahead < count; ahead += 1) {
    const step = sequence.steps[(state.step + ahead) % count];
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
    .filter((fixture) => fixture?.kind === 'switches');
}

/** Whether a group is the decor: it has fixtures and every one of them is a switches fixture. */
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
