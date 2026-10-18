// The page that says why the tablet page can or cannot be installed as an app. Plain browser
// JavaScript, no build step. Chrome on Android installs a page, with no bar of the browser, only
// when it is on https or on an address that the browser was told to trust, has a manifest with
// icons, and has a service worker; there is no way to ask Chrome why it does not offer it, so this
// shows the pieces one by one. It also takes the key that Chrome gives when it does offer the
// install (`beforeinstallprompt`) and puts it on the page.

const list = document.getElementById('checks');
const installKey = document.getElementById('install-key');

/** A line of the list: its name, whether it is good, and what it says. */
function line(name) {
  const item = document.createElement('li');
  item.className = 'check';
  item.dataset.state = 'wait';
  const mark = document.createElement('span');
  mark.className = 'check-mark';
  mark.textContent = '…';
  const title = document.createElement('span');
  title.className = 'check-name';
  title.textContent = name;
  const says = document.createElement('p');
  says.className = 'check-says';
  item.append(mark, title, says);
  list.append(item);
  return (state, text) => {
    item.dataset.state = state;
    mark.textContent = state === 'ok' ? '✓' : state === 'bad' ? '✗' : '…';
    says.textContent = text;
  };
}

const address = line('The address of this page');
const secure = line('The browser trusts this address');
const worker = line('Service worker');
const manifest = line('Manifest');
const icons = line('Icons');
const mode = line('How the page is open now');
const prompt = line('Chrome offers the install');

address(
  'ok',
  `${location.origin}. In the flag, enter exactly this, with the port and without a path.`,
);

if (window.isSecureContext) {
  secure('ok', 'Yes: https, localhost, or an address that the flag treats as secure.');
} else {
  secure(
    'bad',
    'No. Over a plain http address Chrome offers no install. Open chrome://flags/#unsafely-treat-insecure-origin-as-secure, set it to Enabled with the address above, press Relaunch (or swipe Chrome away from the recent apps and open it again), then reload this page.',
  );
}

async function checkWorker() {
  if (!('serviceWorker' in navigator)) {
    worker(
      'bad',
      'This browser has no service worker here, which is what a page that is not trusted gets.',
    );
    return;
  }
  try {
    const registered = await navigator.serviceWorker.register('/sw.js');
    const state = registered.active ? 'active' : registered.installing ? 'installing' : 'waiting';
    worker('ok', `Registered for ${registered.scope} (${state}).`);
  } catch (error) {
    worker('bad', `It could not be registered: ${error.message}`);
  }
}

async function checkManifest() {
  const link = document.querySelector('link[rel="manifest"]');
  try {
    const response = await fetch(link.href);
    if (!response.ok) throw new Error(`${response.status}`);
    const data = await response.json();
    manifest(
      'ok',
      `${data.name}, opens ${data.start_url}, ${data.display_override?.[0] ?? data.display}. If this is not what lightdeck has now, lightdeck has to be started again: it reads its pages once.`,
    );
    let good = 0;
    const problems = [];
    await Promise.all(
      (data.icons ?? []).map(
        (icon) =>
          new Promise((resolve) => {
            const image = new Image();
            image.onload = () => {
              good += 1;
              resolve();
            };
            image.onerror = () => {
              problems.push(icon.src);
              resolve();
            };
            image.src = icon.src;
          }),
      ),
    );
    if (problems.length === 0 && good >= 2) icons('ok', `${good} icons load.`);
    else icons('bad', `${good} load. These do not: ${problems.join(', ') || 'there are too few'}.`);
  } catch (error) {
    manifest(
      'bad',
      `The manifest could not be read (${error.message}). Lightdeck has to be started again to serve it.`,
    );
    icons('bad', 'No manifest, so no icons.');
  }
}

function checkMode() {
  const modes = ['fullscreen', 'standalone', 'minimal-ui', 'browser'];
  const now =
    modes.find((each) => window.matchMedia(`(display-mode: ${each})`).matches) ?? 'unknown';
  mode(
    now === 'browser' ? 'wait' : 'ok',
    now === 'browser'
      ? 'In the browser, with its bar. Once it is installed it opens as standalone or fullscreen.'
      : `As an app (${now}).`,
  );
}

let offered = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  offered = event;
  installKey.hidden = false;
  prompt('ok', 'Yes. Press Install Lightdeck above.');
});
window.addEventListener('appinstalled', () => {
  installKey.hidden = true;
  prompt('ok', 'It is installed. Open it from the home screen.');
});
installKey.addEventListener('click', async () => {
  if (!offered) return;
  offered.prompt();
  await offered.userChoice;
  offered = null;
  installKey.hidden = true;
});

prompt('wait', 'Waiting for Chrome…');
checkMode();
checkWorker();
checkManifest();
// Chrome says it within a moment, once the worker and the manifest are known. Without it, say so.
setTimeout(() => {
  if (offered) return;
  prompt(
    window.matchMedia('(display-mode: browser)').matches ? 'bad' : 'ok',
    window.matchMedia('(display-mode: browser)').matches
      ? 'Not (yet). Check the lines above: every one has to be good. Then reload this page once, and look in the ⋮ menu for Install app.'
      : 'This is the installed app already.',
  );
}, 6000);
