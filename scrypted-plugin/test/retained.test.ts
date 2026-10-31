import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RetainedLedger, staleOwned } from '../src/retained';

test('topics retained by an earlier run, not set again and owned, are stale once', () => {
    const l = new RetainedLedger(['a', 'b', 'c', 'x/other']);
    l.note('a', 'x', true);
    l.note('d', Buffer.from('y'), true);
    l.note('b', 'x', true);
    l.note('b', '', true);
    assert.deepEqual(l.takeStale(t => !t.startsWith('x/')).sort(), ['b', 'c']);
    assert.deepEqual(l.takeStale(t => !t.startsWith('x/')), []);
    // a topic not owned yet stays for a later check
    assert.deepEqual(l.topics().sort(), ['a', 'd', 'x/other']);
    assert.deepEqual(l.takeStale(() => true), ['x/other']);
});

test('note reports only changes to the set of retained topics', () => {
    const l = new RetainedLedger([]);
    assert.equal(l.note('a', 'ON', true), true);
    assert.equal(l.note('a', 'OFF', true), false);
    assert.equal(l.note('a', '', true), true);
    assert.equal(l.note('a', '', true), false);
});

test('clears made while disconnected are replayed once, unless the topic was set again', () => {
    const l = new RetainedLedger([]);
    l.note('a', 'x', true);
    l.note('b', 'x', true);
    l.note('a', '', false);
    l.note('b', '', false);
    l.note('b', 'again', false);
    assert.deepEqual(l.takeCleared(), ['a']);
    assert.deepEqual(l.takeCleared(), []);
});

test('an add-on image its current config still declares is never stale', () => {
    const addons = {
        hasSource: (s: string) => s === 'guard',
        declaresImage: (d: string, s: string, k: string) => d === '42' && s === 'guard' && k === 'last_detection',
    };
    const l = new RetainedLedger([
        'scrypted/devices/42/guard/image/last_detection',
        'scrypted/devices/42/guard/image/old_shot',
        'scrypted/devices/42/guard/state/person',
        'scrypted/devices/42/bridge/state/motion',
        'scrypted/devices/42/other/image/last_detection',
    ]);
    const stale = l.takeStale(t => staleOwned(t, 'scrypted', addons));
    assert.deepEqual(stale.sort(), [
        'scrypted/devices/42/bridge/state/motion',
        'scrypted/devices/42/guard/image/old_shot',
        'scrypted/devices/42/guard/state/person',
    ]);
    // kept for a later check: cleared once the config stops declaring it
    assert.ok(l.topics().includes('scrypted/devices/42/guard/image/last_detection'));
    assert.deepEqual(l.takeStale(t => staleOwned(t, 'scrypted', { ...addons, declaresImage: () => false })), ['scrypted/devices/42/guard/image/last_detection']);
});
