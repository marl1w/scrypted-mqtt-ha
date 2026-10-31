import sdk, { Battery, BinarySensor, Camera, EventListenerRegister, ResponseMediaStreamOptions, MotionSensor, ObjectDetector, ObjectsDetected, OccupancySensor, OnOff, Online, ScryptedDevice, ScryptedInterface, Settings, VideoCamera } from '@scrypted/sdk';
import { ConfigPayload, CONTRACT_VERSION, DeviceSpec, encodeState, EntitySpec, eventType, SnapshotRequest, StreamSpec, streamUrlFor } from './contract';

type Dev = ScryptedDevice & Partial<VideoCamera & Camera & MotionSensor & OccupancySensor & Online & Battery & ObjectDetector & OnOff & BinarySensor & Settings>;

/** What a camera publisher needs from the bridge. */
export interface CameraHost {
    /** config takes no key; state and event do */
    publish(kind: 'config' | 'state' | 'event', device: string, payload: string, key?: string): void;
    streamHost(): string;
    /** false: the rebroadcast without audio (no AAC for WebRTC to stumble on) */
    streamAudio(): boolean;
    console: Console;
}

const SNAPSHOT_TIMEOUT_MS = 8000;
/** A finished snapshot answers requests for this long (dashboards poll every ~10 s per client). */
const SNAPSHOT_REUSE_MS = 3000;
/** One event per class per camera at most this often: detectors repeat every second while a class is seen. */
const DETECTION_EVENT_MS = 5000;
/** The rebroadcast URL is looked up again after this long even when the stream options did not change. */
const STREAM_URL_TTL_MS = 60 * 60_000;
const LOOKUP_TIMEOUT_MS = 15000;
const CHILD_PREFIX = 'child_';

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: timeout`)), ms).unref?.()),
]);

/** How a child device of the camera appears on the camera's device, or undefined to leave it out. */
function childEntity(child: Dev, cameraName: string): EntitySpec | undefined {
    const ifs = child.interfaces || [];
    // a child that is a camera itself (a crop or mirror view) is a device of its own
    if (ifs.includes(ScryptedInterface.VideoCamera)) return undefined;
    let name = String(child.name || child.id);
    if (cameraName && name.startsWith(cameraName + ' ')) name = name.slice(cameraName.length + 1);
    name = name.slice(0, 64) || `Device ${child.id}`;
    const key = `${CHILD_PREFIX}${child.id}`;
    if (ifs.includes(ScryptedInterface.OnOff)) return { key, name, platform: 'switch' };
    if (ifs.includes(ScryptedInterface.OccupancySensor)) return { key, name, platform: 'binary_sensor', device_class: 'occupancy' };
    if (ifs.includes(ScryptedInterface.MotionSensor)) return { key, name, platform: 'binary_sensor', device_class: 'motion' };
    if (ifs.includes(ScryptedInterface.BinarySensor)) return { key, name, platform: 'binary_sensor' };
    return undefined;
}

function childState(child: Dev): boolean | undefined {
    const ifs = child.interfaces || [];
    if (ifs.includes(ScryptedInterface.OnOff)) return child.on;
    if (ifs.includes(ScryptedInterface.OccupancySensor)) return child.occupied;
    if (ifs.includes(ScryptedInterface.MotionSensor)) return child.motionDetected;
    if (ifs.includes(ScryptedInterface.BinarySensor)) return child.binaryState;
    return undefined;
}

/**
 * The RTSP rebroadcasts Home Assistant plays, as it reaches them: Rebroadcast's default stream (a cropped view where one
 * is configured, else a prebuffered one), and the highest-resolution stream when that is another one.
 */
async function rebroadcastUrls(d: Dev, options: ResponseMediaStreamOptions[], host: string, audio: boolean): Promise<{ main?: string; high?: string }> {
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
    const mainUrl = urlOf(main) ?? (urls.length === 1 ? streamUrlFor(String(urls[0].value), host) : undefined);
    const highUrl = high && high !== main && (high.video?.width ?? 0) > (main?.video?.width ?? 0) ? urlOf(high) : undefined;
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
    private stream?: { key: string; urls: { main?: string; high?: string }; at: number };
    private running?: Promise<boolean>;
    private dirty = false;
    private stopped = false;

    constructor(readonly id: string, private host: CameraHost) { }

    private device(): Dev | undefined {
        const d = sdk.systemManager.getDeviceById<Dev>(this.id);
        return d?.interfaces?.includes(ScryptedInterface.VideoCamera) ? d : undefined;
    }

    private children(): Dev[] {
        const state = sdk.systemManager.getSystemState();
        return Object.keys(state)
            .filter(id => id !== this.id && state[id]?.providerId?.value === this.id)
            .map(id => sdk.systemManager.getDeviceById<Dev>(id))
            .filter((c): c is Dev => !!c && !c.interfaces?.includes(ScryptedInterface.VideoCamera));
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
        const ifs = d.interfaces || [];
        const children = this.children();
        const entities: EntitySpec[] = [];
        if (ifs.includes(ScryptedInterface.Online)) entities.push({ key: 'online', name: 'Online', platform: 'binary_sensor', device_class: 'connectivity', category: 'diagnostic' });
        if (ifs.includes(ScryptedInterface.MotionSensor)) entities.push({ key: 'motion', name: 'Motion', platform: 'binary_sensor', device_class: 'motion' });
        if (ifs.includes(ScryptedInterface.OccupancySensor)) entities.push({ key: 'occupancy', name: 'Occupancy', platform: 'binary_sensor', device_class: 'occupancy' });
        if (ifs.includes(ScryptedInterface.ObjectDetector)) {
            const types = await withTimeout(d.getObjectTypes!(), LOOKUP_TIMEOUT_MS, 'object types').catch(() => undefined);
            const eventTypes = [...new Set((types?.classes ?? []).filter(c => c !== 'motion').map(eventType).filter((t): t is string => !!t))].slice(0, 64);
            entities.push({ key: 'detection', name: 'Object detected', platform: 'event', event_types: eventTypes });
        }
        if (ifs.includes(ScryptedInterface.Battery)) entities.push({ key: 'battery', name: 'Battery', platform: 'sensor', device_class: 'battery', unit: '%', state_class: 'measurement', category: 'diagnostic' });
        for (const c of children) {
            const e = childEntity(c, String(d.name || ''));
            if (e) entities.push(e);
        }

        const urls = await this.streamUrls(d);
        if (this.stopped) return false;
        const device: DeviceSpec = { name: String(d.name || this.id).slice(0, 255) };
        if (d.info?.model) device.model = String(d.info.model).slice(0, 255);
        if (d.info?.manufacturer) device.manufacturer = String(d.info.manufacturer).slice(0, 255);
        if (d.info?.firmware) device.sw_version = String(d.info.firmware).slice(0, 255);
        if (urls.main) device.stream = urls.main;
        if (urls.high) device.streams = [{ key: 'high', name: 'High resolution', url: urls.high } satisfies StreamSpec];
        const payload: ConfigPayload = { v: CONTRACT_VERSION, device, entities };
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
        const watched = [this.id, ...children.map(c => c.id)].join(',');
        if (watched !== this.boundTo) this.bind(d, children, watched);
        this.publishStates(d, children);
        return true;
    }

    /** The rebroadcast URLs, looked up through every mixin's settings only when the stream options changed or they are old. */
    private async streamUrls(d: Dev): Promise<{ main?: string; high?: string }> {
        try {
            const options = d.interfaces?.includes(ScryptedInterface.VideoCamera)
                ? await withTimeout(d.getVideoStreamOptions!(), LOOKUP_TIMEOUT_MS, 'stream options')
                : [];
            const audio = this.host.streamAudio();
            const key = JSON.stringify([this.host.streamHost(), audio, options.map(o => [o.id, o.name, !!o.prebuffer])]);
            if (this.stream?.key === key && this.stream.urls.main && Date.now() - this.stream.at < STREAM_URL_TTL_MS) return this.stream.urls;
            const urls = await rebroadcastUrls(d, options, this.host.streamHost(), audio);
            this.stream = { key, urls, at: Date.now() };
            return urls;
        }
        catch (e) {
            this.host.console.warn(`${d.name}: no stream URL (${(e as Error).message})`);
            return this.stream?.urls ?? {};
        }
    }

    private bind(d: Dev, children: Dev[], watched: string) {
        this.unbind();
        const sm = sdk.systemManager;
        const on = (id: string, iface: ScryptedInterface, fn: (data: any) => void) =>
            this.listeners.push(sm.listenDevice(id, iface, (_s, _d, data) => { if (!this.stopped) fn(data); }));
        on(this.id, ScryptedInterface.Online, v => this.state('online', v));
        on(this.id, ScryptedInterface.MotionSensor, v => this.state('motion', v));
        on(this.id, ScryptedInterface.OccupancySensor, v => this.state('occupancy', v));
        on(this.id, ScryptedInterface.Battery, v => this.state('battery', v));
        on(this.id, ScryptedInterface.ObjectDetector, (v: ObjectsDetected) => this.detections(v));
        for (const c of children)
            for (const iface of [ScryptedInterface.OnOff, ScryptedInterface.OccupancySensor, ScryptedInterface.MotionSensor, ScryptedInterface.BinarySensor])
                if (c.interfaces?.includes(iface)) on(c.id, iface, () => this.state(`${CHILD_PREFIX}${c.id}`, childState(sm.getDeviceById<Dev>(c.id))));
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
        if (this.entities.has('battery')) this.state('battery', d.batteryLevel);
        for (const c of children) {
            const k = `${CHILD_PREFIX}${c.id}`;
            if (this.entities.has(k)) this.state(k, childState(c));
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
        if (!child || sdk.systemManager.getSystemState()[childId]?.providerId?.value !== this.id || !child.interfaces?.includes(ScryptedInterface.OnOff)) return false;
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
    }

    /** Republish everything after a broker reconnection. */
    republish() {
        if (this.config) this.host.publish('config', this.id, this.config);
        for (const [k, v] of this.states) this.host.publish('state', this.id, v, k);
    }

    stop(withdraw: boolean) {
        if (withdraw) this.withdraw();
        else this.unbind();
        this.stopped = true;
    }
}
