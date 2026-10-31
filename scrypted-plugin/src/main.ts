import sdk, { EventListenerRegister, ScryptedDeviceBase, ScryptedInterface, Setting, Settings, SettingValue } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import mqtt, { IClientOptions, MqttClient } from 'mqtt';
import packageJson from '../package.json';
import { AddonRelay } from './addons';
import { CameraPublisher } from './camera';
import { ADDON_EVENT, BRIDGE_EVENT, BRIDGE_SOURCE, CONTRACT_VERSION, EntitySpec, helloMessage, isRoot, parseSnapshotRequest, Topics } from './contract';
import { RetainedLedger, staleOwned } from './retained';

/** Every camera's config is rebuilt this often (stream URL, children, object types). */
const REFRESH_MS = 10 * 60_000;
/** A device added, removed or changed somewhere in Scrypted: refresh the cameras this long after the last one. */
const DESCRIPTOR_DEBOUNCE_MS = 3000;
/** After this long connected, retained topics left by earlier runs and not set again are cleared (bridge topics, and those of add-ons heard from this run; others are checked again at every refresh). */
const SETTLE_MS = 120_000;
/** Add-on listeners are registered over RPC; the bridge says hello once they are surely in place. */
const HELLO_DELAY_MS = 2000;
/** Sources first heard within this long of each other share one hello. */
const HELLO_DEBOUNCE_MS = 1000;
const SWEEP_MS = 15_000;
const LEDGER_KEY = 'retainedTopics';

class ScryptedMqttBridge extends ScryptedDeviceBase implements Settings {
    storageSettings = new StorageSettings(this, {
        url: {
            title: 'Broker URL',
            description: 'mqtt:// or mqtts://, with the port.',
            placeholder: 'mqtt://192.0.2.10:1883',
            onPut: () => this.restartSoon(),
        },
        username: { title: 'Username', onPut: () => this.restartSoon() },
        password: { title: 'Password', type: 'password', onPut: () => this.restartSoon() },
        root: {
            title: 'Topic root',
            defaultValue: 'scrypted',
            onPut: () => this.restartSoon(),
        },
        streamHost: {
            title: 'Stream host',
            description: "Host Home Assistant uses to reach Scrypted's rebroadcast. 127.0.0.1 when both share the host network.",
            defaultValue: '127.0.0.1',
            onPut: () => this.restartSoon(),
        },
        streamAudio: {
            title: 'Stream audio',
            description: "Off: Home Assistant gets Scrypted's rebroadcast without audio. On: with audio; see Opus stream for audio that go2rtc needs not transcode.",
            type: 'boolean',
            defaultValue: false,
            onPut: () => this.refreshAll(),
        },
        opusStream: {
            title: 'Opus stream',
            description: "With audio: a camera that has a Rebroadcast synthetic stream of this name (audio already in Opus, e.g. output prefix `-c:v copy -c:a libopus -application:a lowdelay -frame_duration 20 -ar:a 48000 -ac:a 1 -b:a 32k -muxdelay 0`) gets that one as its Home Assistant stream, so go2rtc passes the audio through instead of transcoding it. Leave the stream out of the prebuffered ones: it runs only while someone watches. Empty: off.",
            defaultValue: 'opus',
            onPut: () => this.refreshAll(),
        },
        cameras: {
            title: 'Cameras',
            description: 'Cameras published to MQTT.',
            type: 'device',
            multiple: true,
            deviceFilter: `interfaces.includes('${ScryptedInterface.VideoCamera}')`,
            defaultValue: [],
            onPut: () => this.syncCamerasSoon(),
        },
        status: {
            title: 'Status',
            readonly: true,
            noStore: true,
            mapGet: () => this.statusLine(),
        },
    });

    private client?: MqttClient;
    private topics?: Topics;
    private cameras = new Map<string, CameraPublisher>();
    private relay: AddonRelay;
    private ledger: RetainedLedger;
    private listener?: EventListenerRegister;
    private timers: NodeJS.Timeout[] = [];
    private restartTimer?: NodeJS.Timeout;
    private descriptorTimer?: NodeJS.Timeout;
    private settleTimer?: NodeJS.Timeout;
    private ledgerTimer?: NodeJS.Timeout;
    private lastError = '';
    private addonListeners = new Map<string, EventListenerRegister>();
    private refreshTimers = new Map<string, NodeJS.Timeout>();
    private helloSent = false;
    private helloTimer?: NodeJS.Timeout;

    constructor(nativeId?: string) {
        super(nativeId);
        this.console.log(`Scrypted MQTT ${packageJson.version} loaded`);
        let previous: string[] = [];
        try { previous = JSON.parse(this.storage.getItem(LEDGER_KEY) || '[]'); } catch { /* start clean */ }
        this.ledger = new RetainedLedger(Array.isArray(previous) ? previous.filter(t => typeof t === 'string') : []);
        this.relay = new AddonRelay({
            config: (device, source, entities) => this.publishConfig(device, source, entities),
            state: (device, source, key, payload) => this.send(this.topics?.state(device, source, key), payload, true),
            event: (device, source, key, payload) => this.send(this.topics?.event(device, source, key), payload, false),
            image: (device, source, key, jpeg) => this.send(this.topics?.image(device, source, key), jpeg, true),
            status: (source, online) => this.send(this.topics?.status(source), online ? 'online' : 'offline', true),
            sourceAdded: () => this.helloSoon(),
            helloWanted: () => this.helloSoon(),
        }, device => this.cameras.has(device), m => this.console.warn(m), Date.now,
            device => !!sdk.systemManager.getSystemState()[device]);

        // Descriptor changes reach system listeners; add-on events do not (Scrypted forwards only property changes
        // there), so those are heard on each plugin's own device.
        this.listener = sdk.systemManager.listen((source, details) => {
            if (details.eventInterface === ScryptedInterface.ScryptedDevice) this.descriptorChanged(source?.id);
        });
        this.listenToPlugins();
        this.timers.push(setInterval(() => this.relay.sweep(), SWEEP_MS));
        this.timers.push(setInterval(() => this.refreshAll(), REFRESH_MS));
        // add-ons resend everything when the bridge starts
        setTimeout(() => this.hello(), HELLO_DELAY_MS);
        this.start();
        const shutdown = () => this.stop();
        process.once('SIGTERM', shutdown);
        process.once('beforeExit', shutdown);
    }

    /** Add-ons resend everything, declaring only entities on the platforms it lists. */
    private hello() {
        this.helloSent = true;
        sdk.deviceManager.onDeviceEvent(this.nativeId, BRIDGE_EVENT, helloMessage()).catch(() => { });
    }

    /**
     * A source first heard in this run may have started after the startup hello and so not know the platforms: one more
     * hello (to every add-on: an event goes to all listeners of the bridge's device; the others' resends are deduplicated).
     */
    private helloSoon() {
        if (!this.helloSent || this.helloTimer) return; // the startup hello is still to come
        this.helloTimer = setTimeout(() => {
            this.helloTimer = undefined;
            this.hello();
        }, HELLO_DEBOUNCE_MS);
    }

    // ---- settings -------------------------------------------------------------------------------

    async getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    private statusLine(): string {
        const broker = this.client?.connected ? 'connected' : `not connected${this.lastError ? ` (${this.lastError})` : ''}`;
        return `${broker} · ${this.cameras.size} cameras · add-ons: ${this.relay.summary()}`;
    }

    private selected(): string[] {
        const v = this.storageSettings.values.cameras;
        const state = sdk.systemManager.getSystemState();
        return (Array.isArray(v) ? v : []).map(String)
            .filter(id => (state[id]?.interfaces?.value as string[] | undefined)?.includes(ScryptedInterface.VideoCamera));
    }

    // ---- broker ---------------------------------------------------------------------------------

    /** Listens for add-on events on every plugin's device (a plugin device is its own provider). */
    private listenToPlugins() {
        const state = sdk.systemManager.getSystemState();
        for (const id of Object.keys(state)) {
            if (id === this.id || this.addonListeners.has(id) || state[id]?.providerId?.value !== id) continue;
            this.addonListeners.set(id, sdk.systemManager.listenDevice(id, ADDON_EVENT, (_s, _d, data) => this.relay.handle(id, data)));
        }
        for (const [id, l] of this.addonListeners) {
            if (state[id]) continue;
            l.removeListener();
            this.addonListeners.delete(id);
        }
    }

    private start() {
        const { url, username, password, root } = this.storageSettings.values;
        if (!isRoot(root)) {
            this.lastError = 'invalid topic root';
            this.console.error(`topic root ${JSON.stringify(root)} is invalid`);
            return;
        }
        this.topics = new Topics(root);
        this.syncCameras();
        if (!url) {
            this.lastError = 'no broker URL';
            return;
        }
        if (/^[a-z]+:\/\/[^/]*@/i.test(String(url))) {
            this.lastError = 'put the credentials in Username and Password, not in the broker URL';
            this.console.error(this.lastError);
            return;
        }
        const options: IClientOptions = {
            clientId: `scrypted-mqtt-${Math.random().toString(16).slice(2, 10)}`,
            username: username || undefined,
            password: password || undefined,
            clean: true,
            reconnectPeriod: 5000,
            connectTimeout: 10_000,
            will: { topic: this.topics.status(BRIDGE_SOURCE), payload: Buffer.from('offline'), qos: 1, retain: true },
        };
        let client: MqttClient;
        try {
            client = mqtt.connect(url, options);
        }
        catch (e) {
            this.lastError = (e as Error).message;
            this.console.error(`broker URL rejected: ${this.lastError}`);
            return;
        }
        this.client = client;
        client.on('connect', () => this.onConnect(client));
        client.on('error', e => {
            if (e.message !== this.lastError) this.console.warn(`broker: ${e.message}`);
            this.lastError = e.message;
        });
        client.on('message', (topic, payload) => this.onMessage(topic, payload).catch(e => this.console.warn(`${topic}: ${(e as Error).message}`)));
    }

    private onConnect(client: MqttClient) {
        if (client !== this.client || !this.topics) return;
        this.lastError = '';
        this.console.log('broker connected');
        client.subscribe([this.topics.commands, this.topics.snapshotRequests], { qos: 1 }, err => {
            if (err) this.console.error(`subscribe failed: ${err.message}`);
        });
        this.send(this.topics.status(BRIDGE_SOURCE), 'online', true);
        for (const t of this.ledger.takeCleared()) this.send(t, '', true);
        for (const c of this.cameras.values()) c.republish();
        this.relay.republish();
        clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => this.clearStale(), SETTLE_MS);
    }

    private stop() {
        const client = this.client;
        this.client = undefined;
        if (client?.connected && this.topics) client.publish(this.topics.status(BRIDGE_SOURCE), 'offline', { qos: 1, retain: true });
        client?.end(false);
        clearTimeout(this.settleTimer);
        this.persistLedger();
    }

    private restartSoon() {
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
            this.console.log('settings changed, reconnecting');
            for (const c of this.cameras.values()) c.stop(false);
            this.cameras.clear();
            this.stop();
            this.start();
        }, 1000);
    }

    /** QoS 1 for anything retained (it must land), 0 for events and snapshots. */
    private send(topic: string | undefined, payload: string | Buffer, retain: boolean) {
        if (!topic) return;
        const client = this.client;
        const connected = !!client?.connected;
        if (retain && this.ledger.note(topic, payload, connected)) this.persistLedgerSoon();
        if (!client || !connected) return; // set topics are republished on connect, clears are replayed from the ledger
        client.publish(topic, payload, { qos: retain ? 1 : 0, retain }, err => {
            if (err) this.console.warn(`publish ${topic}: ${err.message}`);
        });
    }

    private publishConfig(device: string, source: string, entities: EntitySpec[] | undefined) {
        if (!this.topics) return;
        if (entities) {
            this.send(this.topics.config(device, source), JSON.stringify({ v: CONTRACT_VERSION, entities }), true);
            return;
        }
        this.send(this.topics.config(device, source), '', true);
    }

    /**
     * Clears retained topics of earlier runs that this run did not set, for the bridge and for add-ons heard from since it
     * started, but not an add-on's image its config still declares.
     */
    private clearStale() {
        if (!this.client?.connected || !this.topics) return;
        const root = this.topics.root;
        const stale = this.ledger.takeStale(t => staleOwned(t, root, this.relay));
        if (stale.length) this.console.log(`clearing ${stale.length} retained topics left by an earlier run`);
        for (const t of stale) this.client.publish(t, '', { qos: 1, retain: true });
        this.persistLedger();
    }

    private persistLedgerSoon() {
        if (this.ledgerTimer) return;
        this.ledgerTimer = setTimeout(() => this.persistLedger(), 5000);
    }

    private persistLedger() {
        clearTimeout(this.ledgerTimer);
        this.ledgerTimer = undefined;
        this.storage.setItem(LEDGER_KEY, JSON.stringify(this.ledger.topics()));
    }

    // ---- inbound --------------------------------------------------------------------------------

    private async onMessage(topic: string, payload: Buffer) {
        const t = this.topics?.parse(topic);
        if (!t) return;
        const camera = this.cameras.get(t.device);
        if (!camera) return;
        if (t.kind === 'snapshot') {
            const req = parseSnapshotRequest(payload);
            if (!req) return;
            const jpeg = await camera.snapshotFor(req);
            this.send(this.topics!.snapshotReply(t.device, req.id), jpeg ?? Buffer.alloc(0), false);
            return;
        }
        const value = payload.toString();
        if (t.source === BRIDGE_SOURCE) {
            if (value === 'ON' || value === 'OFF') await camera.command(t.key, value);
            return;
        }
        const target = this.relay.commandTarget(t.device, t.source, t.key, value);
        if (target) await sdk.deviceManager.onDeviceEvent(this.nativeId, BRIDGE_EVENT, { v: CONTRACT_VERSION, type: 'command', source: target, device: t.device, key: t.key, value });
    }

    // ---- cameras --------------------------------------------------------------------------------

    private syncCamerasSoon() {
        setTimeout(() => this.syncCameras(), 0);
    }

    /** A camera that stopped being a camera (or disappeared) is dropped like a deselected one. */
    private refreshCamera(id: string) {
        const c = this.cameras.get(id);
        c?.refresh().then(present => {
            if (present || this.cameras.get(id) !== c) return;
            c.stop(true);
            this.cameras.delete(id);
            this.relay.deviceUnpublished(id);
        }).catch(e => this.console.warn(`camera ${id}: ${(e as Error).message}`));
    }

    /** Starts publishers for newly selected cameras and withdraws deselected ones. */
    private syncCameras() {
        if (!this.topics) return;
        const want = new Set(this.selected());
        for (const [id, c] of this.cameras) {
            if (want.has(id)) continue;
            c.stop(true);
            this.cameras.delete(id);
            this.relay.deviceUnpublished(id);
        }
        for (const id of want) {
            if (this.cameras.has(id)) continue;
            const c = new CameraPublisher(id, {
                publish: (kind, device, payload, key) => {
                    const topics = this.topics!;
                    if (kind === 'config') this.send(topics.config(device, BRIDGE_SOURCE), payload, true);
                    else if (kind === 'state') this.send(topics.state(device, BRIDGE_SOURCE, key!), payload, true);
                    else this.send(topics.event(device, BRIDGE_SOURCE, key!), payload, false);
                },
                streamHost: () => String(this.storageSettings.values.streamHost || '127.0.0.1'),
                streamAudio: () => !!this.storageSettings.values.streamAudio,
                opusStream: () => String(this.storageSettings.values.opusStream ?? '').trim(),
                console: this.console,
            });
            this.cameras.set(id, c);
            c.refresh().then(present => {
                if (present && this.cameras.get(id) === c) this.relay.devicePublished(id);
                else if (!present) this.refreshCamera(id);
            }).catch(e => this.console.warn(`camera ${id}: ${(e as Error).message}`));
        }
    }

    /**
     * A device was added, changed or removed somewhere in Scrypted. Only what it touches is refreshed: the camera itself,
     * the camera whose child it is, the plugin listeners; a removal (no id) resyncs everything.
     */
    private descriptorChanged(id: string | undefined) {
        const state = sdk.systemManager.getSystemState();
        const provider = id ? state[id]?.providerId?.value : undefined;
        if (!id || provider === id) {
            clearTimeout(this.descriptorTimer);
            this.descriptorTimer = setTimeout(() => {
                this.listenToPlugins();
                this.syncCameras();
                if (!id) this.refreshAll();
            }, DESCRIPTOR_DEBOUNCE_MS);
            return;
        }
        const camera = this.cameras.has(id) ? id : provider && this.cameras.has(provider) ? provider : undefined;
        if (camera) {
            clearTimeout(this.refreshTimers.get(camera));
            this.refreshTimers.set(camera, setTimeout(() => {
                this.refreshTimers.delete(camera);
                this.refreshCamera(camera);
            }, DESCRIPTOR_DEBOUNCE_MS));
        }
        else if (this.selected().includes(id)) this.syncCameras();
    }

    /** Every camera, a few seconds apart; also retries clearing stale add-on topics. */
    private refreshAll() {
        [...this.cameras.keys()].forEach((id, i) => setTimeout(() => this.refreshCamera(id), i * 2000));
        this.clearStale();
    }
}

export default ScryptedMqttBridge;
