import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSetup, fitSetup, readSetupFile, writeSetupFile } from './decorSetup.js';

const IDS = ['a', 'b', 'c'];

describe('the setup of the pipes', () => {
  it('starts apart, in the order of the rig, nothing reversed', () => {
    expect(defaultSetup(IDS)).toEqual({
      linked: false,
      order: ['a', 'b', 'c'],
      reverse: { a: false, b: false, c: false },
    });
  });

  it('keeps the known ids once in the given order and puts the others behind them', () => {
    expect(
      fitSetup({ linked: true, order: ['c', 'x', 'c', 'a'], reverse: { c: true, x: true } }, IDS),
    ).toEqual({ linked: true, order: ['c', 'a', 'b'], reverse: { a: false, b: false, c: true } });
  });

  it('takes nothing but true for linked and for a direction', () => {
    expect(fitSetup({ linked: 'yes', reverse: { a: 1, b: 'true' } }, IDS)).toEqual(
      defaultSetup(IDS),
    );
    expect(fitSetup(null, IDS)).toEqual(defaultSetup(IDS));
    expect(fitSetup([1, 2], IDS)).toEqual(defaultSetup(IDS));
  });

  it('is read from a file it wrote, and a file that is not there is the default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'decor-'));
    const file = join(dir, 'decor.json');
    expect(readSetupFile(file, IDS)).toEqual({ setup: defaultSetup(IDS) });
    writeSetupFile(file, {
      linked: true,
      order: ['b', 'a', 'c'],
      reverse: { a: true, b: false, c: false },
    });
    expect(readSetupFile(file, IDS)).toEqual({
      setup: { linked: true, order: ['b', 'a', 'c'], reverse: { a: true, b: false, c: false } },
    });
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
  });

  it('starts with the default and says why when the file is broken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'decor-'));
    const file = join(dir, 'decor.json');
    writeFileSync(file, '{ not json');
    const read = readSetupFile(file, IDS);
    expect(read.setup).toEqual(defaultSetup(IDS));
    expect(read.problem).toContain('not valid JSON');
  });
});
