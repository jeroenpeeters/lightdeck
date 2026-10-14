// The calibrate panel of the simulator: how a bar of the spider turns for a value of its
// tilt. The tilt is set on the real spider through lightdeck (its page, the deck, a scene);
// this panel shows the value that is being sent and the angle that the simulator gives the
// bar for it, and the operator moves the angle until the bar stands where the real one does.
// That stores a point: this tilt gives that angle. Between two points a bar turns in a
// straight line, so a few points make the whole movement, which is not linear.
//
// It also takes timings for the motor speed, which says how fast the bars turn. The operator
// sets a motor speed on the real spider, lets the bars make a complete swing, times it, and
// types the seconds in. That stores a point: this motor speed turns a bar so many degrees per
// second. The same speed is used for both bars, and a bar turns at a constant speed.
//
// The panel knows nothing of three.js. It works on the bars of a simulated fixture:
//
//   sim.id, sim.bars[i] = { curve, base, custom, preview, tilt }
//   curve      the points of [tilt, degrees] that are in use
//   base       the calibration of the fixture itself, which a reset goes back to
//   custom     true when `curve` is the operator's and has to be kept
//   preview    the angle to show while the slider is moving, else null
//   tilt       the tilt that is being sent, kept up to date by the simulator
//   sim.speed = { curve, base, custom }     points of [motor speed, degrees per second]
//   sim.motorSpeed                          the motor speed that is being sent, 0..1
//
//   const calibration = createCalibration({ root, save, reset, resetSpeed });
//   calibration.show(sim)            the fixture to calibrate, or null
//   calibration.update(sim, look)    call on every frame while the panel is open

import { curveAt, removePoint, replacePoint, setPoint, tiltDegrees } from '/spiderPose.js';

const ANGLE_LIMIT = 180;

function make(tag, className, text) {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}
function key(text, onClick, label) {
  const made = make('button', 'key', text);
  made.type = 'button';
  if (label) made.setAttribute('aria-label', label);
  made.addEventListener('click', onClick);
  return made;
}
const percent = (tilt) => `${(tilt * 100).toFixed(1)}%`;
const degrees = (value) => `${Math.round(value * 10) / 10}°`;
const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * A number field with its name above it, for a value that is typed in. `commit` is called with
 * the number when the field is left or Enter is pressed, and with nothing it can use the
 * field goes back to what it showed.
 */
function numberField(label, value, { min, max, step }, commit) {
  const wrap = make('label', 'point-field');
  wrap.append(make('span', '', label));
  const input = make('input', 'field');
  Object.assign(input, { type: 'number', min: String(min), max: String(max), step: String(step) });
  input.inputMode = 'decimal';
  input.value = String(value);
  input.addEventListener('change', () => {
    const number = Number(input.value);
    if (input.value.trim() === '' || !Number.isFinite(number)) {
      input.value = String(value);
      return;
    }
    commit(Math.max(min, Math.min(max, number)));
  });
  wrap.append(input);
  return { wrap, input };
}

export function createCalibration({ root, save, reset, resetSpeed }) {
  const list = root.querySelector('#calibrate-bars');
  const exportBox = root.querySelector('#calibrate-export');
  const copy = root.querySelector('#calibrate-copy');
  const hint = root.querySelector('#calibrate-hint');
  let sim = null;
  let rows = [];
  /** What the section of the motor speed has on screen, or null without a fixture. */
  let speedView = null;

  function drawExport() {
    exportBox.value = sim
      ? `tiltCurve: ${JSON.stringify(sim.bars.map((bar) => bar.curve))}\nmotorSpeedCurve: ${JSON.stringify(sim.speed.curve)}`
      : '';
  }

  /** The angle of the complete swing of the bar that turns furthest, in degrees. */
  function completeSwing() {
    let widest = 0;
    for (const bar of sim.bars) {
      const first = bar.curve[0];
      const last = bar.curve[bar.curve.length - 1];
      if (first && last) widest = Math.max(widest, Math.abs(first[1] - last[1]));
    }
    return widest > 0 ? widest : 180;
  }

  function drawSpeedPoints() {
    const { speed } = sim;
    const swing = completeSwing();
    const changed = (curve) => {
      speed.curve = curve;
      speed.custom = true;
      save(sim);
      drawSpeedPoints();
      drawExport();
    };
    const items = speed.curve.map(([at, rate], index) => {
      const item = make('li', 'point');
      const fields = make('div', 'point-fields');
      const place = (at2, rate2) => changed(replacePoint(speed.curve, index, at2, rate2));
      fields.append(
        numberField(
          'Motor speed %',
          round(at * 100, 1),
          { min: 0, max: 100, step: 0.1 },
          (number) => place(round(number / 100, 3), rate),
        ).wrap,
        numberField('Degrees/s', round(rate, 1), { min: 0.1, max: 5000, step: 1 }, (number) =>
          place(at, round(number, 1)),
        ).wrap,
        numberField(
          `Seconds for ${degrees(swing)}`,
          round(swing / rate, 2),
          { min: 0.01, max: 600, step: 0.1 },
          (number) => place(at, round(swing / number, 1)),
        ).wrap,
      );
      const remove = key(
        '×',
        () => changed(removePoint(speed.curve, index)),
        `Remove the speed at ${percent(at)}`,
      );
      remove.disabled = speed.curve.length <= 1;
      item.append(fields, remove);
      return item;
    });

    // A point typed in by hand: the motor speed and the speed it gives.
    let addAt = speedView.addAt ?? round(sim.motorSpeed * 100, 1);
    let addRate = speedView.addRate ?? round(curveAt(sim.motorSpeed, speed.curve), 1);
    const add = make('li', 'point point-add');
    const fields = make('div', 'point-fields');
    fields.append(
      numberField('Motor speed %', addAt, { min: 0, max: 100, step: 0.1 }, (number) => {
        addAt = number;
        speedView.addAt = number;
      }).wrap,
      numberField('Degrees/s', addRate, { min: 0.1, max: 5000, step: 1 }, (number) => {
        addRate = number;
        speedView.addRate = number;
      }).wrap,
    );
    add.append(
      fields,
      key(
        'Add',
        () => {
          changed(setPoint(speed.curve, round(addAt / 100, 3), round(addRate, 1)));
        },
        'Add this speed',
      ),
    );
    speedView.points.replaceChildren(...items, add);
  }

  /** The section for the motor speed: what is sent, what it gives, and the timing to enter. */
  function buildSpeed() {
    const section = make('section', 'cal-bar');
    const head = make('div', 'cal-head');
    head.append(
      make('h3', '', 'Motor speed, both bars'),
      key('Reset speed', () => {
        resetSpeed(sim);
        drawSpeedPoints();
        drawExport();
      }),
    );

    const sent = make('output', 'cal-value', '');
    const sentLine = make('p', 'cal-line');
    sentLine.append(make('span', '', 'Motor speed being sent'), sent);
    const rate = make('output', 'cal-value', '');
    const rateLine = make('p', 'cal-line');
    rateLine.append(make('span', '', 'Bars turn at'), rate);

    const form = make('form', 'cal-form');
    const angleId = 'cal-swing-angle';
    const secondsId = 'cal-swing-seconds';
    const angleLabel = make('label', '', 'Angle of the move (degrees)');
    angleLabel.htmlFor = angleId;
    const angleInput = make('input', 'field');
    Object.assign(angleInput, { id: angleId, type: 'number', min: '1', step: '1' });
    angleInput.inputMode = 'decimal';
    angleInput.value = String(Math.round(completeSwing()));
    const secondsLabel = make('label', '', 'Time it took (seconds)');
    secondsLabel.htmlFor = secondsId;
    const secondsInput = make('input', 'field');
    Object.assign(secondsInput, { id: secondsId, type: 'number', min: '0.1', step: '0.1' });
    secondsInput.inputMode = 'decimal';
    const message = make('p', 'hint cal-message', '');
    message.setAttribute('role', 'status');
    const storeKey = make('button', 'key', 'Store for this motor speed');
    storeKey.type = 'submit';
    form.append(angleLabel, angleInput, secondsLabel, secondsInput, storeKey, message);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const angle = Number(angleInput.value);
      const seconds = Number(secondsInput.value);
      if (!(angle > 0) || !(seconds > 0)) {
        message.textContent = 'Enter the angle and the seconds the move took.';
        return;
      }
      const at = Math.round(sim.motorSpeed * 1000) / 1000;
      sim.speed.curve = setPoint(sim.speed.curve, at, Math.round((angle / seconds) * 10) / 10);
      sim.speed.custom = true;
      message.textContent = `Stored: ${percent(at)} turns ${degrees(angle / seconds)}/s.`;
      secondsInput.value = '';
      save(sim);
      drawSpeedPoints();
      drawExport();
    });

    speedView = { sent, rate, points: make('ul', 'points') };
    section.append(
      head,
      make(
        'p',
        'hint',
        'Set a motor speed on the real spider, let the bars make one complete swing, time it, and enter it here.',
      ),
      sentLine,
      rateLine,
      form,
      make('h4', '', 'Stored speeds (type to edit)'),
      speedView.points,
    );
    list.append(section);
    drawSpeedPoints();
  }

  function drawPoints(row) {
    const { bar } = row;
    const changed = (curve) => {
      bar.curve = curve;
      bar.custom = true;
      save(sim);
      drawPoints(row);
      drawExport();
    };
    const angleSpec = { min: -ANGLE_LIMIT, max: ANGLE_LIMIT, step: 0.1 };
    const items = bar.curve.map(([tilt, angle], at) => {
      const item = make('li', 'point');
      const fields = make('div', 'point-fields');
      fields.append(
        numberField('Tilt %', round(tilt * 100, 1), { min: 0, max: 100, step: 0.1 }, (number) =>
          changed(replacePoint(bar.curve, at, round(number / 100, 3), angle)),
        ).wrap,
        numberField('Angle °', round(angle, 1), angleSpec, (number) =>
          changed(replacePoint(bar.curve, at, tilt, round(number, 1))),
        ).wrap,
      );
      const remove = key(
        '×',
        () => changed(removePoint(bar.curve, at)),
        `Remove the point at ${percent(tilt)}`,
      );
      remove.disabled = bar.curve.length <= 1;
      item.append(fields, remove);
      return item;
    });

    // A point typed in by hand.
    let addTilt = row.addTilt ?? round(bar.tilt * 100, 1);
    let addAngle = row.addAngle ?? round(tiltDegrees(bar.tilt, bar.curve), 1);
    const add = make('li', 'point point-add');
    const fields = make('div', 'point-fields');
    fields.append(
      numberField('Tilt %', addTilt, { min: 0, max: 100, step: 0.1 }, (number) => {
        addTilt = number;
        row.addTilt = number;
      }).wrap,
      numberField('Angle °', addAngle, angleSpec, (number) => {
        addAngle = number;
        row.addAngle = number;
      }).wrap,
    );
    add.append(
      fields,
      key(
        'Add',
        () => changed(setPoint(bar.curve, round(addTilt / 100, 3), round(addAngle, 1))),
        'Add this point',
      ),
    );
    row.points.replaceChildren(...items, add);
  }

  /** Stores the angle the bar is at now for the tilt that is being sent. */
  function commit(row, angle) {
    const { bar } = row;
    bar.curve = setPoint(
      bar.curve,
      Math.round(bar.tilt * 1000) / 1000,
      Math.round(angle * 10) / 10,
    );
    bar.custom = true;
    bar.preview = null;
    save(sim);
    drawPoints(row);
    drawExport();
  }

  function build() {
    list.replaceChildren();
    rows = [];
    speedView = null;
    hint.hidden = sim !== null;
    if (!sim) {
      drawExport();
      return;
    }
    const layout = sim.fixture.details.layout;
    sim.bars.forEach((bar, index) => {
      const section = make('section', 'cal-bar');
      const head = make('div', 'cal-head');
      const side = layout.side?.[index] === 'front' ? 'at the front' : 'at the back';
      head.append(make('h3', '', `Bar ${index + 1}, ${side}`));
      const row = { bar, points: make('ul', 'points') };

      const tiltOut = make('output', 'cal-value', '');
      const tilt = make('p', 'cal-line');
      tilt.append(make('span', '', 'Tilt being sent'), tiltOut);

      const slider = make('input');
      slider.type = 'range';
      slider.min = String(-ANGLE_LIMIT);
      slider.max = String(ANGLE_LIMIT);
      slider.step = '1';
      slider.id = `cal-angle-${index}`;
      const angleOut = make('output', 'cal-value', '');
      const angleLabel = make('label', '', 'Angle of the bar');
      angleLabel.htmlFor = slider.id;
      const angle = make('p', 'cal-line');
      angle.append(angleLabel, angleOut);

      slider.addEventListener('input', () => {
        bar.preview = Number(slider.value);
        angleOut.textContent = degrees(bar.preview);
      });
      slider.addEventListener('change', () => commit(row, Number(slider.value)));
      const nudge = (by) => () => {
        const now = bar.preview ?? tiltDegrees(bar.tilt, bar.curve);
        commit(row, Math.max(-ANGLE_LIMIT, Math.min(ANGLE_LIMIT, Math.round(now) + by)));
      };
      const control = make('div', 'cal-angle');
      control.append(
        key('−1°', nudge(-1), 'One degree less'),
        slider,
        key('+1°', nudge(1), 'One degree more'),
      );

      const resetKey = key('Reset bar', () => {
        reset(sim, index);
        drawPoints(row);
        drawExport();
      });
      head.append(resetKey);

      Object.assign(row, { tiltOut, angleOut, slider });
      section.append(
        head,
        tilt,
        angle,
        control,
        make('h4', '', 'Stored points (type to edit)'),
        row.points,
      );
      list.append(section);
      rows.push(row);
      drawPoints(row);
    });
    buildSpeed();
    drawExport();
  }

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(exportBox.value);
      copy.textContent = 'Copied';
    } catch {
      // Without the clipboard (a page that is not on localhost) the text is selected to copy.
      exportBox.select();
      copy.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => {
      copy.textContent = 'Copy';
    }, 1500);
  });

  return {
    show(next) {
      sim = next;
      build();
    },
    update(from) {
      if (!sim || from !== sim) return;
      if (speedView) {
        speedView.sent.textContent = percent(sim.motorSpeed);
        speedView.rate.textContent = `${degrees(curveAt(sim.motorSpeed, sim.speed.curve))}/s`;
      }
      for (const row of rows) {
        const { bar } = row;
        row.tiltOut.textContent = percent(bar.tilt);
        // While the slider is being moved it shows the angle of the operator, not the curve.
        if (bar.preview === null) {
          const now = tiltDegrees(bar.tilt, bar.curve);
          row.slider.value = String(Math.round(now));
          row.angleOut.textContent = degrees(now);
        }
      }
    },
  };
}
