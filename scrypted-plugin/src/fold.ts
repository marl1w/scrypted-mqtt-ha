/**
 * What the bridge reads from standard Scrypted interfaces besides the camera's own (docs/contract.md, section 10): the
 * devices folded into a camera's device, the camera's raw classes, and which add-on entities those replace.
 * No Scrypted imports (interface names are plain strings), so it is testable on its own.
 */
import { EntitySpec, isKey, isSource, slug } from './contract';

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const sameName = (a: string, b: string) => norm(a) === norm(b);

export const CHILD_PREFIX = 'child_';
/** Keys of the camera's raw signals: its own motion and AI classes, before any mixin judges them. */
export const RAW_PREFIX = 'camera_';
export const RAW_MOTION_KEY = `${RAW_PREFIX}motion`;
/**
 * A raw class stays on this long after the last detection that carried it. Detectors repeat a class while it is seen
 * (a Reolink camera every second); one that sends a frame without it, or an empty frame, turns it off at once.
 */
export const RAW_CLASS_HOLD_MS = 2500;
/** At most this many `replaces` per entity, and raw classes per camera. */
export const MAX_REPLACES = 8;
export const MAX_RAW_CLASSES = 32;

/** Interfaces a folded device may have, in the order that picks its platform. */
const FOLDED = ['OnOff', 'OccupancySensor', 'AudioSensor', 'MotionSensor', 'BinarySensor'] as const;
export type FoldedInterface = typeof FOLDED[number];

/** The interface a device is folded by, or undefined to leave it out (a camera, such as a crop or mirror view, is a device of its own). */
export function foldedInterface(interfaces: readonly string[] | undefined): FoldedInterface | undefined {
    const ifs = interfaces || [];
    if (ifs.includes('VideoCamera')) return undefined;
    return FOLDED.find(i => ifs.includes(i));
}

/** The property of a folded interface. */
export const FOLDED_PROPERTY: Record<FoldedInterface, string> = {
    OnOff: 'on',
    OccupancySensor: 'occupied',
    AudioSensor: 'audioDetected',
    MotionSensor: 'motionDetected',
    BinarySensor: 'binaryState',
};

/** A device's name on the camera's device: without the camera's name in front, at most 64 characters. */
export function foldedName(name: string | undefined, id: string, cameraName: string, own = false): string {
    let n = String(name || id);
    if (cameraName && n.startsWith(cameraName + ' ')) n = n.slice(cameraName.length + 1);
    else if (own) n = rawSuffix(n) ?? n;
    return n.trim().slice(0, 64) || `Device ${id}`;
}

/**
 * `Camera <signal>` at the end of a name, whatever comes before it (a camera plugin may name its children after the
 * camera's name on the recorder, not after the Scrypted camera's, which the user may have renamed): from the last word
 * `camera` that has something after it.
 */
export function rawSuffix(name: string): string | undefined {
    const words = String(name).trim().split(/\s+/);
    for (let i = words.length - 2; i >= 0; i--)
        if (words[i].toLowerCase() === 'camera') return words.slice(i).join(' ');
    return undefined;
}

const RAW_INTERFACES: readonly FoldedInterface[] = ['OccupancySensor', 'MotionSensor', 'BinarySensor'];

/**
 * How a child or companion device appears on the camera's device, or undefined to leave it out. An own child (its
 * provider is the camera) that is a sensor named `… Camera <signal>` is named `Camera <signal>`, whatever its prefix.
 */
export function foldedEntity(dev: { id: string; name?: string; interfaces?: string[] }, cameraName: string, own = false): EntitySpec | undefined {
    const iface = foldedInterface(dev.interfaces);
    if (!iface) return undefined;
    const key = `${CHILD_PREFIX}${dev.id}`;
    const name = foldedName(dev.name, dev.id, cameraName, own && RAW_INTERFACES.includes(iface));
    switch (iface) {
        case 'OnOff': return { key, name, platform: 'switch' };
        case 'OccupancySensor': return { key, name, platform: 'binary_sensor', device_class: 'occupancy' };
        case 'AudioSensor': return { key, name, platform: 'binary_sensor', device_class: 'sound' };
        case 'MotionSensor': return { key, name, platform: 'binary_sensor', device_class: 'motion' };
        case 'BinarySensor': return { key, name, platform: 'binary_sensor' };
    }
}

/** A camera's own class as a raw signal: people → person, dog_cat → animal, others slugified. Undefined for motion or nothing. */
export function rawClass(className: unknown): string | undefined {
    const s = slug(String(className ?? ''));
    if (!s || s === 'motion') return undefined;
    const c = s === 'people' ? 'person' : s === 'dog_cat' ? 'animal' : s;
    return isKey(`${RAW_PREFIX}${c}`) ? c : undefined;
}

/**
 * The raw key a folded device stands for, from its name on the camera's device: `Camera motion` (a MotionSensor) is
 * `camera_motion`, `Camera <class>` (an occupancy or binary sensor) is `camera_<class>`. Undefined for anything else.
 */
export function rawKeyOf(e: EntitySpec): string | undefined {
    if (e.platform !== 'binary_sensor') return undefined;
    const m = /^camera (.+)$/.exec(norm(e.name));
    if (!m) return undefined;
    if (m[1] === 'motion') return e.device_class === 'motion' ? RAW_MOTION_KEY : undefined;
    if (e.device_class && e.device_class !== 'occupancy') return undefined;
    const c = rawClass(m[1]);
    return c ? `${RAW_PREFIX}${c}` : undefined;
}

/** The fields of a Scrypted device the folding rules read. */
export interface DeviceFacts {
    id: string;
    name?: string;
    pluginId?: string;
    providerId?: string;
    interfaces?: string[];
    /** mixin provider ids, innermost first */
    mixins?: string[];
}

const isCamera = (d: DeviceFacts) => !!d.interfaces?.includes('VideoCamera');

/**
 * Whether a device may be folded into a camera at all, its name aside: a sensor or switch that is not a camera; the
 * camera's own child, or else a device of a plugin that is a mixin on the camera and not provided by another camera.
 * A raw-signal device (`Camera motion`, `Camera <class>`) only from the camera itself or its own plugin.
 */
export function acceptable(d: DeviceFacts, camera: DeviceFacts, all: readonly DeviceFacts[]): boolean {
    if (d.id === camera.id || !foldedInterface(d.interfaces)) return false;
    const own = d.providerId === camera.id;
    if (!own) {
        const byId = new Map(all.map(x => [x.id, x]));
        if (d.providerId && byId.get(d.providerId)?.interfaces?.includes('VideoCamera')) return false;
        const mixinPlugins = new Set((camera.mixins ?? []).map(m => byId.get(m)?.pluginId).filter((p): p is string => !!p));
        if (!d.pluginId || !mixinPlugins.has(d.pluginId)) return false;
    }
    const e = foldedEntity(d, String(camera.name || ''), own);
    return !(e && rawKeyOf(e) && !own && d.pluginId !== camera.pluginId);
}

/**
 * The devices folded into a camera's device (each one `acceptable`):
 * - its children (their provider is the camera), such as a siren, a floodlight, a day/night or a raw-signal sensor;
 * - its companions: devices of a plugin that is a mixin on the camera, named after the camera (`<camera> <what>`),
 *   such as a mixin's per-class presence or tamper sensors (a mixin cannot make children of another plugin's camera, so
 *   the name is the link). The longest camera name that fits wins, whatever mixins that camera has; two cameras of the
 *   same name fold their companions to neither (`ambiguous` lists those devices).
 * Cameras are never folded.
 */
export function foldedDevices(camera: DeviceFacts, all: readonly DeviceFacts[]): { devices: DeviceFacts[]; ambiguous: DeviceFacts[] } {
    const cameraName = String(camera.name || '');
    const cameras = all.filter(isCamera);
    const devices: DeviceFacts[] = [];
    const ambiguous: DeviceFacts[] = [];
    for (const d of all) {
        if (!acceptable(d, camera, all)) continue;
        if (d.providerId !== camera.id) {
            const name = String(d.name || '');
            if (!cameraName || !name.startsWith(cameraName + ' ')) continue;
            const fits = cameras.filter(c => c.name && name.startsWith(String(c.name) + ' '));
            const longest = Math.max(...fits.map(c => String(c.name).length));
            if (cameraName.length < longest) continue;
            if (fits.filter(c => String(c.name).length === longest).length > 1) {
                ambiguous.push(d);
                continue;
            }
        }
        devices.push(d);
    }
    return { devices, ambiguous };
}

/** The cameras a device is folded into (at most one, but for a child that is a camera's and fits another's name). */
export function camerasOf(deviceId: string, all: readonly DeviceFacts[]): string[] {
    const d = all.find(x => x.id === deviceId);
    if (!d || !foldedInterface(d.interfaces)) return [];
    return all.filter(isCamera).filter(c => foldedDevices(c, all).devices.some(x => x.id === deviceId)).map(c => c.id);
}

/** The raw classes' entities, one occupancy sensor per class, named `Camera <class>`. */
export function rawEntities(classes: readonly unknown[]): EntitySpec[] {
    const out: EntitySpec[] = [];
    const seen = new Set<string>();
    for (const c of classes) {
        const r = rawClass(c);
        if (!r || seen.has(r)) continue;
        seen.add(r);
        out.push({ key: `${RAW_PREFIX}${r}`, name: `Camera ${r.replace(/_/g, ' ')}`.slice(0, 64), platform: 'binary_sensor', device_class: 'occupancy' });
    }
    return out.slice(0, MAX_RAW_CLASSES);
}

/**
 * The derived raw entities beside the folded ones: a folded device that stands for a raw key (rawKeyOf) wins, the
 * derived entity of that key is left out, and the device takes over `bridge:<key>`, in case it was published before.
 */
export function rawBesideFolded(raw: readonly EntitySpec[], folded: readonly EntitySpec[]): { raw: EntitySpec[]; replaces: Record<string, string[]> } {
    const replaces: Record<string, string[]> = {};
    const taken = new Set<string>();
    for (const e of folded) {
        const k = rawKeyOf(e);
        if (!k || taken.has(k)) continue;
        taken.add(k);
        replaces[e.key] = [`bridge:${k}`];
    }
    return { raw: raw.filter(e => !taken.has(e.key)), replaces };
}

/** Detections a mixin plugin on the camera sent (its id or its plugin's, as `sourceId` or the event's `mixinId`) are not the camera's own. */
export function isCameraDetection(sourceId: unknown, mixinId: unknown, mixinSources: ReadonlySet<string>): boolean {
    return !(sourceId !== undefined && sourceId !== null && mixinSources.has(String(sourceId)))
        && !(mixinId !== undefined && mixinId !== null && mixinSources.has(String(mixinId)));
}

/**
 * The camera's classes as levels, from its detection events. Each event is one source's frame: a class turns on with
 * it, and off when the same source sends a frame without it (an empty frame turns all of them off), or
 * RAW_CLASS_HOLD_MS after it was last carried.
 */
export class RawClasses {
    /** class -> source -> hold timer */
    private live = new Map<string, Map<string, unknown>>();

    constructor(
        private changed: (cls: string, on: boolean) => void,
        private holdMs = RAW_CLASS_HOLD_MS,
        private timers: { set(fn: () => void, ms: number): unknown; clear(t: unknown): void } = {
            set: (fn, ms) => setTimeout(fn, ms).unref?.(),
            clear: t => clearTimeout(t as NodeJS.Timeout),
        },
    ) { }

    /** One detection event of `source`; returns the classes it carried. */
    frame(source: string, classNames: readonly unknown[]): string[] {
        const now = new Set(classNames.map(rawClass).filter((c): c is string => !!c));
        for (const [cls, sources] of this.live)
            if (!now.has(cls) && sources.has(source)) this.drop(cls, source);
        for (const cls of now) {
            let sources = this.live.get(cls);
            const was = !!sources?.size;
            if (!sources) this.live.set(cls, sources = new Map());
            if (sources.has(source)) this.timers.clear(sources.get(source));
            sources.set(source, this.timers.set(() => this.drop(cls, source), this.holdMs));
            if (!was) this.changed(cls, true);
        }
        return [...now];
    }

    private drop(cls: string, source: string) {
        const sources = this.live.get(cls);
        if (!sources?.has(source)) return;
        this.timers.clear(sources.get(source));
        sources.delete(source);
        if (sources.size) return;
        this.live.delete(cls);
        this.changed(cls, false);
    }

    isOn(cls: string): boolean {
        return !!this.live.get(cls)?.size;
    }

    /** Forget everything, without reporting. */
    clear() {
        for (const sources of this.live.values()) for (const t of sources.values()) this.timers.clear(t);
        this.live.clear();
    }
}

/** An add-on's entities on one camera, and the Scrypted plugin that sent them. */
export interface AddonEntities {
    source: string;
    pluginId?: string;
    entities: readonly EntitySpec[];
}

/**
 * The add-on entities a bridge entity takes over, as `<source>:<key>`: those of an add-on sent by the plugin the bridge
 * entity is read from, on the same camera, with the same platform and name (case aside). The integration then shows the
 * bridge's entity only, under the add-on entity's registry entry (contract section 9).
 */
export function replacesFor(entity: EntitySpec, pluginId: string | undefined, addons: readonly AddonEntities[]): string[] | undefined {
    if (!pluginId) return undefined;
    const out: string[] = [];
    for (const a of addons) {
        if (a.pluginId !== pluginId || !isSource(a.source) || a.source === 'bridge') continue;
        for (const e of a.entities)
            if (e.platform === entity.platform && sameName(e.name, entity.name)) out.push(`${a.source}:${e.key}`);
    }
    return out.length ? out.slice(0, MAX_REPLACES) : undefined;
}

/**
 * An entity's `replaces`: what it replaces now, merged with what it replaced before. An earlier add-on entry is dropped
 * only when its source's current config for this camera no longer has that key on the entity's platform (no config
 * yet in this run keeps it); `bridge:` entries are worked out afresh each time, and malformed ones are dropped. After a
 * restart the bridge publishes before the add-ons resend, and dropping a replace then would bring the add-on's entity
 * back beside the bridge's.
 */
export function mergeReplaces(now: readonly string[] | undefined, before: readonly string[] | undefined, platform: string, current: (source: string) => readonly EntitySpec[] | undefined): string[] | undefined {
    const kept = (before ?? []).filter(r => {
        if (typeof r !== 'string') return false;
        const i = r.indexOf(':');
        const source = r.slice(0, i), key = r.slice(i + 1);
        if (i < 0 || source === 'bridge' || !isSource(source) || !isKey(key)) return false;
        const entities = current(source);
        return !entities || entities.some(e => e.key === key && e.platform === platform);
    });
    const out = [...new Set([...now ?? [], ...kept])];
    return out.length ? out.slice(0, MAX_REPLACES) : undefined;
}

/** What the bridge remembers of a camera across restarts. */
export interface CameraMemory {
    /** raw classes the camera itself has reported */
    classes?: string[];
    /** ids of the devices last folded into it */
    folded?: string[];
    /** entity key -> what it replaced when last published */
    replaces?: Record<string, string[]>;
}

/**
 * The folded devices to publish: those found now, plus those published before that still exist and are still
 * `acceptable` (a device leaves only when it is gone from Scrypted, no longer acceptable, or now belongs to another
 * camera: a rename or a name clash alone does not make it go).
 */
export function stableFolded(camera: DeviceFacts, now: readonly DeviceFacts[], before: readonly string[] | undefined, all: readonly DeviceFacts[], elsewhere: (id: string) => boolean): DeviceFacts[] {
    const ids = new Set(now.map(d => d.id));
    const out = [...now];
    for (const id of before ?? []) {
        if (ids.has(id) || elsewhere(id)) continue;
        const d = all.find(x => x.id === id);
        if (d && acceptable(d, camera, all)) {
            out.push(d);
            ids.add(id);
        }
    }
    return out;
}

/**
 * When to forget what was remembered of a camera that stopped being published: at once when that is certain (it was
 * removed from Scrypted, or the user deselected it), else only when it is still not a selected camera at the next pass,
 * so a moment in which Scrypted rebuilds the device does not lose it.
 */
export class ForgetLater {
    private pending = new Set<string>();

    /** The camera stopped being published; true when its memory goes now. */
    unpublished(id: string, certain: boolean): boolean {
        if (certain) {
            this.pending.delete(id);
            return true;
        }
        this.pending.add(id);
        return false;
    }

    /** A later pass: the cameras whose memory goes now. */
    sweep(isCamera: (id: string) => boolean): string[] {
        const out: string[] = [];
        for (const id of this.pending) {
            this.pending.delete(id);
            if (!isCamera(id)) out.push(id);
        }
        return out;
    }
}
