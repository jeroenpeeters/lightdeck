// The tab of the decor on the tablet page (Jeroen, 2026-10-30): the UV lamps that light the symbols on
// the cabinet, which are switches in Home Assistant. A column per switch with a big key (on or off, apart
// from the other) and under it the key that says whether it goes off with the blackout of the console,
// and a last column for both together. Plain browser JavaScript, in the classes of lightdeck.css.
//
// A key keeps its place and size whatever it says: a state swaps classes and words only. The page draws
// what the state says; a press is asked once and the answer comes back as an event.

import { decorOf, isDecorGroup, switchView } from './tabletLogic.js';
import { element } from './ui.js';

/** How long a switch may differ from what Home Assistant says before the page says so. */
const DIFFERS_MS = 5000;

/** The fixtures of a group that are decor. */
export function decorFixtures(shell, group) {
  return decorOf(shell.fixtures, group);
}

/** Whether a group is the decor: it has fixtures and they are all switches. */
export function isDecor(shell, group) {
  return isDecorGroup(shell.fixtures, group);
}

/**
 * Mounts the tab into `root` and returns `{ render(group) }`. `ask(url, body)` sends a change once.
 */
export function mountDecor(root, { shell, ask }) {
  let items = [];
  let signature = '';
  const columns = new Map();
  /** Since when a switch has differed from what Home Assistant says. */
  const since = {};
  let late;
  let both;

  const send = (fixtureId, body) => ask(`/api/fixtures/${fixtureId}/update`, body);

  /** One body per fixture, naming every switch of it that `ids` holds. */
  const setMany = (key, ids, value) => {
    const byFixture = new Map();
    for (const item of items) {
      if (!ids.includes(item.id)) continue;
      byFixture.set(item.fixture, { ...(byFixture.get(item.fixture) ?? {}), [item.id]: value });
    }
    for (const [fixtureId, map] of byFixture) send(fixtureId, { [key]: map });
  };

  function column(label, onKey, onFollow) {
    const holder = element('div', 't-dc');
    const key = element('button', 'key t-dc-key');
    key.type = 'button';
    const name = element('span', 'nm', label);
    const word = element('span', 'wd');
    key.append(name, word);
    key.addEventListener('click', onKey);
    const follow = element('button', 'key c t-dc-follow');
    follow.type = 'button';
    follow.append(element('span', '', 'Follows blackout'));
    follow.addEventListener('click', onFollow);
    const note = element('span', 't-dc-note');
    holder.append(key, follow, note);
    holder.parts = { key, name, word, follow, note };
    return holder;
  }

  function build() {
    columns.clear();
    root.replaceChildren();
    for (const item of items) {
      const made = column(
        item.label,
        () => {
          const now = shell.stateOf(item.fixture)?.on?.[item.id] === true;
          setMany('on', [item.id], !now);
        },
        () => {
          const now = shell.stateOf(item.fixture)?.follows?.[item.id] === true;
          setMany('follows', [item.id], !now);
        },
      );
      columns.set(`${item.fixture}/${item.id}`, made);
      root.append(made);
    }
    if (items.length > 1) {
      both = column(
        'Both',
        () => {
          const everyOn = items.every(
            (item) => shell.stateOf(item.fixture)?.on?.[item.id] === true,
          );
          setMany('on', ids(), !everyOn);
        },
        () => {
          const every = items.every(
            (item) => shell.stateOf(item.fixture)?.follows?.[item.id] === true,
          );
          setMany('follows', ids(), !every);
        },
      );
      both.parts.follow.firstChild.textContent = 'All follow blackout';
      root.append(both);
    } else {
      both = undefined;
    }
  }

  const ids = () => items.map((item) => item.id);

  function draw() {
    const now = performance.now();
    let waiting = false;
    const views = items.map((item) => {
      const state = shell.stateOf(item.fixture);
      const seen = switchView(state, item.id, shell.blackout, now, since);
      if (seen.differs) {
        since[item.id] ??= now;
        if (!seen.warn) waiting = true;
      } else delete since[item.id];
      return { item, seen };
    });
    for (const { item, seen } of views) {
      const { parts } = columns.get(`${item.fixture}/${item.id}`);
      drawKey(parts, seen);
    }
    if (both) {
      const lit = views.filter(({ seen }) => seen.on).length;
      const set = views.filter(({ seen }) => seen.set).length;
      const follows = views.filter(({ seen }) => seen.follows).length;
      const { parts } = both;
      parts.key.classList.toggle('is-on', lit === views.length);
      parts.key.classList.toggle('is-part', lit > 0 && lit < views.length);
      parts.key.setAttribute('aria-pressed', String(lit === views.length));
      parts.word.textContent =
        lit === views.length ? 'All on' : lit > 0 ? `${lit} of ${views.length} on` : 'Off';
      parts.word.classList.toggle('red', set > lit);
      parts.follow.classList.toggle('is-on', follows === views.length);
      parts.follow.setAttribute('aria-pressed', String(follows === views.length));
      parts.note.textContent = '';
    }
    // A difference is looked at again when it has lasted long enough to count.
    clearTimeout(late);
    if (waiting) late = setTimeout(draw, DIFFERS_MS + 50);
  }

  function drawKey(parts, seen) {
    parts.key.classList.toggle('is-on', seen.on);
    parts.key.setAttribute('aria-pressed', String(seen.on));
    parts.word.textContent = seen.word;
    parts.word.classList.toggle('red', seen.dark);
    parts.follow.classList.toggle('is-on', seen.follows);
    parts.follow.setAttribute('aria-pressed', String(seen.follows));
    parts.note.textContent = seen.note;
    parts.note.classList.toggle('red', seen.warn);
  }

  return {
    /** Draws the tab for a group of the decor, and again whenever the state may have changed. */
    render(next) {
      items = decorFixtures(shell, next).flatMap((fixture) =>
        (fixture.details?.switches ?? []).map((each) => ({
          fixture: fixture.id,
          id: each.id,
          label: each.label,
        })),
      );
      const wanted = items.map((item) => `${item.fixture}/${item.id}/${item.label}`).join(' ');
      if (wanted !== signature) {
        signature = wanted;
        build();
      }
      draw();
    },
  };
}
