// The rail of the groups on the tablet page: a tile per group (and one for the video wall) that shows
// what the group does right now, a little: the colours of the lenses of the spider, whether the laser
// is open, how bright the rails of the room are. Plain browser JavaScript. It draws what it is told
// (tablet.js works that out from the state); it keeps what it drew last, so that a frame that
// changes nothing touches nothing.

import { element } from './ui.js';

/** The mini output of a tile, by the kind of what it shows. */
const MINI = {
  lenses: () => {
    const mini = element('div', 'lenses');
    mini.append(...Array.from({ length: 8 }, () => element('i')));
    return mini;
  },
  laser: () => element('div', 'hazard-dim t-laser-bar'),
  rails: () => element('div', 'rails'),
  wall: () => element('div', 't-wall-bar'),
};

/** A tile: its name, the mini output of its kind and a line of words. */
export function makeTile(kind, onPress) {
  const tile = element('button', `gtab${kind === 'laser' ? ' laser' : ''}`);
  tile.type = 'button';
  tile.dataset.kind = kind;
  tile.setAttribute('role', 'tab');
  tile.addEventListener('click', onPress);
  const name = element('span', 'nm');
  const mini = MINI[kind]?.() ?? element('div');
  const status = element('span', 'st');
  tile.append(name, mini, status);
  tile.parts = { name, mini, status, kind, last: '' };
  return tile;
}

/**
 * Draws a tile. `tile` is `{ name, status, lit, selected, mini }`: `lit` says the words are of
 * something that is on (amber, or red for the laser), `mini` is what the kind shows:
 * `{ colours }` for lenses (a CSS colour each, '' for dark), `{ open }` for the laser, `{ rails }`
 * (`{ level, colour }` each) for the room, and nothing for the wall.
 */
export function drawTile(tile, { name, status, lit, selected, mini }) {
  const { parts } = tile;
  const words = `${name}\n${status}\n${lit}\n${selected}\n${Boolean(mini?.open)}`;
  if (parts.words !== words) {
    parts.words = words;
    parts.name.textContent = name;
    parts.status.textContent = status;
    parts.status.classList.toggle('amber', lit && parts.kind !== 'laser');
    parts.status.classList.toggle('red', lit && parts.kind === 'laser');
    tile.classList.toggle('is-sel', selected);
    tile.classList.toggle('armed', parts.kind === 'laser' && Boolean(mini?.open));
    tile.setAttribute('aria-selected', String(selected));
  }
  paintTile(tile, mini);
}

/**
 * The mini output apart from the words, because it changes on every frame while the rest does not:
 * only what differs from what was drawn is written.
 */
export function paintTile(tile, mini) {
  const { parts } = tile;
  const wanted = JSON.stringify(mini ?? null);
  if (parts.last === wanted) return;
  parts.last = wanted;
  const holder = parts.mini;
  if (parts.kind === 'lenses') {
    [...holder.children].forEach((lens, index) => {
      lens.style.background = mini?.colours?.[index] ?? '';
    });
  } else if (parts.kind === 'laser') {
    const open = Boolean(mini?.open);
    holder.classList.toggle('hazard', open);
    holder.classList.toggle('hazard-dim', !open);
  } else if (parts.kind === 'rails') {
    const rails = mini?.rails ?? [];
    if (holder.children.length !== rails.length) {
      holder.replaceChildren(...rails.map(() => element('i')));
    }
    rails.forEach((rail, index) => {
      const bar = holder.children[index];
      // A rail that is dark still shows as a line, so that the tile does not look broken.
      bar.style.height = `${Math.max(6, Math.round(rail.level * 100))}%`;
      bar.style.background = rail.colour || '';
    });
  }
}
