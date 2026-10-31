import { BRIDGE_SOURCE } from './contract';

/**
 * The retained topics this bridge has set, across restarts. A topic retained by an earlier run and not set again in
 * this one (a camera deselected while the bridge was stopped, an add-on that is gone) would keep a device alive in
 * Home Assistant; once the run has settled, those are cleared. Clears made while the broker was unreachable are
 * remembered and sent on the next connection.
 */
export class RetainedLedger {
    private current = new Set<string>();
    private previous: Set<string>;
    private cleared = new Set<string>();

    constructor(previous: Iterable<string>) {
        this.previous = new Set(previous);
    }

    /** Records a retained publish; true when the set of retained topics changed (worth persisting). */
    note(topic: string, payload: string | Buffer, sent: boolean): boolean {
        if (payload.length) {
            this.cleared.delete(topic);
            if (this.current.has(topic)) return false;
            this.current.add(topic);
            return true;
        }
        if (!sent) this.cleared.add(topic);
        else this.cleared.delete(topic);
        return this.current.delete(topic);
    }

    /** Clears that could not be sent; forgotten once taken. */
    takeCleared(): string[] {
        const out = [...this.cleared];
        this.cleared.clear();
        return out;
    }

    /** Topics an earlier run retained, this run has not set, and `owned` accepts; forgotten once taken. */
    takeStale(owned: (topic: string) => boolean): string[] {
        const stale = [...this.previous].filter(t => !this.current.has(t) && owned(t));
        for (const t of stale) this.previous.delete(t);
        for (const t of [...this.previous]) if (this.current.has(t)) this.previous.delete(t);
        return stale;
    }

    /** What to persist: this run's topics plus those of earlier runs not yet checked. */
    topics(): string[] {
        return [...new Set([...this.current, ...this.previous])];
    }
}

/** What `staleOwned` asks of the add-on relay. */
export interface AddonSources {
    hasSource(source: string): boolean;
    declaresImage(device: string, source: string, key: string): boolean;
}

/**
 * Whether a retained topic of an earlier run that this run did not set may be cleared now: the bridge's own, and those
 * of add-ons heard from in this run. An add-on's image stays while its current config still declares it: an add-on
 * restarted with Scrypted resends its config but may no longer have the picture, and the broker's copy is the only one.
 */
export function staleOwned(topic: string, root: string, addons: AddonSources): boolean {
    const p = topic.startsWith(root + '/') ? topic.slice(root.length + 1).split('/') : [];
    const source = p[0] === 'sources' ? p[1] : p[0] === 'devices' ? p[2] : undefined;
    if (source === BRIDGE_SOURCE) return true;
    if (!source || !addons.hasSource(source)) return false;
    return !(p.length === 5 && p[3] === 'image' && addons.declaresImage(p[1], source, p[4]));
}
