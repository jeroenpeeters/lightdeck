// The video wall page, a setup page: the controls of the video wall (videowallPanel.js, which the
// tablet page has as a tab too, with the settings in its tab Text settings) under the top bar of the
// shell, with the settings and the library in the main column and "On the wall" in the side panel.
// Plain browser JavaScript, no build step.
//
// Its notice lies over the foot of the screen, with the one of the shell, so that no key moves when
// it comes or goes.

import { start } from './shell.js';
import { $, sentence, setNotice } from './ui.js';
import { mountVideoWall } from './videowallPanel.js';

/** What the server answered to what could not be done. */
let failure = '';

async function main() {
  const shell = await start({ page: 'videowall' });
  if (!shell) return;
  document.title = 'Video wall · Lightdeck';

  async function ask(url, body = {}) {
    failure = '';
    const answer = await shell.ask(url, body);
    if (!answer.ok) failure = answer.lost ? answer.error : sentence(answer.error);
    setNotice($('wall-notice'), failure);
    return answer;
  }

  /** The line under the title: whether the track goes to the wall, and where the player is. */
  function drawWhere() {
    const { settings } = shell.videowall;
    $('where').textContent = `Track text ${settings.enabled ? 'on' : 'off'} · ${settings.url}`;
  }

  const wall = mountVideoWall($('wall'), { shell, ask, side: $('wall-side') });
  wall.activate();
  drawWhere();
  shell.on('videowall', () => {
    failure = '';
    setNotice($('wall-notice'), failure);
    drawWhere();
  });
}

main();
