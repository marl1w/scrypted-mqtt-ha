import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptsCommand, decodeImage, encodeState, eventType, helloMessage, isSource, MAX_IMAGE_BYTES, parseSnapshotRequest, slug, streamUrlFor, Topics, validateEntities, validateEntity } from '../src/contract';

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

test('validateEntities with a dropped callback leaves out invalid entities and keeps the rest', () => {
    const one = { key: 'a', name: 'A', platform: 'sensor' };
    const reasons: string[] = [];
    const out = validateEntities([one, { key: 'b', name: 'B', platform: 'video' }, { ...one, key: 'c' }], r => reasons.push(r));
    assert.deepEqual(out.map(e => e.key), ['a', 'c']);
    assert.deepEqual(reasons, ['b: invalid platform']);
    assert.throws(() => validateEntities([one, { key: 'b', name: 'B', platform: 'video' }]));
    // duplicates and oversized lists still refuse the whole list
    assert.throws(() => validateEntities([one, one], () => { }));
    assert.throws(() => validateEntities(Array.from({ length: 65 }, (_, i) => ({ ...one, key: `k${i}` })), () => { }));
});

test('camera is not a source name: it would collide with the extra cameras in Home Assistant', () => {
    assert.equal(isSource('camera'), false);
    assert.equal(isSource('coral-guard'), true);
    assert.equal(new Topics('scrypted').parse('scrypted/devices/42/camera/set/high'), undefined);
});

test('the hello lists the platforms the bridge accepts, image included', () => {
    assert.deepEqual(helloMessage(), { v: 1, type: 'hello', platforms: ['binary_sensor', 'sensor', 'switch', 'button', 'event', 'image'] });
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

test('decodeImage takes base64 of a JPEG up to 1 MB, and null or empty as no image', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    assert.deepEqual(decodeImage(jpeg.toString('base64')), jpeg);
    assert.equal(decodeImage(null).length, 0);
    assert.equal(decodeImage('').length, 0);
    assert.throws(() => decodeImage(Buffer.from('not a jpeg').toString('base64')), /not a JPEG/);
    assert.throws(() => decodeImage('not base64!'), /base64/);
    assert.throws(() => decodeImage(jpeg), /base64/);
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0);
    big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
    assert.throws(() => decodeImage(big.toString('base64')), /1 MB/);
    big[MAX_IMAGE_BYTES - 1] = 0;
    assert.equal(decodeImage(big.subarray(0, MAX_IMAGE_BYTES).toString('base64')).length, MAX_IMAGE_BYTES);
});

test('image is a platform and its topic sits under the source', () => {
    assert.equal(validateEntity({ key: 'last_detection', name: 'Last detection', platform: 'image' }).platform, 'image');
    assert.equal(acceptsCommand('image', 'ON'), false);
    assert.equal(new Topics('scrypted').image('42', 'guard', 'last_detection'), 'scrypted/devices/42/guard/image/last_detection');
});
