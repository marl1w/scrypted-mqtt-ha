import sdk, { AudioSensor, Battery, BinarySensor, Camera, EventListenerRegister, ResponseMediaStreamOptions, MotionSensor, ObjectDetector, ObjectsDetected, OccupancySensor, OnOff, Online, ScryptedDevice, ScryptedInterface, Settings, VideoCamera } from '@scrypted/sdk';
import { ConfigPayload, CONTRACT_VERSION, DeviceSpec, encodeState, EntitySpec, eventType, MIN_INTEGRATION, SnapshotRequest, StreamSpec, streamUrlFor } from './contract';
import { AddonEntities, CameraMemory, CHILD_PREFIX, DeviceFacts, FOLDED_PROPERTY, foldedDevices, foldedEntity, foldedInterface, isCameraDetection, MAX_RAW_CLASSES, mergeReplaces, RAW_PREFIX, RawClasses, rawBesideFolded, rawEntities, replacesFor, stableFolded } from './fold';
import { StreamUrlKeeper, StreamUrls, syntheticStreamUrl } from './stream';

type Dev = ScryptedDevice & Partial<VideoCamera & Camera & MotionSensor & OccupancySensor & AudioSensor & Online & Battery & ObjectDetector & OnOff & BinarySensor & Settings>;

/** What a camera publisher needs from the bridge. */
export interface CameraHost {
    /** config takes no key; state and event do */
    publish(kind: 'config' | 'state' | 'event', device: string, payload: string, key?: string): void;
    streamHost(): string;
    /** false: the rebroadcast without audio (no AAC for WebRTC to stumble on) */
    streamAudio(): boolean;
    /** name of a Rebroadcast synthetic stream that, where a camera has it, Home Assistant plays instead (empty: none) */
    opusStream(): string;
    /** the add-ons' entities on this camera, with the plugin that sent each */
    addons(device: string, state: SystemState): AddonEntities[];
    /** what the bridge remembers of this camera across restarts */
    memory(device: string): CameraMemory;
    remember(device: string, memory: CameraMemory): void;
    /** true when another published camera folds this device now */
    foldedElsewhere(device: string, id: string): boolean;
    console: Console;
}

const SNAPSHOT_TIMEOUT_MS = 8000;
/** A finished snapshot answers requests for this long (dashboards poll every ~10 s per client). */
const SNAPSHOT_REUSE_MS = 3000;
/** One event per class per camera at most this often: detectors repeat every second while a class is seen. */
const DETECTION_EVENT_MS = 5000;
const LOOKUP_TIMEOUT_MS = 15000;

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: timeout`)), ms).unref?.()),
]);

export type SystemState = ReturnType<typeof sdk.systemManager.getSystemState>;

export function factsOf(id: string, s: any): DeviceFacts {
    return {
        id,
        name: s?.name?.value,
        pluginId: s?.pluginId?.value,
        providerId: s?.providerId?.value,
        interfaces: s?.interfaces?.value,
        mixins: (s?.mixins?.value as unknown[] | undefined)?.map(String),
    };
}

export const allFacts = (state: SystemState) => Object.keys(state).map(id => factsOf(id, state[id]));

function foldedState(dev: Dev): unknown {
    const iface = foldedInterface(dev.interfaces);
    return iface ? (dev as any)[FOLDED_PROPERTY[iface]] : undefined;
}

/**
 * The RTSP rebroadcasts Home Assistant plays, as it reaches them: Rebroadcast's default stream (a cropped view where one
 * is configured, else a prebuffered one), and the highest-resolution stream when that is another one.
 */
async function rebroadcastUrls(d: Dev, options: ResponseMediaStreamOptions[], host: string, audio: boolean, opus: string): Promise<StreamUrls> {
    if (!options.length || !d.interfaces?.includes(ScryptedInterface.Settings)) return {};
    const settings = await withTimeout(d.getSettings!(), LOOKUP_TIMEOUT_MS, 'settings');
    const key = audio ? 'prebuffer:rtspRebroadcastUrl' : 'prebuffer:rtspRebroadcastMutedUrl';
    const urls = settings.filter(s => s.key === key && typeof s.value === 'string');
    if (!urls.length) return {};
    const urlOf = (o?: ResponseMediaStreamOptions) => {
        const s = o && urls.find(u => u.subgroup === `Stream: ${o.name}`);
        return s ? streamUrlFor(String(s.value), host) : undefined;
    };
    const defaultName = settings.find(s => s.key === 'prebuffer:defaultStream')?.value;
    const main = options.find(o => o.name === defaultName) ?? options.find(o => o.prebuffer) ?? options.find(o => o.video?.codec === 'h264') ?? options[0];
    // widest stream; RTSP before RTMP at the same width (its codec is declared)
    const high = [...options].sort((a, b) => (b.video?.width ?? 0) - (a.video?.width ?? 0) || Number(b.container === 'rtsp') - Number(a.container === 'rtsp'))[0];
    const synthetic = syntheticStreamUrl(settings, opus, audio);
    const mainUrl = (synthetic && streamUrlFor(synthetic, host))
        ?? urlOf(main) ?? (urls.length === 1 ? streamUrlFor(String(urls[0].value), host) : undefined);
    const highUrl = high && high !== main && (high.video?.width ?? 0) > (main?.video?.width ?? 0)
        ? (streamUrlFor(syntheticStreamUrl(settings, opus && `${opus}-high`, audio) ?? '', host) ?? urlOf(high)) : undefined;
    return { main: mainUrl, high: highUrl };
}

/** One published camera: its config, the states of its entities, its detections, children and snapshots. */
export class CameraPublisher {
    private listeners: EventListenerRegister[] = [];
    private boundTo = '';
    private config = '';
    private entities = new Map<string, EntitySpec>();
    private states = new Map<string, string>();
    private snapshot?: Promise<Buffer | undefined>;
    private lastPicture?: { at: number; jpeg: Buffer };
    private lastEvent = new Map<string, number>();
    private stream = new StreamUrlKeeper();
    private streamRetry?: NodeJS.Timeout;
    private running?: Promise<boolean>;
    private dirty = false;
    private stopped = false;
    private rawClasses = new RawClasses((cls, on) => this.state(`${RAW_PREFIX}${cls}`, on));
    /** detections from these (the camera's mixins and their plugins) are not the camera's own */
    private mixinSources = new Set<string>();
    /** ids of the devices folded into the camera at the last refresh */
    private foldedIds = new Set<string>();
    private ambiguousLogged = '';

    constructor(readonly id: string, private host: CameraHost) { }

    private device(): Dev | undefined {
        const d = sdk.systemManager.getDeviceById<Dev>(this.id);
        return d?.interfaces?.includes(ScryptedInterface.VideoCamera) ? d : undefined;
    }

    /**
     * The children and companions folded into this camera's device (fold.ts), and those folded before that still exist
     * and belong to no other camera: a device leaves the camera's device only when it positively goes.
     */
    private folded(state: SystemState, all: DeviceFacts[], memory: CameraMemory): Dev[] {
        const me = all.find(f => f.id === this.id);
        if (!me) return [];
        const found = foldedDevices(me, all);
        const ambiguous = found.ambiguous.map(d => d.name).join(', ');
        if (ambiguous && ambiguous !== this.ambiguousLogged)
            this.host.console.warn(`${me.name}: not folded, more than one camera has this name: ${ambiguous}`);
        this.ambiguousLogged = ambiguous;
        return stableFolded(me, found.devices, memory.folded, all, id => this.host.foldedElsewhere(this.id, id))
            .filter(f => state[f.id])
            .map(f => sdk.systemManager.getDeviceById<Dev>(f.id))
            .filter((c): c is Dev => !!c);
    }

    /** Ids of the devices folded into this camera at the last refresh. */
    folds(id: string): boolean {
        return this.foldedIds.has(id);
    }

    /**
     * Rebuilds the config (published only when it changed), rebinds listeners when the watched devices changed, publishes
     * states. One refresh at a time: a request during one runs once more afterwards, so the newest state always wins.
     * Resolves false when the device is no longer a camera (its config is withdrawn).
     */
    refresh(): Promise<boolean> {
        if (this.running) {
            this.dirty = true;
            return this.running;
        }
        const run = async (): Promise<boolean> => {
            let present = true;
            do {
                this.dirty = false;
                present = await this.refreshOnce();
            } while (this.dirty && present && !this.stopped);
            return present;
        };
        this.running = run().finally(() => { this.running = undefined; });
        return this.running;
    }

    private async refreshOnce(): Promise<boolean> {
        if (this.stopped) return false;
        const d = this.device();
        if (!d) {
            this.withdraw();
            return false;
        }
        const state = sdk.systemManager.getSystemState();
        const all = allFacts(state);
        const memory = this.host.memory(this.id);
        const ifs = d.interfaces || [];
        const children = this.folded(state, all, memory);
        const entities: EntitySpec[] = [];
        /** the Scrypted plugin each entity is read from, for the add-on entities it takes over */
        const origin = new Map<string, string | undefined>();
        if (ifs.includes(ScryptedInterface.Online)) entities.push({ key: 'online', name: 'Online', platform: 'binary_sensor', device_class: 'connectivity', category: 'diagnostic' });
        if (ifs.includes(ScryptedInterface.MotionSensor)) entities.push({ key: 'motion', name: 'Motion', platform: 'binary_sensor', device_class: 'motion' });
        if (ifs.includes(ScryptedInterface.OccupancySensor)) entities.push({ key: 'occupancy', name: 'Occupancy', platform: 'binary_sensor', device_class: 'occupancy' });
        if (ifs.includes(ScryptedInterface.AudioSensor)) entities.push({ key: 'audio', name: 'Sound', platform: 'binary_sensor', device_class: 'sound' });
        if (ifs.includes(ScryptedInterface.ObjectDetector)) {
            const types = await withTimeout(d.getObjectTypes!(), LOOKUP_TIMEOUT_MS, 'object types').catch(() => undefined);
            const eventTypes = [...new Set((types?.classes ?? []).filter(c => c !== 'motion').map(eventType).filter((t): t is string => !!t))].slice(0, 64);
            entities.push({ key: 'detection', name: 'Object detected', platform: 'event', event_types: eventTypes });
        }
        if (ifs.includes(ScryptedInterface.Battery)) entities.push({ key: 'battery', name: 'Battery', platform: 'sensor', device_class: 'battery', unit: '%', state_class: 'measurement', category: 'diagnostic' });
        const folded: EntitySpec[] = [];
        for (const c of children) {
            const e = foldedEntity({ id: c.id, name: c.name, interfaces: c.interfaces }, [String(d.name || ''), String((d as any).providedName || '')], c.providerId === this.id);
            if (!e) continue;
            folded.push(e);
            origin.set(e.key, c.pluginId);
        }
        // the classes the camera itself has reported (remembered, so the list never shrinks); a raw device of the same key wins
        const raw = ifs.includes(ScryptedInterface.ObjectDetector) ? rawEntities(memory.classes ?? []) : [];
        const beside = rawBesideFolded(raw, folded);
        for (const e of beside.raw) {
            entities.push(e);
            origin.set(e.key, d.pluginId);
        }
        entities.push(...folded);
        const addons = this.host.addons(this.id, state);
        const replaces: Record<string, string[]> = {};
        for (const e of entities) {
            if (!origin.has(e.key)) continue;
            const now = [...replacesFor(e, origin.get(e.key), addons) ?? [], ...beside.replaces[e.key] ?? []];
            const r = mergeReplaces(now, memory.replaces?.[e.key], e.platform, source => addons.find(a => a.source === source)?.entities);
            if (!r) continue;
            e.replaces = r;
            replaces[e.key] = r;
        }

        const urls = await this.streamUrls(d);
        if (this.stopped) return false;
        const device: DeviceSpec = { name: String(d.name || this.id).slice(0, 255) };
        if (d.info?.model) device.model = String(d.info.model).slice(0, 255);
        if (d.info?.manufacturer) device.manufacturer = String(d.info.manufacturer).slice(0, 255);
        if (d.info?.firmware) device.sw_version = String(d.info.firmware).slice(0, 255);
        if (urls.main) device.stream = urls.main;
        if (urls.high) device.streams = [{ key: 'high', name: 'High resolution', url: urls.high } satisfies StreamSpec];
        const payload: ConfigPayload = { v: CONTRACT_VERSION, min_integration: MIN_INTEGRATION, device, entities };
        const json = JSON.stringify(payload);

        const declared = new Set(entities.map(e => e.key));
        for (const k of [...this.states.keys()]) {
            if (declared.has(k)) continue;
            this.states.delete(k);
            this.host.publish('state', this.id, '', k);
        }
        this.entities = new Map(entities.map(e => [e.key, e]));
        if (json !== this.config) {
            this.config = json;
            this.host.publish('config', this.id, json);
        }
        this.foldedIds = new Set(children.map(c => c.id));
        // read again: a class seen while this refresh waited is kept
        const latest = this.host.memory(this.id);
        const next: CameraMemory = { classes: latest.classes, folded: [...this.foldedIds], replaces };
        if (JSON.stringify(next) !== JSON.stringify(latest)) this.host.remember(this.id, next);
        const mine = all.find(f => f.id === this.id);
        this.mixinSources = new Set((mine?.mixins ?? []).flatMap(m => [m, String(state[m]?.pluginId?.value ?? '')]).filter(Boolean));
        const watched = JSON.stringify([this.id, children.map(c => c.id)]);
        if (watched !== this.boundTo) this.bind(children, watched);
        this.publishStates(d, children);
        return true;
    }

    /** A class the camera itself reported: remembered, and the camera gets its entity (an add-on's of that name hands over). */
    private rawSeen(classes: string[]) {
        if (!classes.length) return;
        const memory = this.host.memory(this.id);
        const known = new Set(memory.classes ?? []);
        const fresh = classes.filter(c => !known.has(c));
        if (!fresh.length || known.size >= MAX_RAW_CLASSES) return;
        this.host.remember(this.id, { ...memory, classes: [...known, ...fresh].slice(0, MAX_RAW_CLASSES) });
        this.refresh().catch(e => this.host.console.warn(`camera ${this.id}: ${(e as Error).message}`));
    }

    /**
     * The rebroadcast URLs, looked up through every mixin's settings only when the stream options changed or they are old.
     * A lookup that fails or loses a URL keeps the last good ones and is retried soon (StreamUrlKeeper).
     */
    private async streamUrls(d: Dev): Promise<StreamUrls> {
        let key = '';
        let urls: StreamUrls | undefined;
        try {
            const options = d.interfaces?.includes(ScryptedInterface.VideoCamera)
                ? await withTimeout(d.getVideoStreamOptions!(), LOOKUP_TIMEOUT_MS, 'stream options')
                : [];
            const audio = this.host.streamAudio();
            const opus = this.host.opusStream();
            key = JSON.stringify([this.host.streamHost(), audio, opus, options.map(o => [o.id, o.name, !!o.prebuffer])]);
            const cached = this.stream.cached(key);
            if (cached) return cached;
            urls = await rebroadcastUrls(d, options, this.host.streamHost(), audio, opus);
        }
        catch (e) {
            this.host.console.warn(`${d.name}: no stream URL (${(e as Error).message})`);
        }
        const next = this.stream.update(key, urls);
        if (next.retryMs !== undefined && !this.streamRetry && !this.stopped) {
            this.streamRetry = setTimeout(() => {
                this.streamRetry = undefined;
                this.refresh().catch(e => this.host.console.warn(`${d.name}: ${(e as Error).message}`));
            }, next.retryMs);
        }
        return next.urls;
    }

    private bind(children: Dev[], watched: string) {
        this.unbind();
        const sm = sdk.systemManager;
        const on = (id: string, iface: ScryptedInterface, fn: (data: any, mixinId?: string) => void) =>
            this.listeners.push(sm.listenDevice(id, iface, (_s, details, data) => { if (!this.stopped) fn(data, details?.mixinId); }));
        on(this.id, ScryptedInterface.Online, v => this.state('online', v));
        on(this.id, ScryptedInterface.MotionSensor, v => this.state('motion', v));
        on(this.id, ScryptedInterface.OccupancySensor, v => this.state('occupancy', v));
        on(this.id, ScryptedInterface.AudioSensor, v => this.state('audio', v));
        on(this.id, ScryptedInterface.Battery, v => this.state('battery', v));
        // detection events are never masked by a mixin: every listener gets the camera's and its mixins'
        on(this.id, ScryptedInterface.ObjectDetector, (v: ObjectsDetected, mixinId) => {
            this.detections(v);
            if (!v || !isCameraDetection(v.sourceId, mixinId, this.mixinSources)) return;
            this.rawSeen(this.rawClasses.frame(String(v.sourceId ?? ''), (v.detections ?? []).map(x => x?.className)));
        });
        for (const c of children) {
            const iface = foldedInterface(c.interfaces);
            if (iface) on(c.id, iface as ScryptedInterface, () => this.state(`${CHILD_PREFIX}${c.id}`, foldedState(sm.getDeviceById<Dev>(c.id))));
        }
        this.boundTo = watched;
    }

    private unbind() {
        for (const l of this.listeners) l.removeListener();
        this.listeners = [];
        this.boundTo = '';
    }

    private publishStates(d: Dev, children: Dev[]) {
        if (this.entities.has('online')) this.state('online', d.online);
        if (this.entities.has('motion')) this.state('motion', d.motionDetected);
        if (this.entities.has('occupancy')) this.state('occupancy', d.occupied);
        if (this.entities.has('audio')) this.state('audio', d.audioDetected);
        if (this.entities.has('battery')) this.state('battery', d.batteryLevel);
        for (const [k, e] of this.entities)
            if (k.startsWith(RAW_PREFIX) && e.platform === 'binary_sensor') this.state(k, this.rawClasses.isOn(k.slice(RAW_PREFIX.length)));
        for (const c of children) {
            const k = `${CHILD_PREFIX}${c.id}`;
            if (this.entities.has(k)) this.state(k, foldedState(c));
        }
    }

    private state(key: string, value: unknown) {
        const e = this.entities.get(key);
        if (!e) return;
        const payload = e.platform === 'binary_sensor' || e.platform === 'switch'
            ? (value === undefined || value === null ? '' : encodeState(!!value))
            : encodeState(value);
        if (this.states.get(key) === payload) return;
        this.states.set(key, payload);
        this.host.publish('state', this.id, payload, key);
    }

    /**
     * One event per distinct class of a detection payload, as Scrypted's own Home Assistant integration fires them, but
     * at most one per class every DETECTION_EVENT_MS: a class that stays in view keeps firing at that pace (state
     * triggers with a longer auto-off still hold), without a recorder row every second.
     */
    private detections(data: ObjectsDetected) {
        if (!this.entities.has('detection') || !data) return;
        const now = Date.now();
        const seen = new Set<string>();
        for (const det of data.detections ?? []) {
            if (det?.className === 'motion') continue;
            const type = eventType(det?.className);
            if (!type || seen.has(type)) continue;
            seen.add(type);
            if (now - (this.lastEvent.get(type) ?? -Infinity) < DETECTION_EVENT_MS) continue;
            this.lastEvent.set(type, now);
            const score = typeof det.score === 'number' ? Math.round(det.score * 100) / 100 : null;
            const attributes = { label: det.label ?? null, score, zones: det.zones ?? null };
            this.host.publish('event', this.id, JSON.stringify({ event_type: type, attributes }), 'detection');
        }
    }

    /** Runs a command for one of the bridge's own keys; false when the key takes no commands. */
    async command(key: string, value: string): Promise<boolean> {
        const e = this.entities.get(key);
        if (!e || e.platform !== 'switch' || !key.startsWith(CHILD_PREFIX)) return false;
        const childId = key.slice(CHILD_PREFIX.length);
        const child = sdk.systemManager.getDeviceById<Dev>(childId);
        if (!child || !this.foldedIds.has(childId) || !child.interfaces?.includes(ScryptedInterface.OnOff)) return false;
        await (value === 'ON' ? child.turnOn!() : child.turnOff!());
        return true;
    }

    /**
     * A JPEG for the request. One picture at a time per camera whatever the size asked (Home Assistant scales it down),
     * and a finished one answers every request for SNAPSHOT_REUSE_MS.
     */
    snapshotFor(req: SnapshotRequest): Promise<Buffer | undefined> {
        if (this.lastPicture && Date.now() - this.lastPicture.at < SNAPSHOT_REUSE_MS) return Promise.resolve(this.lastPicture.jpeg);
        if (this.snapshot) return this.snapshot;
        const picture = this.takePicture(req).then(jpeg => {
            if (jpeg) this.lastPicture = { at: Date.now(), jpeg };
            return jpeg;
        }).finally(() => { this.snapshot = undefined; });
        this.snapshot = picture;
        return picture;
    }

    private async takePicture(req: SnapshotRequest): Promise<Buffer | undefined> {
        const d = this.device();
        if (!d?.interfaces?.includes(ScryptedInterface.Camera)) return undefined;
        try {
            const picture = req.width || req.height ? { width: req.width, height: req.height } : undefined;
            const mo = await withTimeout(d.takePicture!(picture ? { picture } : undefined), SNAPSHOT_TIMEOUT_MS, 'snapshot');
            return await withTimeout(sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg'), SNAPSHOT_TIMEOUT_MS, 'snapshot');
        }
        catch (e) {
            this.host.console.warn(`${d.name}: snapshot failed (${(e as Error).message})`);
            return undefined;
        }
    }

    /** The bridge's config and states for this camera, cleared from the broker. */
    withdraw() {
        if (this.config) this.host.publish('config', this.id, '');
        for (const k of this.states.keys()) this.host.publish('state', this.id, '', k);
        this.config = '';
        this.states.clear();
        this.entities.clear();
        this.unbind();
        this.rawClasses.clear();
        this.foldedIds.clear();
    }

    /** Republish everything after a broker reconnection. */
    republish() {
        if (this.config) this.host.publish('config', this.id, this.config);
        for (const [k, v] of this.states) this.host.publish('state', this.id, v, k);
    }

    stop(withdraw: boolean) {
        clearTimeout(this.streamRetry);
        if (withdraw) this.withdraw();
        else this.unbind();
        this.rawClasses.clear();
        this.stopped = true;
    }
}
