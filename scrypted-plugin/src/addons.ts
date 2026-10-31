import { acceptsCommand, BRIDGE_SOURCE, CONTRACT_VERSION, encodeState, EntitySpec, isDevice, isEventType, isKey, isSource, validateEntities } from './contract';

/** Seconds without any message after which a source is published offline. */
export const SOURCE_TIMEOUT_MS = 90_000;
const MAX_ATTRIBUTES_BYTES = 4096;
const MAX_SOURCES = 32;
const MAX_DEVICES_PER_SOURCE = 256;
/** A source's dropped messages are logged at most this often. */
const DROP_LOG_MS = 60_000;

/** Where the relay's output goes: the bridge turns these into MQTT publishes. */
export interface AddonSink {
    /** entities undefined withdraws the source's config (and its states) for the device */
    config(device: string, source: string, entities: EntitySpec[] | undefined): void;
    state(device: string, source: string, key: string, payload: string): void;
    event(device: string, source: string, key: string, payload: string): void;
    status(source: string, online: boolean): void;
}

interface SourceRecord {
    /** Scrypted id of the plugin device that first used this source name; others are refused */
    owner: string;
    lastSeen: number;
    online: boolean;
    configs: Map<string, EntitySpec[]>;
    states: Map<string, Map<string, string>>;
}

/**
 * Add-ons from other Scrypted plugins (docs/contract.md, section 10). Keeps the last config and states of every
 * source so a broker reconnection or a camera that becomes published needs nothing from the add-ons, and publishes
 * only for cameras the bridge publishes.
 */
export class AddonRelay {
    private sources = new Map<string, SourceRecord>();
    private dropLoggedAt = new Map<string, number>();

    constructor(
        private sink: AddonSink,
        private isPublished: (device: string) => boolean,
        private log: (message: string) => void,
        private now: () => number = Date.now,
        /** devices an add-on may describe: those that exist in Scrypted */
        private isKnown: (device: string) => boolean = () => true,
    ) { }

    /** One message from the plugin device `owner`. Invalid messages are dropped, logged at most once a minute per owner. */
    handle(owner: string, msg: any) {
        try {
            this.apply(owner, msg);
        }
        catch (e) {
            const now = this.now();
            if (now - (this.dropLoggedAt.get(owner) ?? -Infinity) < DROP_LOG_MS) return;
            this.dropLoggedAt.set(owner, now);
            this.log(`add-on message dropped: ${(e as Error).message}`);
        }
    }

    /** True once the source has sent something since the bridge started. */
    hasSource(source: string): boolean {
        return this.sources.has(source);
    }

    private apply(owner: string, msg: any) {
        if (!msg || typeof msg !== 'object' || msg.v !== CONTRACT_VERSION) throw new Error('not a v1 message');
        const source = msg.source;
        if (!isSource(source) || source === BRIDGE_SOURCE) throw new Error(`invalid source ${JSON.stringify(source)}`);
        let rec = this.sources.get(source);
        if (rec && rec.owner !== owner) throw new Error(`source ${source} belongs to another plugin`);
        if (!rec) {
            if (this.sources.size >= MAX_SOURCES) throw new Error(`too many sources, ${source} ignored`);
            rec = { owner, lastSeen: 0, online: false, configs: new Map(), states: new Map() };
            this.sources.set(source, rec);
        }
        rec.lastSeen = this.now();
        if (!rec.online) {
            rec.online = true;
            this.sink.status(source, true);
        }
        if (msg.type === 'alive') return;
        const device = msg.device;
        if (!isDevice(device)) throw new Error(`${source}: invalid device`);
        switch (msg.type) {
            case 'config':
                if (!this.isKnown(device)) throw new Error(`${source}: unknown device ${device}`);
                if (!rec.configs.has(device) && rec.configs.size >= MAX_DEVICES_PER_SOURCE) throw new Error(`${source}: too many devices`);
                return this.config(rec, source, device, validateEntities(msg.entities));
            case 'withdraw': return this.withdraw(rec, source, device);
            case 'state': return this.state(rec, source, device, msg.key, msg.value);
            case 'event': return this.event(rec, source, device, msg.key, msg.event_type, msg.attributes);
            default: throw new Error(`${source}: unknown type ${JSON.stringify(msg.type)}`);
        }
    }

    private config(rec: SourceRecord, source: string, device: string, entities: EntitySpec[]) {
        const before = rec.configs.get(device);
        if (before && JSON.stringify(before) === JSON.stringify(entities)) return;
        rec.configs.set(device, entities);
        const keys = new Set(entities.map(e => e.key));
        const states = rec.states.get(device);
        const published = this.isPublished(device);
        if (published) this.sink.config(device, source, entities);
        for (const k of [...states?.keys() ?? []]) {
            if (keys.has(k)) continue;
            states!.delete(k);
            if (published) this.sink.state(device, source, k, '');
        }
    }

    private withdraw(rec: SourceRecord, source: string, device: string) {
        if (!rec.configs.has(device)) return;
        rec.configs.delete(device);
        rec.states.delete(device);
        if (this.isPublished(device)) this.sink.config(device, source, undefined);
    }

    private entity(rec: SourceRecord, source: string, device: string, key: unknown): EntitySpec {
        const e = isKey(key) ? rec.configs.get(device)?.find(x => x.key === key) : undefined;
        if (!e) throw new Error(`${source}/${device}: undeclared key ${JSON.stringify(key)}`);
        return e;
    }

    private state(rec: SourceRecord, source: string, device: string, key: unknown, value: unknown) {
        const e = this.entity(rec, source, device, key);
        if (e.platform === 'button' || e.platform === 'event') throw new Error(`${source}/${device}/${e.key}: ${e.platform} has no state`);
        const payload = encodeState(value);
        let states = rec.states.get(device);
        if (!states) rec.states.set(device, states = new Map());
        if (states.get(e.key) === payload) return;
        states.set(e.key, payload);
        if (this.isPublished(device)) this.sink.state(device, source, e.key, payload);
    }

    private event(rec: SourceRecord, source: string, device: string, key: unknown, type: unknown, attributes: unknown) {
        const e = this.entity(rec, source, device, key);
        if (e.platform !== 'event') throw new Error(`${source}/${device}/${e.key}: not an event`);
        if (!isEventType(type)) throw new Error(`${source}/${device}/${e.key}: invalid event_type`);
        const attrs = attributes && typeof attributes === 'object' && !Array.isArray(attributes) ? attributes : {};
        const payload = JSON.stringify({ event_type: type, attributes: attrs });
        if (payload.length > MAX_ATTRIBUTES_BYTES) throw new Error(`${source}/${device}/${e.key}: attributes too large`);
        if (this.isPublished(device)) this.sink.event(device, source, e.key, payload);
    }

    /** Sources silent for SOURCE_TIMEOUT_MS go offline; run every few seconds. */
    sweep() {
        const now = this.now();
        for (const [source, rec] of this.sources) {
            if (rec.online && now - rec.lastSeen > SOURCE_TIMEOUT_MS) {
                rec.online = false;
                this.sink.status(source, false);
            }
        }
    }

    /** A camera became published: everything the add-ons sent for it. */
    devicePublished(device: string) {
        for (const [source, rec] of this.sources) {
            const entities = rec.configs.get(device);
            if (!entities) continue;
            this.sink.config(device, source, entities);
            for (const [k, v] of rec.states.get(device) ?? []) this.sink.state(device, source, k, v);
        }
    }

    /** A camera is no longer published: withdraw the add-ons' configs (kept in memory for later). */
    deviceUnpublished(device: string) {
        for (const [source, rec] of this.sources)
            if (rec.configs.has(device)) this.sink.config(device, source, undefined);
    }

    /** After a broker (re)connection: statuses, then every published device's configs and states. */
    republish() {
        const devices = new Set<string>();
        for (const [source, rec] of this.sources) {
            this.sink.status(source, rec.online);
            for (const d of rec.configs.keys()) devices.add(d);
        }
        for (const d of devices) if (this.isPublished(d)) this.devicePublished(d);
    }

    /** The source that may receive a command for this key, or undefined when it may not. */
    commandTarget(device: string, source: string, key: string, value: string): string | undefined {
        const rec = this.sources.get(source);
        if (!rec?.online || !this.isPublished(device)) return undefined;
        const e = rec.configs.get(device)?.find(x => x.key === key);
        return e && acceptsCommand(e.platform, value) ? source : undefined;
    }

    summary(): string {
        const parts = [...this.sources].map(([s, r]) => `${s} (${r.online ? 'online' : 'offline'}, ${r.configs.size} cameras)`);
        return parts.length ? parts.join(', ') : 'none';
    }
}
