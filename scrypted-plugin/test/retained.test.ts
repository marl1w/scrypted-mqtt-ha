import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RetainedLedger } from '../src/retained';

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
