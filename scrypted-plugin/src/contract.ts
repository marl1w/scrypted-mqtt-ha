/**
 * The MQTT contract (docs/contract.md): identifiers, topics, payload validation. No Scrypted imports, so it is
 * testable on its own and add-ons can copy the shapes.
 */

export const CONTRACT_VERSION = 1;
export const BRIDGE_SOURCE = 'bridge';
/** Scrypted event interface an add-on emits on its own plugin device. */
export const ADDON_EVENT = 'ScryptedMqttAddon';
/** Scrypted event interface the bridge emits on its own plugin device. */
export const BRIDGE_EVENT = 'ScryptedMqttBridge';

export const PLATFORMS = ['binary_sensor', 'sensor', 'switch', 'button', 'event'] as const;
export type Platform = typeof PLATFORMS[number];

export const MAX_ENTITIES = 64;
const MAX_TEXT = 255;

const DEVICE_RE = /^[0-9A-Za-z_-]{1,64}$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const KEY_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;
const EVENT_TYPE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OBJECT_ID_RE = /^[a-z0-9_]{1,128}$/;
const REQUEST_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ROOT_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;
const DEVICE_CLASS_RE = /^[a-z_]{1,32}$/;
const ICON_RE = /^mdi:[a-z0-9-]{1,64}$/;
const STATE_CLASSES = ['measurement', 'total', 'total_increasing'];
const CATEGORIES = ['diagnostic', 'config'];

export const isDevice = (s: unknown): s is string => typeof s === 'string' && DEVICE_RE.test(s);
export const isSource = (s: unknown): s is string => typeof s === 'string' && SOURCE_RE.test(s);
export const isKey = (s: unknown): s is string => typeof s === 'string' && KEY_RE.test(s);
export const isEventType = (s: unknown): s is string => typeof s === 'string' && EVENT_TYPE_RE.test(s);
export const isRequestId = (s: unknown): s is string => typeof s === 'string' && REQUEST_RE.test(s);
export const isRoot = (s: unknown): s is string => typeof s === 'string' && ROOT_RE.test(s);

export interface EntitySpec {
    key: string;
    name: string;
    platform: Platform;
    device_class?: string;
    unit?: string;
    state_class?: string;
    event_types?: string[];
    category?: string;
    enabled?: boolean;
    icon?: string;
    object_id?: string;
}

export interface DeviceSpec {
    name: string;
    model?: string;
    manufacturer?: string;
    sw_version?: string;
    stream?: string;
}

export interface ConfigPayload {
    v: number;
    device?: DeviceSpec;
    entities: EntitySpec[];
}

/** Lower-case words joined by `_`, as Home Assistant's slugify does for plain names. */
export function slug(s: string): string {
    return String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** A Scrypted class name as an event type: lower case, anything else becomes `_`. Undefined when nothing is left. */
export function eventType(className: unknown): string | undefined {
    const t = slug(String(className ?? '')).slice(0, 64);
    return isEventType(t) ? t : undefined;
}

const text = (v: unknown, max = MAX_TEXT): string | undefined =>
    typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;

/** One entity, cleaned to the contract's fields; throws with the reason when it does not validate. */
export function validateEntity(raw: any): EntitySpec {
    if (!raw || typeof raw !== 'object') throw new Error('entity is not an object');
    if (!isKey(raw.key)) throw new Error(`invalid key ${JSON.stringify(raw.key)}`);
    const name = text(raw.name, 64);
    if (!name) throw new Error(`${raw.key}: invalid name`);
    if (!(PLATFORMS as readonly string[]).includes(raw.platform)) throw new Error(`${raw.key}: invalid platform`);
    const e: EntitySpec = { key: raw.key, name, platform: raw.platform };
    if (raw.device_class !== undefined) {
        if (typeof raw.device_class !== 'string' || !DEVICE_CLASS_RE.test(raw.device_class)) throw new Error(`${raw.key}: invalid device_class`);
        e.device_class = raw.device_class;
    }
    if (raw.unit !== undefined) {
        if (e.platform !== 'sensor' || !text(raw.unit, 16)) throw new Error(`${raw.key}: invalid unit`);
        e.unit = raw.unit;
    }
    if (raw.state_class !== undefined) {
        if (e.platform !== 'sensor' || !STATE_CLASSES.includes(raw.state_class)) throw new Error(`${raw.key}: invalid state_class`);
        e.state_class = raw.state_class;
    }
    if (raw.event_types !== undefined) {
        if (e.platform !== 'event' || !Array.isArray(raw.event_types) || raw.event_types.length > 64 || !raw.event_types.every(isEventType))
            throw new Error(`${raw.key}: invalid event_types`);
        e.event_types = [...new Set<string>(raw.event_types)];
    }
    if (raw.category !== undefined) {
        if (!CATEGORIES.includes(raw.category)) throw new Error(`${raw.key}: invalid category`);
        e.category = raw.category;
    }
    if (raw.enabled !== undefined) {
        if (typeof raw.enabled !== 'boolean') throw new Error(`${raw.key}: invalid enabled`);
        e.enabled = raw.enabled;
    }
    if (raw.icon !== undefined) {
        if (typeof raw.icon !== 'string' || !ICON_RE.test(raw.icon)) throw new Error(`${raw.key}: invalid icon`);
        e.icon = raw.icon;
    }
    if (raw.object_id !== undefined) {
        if (typeof raw.object_id !== 'string' || !OBJECT_ID_RE.test(raw.object_id)) throw new Error(`${raw.key}: invalid object_id`);
        e.object_id = raw.object_id;
    }
    return e;
}

/** A source's entity list: every entity valid, keys unique, at most MAX_ENTITIES. */
export function validateEntities(raw: unknown): EntitySpec[] {
    if (!Array.isArray(raw)) throw new Error('entities is not a list');
    if (raw.length > MAX_ENTITIES) throw new Error(`more than ${MAX_ENTITIES} entities`);
    const out = raw.map(validateEntity);
    const keys = new Set<string>();
    for (const e of out) {
        if (keys.has(e.key)) throw new Error(`duplicate key ${e.key}`);
        keys.add(e.key);
    }
    return out;
}

/** A state payload: booleans as ON/OFF, null/undefined as unknown (empty), text up to 255 characters. */
export function encodeState(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'ON' : 'OFF';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    const s = String(value);
    if (s.length > MAX_TEXT) throw new Error('state longer than 255 characters');
    return s;
}

export class Topics {
    constructor(readonly root: string) {
        if (!isRoot(root)) throw new Error(`invalid topic root ${JSON.stringify(root)}`);
    }
    status(source: string) { return `${this.root}/sources/${source}/status`; }
    config(device: string, source: string) { return `${this.root}/devices/${device}/${source}/config`; }
    state(device: string, source: string, key: string) { return `${this.root}/devices/${device}/${source}/state/${key}`; }
    event(device: string, source: string, key: string) { return `${this.root}/devices/${device}/${source}/event/${key}`; }
    snapshotReply(device: string, id: string) { return `${this.root}/devices/${device}/${BRIDGE_SOURCE}/snapshot/${id}`; }
    /** what the bridge subscribes to */
    get commands() { return `${this.root}/devices/+/+/set/+`; }
    get snapshotRequests() { return `${this.root}/devices/+/${BRIDGE_SOURCE}/snapshot/request`; }

    /** Inbound topics the bridge acts on, or undefined for anything else. */
    parse(topic: string): { kind: 'set'; device: string; source: string; key: string } | { kind: 'snapshot'; device: string } | undefined {
        if (!topic.startsWith(this.root + '/')) return undefined;
        const p = topic.slice(this.root.length + 1).split('/');
        if (p.length === 5 && p[0] === 'devices' && p[3] === 'set' && isDevice(p[1]) && isSource(p[2]) && isKey(p[4]))
            return { kind: 'set', device: p[1], source: p[2], key: p[4] };
        if (p.length === 5 && p[0] === 'devices' && p[2] === BRIDGE_SOURCE && p[3] === 'snapshot' && p[4] === 'request' && isDevice(p[1]))
            return { kind: 'snapshot', device: p[1] };
        return undefined;
    }
}

export interface SnapshotRequest { id: string; width?: number; height?: number }

/** `{"id", "width"?, "height"?}`; sizes are whole pixels from 16 to 7680. */
export function parseSnapshotRequest(payload: Buffer | string): SnapshotRequest | undefined {
    let j: any;
    try { j = JSON.parse(payload.toString()); } catch { return undefined; }
    if (!j || !isRequestId(j.id)) return undefined;
    const size = (v: unknown) => Number.isInteger(v) && (v as number) >= 16 && (v as number) <= 7680 ? v as number : undefined;
    return { id: j.id, width: size(j.width), height: size(j.height) };
}

/** Commands a platform accepts on `set/<key>`. */
export function acceptsCommand(platform: Platform, value: string): boolean {
    if (platform === 'switch') return value === 'ON' || value === 'OFF';
    if (platform === 'button') return value === 'PRESS';
    return false;
}

/** Rebroadcast URLs point at localhost inside Scrypted; Home Assistant reaches them on `host`. */
export function streamUrlFor(url: string, host: string): string | undefined {
    let u: URL;
    try { u = new URL(url); } catch { return undefined; }
    if (u.protocol !== 'rtsp:' && u.protocol !== 'rtsps:') return undefined;
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') u.hostname = host;
    return u.toString();
}
