// The video wall page: the controls of the video wall (videowallPanel.js, which the tablet page has
// as a tab too) on a page of their own, with the shell around them. Plain browser JavaScript, no
// build step.
//
// Its notice is kept at the bottom of the screen, with the one of the shell, so that no key moves
// when it comes or goes.

import { start } from './shell.js';
import { $, sentence, setNotice } from './ui.js';
import { mountVideoWall } from './videowallPanel.js';

/** What the server answered to what could not be done. */
let failure = '';

async function main() {
  const shell = await start({ page: 'videowall' });
  if (!shell) return;
  document.title = 'Video wall · Lightdeck';
  // The notice of the shell joins the one of the page, where it takes no room from the keys.
  $('notices').prepend($('notice'));

  async function ask(url, body = {}) {
    failure = '';
    const answer = await shell.ask(url, body);
    if (!answer.ok) failure = answer.lost ? answer.error : sentence(answer.error);
    setNotice($('wall-notice'), failure);
    return answer;
  }

  const wall = mountVideoWall($('wall'), { shell, ask });
  wall.activate();
  shell.on('videowall', () => {
    failure = '';
    setNotice($('wall-notice'), failure);
  });
}

main();
