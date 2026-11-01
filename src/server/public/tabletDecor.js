// The tab of the decor on the tablet page (Jeroen, 2026-10-30 and 2026-10-31): what is part of the set and
// not of the lighting. Plain browser JavaScript, in the classes of lightdeck.css.
//
// Two rows of columns at the left. The UV lamps (switches in Home Assistant): a column per lamp with a
// big key (on or off, apart from the other), the key that says whether it goes off with the blackout of
// the console, and a last column for both together. The pipes (three strips of WLED in dryer hoses): the
// same columns, with the effect each shows under its name. At the right the look of the pipes: which
// pipe it is for (one, or All), the brightness, the colour and the effect, which the strip itself lists.
// The speed of the effect follows the bpm and is nothing to set here.
//
// A key keeps its place and size whatever it says: a state swaps classes and words only. The page draws
// what the state says; a press is asked once and the answer comes back as an event.

import { chipColour, drawChip, makeChip } from './tabletKit.js';
import {
  colourCss,
  commonValue,
  DIFFERS_MS,
  decorOf,
  effectGroups,
  hexColour,
  isDecorGroup,
  lookIsOn,
  PACES,
  paletteGroups,
  STRIP_COLOURS,
  sameColour,
  stripView,
  switchView,
  targetIds,
} from './tabletLogic.js';
import { element, fader } from './ui.js';

/** A fader is sent at most this often, and the last position always. */
const SEND_GAP_MS = 120;

/** The fixtures of a group that are decor. */
export function decorFixtures(shell, group) {
  return decorOf(shell.fixtures, group);
}

/** Whether a group is the decor: it has fixtures and they are all decor. */
export function isDecor(shell, group) {
  return isDecorGroup(shell.fixtures, group);
}

/**
 * A fader that sends at most every 120 ms, the last position always, and stays where the finger put it for
 * 700 ms after the last move, because the stream tells of an older position after a newer one is sent.
 * `read` gives 0 to 100, or null when there is nothing to set; `send` gets the number.
 */
function heldFader({ id, label, read, send, format }) {
  let held = null;
  let holdTimer;
  let sentAt = 0;
  let lateTimer;
  const bar = fader({
    id,
    label,
    ...(format ? { format } : {}),
    read: () => {
      const value = read();
      return value === null ? null : (held ?? value);
    },
    write: (number) => {
      held = number;
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        held = null;
        bar.refresh();
      }, 700);
      clearTimeout(lateTimer);
      const wait = SEND_GAP_MS - (performance.now() - sentAt);
      if (wait <= 0) {
        sentAt = performance.now();
        send(number);
      } else {
        lateTimer = setTimeout(() => {
          sentAt = performance.now();
          send(number);
        }, wait);
      }
    },
  });
  return bar;
}

/**
 * Mounts the tab into `root` and returns `{ render(group) }`. `ask(url, body)` sends a change once.
 */
export function mountDecor(root, { shell, ask }) {
  /** The switches and the strips of the group, in the order of the rig. */
  let items = [];
  let signature = '';
  const columns = new Map();
  /** Since when an item has differed from what Home Assistant says. */
  const since = {};
  let late;
  let main;
  let side;
  let both;
  let bothStrips;
  /** Which pipe the look is for: the id of a strip, or `all`. */
  let target = 'all';
  let targetKeys = new Map();
  let level;
  let pipesDimmer;
  let uvDimmer;
  let colourKeys = new Map();
  let effectHolder;
  let effectKeys = new Map();
  let effectNote;
  let moreKey;
  let looks = [];
  /** The effects lightdeck itself draws for a pipe, from the fixture. */
  let pipeEffects = [];
  let wledGroup;
  let ownGroup;
  let mixedNote;
  let linkedNote;
  let ownPaletteHolder;
  let ownPaletteKeys = new Map();
  let ownEffectHolder;
  let ownEffectKeys = new Map();
  let looksHolder;
  let looksLabel;
  let looksKeys = new Map();
  let paceKeys = new Map();
  let paletteHolder;
  let paletteKeys = new Map();
  let paletteMoreKey;
  let paletteNote;
  /** Whether the palettes that are not the usual ones are shown too: WLED has seventy. */
  let palettesOpen = false;
  /** Whether the effects that are not flowing ones are shown too: WLED has a hundred and more. */
  let moreOpen = false;

  const switches = () => items.filter((item) => item.kind === 'switch');
  const strips = () => items.filter((item) => item.kind === 'strip');
  const stateOf = (item) => shell.stateOf(item.fixture);
  const send = (fixtureId, body) => ask(`/api/fixtures/${fixtureId}/update`, body);

  /** One request per fixture, naming every item of `list` with what `valueFor` says of it. */
  const setMany = (key, list, valueFor) => {
    const byFixture = new Map();
    for (const item of list) {
      byFixture.set(item.fixture, {
        ...(byFixture.get(item.fixture) ?? {}),
        [item.id]: valueFor(item),
      });
    }
    for (const [fixtureId, map] of byFixture) send(fixtureId, { [key]: map });
  };

  const targeted = () => {
    const wanted = targetIds(
      target,
      strips().map((item) => item.id),
    );
    return strips().filter((item) => wanted.includes(item.id));
  };

  // ---- the columns ----

  function column(label, onKey, onFollow) {
    const holder = element('div', 't-dc');
    const key = element('button', 'key t-dc-key');
    key.type = 'button';
    const name = element('span', 'nm', label);
    const word = element('span', 'wd');
    const note = element('span', 'fx');
    key.append(name, note, word);
    key.addEventListener('click', onKey);
    const follow = element('button', 'key c t-dc-follow');
    follow.type = 'button';
    follow.append(element('span', '', 'Follows blackout'));
    follow.addEventListener('click', onFollow);
    const line = element('span', 't-dc-note');
    holder.append(key, follow, line);
    holder.parts = { key, name, word, follow, note, line };
    return holder;
  }

  function pairOf(list, label, followText) {
    const all = column(
      label,
      () => {
        const every = list.every((item) => stateOf(item)?.on?.[item.id] === true);
        setMany('on', list, () => !every);
      },
      () => {
        const every = list.every((item) => stateOf(item)?.follows?.[item.id] === true);
        setMany('follows', list, () => !every);
      },
    );
    all.parts.follow.firstChild.textContent = followText;
    return all;
  }

  function row(title, list, holder, allLabel, dimmer) {
    const section = element('section', 't-dc-row');
    const head = element('div', 't-dc-rowhead');
    head.append(element('span', 'lbl', title));
    if (dimmer) {
      const slot = element('div', 't-dc-rowdimmer');
      slot.append(dimmer);
      head.append(slot);
    }
    section.append(head);
    const cells = element('div', 't-dc-cells');
    for (const item of list) {
      const made = column(
        item.label,
        () => setMany('on', [item], () => stateOf(item)?.on?.[item.id] !== true),
        () => setMany('follows', [item], () => stateOf(item)?.follows?.[item.id] !== true),
      );
      columns.set(`${item.fixture}/${item.id}`, made);
      cells.append(made);
    }
    if (list.length > 1) {
      const all = pairOf(list, allLabel, `${allLabel} follow blackout`);
      holder(all);
      cells.append(all);
    }
    section.append(cells);
    return section;
  }

  // ---- the look of the pipes ----

  function buildSide() {
    side = element('aside', 't-dc-side');
    side.append(element('span', 'lbl', 'Pipes · look'));
    const targets = element('div', 't-dc-targets');
    targets.setAttribute('role', 'tablist');
    targetKeys = new Map();
    const list = strips();
    for (const [id, label] of [...list.map((item) => [item.id, item.label]), ['all', 'All']]) {
      const key = element('button', 'tab');
      key.type = 'button';
      key.setAttribute('role', 'tab');
      key.append(element('span', 'name', label));
      key.addEventListener('click', () => {
        target = id;
        draw();
      });
      targetKeys.set(id, key);
      targets.append(key);
    }
    level = heldFader({
      id: 't-dc-level',
      label: 'Brightness',
      read: () => {
        const first = targeted()[0];
        return first ? Math.round(100 * (stateOf(first)?.level?.[first.id] ?? 1)) : null;
      },
      send: (number) => setMany('level', targeted(), () => number / 100),
    });

    // The looks: an effect with its colours, a key that sets all of it on the pipes.
    looksHolder = element('div', 't-dc-looks');
    looksKeys = new Map();
    for (const look of looks) {
      const key = element('button', 'chip t-dc-look');
      key.type = 'button';
      key.append(element('span', 'name', look.label));
      key.addEventListener('click', () => {
        const byFixture = new Map();
        for (const item of targeted()) {
          byFixture.set(item.fixture, {
            ...(byFixture.get(item.fixture) ?? {}),
            [item.id]: look.id,
          });
        }
        for (const [fixtureId, map] of byFixture) send(fixtureId, { look: map });
      });
      looksKeys.set(look.id, key);
      looksHolder.append(key);
    }

    // The pace on top of the bpm.
    const pace = element('div', 't-dc-pace');
    paceKeys = new Map();
    for (const { value, name } of PACES) {
      const key = element('button', 'chip c');
      key.type = 'button';
      key.append(element('span', 'name', name));
      key.addEventListener('click', () => setMany('pace', targeted(), () => value));
      paceKeys.set(value, key);
      pace.append(key);
    }

    // The palette: WLED's colours for an effect, more than one.
    paletteHolder = element('div', 't-dc-effects');
    paletteKeys = new Map();
    paletteMoreKey = element('button', 'key c t-dc-more');
    paletteMoreKey.type = 'button';
    paletteMoreKey.append(element('span', '', 'More palettes'));
    paletteMoreKey.addEventListener('click', () => {
      palettesOpen = !palettesOpen;
      drawPalettes();
    });
    paletteNote = element('p', 't-dc-hint');

    const colours = element('div', 't-dc-colours');
    colourKeys = new Map();
    for (const { name, hex } of STRIP_COLOURS) {
      const key = element('button', 'chip t-dc-colour');
      key.type = 'button';
      key.title = name;
      key.setAttribute('aria-label', name);
      const swatch = element('i');
      swatch.style.background = colourCss(hexColour(hex));
      key.append(swatch, element('span', 'name', name));
      key.addEventListener('click', () => {
        const colour = hexColour(hex);
        setMany('colour', targeted(), () => colour);
      });
      colourKeys.set(hex, key);
      colours.append(key);
    }

    effectHolder = element('div', 't-dc-effects');
    moreKey = element('button', 'key c t-dc-more');
    moreKey.type = 'button';
    moreKey.append(element('span', '', 'More effects'));
    moreKey.addEventListener('click', () => {
      moreOpen = !moreOpen;
      drawEffects();
    });
    effectNote = element('p', 't-dc-hint');
    effectKeys = new Map();
    // What a pipe that WLED draws is given: a colour, a palette of WLED and an effect of WLED's own.
    wledGroup = element('div', 't-dc-group');
    wledGroup.append(
      element('span', 'lbl', 'Colour'),
      colours,
      element('span', 'lbl', 'Palette'),
      paletteHolder,
      paletteMoreKey,
      paletteNote,
      element('span', 'lbl', 'Effect'),
      effectHolder,
      moreKey,
      effectNote,
    );

    // What a pipe that lightdeck draws is given: a palette of the show (its first colour is the foreground,
    // the second the background, the third an accent) and an effect of lightdeck's own.
    ownPaletteHolder = element('div', 't-dc-palettes');
    ownPaletteKeys = new Map();
    ownEffectHolder = element('div', 't-dc-effects');
    ownEffectKeys = new Map();
    ownGroup = element('div', 't-dc-group');
    ownGroup.append(
      element('span', 'lbl', 'Palette · 1 foreground, 2 background, 3 accent'),
      ownPaletteHolder,
      element('span', 'lbl', 'Effect'),
      ownEffectHolder,
    );
    mixedNote = element('p', 't-dc-hint');
    mixedNote.textContent =
      'These pipes work differently, one drawn by lightdeck and one by WLED: choose one pipe above.';

    // Linked pipes are one pipe (set on /decor): what is set on one of them is set on all of them.
    linkedNote = element('p', 't-dc-hint');
    linkedNote.textContent =
      'The pipes are linked as one long pipe: the effect, the palette and the pace go to all of them. The order and the direction are set on the Decor page.';
    linkedNote.hidden = true;

    const parts = [targets, linkedNote];
    looksLabel = element('span', 'lbl', 'Looks');
    if (looks.length > 0) parts.push(looksLabel, looksHolder);
    parts.push(
      level,
      element('span', 'lbl', 'Pace · on top of the bpm'),
      pace,
      wledGroup,
      ownGroup,
      mixedNote,
    );
    side.append(...parts);
  }

  /** The effects that the strips of the target list, flowing ones first; the key for none is Solid. */
  function drawEffects() {
    const here = targeted();
    // The list of the first strip that has said; strips of one kind list the same.
    const listed = here
      .map((item) => stateOf(item)?.reported?.[item.id]?.effects)
      .find((list) => Array.isArray(list) && list.length > 0);
    const { liquid, rest } = effectGroups(listed);
    const now = commonValue(here.map((item) => stateOf(item)?.effect?.[item.id] ?? null));
    // The others stay out of the way until asked for, but the effect that is on is always shown.
    const names = ['Solid', ...liquid, ...(moreOpen ? rest : rest.filter((name) => name === now))];
    moreKey.hidden = rest.length === 0;
    moreKey.firstChild.textContent = moreOpen ? 'Fewer effects' : `More effects (${rest.length})`;
    moreKey.setAttribute('aria-pressed', String(moreOpen));
    const wanted = listed ? names : [];
    for (const [name, key] of effectKeys) {
      if (wanted.includes(name)) continue;
      key.remove();
      effectKeys.delete(name);
    }
    wanted.forEach((name, index) => {
      let key = effectKeys.get(name);
      if (!key) {
        key = element('button', 'chip');
        key.type = 'button';
        key.append(element('span', 'name', name));
        key.addEventListener('click', () => {
          setMany('effect', targeted(), () => (name === 'Solid' ? null : name));
        });
        effectKeys.set(name, key);
      }
      if (effectHolder.children[index] !== key) {
        effectHolder.insertBefore(key, effectHolder.children[index] ?? null);
      }
      const on = name === 'Solid' ? now === null : now === name;
      key.classList.toggle('is-on', on);
      key.classList.toggle('is-liquid', liquid.includes(name));
      key.setAttribute('aria-pressed', String(on));
    });
    effectNote.textContent = listed
      ? 'The speed follows the bpm.'
      : 'The effects appear when a pipe is online.';
  }

  // ---- building and drawing ----

  function build() {
    columns.clear();
    root.replaceChildren();
    main = element('div', 't-dc-main');
    // A dimmer for each of the two (Jeroen: they are not the same at all). The UV lamps are switches, which
    // cannot dim, so theirs rests, as the dimmer of the laser does; the pipes' dims the pipes.
    uvDimmer = heldFader({
      id: 't-dc-uv-dimmer',
      label: 'UV dimmer',
      format: () => '–',
      read: () => null,
      send: () => {},
    });
    uvDimmer.title =
      'The UV lamps are switches: they only go on and off, so they cannot be dimmed.';
    pipesDimmer = heldFader({
      id: 't-dc-pipes-dimmer',
      label: 'Pipes dimmer',
      read: () => {
        const first = strips()[0];
        return first ? Math.round(100 * (stateOf(first)?.pipesDimmer ?? 1)) : null;
      },
      send: (number) => {
        for (const fixtureId of new Set(strips().map((item) => item.fixture))) {
          send(fixtureId, { pipesDimmer: number / 100 });
        }
      },
    });
    const sw = switches();
    const st = strips();
    if (sw.length > 0) {
      both = undefined;
      main.append(
        row(
          'UV lamps',
          sw,
          (made) => {
            both = made;
          },
          'Both',
          uvDimmer,
        ),
      );
    } else both = undefined;
    if (st.length > 0) {
      bothStrips = undefined;
      main.append(
        row(
          'Pipes',
          st,
          (made) => {
            bothStrips = made;
          },
          'All',
          pipesDimmer,
        ),
      );
    } else bothStrips = undefined;
    root.append(main);
    if (st.length > 0) {
      buildSide();
      root.append(side);
    } else side = undefined;
    root.dataset.pipes = String(st.length > 0);
  }

  function drawKey(parts, seen, note) {
    parts.key.classList.toggle('is-on', seen.on);
    parts.key.setAttribute('aria-pressed', String(seen.on));
    parts.word.textContent = seen.word;
    parts.word.classList.toggle('red', seen.dark);
    parts.follow.classList.toggle('is-on', seen.follows);
    parts.follow.setAttribute('aria-pressed', String(seen.follows));
    parts.line.textContent = seen.note;
    parts.line.classList.toggle('red', seen.warn);
    parts.note.textContent = note;
  }

  /** The key for all of a row: lit when all are on, with how many are on in words. */
  function drawAll(parts, views) {
    const lit = views.filter(({ seen }) => seen.on).length;
    const set = views.filter(({ seen }) => seen.set).length;
    const follows = views.filter(({ seen }) => seen.follows).length;
    parts.key.classList.toggle('is-on', lit === views.length);
    parts.key.classList.toggle('is-part', lit > 0 && lit < views.length);
    parts.key.setAttribute('aria-pressed', String(lit === views.length));
    parts.word.textContent =
      lit === views.length ? 'All on' : lit > 0 ? `${lit} of ${views.length} on` : 'Off';
    parts.word.classList.toggle('red', set > lit);
    parts.follow.classList.toggle('is-on', follows === views.length);
    parts.follow.setAttribute('aria-pressed', String(follows === views.length));
    parts.line.textContent = '';
    parts.note.textContent = '';
  }

  function draw() {
    const now = performance.now();
    let waiting = false;
    const look = (item) => {
      const state = stateOf(item);
      const seen =
        item.kind === 'strip'
          ? stripView(state, item.id, shell.blackout, now, since)
          : switchView(state, item.id, shell.blackout, now, since);
      if (seen.differs) {
        since[item.id] ??= now;
        if (!seen.warn) waiting = true;
      } else delete since[item.id];
      return { item, seen };
    };
    const views = items.map(look);
    for (const { item, seen } of views) {
      const { parts } = columns.get(`${item.fixture}/${item.id}`);
      drawKey(parts, seen, item.kind === 'strip' ? seen.effectName : '');
      if (item.kind === 'strip') {
        // A pipe lightdeck draws shows the first colour of its palette; one WLED draws, its own colour.
        const palette = item.rendered
          ? (shell.show.palettes ?? []).find(
              (each) => each.id === stateOf(item)?.palette?.[item.id],
            )
          : undefined;
        const dot = item.rendered
          ? (chipColour(palette?.colours?.[0] ?? '') ?? '#ffffff')
          : seen.css;
        parts.key.style.setProperty('--strip', dot);
        parts.key.classList.add('has-strip');
      }
    }
    if (both) {
      drawAll(
        both.parts,
        views.filter(({ item }) => item.kind === 'switch'),
      );
    }
    if (bothStrips) {
      drawAll(
        bothStrips.parts,
        views.filter(({ item }) => item.kind === 'strip'),
      );
    }
    uvDimmer?.refresh();
    pipesDimmer?.refresh();
    if (side) drawSide(views.filter(({ item }) => item.kind === 'strip'));
    // A difference is looked at again when it has lasted long enough to count.
    clearTimeout(late);
    if (waiting) late = setTimeout(draw, DIFFERS_MS + 50);
  }

  function drawSide(views) {
    const ids = views.map(({ item }) => item.id);
    if (target !== 'all' && !ids.includes(target)) target = 'all';
    for (const [id, key] of targetKeys) {
      key.classList.toggle('is-sel', id === target);
      key.setAttribute('aria-selected', String(id === target));
    }
    const here = views.filter(({ item }) => targetIds(target, ids).includes(item.id));
    level.refresh();
    const colour = here.length > 0 ? here.map(({ seen }) => seen.colour) : [];
    for (const [hex, key] of colourKeys) {
      const wanted = hexColour(hex);
      const on = colour.length > 0 && colour.every((each) => sameColour(each, wanted));
      key.classList.toggle('is-on', on);
      key.setAttribute('aria-pressed', String(on));
    }
    const rendered = here.filter(({ item }) => item.rendered).length;
    const mode = rendered === 0 ? 'wled' : rendered === here.length ? 'own' : 'mixed';
    looksHolder.hidden = mode === 'mixed';
    if (looksLabel) looksLabel.hidden = mode === 'mixed';
    wledGroup.hidden = mode !== 'wled';
    ownGroup.hidden = mode !== 'own';
    mixedNote.hidden = mode !== 'mixed';
    linkedNote.hidden = !views.some(({ item }) => item.rendered && stateOf(item)?.linked === true);
    if (mode === 'wled') {
      drawEffects();
      drawPalettes();
    } else if (mode === 'own') drawOwn(here);
    drawLooksAndPace(here);
  }

  /** The palettes of the show and the effects lightdeck draws, for the pipes of the target. */
  function drawOwn(here) {
    const states = here.map(({ item }) => stateOf(item));
    const palette = commonValue(
      here.map(({ item }, index) => states[index]?.palette?.[item.id] ?? null),
    );
    const palettes = shell.show.palettes ?? [];
    for (const [id, chip] of ownPaletteKeys) {
      if (palettes.some((each) => each.id === id)) continue;
      chip.remove();
      ownPaletteKeys.delete(id);
    }
    palettes.forEach((each, index) => {
      let chip = ownPaletteKeys.get(each.id);
      if (!chip) {
        chip = makeChip(() => setMany('palette', targeted(), () => each.id), { strip: true });
        ownPaletteKeys.set(each.id, chip);
      }
      if (ownPaletteHolder.children[index] !== chip) {
        ownPaletteHolder.insertBefore(chip, ownPaletteHolder.children[index] ?? null);
      }
      drawChip(chip, {
        label: each.label,
        on: palette === each.id,
        own: false,
        colours: each.colours,
      });
    });
    const effect = commonValue(
      here.map(({ item }, index) => states[index]?.effect?.[item.id] ?? null),
    );
    const now = effect ?? 'solid';
    for (const [id, key] of ownEffectKeys) {
      if (pipeEffects.some((each) => each.id === id)) continue;
      key.remove();
      ownEffectKeys.delete(id);
    }
    pipeEffects.forEach((each, index) => {
      let key = ownEffectKeys.get(each.id);
      if (!key) {
        key = element('button', 'chip');
        key.type = 'button';
        key.append(element('span', 'name', each.name));
        key.title = each.description;
        key.addEventListener('click', () =>
          setMany('effect', targeted(), () => (each.id === 'solid' ? null : each.id)),
        );
        ownEffectKeys.set(each.id, key);
      }
      if (ownEffectHolder.children[index] !== key) {
        ownEffectHolder.insertBefore(key, ownEffectHolder.children[index] ?? null);
      }
      const on = effect !== undefined && now === each.id;
      key.classList.toggle('is-on', on);
      key.setAttribute('aria-pressed', String(on));
    });
  }

  /** The palettes that the strips of the target list, the usual ones first. */
  function drawPalettes() {
    if (!paletteHolder) return;
    const here = targeted();
    const listed = here
      .map((item) => stateOf(item)?.palettes?.[item.id])
      .find((list) => Array.isArray(list) && list.length > 0);
    const { common, rest } = paletteGroups(listed);
    const now = commonValue(here.map((item) => stateOf(item)?.palette?.[item.id] ?? null));
    const names = [...common, ...(palettesOpen ? rest : rest.filter((name) => name === now))];
    paletteMoreKey.hidden = rest.length === 0;
    paletteMoreKey.firstChild.textContent = palettesOpen
      ? 'Fewer palettes'
      : `More palettes (${rest.length})`;
    paletteMoreKey.setAttribute('aria-pressed', String(palettesOpen));
    for (const [name, key] of paletteKeys) {
      if (names.includes(name)) continue;
      key.remove();
      paletteKeys.delete(name);
    }
    names.forEach((name, index) => {
      let key = paletteKeys.get(name);
      if (!key) {
        key = element('button', 'chip');
        key.type = 'button';
        key.append(element('span', 'name', name));
        key.addEventListener('click', () => setMany('palette', targeted(), () => name));
        paletteKeys.set(name, key);
      }
      if (paletteHolder.children[index] !== key) {
        paletteHolder.insertBefore(key, paletteHolder.children[index] ?? null);
      }
      const on = now === name;
      key.classList.toggle('is-on', on);
      key.setAttribute('aria-pressed', String(on));
    });
    paletteNote.textContent = listed
      ? 'Colour 1 is the colour above; most palettes bring their own.'
      : 'The palettes appear when a pipe is online.';
  }

  /** Which look is on, and which pace, for the pipes the target means. */
  function drawLooksAndPace(here) {
    const states = here.map(({ item }) => {
      const state = stateOf(item);
      return {
        effect: state?.effect?.[item.id] ?? null,
        palette: state?.palette?.[item.id] ?? null,
        intensity: state?.intensity?.[item.id] ?? null,
        pace: state?.pace?.[item.id] ?? 1,
        colour: state?.colour?.[item.id] ?? { red: 1, green: 1, blue: 1 },
      };
    });
    for (const look of looks) {
      const key = looksKeys.get(look.id);
      if (!key) continue;
      const on = lookIsOn(look, states);
      key.classList.toggle('is-on', on);
      key.setAttribute('aria-pressed', String(on));
    }
    const pace = commonValue(states.map((each) => each.pace));
    for (const [value, key] of paceKeys) {
      key.classList.toggle('is-on', pace === value);
      key.setAttribute('aria-pressed', String(pace === value));
    }
  }

  return {
    /** Draws the tab for a group of the decor, and again whenever the state may have changed. */
    render(next) {
      items = decorFixtures(shell, next).flatMap((fixture) => [
        ...(fixture.details?.switches ?? []).map((each) => ({
          kind: 'switch',
          fixture: fixture.id,
          id: each.id,
          label: each.label,
        })),
        ...(fixture.details?.strips ?? []).map((each) => ({
          kind: 'strip',
          fixture: fixture.id,
          id: each.id,
          label: each.label,
          rendered: each.rendered === true,
        })),
      ]);
      looks = [];
      pipeEffects = decorFixtures(shell, next).flatMap(
        (fixture) => fixture.details?.pipeEffects ?? [],
      );
      for (const fixture of decorFixtures(shell, next)) {
        for (const look of fixture.details?.looks ?? []) {
          if (!looks.some((each) => each.id === look.id)) looks.push(look);
        }
      }
      const wanted = `${items
        .map((item) => `${item.kind}/${item.fixture}/${item.id}/${item.label}/${item.rendered}`)
        .join(' ')}|${looks.map((look) => look.id).join(' ')}`;
      if (wanted !== signature) {
        signature = wanted;
        build();
      }
      draw();
    },
  };
}
