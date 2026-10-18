// Where the lamps of the room hang, and what they show. Plain functions with nothing of the
// browser in them, so that they can have a test: simulator.js only draws what this says.
//
// The lamps of the room are ONE fixture for lightdeck ("Room Lights", `protocol: 'hass'`), but
// in the room every lamp hangs somewhere of its own. They hang on rails: the lamps of a zone of
// the rig are the lamps of a rail, and a rail is a straight line, so those lamps lie on the same
// axis (Jeroen, 2026-10-18). A rail is put in the room like a fixture, moved and turned as a
// whole. A lamp is then moved along the axis of its rail and nowhere else, so between two rails
// the lamps are free but on one rail they stay in line. A light that is in no zone has no rail to
// share: it gets one of its own with the one lamp on it.
//
// A switch (a fog machine, a heater) is not a light and has nothing to draw.
//
// What a lamp shows is what lightdeck asks of it (the state of the fixture, the grand master and
// the blackout), and not what the lamp reports, in the way that the spiders are drawn from the
// bytes that are sent. Whether the real lamp keeps up is a matter for the room page.

/** How high a rail hangs when nothing says otherwise, in metres: just under a ceiling of 2.6. */
export const RAIL_HEIGHT = 2.5;
/** How far apart the rails are set when nothing says otherwise, in metres. */
export const RAIL_SPACING = 1.4;
/**
 * Where the first rail hangs along the room when nothing says otherwise, in metres. The spiders hang
 * at 0 by default, so the rails are put in front of them and not in them.
 */
export const RAIL_FIRST_Z = 1.8;
/** How far apart the lamps of a rail are set when nothing says otherwise, in metres. */
export const LAMP_SPACING = 0.6;
/** How far along its rail a lamp can be put, from the middle of the rail, in metres. */
export const MAX_ALONG = 6;

/** The rail a light hangs on has the id of its zone, or of the lamp when it has no zone. */
export function railsOf(details) {
  const lamps = details?.lamps ?? [];
  const rails = [];
  for (const zone of details?.zones ?? []) {
    const members = zone.lamps
      .map((id) => lamps.find((lamp) => lamp.id === id))
      .filter((lamp) => lamp && lamp.kind === 'light');
    if (members.length > 0) rails.push({ id: zone.id, label: zone.label, lamps: members });
  }
  for (const lamp of lamps) {
    if (lamp.kind === 'light' && !lamp.zone) {
      rails.push({ id: lamp.id, label: lamp.label, lamps: [lamp], loose: true });
    }
  }
  return rails;
}

/** Where everything hangs before anybody moves it: rails side by side, lamps evenly spaced. */
export function defaultPlacement(rails) {
  const placement = { rails: {}, along: {} };
  rails.forEach((rail, index) => {
    placement.rails[rail.id] = {
      p: [0, RAIL_HEIGHT, RAIL_FIRST_Z + index * RAIL_SPACING],
      q: [0, 0, 0, 1],
    };
    rail.lamps.forEach((lamp, i) => {
      placement.along[lamp.id] = (i - (rail.lamps.length - 1) / 2) * LAMP_SPACING;
    });
  });
  return placement;
}

const numbers = (value, length) =>
  Array.isArray(value) &&
  value.length === length &&
  value.every((part) => typeof part === 'number' && Number.isFinite(part));

/** A distance along a rail, kept to what a rail can be. Anything else is the middle. */
export function clampAlong(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(-MAX_ALONG, Math.min(MAX_ALONG, value));
}

/**
 * What this browser kept of where the lamps hang, laid over the defaults for these rails. What
 * was kept for a rail or a lamp that is not in the rig any more is dropped, and what is wrong
 * in it is left out, so that a stale or damaged store can never hide a lamp.
 */
export function cleanPlacement(kept, rails) {
  const placement = defaultPlacement(rails);
  for (const rail of rails) {
    const pose = kept?.rails?.[rail.id];
    if (numbers(pose?.p, 3) && numbers(pose?.q, 4)) {
      placement.rails[rail.id] = { p: [...pose.p], q: [...pose.q] };
    }
    for (const lamp of rail.lamps) {
      const along = kept?.along?.[lamp.id];
      if (typeof along === 'number' && Number.isFinite(along)) {
        placement.along[lamp.id] = clampAlong(along);
      }
    }
  }
  return placement;
}

/** How long to draw a rail so that it reaches a little past its first and last lamp. */
export function railSpan(alongs) {
  const margin = 0.3;
  const from = alongs.length > 0 ? Math.min(...alongs) - margin : -0.5;
  const to = alongs.length > 0 ? Math.max(...alongs) + margin : 0.5;
  // At least as long as something that is worth a rail.
  const length = Math.max(to - from, 0.8);
  const middle = (from + to) / 2;
  return { from: middle - length / 2, to: middle + length / 2, length, middle };
}

/**
 * What a lamp shows, from the state of the room fixture:
 *
 *   r, g, b      the colour at full brightness, 0..1, the white of an RGBW colour put into all three
 *   brightness   0..1: the level of the lamp times the dimmer of the room, the dimmer of its zone
 *                (`zone`, the id of the zone it is in) and the grand master, and 0 in a blackout
 *
 * `state` is what /api/state and the `fixture` events give for the room. A lamp the state does not
 * know is dark.
 */
export function lampLook(state, lampId, { master = 1, blackout = false, zone = null } = {}) {
  const level = state?.levels?.[lampId] ?? 0;
  // The dimmer of the room, and the one of the zone the lamp is in (a zone that is switched off is 0).
  const dimmer =
    clamp01(state?.dimmer ?? 1) * (zone === null ? 1 : clamp01(state?.zones?.[zone] ?? 1));
  const colour = state?.shown?.[lampId] ?? { red: 0, green: 0, blue: 0, white: 0 };
  const white = colour.white ?? 0;
  const mix = (part) => Math.max(0, Math.min(1, (part ?? 0) + white));
  const brightness = blackout ? 0 : clamp01(level) * dimmer * clamp01(master);
  return { r: mix(colour.red), g: mix(colour.green), b: mix(colour.blue), brightness };
}

function clamp01(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
