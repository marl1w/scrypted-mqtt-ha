import { acceptsCommand, BRIDGE_SOURCE, CONTRACT_VERSION, decodeImage, encodeState, EntitySpec, isDevice, isEventType, isKey, isSource, validateEntities } from './contract';

/** Seconds without any message after which a source is published offline. */
export const SOURCE_TIMEOUT_MS = 90_000;
const MAX_ATTRIBUTES_BYTES = 4096;
const MAX_SOURCES = 32;
const MAX_DEVICES_PER_SOURCE = 256;
/** Images kept for republishing, all sources together; beyond it a new image is still published but not kept. */
const MAX_KEPT_IMAGE_BYTES = 32 * 1024 * 1024;
/** A source's dropped messages are logged at most this often. */
const DROP_LOG_MS = 60_000;

/** Where the relay's output goes: the bridge turns these into MQTT publishes. */
export interface AddonSink {
    /** entities undefined withdraws the source's config (and its states) for the device */
    config(device: string, source: string, entities: EntitySpec[] | undefined): void;
    state(device: string, source: string, key: string, payload: string): void;
    event(device: string, source: string, key: string, payload: string): void;
    /** retained; an empty buffer clears the image */
    image(device: string, source: string, key: string, jpeg: Buffer): void;
    status(source: string, online: boolean): void;
    /** a source sent its first message since the bridge started */
    sourceAdded?(source: string): void;
}

interface SourceRecord {
    /** Scrypted id of the plugin device that first used this source name; others are refused */
    owner: string;
    lastSeen: number;
    online: boolean;
    configs: Map<string, EntitySpec[]>;
    states: Map<string, Map<string, string>>;
    images: Map<string, Map<string, Buffer>>;
    /** keys of images published over budget: retained on the broker, so cleared like kept ones, but without their bytes */
    unkept: Map<string, Set<string>>;
}

/**
 * Add-ons from other Scrypted plugins (docs/contract.md, section 10). Keeps the last config and states of every
 * source so a broker reconnection or a camera that becomes published needs nothing from the add-ons, and publishes
 * only for cameras the bridge publishes.
 */
export class AddonRelay {
    private sources = new Map<string, SourceRecord>();
    private dropLoggedAt = new Map<string, number>();
    private imageBytes = 0;

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
            this.dropped(owner, `add-on message dropped: ${(e as Error).message}`);
        }
    }

    private dropped(owner: string, message: string) {
        const now = this.now();
        if (now - (this.dropLoggedAt.get(owner) ?? -Infinity) < DROP_LOG_MS) return;
        this.dropLoggedAt.set(owner, now);
        this.log(message);
    }

    /** True once the source has sent something since the bridge started. */
    hasSource(source: string): boolean {
        return this.sources.has(source);
    }

    /** True when the source's current config for the device declares `key` as an image entity. */
    declaresImage(device: string, source: string, key: string): boolean {
        return !!this.sources.get(source)?.configs.get(device)?.some(e => e.key === key && e.platform === 'image');
    }

    private apply(owner: string, msg: any) {
        if (!msg || typeof msg !== 'object' || msg.v !== CONTRACT_VERSION) throw new Error('not a v1 message');
        const source = msg.source;
        if (!isSource(source) || source === BRIDGE_SOURCE) throw new Error(`invalid source ${JSON.stringify(source)}`);
        let rec = this.sources.get(source);
        if (rec && rec.owner !== owner) throw new Error(`source ${source} belongs to another plugin`);
        if (!rec) {
            if (this.sources.size >= MAX_SOURCES) throw new Error(`too many sources, ${source} ignored`);
            rec = { owner, lastSeen: 0, online: false, configs: new Map(), states: new Map(), images: new Map(), unkept: new Map() };
            this.sources.set(source, rec);
            this.sink.sourceAdded?.(source);
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
                // an entity this bridge cannot take (a newer add-on's) is dropped alone, the others are kept
                return this.config(rec, source, device, validateEntities(msg.entities,
                    reason => this.dropped(owner, `${source}/${device}: entity dropped: ${reason}`)));
            case 'withdraw': return this.withdraw(rec, source, device);
            case 'state': return this.state(rec, source, device, msg.key, msg.value);
            case 'event': return this.event(rec, source, device, msg.key, msg.event_type, msg.attributes);
            case 'image': return this.image(rec, source, device, msg.key, msg.jpeg);
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
        for (const k of this.imageKeys(rec, device)) {
            if (keys.has(k)) continue;
            this.keepImage(rec, device, k, undefined);
            if (published) this.sink.image(device, source, k, Buffer.alloc(0));
        }
    }

    private withdraw(rec: SourceRecord, source: string, device: string) {
        if (!rec.configs.has(device)) return;
        rec.configs.delete(device);
        rec.states.delete(device);
        const published = this.isPublished(device);
        // images are large: cleared from the broker at once, not left retained until a later run finds them stale
        for (const k of this.imageKeys(rec, device)) {
            this.keepImage(rec, device, k, undefined);
            if (published) this.sink.image(device, source, k, Buffer.alloc(0));
        }
        if (published) this.sink.config(device, source, undefined);
    }

    private entity(rec: SourceRecord, source: string, device: string, key: unknown): EntitySpec {
        const e = isKey(key) ? rec.configs.get(device)?.find(x => x.key === key) : undefined;
        if (!e) throw new Error(`${source}/${device}: undeclared key ${JSON.stringify(key)}`);
        return e;
    }

    private state(rec: SourceRecord, source: string, device: string, key: unknown, value: unknown) {
        const e = this.entity(rec, source, device, key);
        if (e.platform === 'button' || e.platform === 'event' || e.platform === 'image') throw new Error(`${source}/${device}/${e.key}: ${e.platform} has no state`);
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

    private image(rec: SourceRecord, source: string, device: string, key: unknown, jpeg: unknown) {
        const e = this.entity(rec, source, device, key);
        if (e.platform !== 'image') throw new Error(`${source}/${device}/${e.key}: not an image`);
        let payload: Buffer;
        try { payload = decodeImage(jpeg); }
        catch (err) { throw new Error(`${source}/${device}/${e.key}: ${(err as Error).message}`); }
        // a clear is always passed on: an image published over budget was not kept, yet is retained on the broker
        if (rec.images.get(device)?.get(e.key)?.equals(payload)) return;
        if (!this.keepImage(rec, device, e.key, payload.length ? payload : undefined))
            this.log(`${source}/${device}/${e.key}: image published but not kept (more than ${MAX_KEPT_IMAGE_BYTES >> 20} MB of images)`);
        if (this.isPublished(device)) this.sink.image(device, source, e.key, payload);
    }

    /** Keys of the device's images on the broker, kept or not. */
    private imageKeys(rec: SourceRecord, device: string): string[] {
        return [...new Set([...rec.images.get(device)?.keys() ?? [], ...rec.unkept.get(device) ?? []])];
    }

    /**
     * Remembers (or forgets, when undefined) a device's image within MAX_KEPT_IMAGE_BYTES; false when it was over budget,
     * and then only its key is remembered.
     */
    private keepImage(rec: SourceRecord, device: string, key: string, jpeg: Buffer | undefined): boolean {
        let images = rec.images.get(device);
        const before = images?.get(key);
        if (before) {
            this.imageBytes -= before.length;
            images!.delete(key);
            if (!images!.size) rec.images.delete(device);
        }
        const unkept = rec.unkept.get(device);
        if (unkept?.delete(key) && !unkept.size) rec.unkept.delete(device);
        if (!jpeg) return true;
        if (this.imageBytes + jpeg.length > MAX_KEPT_IMAGE_BYTES) {
            if (!rec.unkept.has(device)) rec.unkept.set(device, new Set());
            rec.unkept.get(device)!.add(key);
            return false;
        }
        if (!images || !rec.images.has(device)) rec.images.set(device, images = new Map());
        images.set(key, jpeg);
        this.imageBytes += jpeg.length;
        return true;
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
            for (const [k, jpeg] of rec.images.get(device) ?? []) this.sink.image(device, source, k, jpeg);
        }
    }

    /**
     * A camera is no longer published: clear the add-ons' images and withdraw their configs (both kept in memory for
     * later, but for images that were not kept: those are gone from the broker now).
     */
    deviceUnpublished(device: string) {
        for (const [source, rec] of this.sources) {
            for (const k of this.imageKeys(rec, device)) this.sink.image(device, source, k, Buffer.alloc(0));
            rec.unkept.delete(device);
            if (rec.configs.has(device)) this.sink.config(device, source, undefined);
        }
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
