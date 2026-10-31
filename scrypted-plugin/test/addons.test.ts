import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AddonRelay, SOURCE_TIMEOUT_MS } from '../src/addons';
import { EntitySpec } from '../src/contract';

function setup(published = new Set(['42'])) {
    const out: string[] = [];
    const logs: string[] = [];
    let now = 1000;
    const relay = new AddonRelay({
        config: (d, s, e) => out.push(`config ${d} ${s} ${e ? e.map(x => x.key).join(',') : '-'}`),
        state: (d, s, k, p) => out.push(`state ${d} ${s} ${k}=${p}`),
        event: (d, s, k, p) => out.push(`event ${d} ${s} ${k} ${p}`),
        status: (s, on) => out.push(`status ${s} ${on ? 'online' : 'offline'}`),
    }, d => published.has(d), m => logs.push(m), () => now);
    return { relay, out, logs, published, tick: (ms: number) => { now += ms; } };
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
        config: (d, s) => out.push(`config ${d} ${s}`), state: () => { }, event: () => { }, status: () => { },
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
