import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptable, camerasOf, DeviceFacts, ForgetLater, foldedDevices, foldedEntity, isCameraDetection, mergeReplaces, RAW_CLASS_HOLD_MS, RawClasses, rawBesideFolded, rawClass, rawEntities, rawKeyOf, rawSuffix, replacesFor, stableFolded } from '../src/fold';

test('folded devices get their platform and device class from the interface', () => {
    const e = (interfaces: string[], name = 'Front door Thing') => foldedEntity({ id: '9', name, interfaces }, 'Front door');
    assert.deepEqual(e(['OnOff', 'BinarySensor']), { key: 'child_9', name: 'Thing', platform: 'switch' });
    assert.deepEqual(e(['OccupancySensor']), { key: 'child_9', name: 'Thing', platform: 'binary_sensor', device_class: 'occupancy' });
    assert.deepEqual(e(['AudioSensor', 'BinarySensor']), { key: 'child_9', name: 'Thing', platform: 'binary_sensor', device_class: 'sound' });
    assert.deepEqual(e(['MotionSensor']), { key: 'child_9', name: 'Thing', platform: 'binary_sensor', device_class: 'motion' });
    assert.deepEqual(e(['BinarySensor'], 'Night mode'), { key: 'child_9', name: 'Night mode', platform: 'binary_sensor' });
    assert.equal(e(['VideoCamera', 'MotionSensor']), undefined);
    assert.equal(e(['Settings']), undefined);
    assert.equal(e(['BinarySensor'], 'Front door')?.name, 'Front door');
});

const camera = (id: string, name: string, mixins: string[] = [], pluginId = 'cams'): DeviceFacts =>
    ({ id, name, pluginId, providerId: 'nvr', interfaces: ['VideoCamera', 'MotionSensor'], mixins });
const guardPlugin: DeviceFacts = { id: 'guard', name: 'Guard', pluginId: 'guard-plugin', providerId: 'guard', interfaces: ['MixinProvider'] };
const presence = (id: string, name: string): DeviceFacts => ({ id, name, pluginId: 'guard-plugin', providerId: 'guard', interfaces: ['OccupancySensor'] });

test('children and companions are folded into the camera they belong to', () => {
    const all: DeviceFacts[] = [
        guardPlugin,
        camera('1', 'Garden', ['guard']),
        camera('2', 'Garden Back', ['guard']),
        camera('3', 'Porch'),
        { id: '10', name: 'Garden Siren', pluginId: 'cams', providerId: '1', interfaces: ['OnOff'] },
        { id: '11', name: 'Garden Night mode', pluginId: 'cams', providerId: '1', interfaces: ['BinarySensor'] },
        { id: '12', name: 'Garden Crop', pluginId: 'cams', providerId: '1', interfaces: ['VideoCamera', 'MotionSensor'] },
        presence('20', 'Garden Person Presence'),
        presence('21', 'Garden Back Person Presence'),
        { id: '22', name: 'Garden Tamper', pluginId: 'guard-plugin', providerId: 'guard', interfaces: ['BinarySensor'] },
        presence('23', 'Porch Person Presence'),
        { id: '24', name: 'Garden lamp', pluginId: 'lights', providerId: 'lights', interfaces: ['OnOff'] },
        // a child of another camera whose name starts with this camera's
        { id: '25', name: 'Garden Back Siren', pluginId: 'guard-plugin', providerId: '2', interfaces: ['OnOff'] },
        { id: '26', name: 'Garden Speaker', pluginId: 'guard-plugin', providerId: '3', interfaces: ['OnOff'] },
    ];
    const ids = (c: DeviceFacts) => foldedDevices(c, all).devices.map(d => d.id);
    assert.deepEqual(ids(all[1]), ['10', '11', '20', '22']);
    assert.deepEqual(ids(all[2]), ['21', '25']);
    // Porch does not carry the guard mixin: its namesake sensor is not its companion
    assert.deepEqual(ids(all[3]), ['26']);
    assert.deepEqual(camerasOf('21', all), ['2']);
    assert.deepEqual(camerasOf('24', all), []);
});

test('the longest camera name wins even when that camera lacks the mixin', () => {
    const all = [guardPlugin, camera('1', 'Garden', ['guard']), camera('2', 'Garden Back'), presence('21', 'Garden Back Person Presence')];
    assert.deepEqual(foldedDevices(all[1], all).devices, []);
    assert.deepEqual(foldedDevices(all[2], all).devices, []);
});

test('two cameras of the same name fold their companions to neither', () => {
    const all = [guardPlugin, camera('1', 'Garden', ['guard']), camera('2', 'Garden', ['guard']), presence('20', 'Garden Person Presence')];
    for (const c of [all[1], all[2]]) {
        const r = foldedDevices(c, all);
        assert.deepEqual(r.devices, []);
        assert.deepEqual(r.ambiguous.map(d => d.id), ['20']);
    }
});

test('a raw-signal device is taken only from the camera itself or its own plugin', () => {
    const all: DeviceFacts[] = [
        guardPlugin,
        camera('1', 'Garden', ['guard']),
        { id: '30', name: 'Garden Camera motion', pluginId: 'cams', providerId: '1', interfaces: ['MotionSensor'] },
        { id: '31', name: 'Garden Camera person', pluginId: 'cams', providerId: '1', interfaces: ['OccupancySensor'] },
        { id: '32', name: 'Garden Camera motion', pluginId: 'guard-plugin', providerId: 'guard', interfaces: ['MotionSensor'] },
        { id: '33', name: 'Garden Camera vehicle', pluginId: 'guard-plugin', providerId: 'guard', interfaces: ['BinarySensor'] },
        { id: '34', name: 'Garden Camera status', pluginId: 'guard-plugin', providerId: 'guard', interfaces: ['OnOff'] },
    ];
    assert.deepEqual(foldedDevices(all[1], all).devices.map(d => d.id), ['30', '31', '34']);
});

test('raw classes are normalised as the camera add-on names them', () => {
    assert.equal(rawClass('people'), 'person');
    assert.equal(rawClass('dog_cat'), 'animal');
    assert.equal(rawClass('vehicle'), 'vehicle');
    assert.equal(rawClass('Face'), 'face');
    assert.equal(rawClass('Bicycle Rider'), 'bicycle_rider');
    assert.equal(rawClass('motion'), undefined);
    assert.equal(rawClass(''), undefined);
});

test('raw entities: one occupancy sensor per class', () => {
    assert.deepEqual(rawEntities(['people', 'vehicle', 'dog_cat', 'motion', 'person', 'package']), [
        { key: 'camera_person', name: 'Camera person', platform: 'binary_sensor', device_class: 'occupancy' },
        { key: 'camera_vehicle', name: 'Camera vehicle', platform: 'binary_sensor', device_class: 'occupancy' },
        { key: 'camera_animal', name: 'Camera animal', platform: 'binary_sensor', device_class: 'occupancy' },
        { key: 'camera_package', name: 'Camera package', platform: 'binary_sensor', device_class: 'occupancy' },
    ]);
    assert.deepEqual(rawEntities([]), []);
});

test('the raw key of a folded device follows its name and kind', () => {
    const e = (name: string, interfaces: string[]) => rawKeyOf(foldedEntity({ id: '9', name, interfaces }, 'Garden')!);
    assert.equal(e('Garden Camera motion', ['MotionSensor']), 'camera_motion');
    assert.equal(e('Garden Camera motion', ['BinarySensor']), undefined);
    assert.equal(e('Garden Camera person', ['OccupancySensor']), 'camera_person');
    assert.equal(e('Garden Camera people', ['BinarySensor']), 'camera_person');
    assert.equal(e('Garden Camera person', ['MotionSensor']), undefined);
    assert.equal(e('Garden Siren', ['OnOff']), undefined);
});

test('detections of the camera\'s mixins are not the camera\'s own', () => {
    const mixins = new Set(['70', 'guard-plugin']);
    assert.equal(isCameraDetection('cams-plugin', undefined, mixins), true);
    assert.equal(isCameraDetection('70', undefined, mixins), false);
    assert.equal(isCameraDetection(undefined, 'guard-plugin', mixins), false);
    assert.equal(isCameraDetection(undefined, undefined, mixins), true);
});

function fakeTimers() {
    let now = 0;
    const pending = new Map<number, { at: number; fn: () => void }>();
    let next = 1;
    return {
        timers: {
            set: (fn: () => void, ms: number) => { pending.set(next, { at: now + ms, fn }); return next++; },
            clear: (t: unknown) => { pending.delete(t as number); },
        },
        advance(ms: number) {
            now += ms;
            for (const [id, p] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
                if (p.at > now || !pending.has(id)) continue;
                pending.delete(id);
                p.fn();
            }
        },
    };
}

test('raw classes hold while repeated, and drop when the same source leaves them out or goes quiet', () => {
    const t = fakeTimers();
    const out: string[] = [];
    const rc = new RawClasses((c, on) => out.push(`${c} ${on ? 'on' : 'off'}`), RAW_CLASS_HOLD_MS, t.timers);
    assert.deepEqual(rc.frame('cam', ['people', 'vehicle']).sort(), ['person', 'vehicle']);
    for (let i = 0; i < 5; i++) {
        t.advance(1000);
        rc.frame('cam', ['people', 'vehicle']);
    }
    assert.deepEqual(out, ['person on', 'vehicle on']);
    rc.frame('cam', ['vehicle']);
    assert.deepEqual(out, ['person on', 'vehicle on', 'person off']);
    assert.equal(rc.isOn('vehicle'), true);
    t.advance(RAW_CLASS_HOLD_MS - 1);
    assert.equal(rc.isOn('vehicle'), true);
    t.advance(1);
    assert.deepEqual(out.slice(3), ['vehicle off']);
});

test('a class another source still carries stays on', () => {
    const t = fakeTimers();
    const out: string[] = [];
    const rc = new RawClasses((c, on) => out.push(`${c} ${on ? 'on' : 'off'}`), RAW_CLASS_HOLD_MS, t.timers);
    rc.frame('cam', ['people']);
    rc.frame('detector', ['person', 'motion']);
    rc.frame('cam', []);
    assert.deepEqual(out, ['person on']);
    t.advance(RAW_CLASS_HOLD_MS);
    assert.deepEqual(out, ['person on', 'person off']);
    rc.frame('cam', ['people']);
    rc.clear();
    t.advance(RAW_CLASS_HOLD_MS);
    assert.deepEqual(out, ['person on', 'person off', 'person on']);
});

test('an empty detection frame turns all of that source\'s classes off at once', () => {
    const t = fakeTimers();
    const out: string[] = [];
    const rc = new RawClasses((c, on) => out.push(`${c} ${on ? 'on' : 'off'}`), RAW_CLASS_HOLD_MS, t.timers);
    rc.frame('cam', ['people', 'vehicle', 'dog_cat']);
    rc.frame('other', ['vehicle']);
    out.length = 0;
    rc.frame('cam', []);
    assert.deepEqual(out, ['person off', 'animal off']);
    assert.equal(rc.isOn('vehicle'), true); // another source still carries it
    rc.frame('other', []);
    assert.deepEqual(out, ['person off', 'animal off', 'vehicle off']);
    t.advance(RAW_CLASS_HOLD_MS);
    assert.equal(out.length, 3); // no late repeats from the expired holds
});

test('raw devices of the camera win over derived classes, so each Camera <x> exists once', () => {
    const raw = rawEntities(['people', 'vehicle', 'face']);
    const motion = foldedEntity({ id: '30', name: 'Garden Camera motion', interfaces: ['MotionSensor'] }, 'Garden')!;
    const person = foldedEntity({ id: '31', name: 'Garden Camera person', interfaces: ['OccupancySensor'] }, 'Garden')!;
    const siren = foldedEntity({ id: '32', name: 'Garden Siren', interfaces: ['OnOff'] }, 'Garden')!;
    const r = rawBesideFolded(raw, [siren, motion, person]);
    assert.deepEqual(r.raw.map(e => e.key), ['camera_vehicle', 'camera_face']);
    assert.deepEqual(r.replaces, { child_30: ['bridge:camera_motion'], child_31: ['bridge:camera_person'] });
    const names = [...r.raw, siren, motion, person].map(e => e.name.toLowerCase());
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(rawBesideFolded(raw, [siren]), { raw, replaces: {} });
});

test('a bridge entity replaces the add-on entities of its own plugin with the same name and platform', () => {
    const addons = [
        { source: 'cam-addon', pluginId: 'cams', entities: [
            { key: 'people', name: 'Camera person', platform: 'binary_sensor' as const },
            { key: 'motion', name: 'Camera motion', platform: 'binary_sensor' as const },
        ] },
        { source: 'guard', pluginId: 'guard-plugin', entities: [
            { key: 'person', name: 'Person presence', platform: 'binary_sensor' as const },
            { key: 'last_detection', name: 'Last detection', platform: 'image' as const },
        ] },
        { source: 'other', pluginId: 'elsewhere', entities: [{ key: 'person', name: 'Person Presence', platform: 'binary_sensor' as const }] },
    ];
    const person = rawEntities(['people'])[0];
    assert.deepEqual(replacesFor(person, 'cams', addons), ['cam-addon:people']);
    assert.equal(replacesFor(person, 'guard-plugin', addons), undefined);
    const motionChild = foldedEntity({ id: '30', name: 'Garden Camera motion', interfaces: ['MotionSensor'] }, 'Garden')!;
    assert.deepEqual(replacesFor(motionChild, 'cams', addons), ['cam-addon:motion']);
    const presenceEntity = foldedEntity({ id: '20', name: 'Garden Person Presence', interfaces: ['OccupancySensor'] }, 'Garden')!;
    assert.deepEqual(replacesFor(presenceEntity, 'guard-plugin', addons), ['guard:person']);
    assert.equal(replacesFor({ ...presenceEntity, platform: 'switch' }, 'guard-plugin', addons), undefined);
    assert.equal(replacesFor(presenceEntity, undefined, addons), undefined);
});

test('remembered replaces are merged, and dropped only when the source\'s current config lacks the key', () => {
    const configs: Record<string, { key: string; name: string; platform: 'binary_sensor' | 'switch' }[]> = {
        'cam-addon': [{ key: 'people', name: 'Renamed', platform: 'binary_sensor' }],
        guard: [{ key: 'person', name: 'Person presence', platform: 'switch' }],
    };
    const current = (s: string) => configs[s];
    // no config from that source yet in this run: kept
    assert.deepEqual(mergeReplaces(undefined, ['other:person'], 'binary_sensor', current), ['other:person']);
    // the source's config still has the key on this platform (even under another name): kept
    assert.deepEqual(mergeReplaces(['cam-addon:motion'], ['cam-addon:people'], 'binary_sensor', current), ['cam-addon:motion', 'cam-addon:people']);
    // the key is gone, or is on another platform: dropped
    assert.equal(mergeReplaces(undefined, ['cam-addon:face'], 'binary_sensor', current), undefined);
    assert.equal(mergeReplaces(undefined, ['guard:person'], 'binary_sensor', current), undefined);
    // bridge entries are worked out afresh; malformed ones are dropped
    assert.equal(mergeReplaces(undefined, ['bridge:camera_motion'], 'binary_sensor', () => undefined), undefined);
    assert.equal(mergeReplaces(undefined, ['nocolon', 'Bad:key', 'camera:x', 'ok:Bad Key', 42 as any], 'binary_sensor', () => undefined), undefined);
    assert.deepEqual(mergeReplaces(['bridge:camera_motion'], undefined, 'binary_sensor', () => undefined), ['bridge:camera_motion']);
});

test('folded devices published before stay until they are gone or belong to another camera', () => {
    const all: DeviceFacts[] = [
        camera('1', 'Garden'),
        { id: '10', name: 'Garden Siren', pluginId: 'cams', providerId: '1', interfaces: ['OnOff'] },
        presence('20', 'Garden Person Presence'),
        presence('21', 'Patio Person Presence'),
    ];
    const now = [all[1]];
    assert.deepEqual(stableFolded(all[0], now, ['10', '21', '99'], all, id => id === '21').map(d => d.id), ['10']);
    assert.deepEqual(stableFolded(all[0], now, undefined, all, () => false).map(d => d.id), ['10']);
    // the guard mixin is not on the camera: its presence sensor is not acceptable, however it was folded before
    assert.deepEqual(stableFolded(all[0], now, ['20'], all, () => false).map(d => d.id), ['10']);
    const withGuard = [guardPlugin, { ...all[0], mixins: ['guard'] }, ...all.slice(1)];
    assert.deepEqual(stableFolded(withGuard[1], now, ['20'], withGuard, () => false).map(d => d.id), ['10', '20']);
    // renamed so it no longer matches: still kept, it is acceptable
    const renamed = withGuard.map(d => d.id === '20' ? { ...d, name: 'Somewhere else' } : d);
    assert.deepEqual(stableFolded(renamed[1], now, ['20'], renamed, () => false).map(d => d.id), ['10', '20']);
});

test('a remembered raw-signal device from a foreign plugin is never kept', () => {
    const all: DeviceFacts[] = [guardPlugin, camera('1', 'Garden', ['guard']),
        { id: '32', name: 'Garden Camera motion', pluginId: 'guard-plugin', providerId: 'guard', interfaces: ['MotionSensor'] }];
    assert.equal(acceptable(all[2], all[1], all), false);
    assert.deepEqual(stableFolded(all[1], [], ['32'], all, () => false), []);
});

test('own children are raw signals by their name\'s end, whatever camera name they carry', () => {
    assert.equal(rawSuffix('Front Yard Camera motion'), 'Camera motion');
    assert.equal(rawSuffix('NVR Camera 3 Camera person'), 'Camera person');
    assert.equal(rawSuffix('Camera motion'), 'Camera motion');
    assert.equal(rawSuffix('Front camera'), undefined);
    // the Scrypted camera was renamed; the plugin names its children after the recorder's channel name
    const all: DeviceFacts[] = [
        camera('1', 'Garden'),
        { id: '30', name: 'Channel 2 Camera motion', pluginId: 'cams', providerId: '1', interfaces: ['MotionSensor'] },
        { id: '31', name: 'Channel 2 Camera people', pluginId: 'cams', providerId: '1', interfaces: ['OccupancySensor'] },
        { id: '33', name: 'Channel 2 Siren', pluginId: 'cams', providerId: '1', interfaces: ['OnOff'] },
    ];
    const folded = foldedDevices(all[0], all).devices.map(d => foldedEntity(d, 'Garden', d.providerId === '1')!);
    assert.deepEqual(folded.map(e => e.name), ['Camera motion', 'Camera people', 'Channel 2 Siren']);
    const r = rawBesideFolded(rawEntities(['people', 'vehicle']), folded);
    assert.deepEqual(r.raw.map(e => e.key), ['camera_vehicle']);
    assert.deepEqual(r.replaces, { child_30: ['bridge:camera_motion'], child_31: ['bridge:camera_person'] });
    const addons = [{ source: 'cam-addon', pluginId: 'cams', entities: [
        { key: 'motion', name: 'Camera motion', platform: 'binary_sensor' as const },
        { key: 'vehicle', name: 'Camera vehicle', platform: 'binary_sensor' as const },
    ] }];
    assert.deepEqual(replacesFor(folded[0], 'cams', addons), ['cam-addon:motion']);
    assert.deepEqual(replacesFor(r.raw[0], 'cams', addons), ['cam-addon:vehicle']);
    const names = [...r.raw, ...folded].map(e => e.name.toLowerCase());
    assert.equal(new Set(names).size, names.length);
    // a companion is not renamed by the suffix rule
    assert.equal(foldedEntity({ id: '9', name: 'Other Camera motion', interfaces: ['MotionSensor'] }, 'Garden')!.name, 'Other Camera motion');
});

test('memory is forgotten at once when certain, else only if the camera is still not one at the next pass', () => {
    const f = new ForgetLater();
    assert.equal(f.unpublished('1', true), true);
    assert.equal(f.unpublished('2', false), false);
    assert.equal(f.unpublished('3', false), false);
    assert.deepEqual(f.sweep(id => id === '2'), ['3']);
    assert.deepEqual(f.sweep(() => false), []);

});
