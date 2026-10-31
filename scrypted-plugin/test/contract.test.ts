import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptsCommand, encodeState, eventType, parseSnapshotRequest, slug, streamUrlFor, Topics, validateEntities, validateEntity } from '../src/contract';

test('slug follows Home Assistant for plain names', () => {
    assert.equal(slug('Front Door'), 'front_door');
    assert.equal(slug('garage_2'), 'garage_2');
    assert.equal(slug('Café  Terrace!'), 'cafe_terrace');
});

test('eventType keeps class names that are already valid and normalises others', () => {
    assert.equal(eventType('verified_person'), 'verified_person');
    assert.equal(eventType('dog_cat'), 'dog_cat');
    assert.equal(eventType('Person'), 'person');
    assert.equal(eventType(''), undefined);
    assert.equal(eventType(undefined), undefined);
});

test('validateEntity keeps contract fields and drops anything else', () => {
    const e = validateEntity({ key: 'person', name: 'Person presence', platform: 'binary_sensor', device_class: 'occupancy', object_id: 'front_door_person', extra: 1 });
    assert.deepEqual(e, { key: 'person', name: 'Person presence', platform: 'binary_sensor', device_class: 'occupancy', object_id: 'front_door_person' });
});

test('validateEntity refuses bad keys, platforms and platform-specific fields', () => {
    assert.throws(() => validateEntity({ key: 'Bad Key', name: 'x', platform: 'sensor' }));
    assert.throws(() => validateEntity({ key: 'a', name: 'x', platform: 'light' }));
    assert.throws(() => validateEntity({ key: 'a', name: 'x', platform: 'binary_sensor', unit: '%' }));
    assert.throws(() => validateEntity({ key: 'a', name: 'x', platform: 'sensor', event_types: ['x'] }));
    assert.throws(() => validateEntity({ key: 'a', name: 'x', platform: 'sensor', object_id: '../x' }));
    assert.throws(() => validateEntity({ key: 'a', name: '', platform: 'sensor' }));
});

test('validateEntities refuses duplicates and oversized lists', () => {
    const one = { key: 'a', name: 'A', platform: 'sensor' };
    assert.throws(() => validateEntities([one, one]));
    assert.throws(() => validateEntities(Array.from({ length: 65 }, (_, i) => ({ ...one, key: `k${i}` }))));
    assert.equal(validateEntities([one]).length, 1);
});

test('encodeState', () => {
    assert.equal(encodeState(true), 'ON');
    assert.equal(encodeState(false), 'OFF');
    assert.equal(encodeState(null), '');
    assert.equal(encodeState(42), '42');
    assert.equal(encodeState(NaN), '');
    assert.throws(() => encodeState('x'.repeat(256)));
});

test('Topics builds and parses only the inbound topics the bridge serves', () => {
    const t = new Topics('scrypted');
    assert.equal(t.state('42', 'bridge', 'motion'), 'scrypted/devices/42/bridge/state/motion');
    assert.deepEqual(t.parse('scrypted/devices/42/coral-guard/set/person'), { kind: 'set', device: '42', source: 'coral-guard', key: 'person' });
    assert.deepEqual(t.parse('scrypted/devices/42/bridge/snapshot/request'), { kind: 'snapshot', device: '42' });
    assert.equal(t.parse('scrypted/devices/42/bridge/state/motion'), undefined);
    assert.equal(t.parse('scrypted/devices/42/other/snapshot/request'), undefined);
    assert.equal(t.parse('other/devices/42/bridge/set/x'), undefined);
    assert.equal(t.parse('scrypted/devices/4 2/bridge/set/x'), undefined);
    assert.throws(() => new Topics('scrypted/#'));
    assert.throws(() => new Topics(''));
});

test('parseSnapshotRequest', () => {
    assert.deepEqual(parseSnapshotRequest('{"id":"abc","width":640}'), { id: 'abc', width: 640, height: undefined });
    assert.deepEqual(parseSnapshotRequest('{"id":"abc","width":99999}'), { id: 'abc', width: undefined, height: undefined });
    assert.equal(parseSnapshotRequest('{"id":"a/b"}'), undefined);
    assert.equal(parseSnapshotRequest('not json'), undefined);
});

test('acceptsCommand', () => {
    assert.equal(acceptsCommand('switch', 'ON'), true);
    assert.equal(acceptsCommand('switch', 'PRESS'), false);
    assert.equal(acceptsCommand('button', 'PRESS'), true);
    assert.equal(acceptsCommand('binary_sensor', 'ON'), false);
});

test('streamUrlFor points localhost at the configured host and keeps the path', () => {
    assert.equal(streamUrlFor('rtsp://localhost:40000/0123abcd', '127.0.0.1'), 'rtsp://127.0.0.1:40000/0123abcd');
    assert.equal(streamUrlFor('rtsp://127.0.0.1:40000/0123abcd', '192.0.2.10'), 'rtsp://192.0.2.10:40000/0123abcd');
    assert.equal(streamUrlFor('http://localhost/x', '127.0.0.1'), undefined);
    assert.equal(streamUrlFor('nonsense', '127.0.0.1'), undefined);
});
