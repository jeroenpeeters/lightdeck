// The decor page, a setup page: how the pipes of the decor (the strips of WLED that lightdeck draws) are put
// together (Jeroen, 2026-11-01). Whether they are one long pipe that an effect runs through, in which order,
// and which of them are mounted the other way round, because he does not know yet how he will hang them. It is
// not on the live page: it is set once, when the pipes are hung. Plain browser JavaScript, no build step.
//
// The fixture keeps it (`linked`, `order` and `reverse` of its state, set with an update) and writes it to
// decor.json; this page only sends a change and draws what the server says. Every row and every piece of the
// drawing is made once and put in order again when the state changes, so that no key moves under a finger.

import { start } from './shell.js';
import { $, element, sentence, setNotice } from './ui.js';

async function main() {
  const shell = await start({ page: 'decor' });
  if (!shell) return;
  document.title = 'Decor · Lightdeck';

  const fixture = shell.fixtures.find((each) => each.kind === 'decor');
  const pipes = (fixture?.details?.strips ?? []).filter((strip) => strip.rendered);
  const byId = new Map(pipes.map((pipe) => [pipe.id, pipe]));

  if (!fixture || pipes.length === 0) {
    $('where').textContent = 'No pipes';
    $('dc-link').disabled = true;
    $('dc-link-sub').textContent =
      'The rig has no pipes that lightdeck draws. Add strips to the decor in rig.yaml.';
    return;
  }

  const update = async (body) => {
    const answer = await shell.ask(`/api/fixtures/${fixture.id}/update`, body);
    setNotice($('dc-notice'), answer.ok ? '' : answer.lost ? answer.error : sentence(answer.error));
  };

  // ---- the rows ----
  const list = $('dc-list');
  const rows = new Map();
  for (const pipe of pipes) {
    const row = element('li', 'dc-row');
    const pos = element('span', 'dc-pos num');
    const name = element('div', 'dc-name');
    const nm = element('span', 'nm', pipe.label);
    const sub = element('span', 'sub');
    name.append(nm, sub);
    const key = (text, label, onPress, className = 'key c') => {
      const made = element('button', className, text);
      made.type = 'button';
      made.setAttribute('aria-label', label);
      made.addEventListener('click', onPress);
      return made;
    };
    const move = (step) => () => {
      const order = [...(shell.stateOf(fixture.id)?.order ?? [])];
      const at = order.indexOf(pipe.id);
      const to = at + step;
      if (at < 0 || to < 0 || to >= order.length) return;
      order.splice(at, 1);
      order.splice(to, 0, pipe.id);
      update({ order });
    };
    const up = key('↑', `Move ${pipe.label} earlier`, move(-1));
    const down = key('↓', `Move ${pipe.label} later`, move(1));
    const turn = key('', `Reverse ${pipe.label}`, () =>
      update({ reverse: { [pipe.id]: !shell.stateOf(fixture.id)?.reverse?.[pipe.id] } }),
    );
    turn.classList.add('dc-turn');
    turn.append(element('span', 'arrow', '⇄'), element('span', 'word', 'Reverse'));
    turn.setAttribute('aria-pressed', 'false');
    row.append(pos, name, up, down, turn);
    rows.set(pipe.id, { row, pos, sub, up, down, turn });
  }

  // ---- the drawing of the chain ----
  const chain = $('dc-chain');
  const pieces = new Map();
  for (const pipe of pipes) {
    const piece = element('div', 'dc-seg');
    piece.style.flex = `${pipe.leds} 1 0`;
    const nm = element('span', 'nm', pipe.label);
    const way = element('span', 'way');
    piece.append(nm, way);
    pieces.set(pipe.id, { piece, way });
  }

  const link = $('dc-link');
  link.addEventListener('click', () => update({ linked: !shell.stateOf(fixture.id)?.linked }));

  function draw() {
    const state = shell.stateOf(fixture.id);
    if (!state) return;
    const order = (state.order ?? []).filter((id) => byId.has(id));
    const linked = state.linked === true && pipes.length > 1;

    $('where').textContent = `${pipes.length} ${pipes.length === 1 ? 'pipe' : 'pipes'} · ${
      pipes.length === 1 ? 'one pipe' : linked ? 'linked as one pipe' : 'apart'
    }`;
    link.disabled = pipes.length < 2;
    link.classList.toggle('is-on', linked);
    link.setAttribute('aria-pressed', String(linked));
    const tag = $('dc-link-tag');
    tag.textContent = linked ? 'Linked' : 'Apart';
    tag.className = linked ? 'tag on' : 'tag mute';
    $('dc-link-sub').textContent =
      pipes.length < 2
        ? 'There is one pipe, so there is nothing to link.'
        : linked
          ? 'An effect runs through the pipes one after the other, in the order below.'
          : 'Each pipe runs its own effect. Press to link them into one long pipe.';

    order.forEach((id, i) => {
      const parts = rows.get(id);
      const pipe = byId.get(id);
      if (!parts || !pipe) return;
      const turned = state.reverse?.[id] === true;
      parts.pos.textContent = String(i + 1);
      const address = state.hosts?.[id];
      parts.sub.textContent = `${pipe.leds} LEDs · ${address ?? 'waiting for its address'}`;
      parts.up.disabled = i === 0;
      parts.down.disabled = i === order.length - 1;
      parts.turn.classList.toggle('is-on', turned);
      parts.turn.setAttribute('aria-pressed', String(turned));
      const way = pieces.get(id);
      if (way) {
        way.way.textContent = turned ? `LED ${pipe.leds} → 1` : `LED 1 → ${pipe.leds}`;
      }
    });
    list.append(...order.map((id) => rows.get(id)?.row).filter(Boolean));
    chain.classList.toggle('is-linked', linked);
    chain.append(...order.map((id) => pieces.get(id)?.piece).filter(Boolean));

    const first = byId.get(order[0] ?? '');
    const last = byId.get(order[order.length - 1] ?? '');
    const enters = (id) => (state.reverse?.[id] === true ? 'its last LED' : 'its first LED');
    $('dc-chain-note').textContent = linked
      ? `The effect enters ${first?.label} at ${enters(first?.id)} and leaves ${last?.label}. Each box shows how the LEDs of a pipe run along the chain.`
      : 'Not linked: each pipe runs by itself. Each box shows which way its LEDs run.';
  }

  draw();
  shell.on('fixtures', (id) => {
    if (id === fixture.id) draw();
  });
}

main();
