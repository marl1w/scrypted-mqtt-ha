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
