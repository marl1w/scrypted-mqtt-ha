import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STREAM_RETRIES, STREAM_RETRY_MS, StreamUrlKeeper, syntheticStreamUrl } from '../src/stream';

const good = { main: 'rtsp://127.0.0.1:40000/main', high: 'rtsp://127.0.0.1:40000/high' };

test('an empty lookup keeps the last URLs and asks for a sooner retry, backing off', () => {
    let now = 0;
    const k = new StreamUrlKeeper(() => now);
    assert.deepEqual(k.update('a', good), { urls: good });
    assert.deepEqual(k.cached('a'), good);
    now += 61 * 60_000;
    assert.equal(k.cached('a'), undefined);
    assert.deepEqual(k.update('a', {}), { urls: good, retryMs: STREAM_RETRY_MS });
    // while retrying, the cache does not answer: the retry looks up again
    assert.equal(k.cached('a'), undefined);
    assert.deepEqual(k.update('a', undefined), { urls: good, retryMs: STREAM_RETRY_MS * 2 });
    assert.deepEqual(k.update('a', good), { urls: good });
    assert.deepEqual(k.update('a', {}).retryMs, STREAM_RETRY_MS);
});

test('a lost high-resolution URL is kept through the retries, then believed', () => {
    const k = new StreamUrlKeeper(() => 0);
    k.update('a', good);
    const mainOnly = { main: good.main };
    for (let i = 0; i < STREAM_RETRIES; i++) assert.deepEqual(k.update('a', mainOnly), { urls: good, retryMs: STREAM_RETRY_MS * 2 ** i });
    assert.deepEqual(k.update('a', mainOnly), { urls: mainOnly });
    assert.deepEqual(k.update('a', mainOnly), { urls: mainOnly });
});

test('a camera without a rebroadcast retries a few times, then stops asking', () => {
    const k = new StreamUrlKeeper(() => 0);
    for (let i = 0; i < STREAM_RETRIES; i++) assert.equal(k.update('a', {}).retryMs, STREAM_RETRY_MS * 2 ** i);
    assert.deepEqual(k.update('a', {}), { urls: {} });
    assert.deepEqual(k.update('a', undefined), { urls: {} });
});

test('a synthetic stream of the configured name is found by its rebroadcast URL, with audio only', () => {
    const settings = [
        { key: 'prebuffer:rtspRebroadcastUrl', subgroup: 'Stream: RTMP sub', value: 'rtsp://localhost:40000/sub' },
        { key: 'prebuffer:rtspRebroadcastMutedUrl', subgroup: 'Stream: Stream opus', value: 'rtsp://localhost:40000/muted' },
        { key: 'prebuffer:rtspRebroadcastUrl', subgroup: 'Stream: Stream opus', value: 'rtsp://localhost:40000/opus' },
    ];
    assert.equal(syntheticStreamUrl(settings, 'opus', true), 'rtsp://localhost:40000/opus');
    assert.equal(syntheticStreamUrl(settings, 'opus', false), undefined, 'muted: the default stream');
    assert.equal(syntheticStreamUrl(settings, '', true), undefined, 'off');
    assert.equal(syntheticStreamUrl(settings, 'other', true), undefined, 'camera without it');
});
