/** The rebroadcast URLs of a camera: Rebroadcast's default stream, and the highest-resolution one when it is another. */
export interface StreamUrls {
    main?: string;
    high?: string;
}

/**
 * The rebroadcast URL of a Rebroadcast synthetic stream called `name`, as listed in the camera's settings (Rebroadcast
 * shows it under "Stream: Stream <name>"; synthetic streams are not among the stream options). With audio only: the
 * point of such a stream is its audio, already in Opus, which Home Assistant's go2rtc then passes through instead of
 * transcoding the camera's AAC in an ffmpeg of its own.
 */
export function syntheticStreamUrl(settings: { key?: string; subgroup?: string; value?: unknown }[], name: string, audio: boolean): string | undefined {
    if (!audio || !name) return undefined;
    const s = settings.find(x => x.key === 'prebuffer:rtspRebroadcastUrl' && x.subgroup === `Stream: Stream ${name}`);
    return typeof s?.value === 'string' && s.value ? s.value : undefined;
}

/** The URLs are looked up again after this long even when the stream options did not change. */
const STREAM_URL_TTL_MS = 60 * 60_000;
/** A lookup that loses a URL is retried this soon, twice as late each time, STREAM_RETRIES times before the loss is believed. */
export const STREAM_RETRY_MS = 30_000;
export const STREAM_RETRIES = 5;

/**
 * The last good URLs, kept through lookups that fail, find none or lose the high-resolution one: Rebroadcast's settings
 * are briefly empty while a stream restarts, and publishing that would take the live view, or the whole high-resolution
 * camera, out of Home Assistant until the next refresh.
 */
export class StreamUrlKeeper {
    private known?: { key: string; urls: StreamUrls; at: number };
    private misses = 0;

    constructor(private now: () => number = Date.now) { }

    /** The known URLs while they are good for `key` (the stream options), else undefined: look them up. */
    cached(key: string): StreamUrls | undefined {
        const settled = this.misses === 0 || this.misses >= STREAM_RETRIES;
        const k = this.known;
        return settled && k?.key === key && k.urls.main && this.now() - k.at < STREAM_URL_TTL_MS ? k.urls : undefined;
    }

    /** A lookup's result (undefined when it failed): the URLs to publish, and when one lost a URL, how soon to look again. */
    update(key: string, urls: StreamUrls | undefined): { urls: StreamUrls; retryMs?: number } {
        const lost = !urls?.main || (!!this.known?.urls.high && !urls.high);
        if (lost && this.misses < STREAM_RETRIES)
            return { urls: this.known?.urls ?? urls ?? {}, retryMs: STREAM_RETRY_MS * 2 ** this.misses++ };
        if (!urls) return { urls: this.known?.urls ?? {} };
        // a loss that outlasted the retries is real (the stream was removed in Rebroadcast)
        if (!lost) this.misses = 0;
        this.known = { key, urls, at: this.now() };
        return { urls };
    }
}
