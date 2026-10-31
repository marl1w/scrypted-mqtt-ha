import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AddonRelay, SOURCE_TIMEOUT_MS } from '../src/addons';
import { EntitySpec } from '../src/contract';

function setup(published = new Set(['42'])) {
    const out: string[] = [];
    const logs: string[] = [];
    const added: string[] = [];
    let now = 1000;
    const relay = new AddonRelay({
        config: (d, s, e) => out.push(`config ${d} ${s} ${e ? e.map(x => x.key).join(',') : '-'}`),
        state: (d, s, k, p) => out.push(`state ${d} ${s} ${k}=${p}`),
        event: (d, s, k, p) => out.push(`event ${d} ${s} ${k} ${p}`),
        image: (d, s, k, j) => out.push(`image ${d} ${s} ${k} ${j.length}`),
        status: (s, on) => out.push(`status ${s} ${on ? 'online' : 'offline'}`),
        sourceAdded: s => added.push(s),
    }, d => published.has(d), m => logs.push(m), () => now);
    return { relay, out, logs, added, published, tick: (ms: number) => { now += ms; } };
}

const presence: EntitySpec[] = [
    { key: 'person', name: 'Person presence', platform: 'binary_sensor', device_class: 'occupancy' },
    { key: 'seen', name: 'Seen', platform: 'event' },
];
const msg = (type: string, extra: object = {}) => ({ v: 1, type, source: 'guard', device: '42', ...extra });

test('a source goes online with its first message and publishes config and changed states only', () => {
    const { relay, out } = setup();
    relay.handle('p1', msg('config', { entities: presence }));
    relay.handle('p1', msg('state', { key: 'person', value: 'ON' }));
    relay.handle('p1', msg('state', { key: 'person', value: 'ON' }));
    relay.handle('p1', msg('state', { key: 'person', value: 'OFF' }));
    assert.deepEqual(out, ['status guard online', 'config 42 guard person,seen', 'state 42 guard person=ON', 'state 42 guard person=OFF']);
});

test('the same config twice is published once', () => {
    const { relay, out } = setup();
    relay.handle('p1', msg('config', { entities: presence }));
    relay.handle('p1', msg('config', { entities: presence }));
    assert.equal(out.filter(l => l.startsWith('config')).length, 1);
});

test('states of undeclared keys, other owners, the bridge name and invalid messages are dropped', () => {
    const { relay, out, logs } = setup();
    relay.handle('p1', msg('config', { entities: presence }));
    relay.handle('p1', msg('state', { key: 'nope', value: 'ON' }));
    relay.handle('p2', msg('state', { key: 'person', value: 'ON' }));
    relay.handle('p1', { v: 1, type: 'alive', source: 'bridge' });
    relay.handle('p1', { v: 2, type: 'alive', source: 'guard' });
    relay.handle('p1', msg('state', { key: 'seen', value: 'ON' }));
    relay.handle('p1', msg('config', { device: '../x', entities: presence }));
    assert.deepEqual(out, ['status guard online', 'config 42 guard person,seen']);
    // one line per owner and minute
    assert.equal(logs.length, 2);
});

test('a key dropped from a new config has its state cleared', () => {
    const { relay, out } = setup();
    relay.handle('p1', msg('config', { entities: presence }));
    relay.handle('p1', msg('state', { key: 'person', value: 'ON' }));
    relay.handle('p1', msg('config', { entities: [presence[1]] }));
    assert.deepEqual(out.slice(-2), ['config 42 guard seen', 'state 42 guard person=']);
});

test('events need an event entity and a valid type', () => {
    const { relay, out } = setup();
    relay.handle('p1', msg('config', { entities: presence }));
    relay.handle('p1', msg('event', { key: 'seen', event_type: 'person', attributes: { score: 0.9 } }));
    relay.handle('p1', msg('event', { key: 'seen', event_type: 'Not Valid' }));
    relay.handle('p1', msg('event', { key: 'person', event_type: 'person' }));
    assert.deepEqual(out.slice(2), ['event 42 guard seen {"event_type":"person","attributes":{"score":0.9}}']);
});

test('nothing is published for cameras the bridge does not publish, and everything is once they are', () => {
    const { relay, out, published } = setup(new Set());
    relay.handle('p1', msg('config', { entities: presence }));
    relay.handle('p1', msg('state', { key: 'person', value: 'ON' }));
    assert.deepEqual(out, ['status guard online']);
    published.add('42');
    relay.devicePublished('42');
    assert.deepEqual(out.slice(1), ['config 42 guard person,seen', 'state 42 guard person=ON']);
    published.delete('42');
    relay.deviceUnpublished('42');
    assert.equal(out.at(-1), 'config 42 guard -');
});

test('configs for devices Scrypted does not know are dropped', () => {
    const out: string[] = [];
    const relay = new AddonRelay({
        config: (d, s) => out.push(`config ${d} ${s}`), state: () => { }, event: () => { }, image: () => { }, status: () => { },
    }, () => true, () => { }, Date.now, d => d === '42');
    relay.handle('p1', msg('config', { device: '7', entities: presence }));
    relay.handle('p1', msg('config', { entities: presence }));
    assert.deepEqual(out, ['config 42 guard']);
});

test('a silent source goes offline and comes back with its next message', () => {
    const { relay, out, tick } = setup();
    relay.handle('p1', { v: 1, type: 'alive', source: 'guard' });
    tick(SOURCE_TIMEOUT_MS - 1);
    relay.sweep();
    tick(2);
    relay.sweep();
    relay.handle('p1', { v: 1, type: 'alive', source: 'guard' });
    assert.deepEqual(out, ['status guard online', 'status guard offline', 'status guard online']);
});

test('commands reach only online sources, published cameras and declared switch or button keys', () => {
    const { relay, tick } = setup();
    relay.handle('p1', msg('config', { entities: [...presence, { key: 'light', name: 'Light', platform: 'switch' }] }));
    assert.equal(relay.commandTarget('42', 'guard', 'light', 'ON'), 'guard');
    assert.equal(relay.commandTarget('42', 'guard', 'light', 'PRESS'), undefined);
    assert.equal(relay.commandTarget('42', 'guard', 'person', 'ON'), undefined);
    assert.equal(relay.commandTarget('7', 'guard', 'light', 'ON'), undefined);
    tick(SOURCE_TIMEOUT_MS + 1);
    relay.sweep();
    assert.equal(relay.commandTarget('42', 'guard', 'light', 'ON'), undefined);
});

test('withdraw clears the config and republish restores what is left', () => {
    const { relay, out } = setup();
    relay.handle('p1', msg('config', { entities: presence }));
    relay.handle('p1', msg('withdraw'));
    assert.equal(out.at(-1), 'config 42 guard -');
    out.length = 0;
    relay.republish();
    assert.deepEqual(out, ['status guard online']);
});

const shot = { key: 'last_detection', name: 'Last detection', platform: 'image' } as EntitySpec;
const jpeg = (n: number) => { const b = Buffer.alloc(n, 7); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return b.toString('base64'); };

test('images need an image entity and a valid JPEG; the same image twice is published once', () => {
    const { relay, out, logs } = setup();
    relay.handle('p1', msg('config', { entities: [...presence, shot] }));
    relay.handle('p1', msg('image', { key: 'last_detection', jpeg: jpeg(100) }));
    relay.handle('p1', msg('image', { key: 'last_detection', jpeg: jpeg(100) }));
    relay.handle('p1', msg('image', { key: 'person', jpeg: jpeg(100) }));
    relay.handle('p1', msg('state', { key: 'last_detection', value: 'ON' }));
    assert.deepEqual(out.slice(2), ['image 42 guard last_detection 100']);
    assert.equal(logs.length, 1);
});

test('a bad image is dropped and null clears', () => {
    const { relay, out, tick } = setup();
    relay.handle('p1', msg('config', { entities: [shot] }));
    relay.handle('p1', msg('image', { key: 'last_detection', jpeg: Buffer.from('GIF89a').toString('base64') }));
    tick(60_000);
    relay.handle('p1', msg('image', { key: 'last_detection', jpeg: jpeg(10) }));
    relay.handle('p1', msg('image', { key: 'last_detection', jpeg: null }));
    assert.deepEqual(out.slice(2), ['image 42 guard last_detection 10', 'image 42 guard last_detection 0']);
});

test('images follow the camera: kept while unpublished, cleared on unpublish, withdraw and a dropped key', () => {
    const { relay, out, published } = setup(new Set());
    relay.handle('p1', msg('config', { entities: [...presence, shot] }));
    relay.handle('p1', msg('image', { key: 'last_detection', jpeg: jpeg(50) }));
    assert.deepEqual(out, ['status guard online']);
    published.add('42');
    relay.devicePublished('42');
    assert.deepEqual(out.slice(1), ['config 42 guard person,seen,last_detection', 'image 42 guard last_detection 50']);
    out.length = 0;
    relay.republish();
    assert.deepEqual(out, ['status guard online', 'config 42 guard person,seen,last_detection', 'image 42 guard last_detection 50']);
    out.length = 0;
    published.delete('42');
    relay.deviceUnpublished('42');
    assert.deepEqual(out, ['image 42 guard last_detection 0', 'config 42 guard -']);
    published.add('42');
    relay.devicePublished('42');
    out.length = 0;
    relay.handle('p1', msg('config', { entities: presence }));
    assert.deepEqual(out, ['config 42 guard person,seen', 'image 42 guard last_detection 0']);
    relay.handle('p1', msg('config', { entities: [shot] }));
    relay.handle('p1', msg('image', { key: 'last_detection', jpeg: jpeg(20) }));
    out.length = 0;
    relay.handle('p1', msg('withdraw'));
    assert.deepEqual(out, ['image 42 guard last_detection 0', 'config 42 guard -']);
});

test('an entity the bridge cannot take is dropped alone, logged at most once a minute', () => {
    const { relay, out, logs } = setup();
    const future = { key: 'clip', name: 'Clip', platform: 'video' };
    relay.handle('p1', msg('config', { entities: [presence[0], future, presence[1]] }));
    relay.handle('p1', msg('config', { entities: [presence[0], future] }));
    assert.deepEqual(out, ['status guard online', 'config 42 guard person,seen', 'config 42 guard person']);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /clip: invalid platform/);
    // duplicates still refuse the whole list
    relay.handle('p1', msg('config', { entities: [presence[0], presence[0]] }));
    assert.equal(out.length, 3);
});

test('camera is not a source name', () => {
    const { relay, out } = setup();
    relay.handle('p1', { v: 1, type: 'alive', source: 'camera' });
    assert.deepEqual(out, []);
});

test('a source first heard in this run is reported once (the bridge says hello to it), whatever its first message', () => {
    const { relay, added } = setup();
    relay.handle('p1', msg('config', { entities: presence }));
    relay.handle('p1', { v: 1, type: 'alive', source: 'guard' });
    relay.handle('p2', { v: 1, type: 'alive', source: 'other' });
    relay.handle('p2', { v: 1, type: 'alive', source: 'other' });
    // refused sources are not
    relay.handle('p3', { v: 1, type: 'alive', source: 'camera' });
    relay.handle('p3', { v: 1, type: 'alive', source: 'guard' });
    assert.deepEqual(added, ['guard', 'other']);
});

test('declaresImage follows the current config', () => {
    const { relay } = setup();
    relay.handle('p1', msg('config', { entities: [...presence, shot] }));
    assert.equal(relay.declaresImage('42', 'guard', 'last_detection'), true);
    assert.equal(relay.declaresImage('42', 'guard', 'person'), false);
    assert.equal(relay.declaresImage('7', 'guard', 'last_detection'), false);
    relay.handle('p1', msg('config', { entities: presence }));
    assert.equal(relay.declaresImage('42', 'guard', 'last_detection'), false);
});

test('images published over budget are cleared like kept ones on a dropped key, withdraw and unpublish', () => {
    const { relay, out, logs, published } = setup();
    // 32 MB are kept: the 33rd picture of 1 MB is published but not kept
    const shots = Array.from({ length: 33 }, (_, i) => ({ key: `shot_${i}`, name: `Shot ${i}`, platform: 'image' }) as EntitySpec);
    const big = jpeg(1024 * 1024);
    const sendAll = () => {
        relay.handle('p1', msg('config', { entities: shots }));
        for (const s of shots) relay.handle('p1', msg('image', { key: s.key, jpeg: big }));
    };
    const cleared = () => out.filter(l => l.startsWith('image') && l.endsWith(' 0')).length;
    sendAll();
    assert.match(logs.at(-1)!, /shot_32: image published but not kept/);
    out.length = 0;
    relay.handle('p1', msg('config', { entities: shots.slice(0, 32) }));
    assert.deepEqual(out.filter(l => l.startsWith('image')), ['image 42 guard shot_32 0']);
    sendAll();
    out.length = 0;
    relay.handle('p1', msg('withdraw'));
    assert.equal(cleared(), 33);
    sendAll();
    out.length = 0;
    published.delete('42');
    relay.deviceUnpublished('42');
    assert.equal(cleared(), 33);
    // the unkept picture is gone from the broker now: published again without it, and not cleared twice
    published.add('42');
    relay.devicePublished('42');
    assert.equal(out.filter(l => l.startsWith('image') && !l.endsWith(' 0')).length, 32);
    out.length = 0;
    published.delete('42');
    relay.deviceUnpublished('42');
    assert.equal(cleared(), 32);
});
