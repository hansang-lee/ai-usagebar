import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import system from 'system';

import {Cache} from '../../../../lib/cache.js';
import {
    fetchSnapshot,
    parseAgyUsageOutput,
    parseAgyToken,
    parseQuotaSummary,
    tokenUsable,
    tryFetchAgyQuota,
    QUOTA_URL,
} from '../../../../lib/vendors/gemini/main.js';
import {describe, it, assertEqual, assertDeepEqual, summary} from '../../../_assert.js';

function runSync(promise) {
    const loop = GLib.MainLoop.new(null, false);
    let value, err, done = false;
    Promise.resolve(promise).then(
        v => { value = v; done = true; loop.quit(); },
        e => { err = e; done = true; loop.quit(); }
    );
    if (!done)
        loop.run();
    if (err)
        throw err;
    return value;
}

function rmRf(path) {
    const f = Gio.File.new_for_path(path);
    if (!f.query_exists(null))
        return;
    let info;
    try {
        info = f.query_info('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch (_) { return; }
    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
        const en = f.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let child;
        while ((child = en.next_file(null)))
            rmRf(GLib.build_filenamev([path, child.get_name()]));
        en.close(null);
    }
    try { f.delete(null); } catch (_) { /* best-effort */ }
}

function withTemp(fn) {
    const tmp = GLib.dir_make_tmp('gemini-test-XXXXXX');
    try {
        fn(tmp);
    } finally {
        rmRf(tmp);
    }
}

const SAMPLE_AGY_JSON = JSON.stringify({
    status: 'SUCCESS',
    command: {
        name: 'usage',
        data: {
            groups: [
                {
                    name: 'Gemini Models',
                    buckets: [
                        {
                            id: 'gemini-weekly',
                            name: 'Weekly Limit Remaining',
                            window: 'weekly',
                            remaining_fraction: 0.7929,
                            reset_time: '2026-09-30T04:07:09Z',
                        },
                        {
                            id: 'gemini-5h',
                            name: 'Five Hour Limit Remaining',
                            window: '5h',
                            remaining_fraction: 0.6316,
                            reset_time: '2026-09-23T13:20:26Z',
                        },
                    ],
                },
                {
                    name: 'Claude and GPT models',
                    buckets: [],
                },
            ],
        },
    },
});

const noToken = () => Promise.resolve(null);
const liveToken = () => Promise.resolve({accessToken: 'tok', expiresAt: new Date(Date.now() + 3600_000)});
const versionRunner = (argv) => argv[1] === '--version'
    ? Promise.resolve({ok: true, stdout: 'agy 1.2.9\n'})
    : Promise.reject(new Error('agy /usage should not run'));

const SAMPLE_API_JSON = JSON.stringify({
    groups: [
        {
            displayName: 'Gemini Models',
            buckets: [
                {bucketId: 'gemini-weekly', window: 'weekly', resetTime: '2026-09-30T04:07:09Z', remainingFraction: 0.69097173},
                {bucketId: 'gemini-5h', window: '5h', resetTime: '2026-09-23T13:20:26Z', remainingFraction: 0.0195117},
            ],
        },
        {displayName: 'Claude and GPT models', buckets: []},
    ],
});

describe('parseAgyUsageOutput', () => {
    it('returns null for null or non-string input', () => {
        assertEqual(parseAgyUsageOutput(null), null);
        assertEqual(parseAgyUsageOutput(''), null);
        assertEqual(parseAgyUsageOutput(123), null);
    });

    it('returns null for invalid JSON or missing groups', () => {
        assertEqual(parseAgyUsageOutput('{ invalid'), null);
        assertEqual(parseAgyUsageOutput('{"command":{}}'), null);
        assertEqual(parseAgyUsageOutput('{"command":{"data":{"groups":[]}}}'), null);
    });

    it('correctly extracts session and weekly buckets with utilization % and reset times', () => {
        const parsed = parseAgyUsageOutput(SAMPLE_AGY_JSON);
        assertEqual(parsed !== null, true);
        assertEqual(parsed.session.utilizationPct, 36.84);
        assertEqual(parsed.session.resetsAt.toISOString(), '2026-09-23T13:20:26.000Z');
        assertEqual(parsed.weekly.utilizationPct, 20.71);
        assertEqual(parsed.weekly.resetsAt.toISOString(), '2026-09-30T04:07:09.000Z');
    });

    it('handles groups with only 5h bucket', () => {
        const json = JSON.stringify({
            command: {
                data: {
                    groups: [{
                        name: 'Gemini Models',
                        buckets: [{id: 'gemini-5h', window: '5h', remaining_fraction: 0.5}],
                    }],
                },
            },
        });
        const parsed = parseAgyUsageOutput(json);
        assertEqual(parsed !== null, true);
        assertEqual(parsed.session.utilizationPct, 50);
        assertEqual(parsed.session.resetsAt, null);
        assertEqual(parsed.weekly, null);
    });
});

describe('tryFetchAgyQuota', () => {
    it('returns null if runner fails or exits nonzero', () => {
        const failingRunner = () => Promise.resolve({ok: false, stdout: '', stderr: 'error'});
        const res = runSync(tryFetchAgyQuota(failingRunner, null, '/fake/agy'));
        assertEqual(res, null);
    });

    it('returns parsed quota when runner succeeds', () => {
        const successRunner = (argv) => {
            assertEqual(argv[1], '-p');
            assertEqual(argv[2], '/usage');
            return Promise.resolve({ok: true, stdout: SAMPLE_AGY_JSON});
        };
        const res = runSync(tryFetchAgyQuota(successRunner, null, '/fake/agy'));
        assertEqual(res !== null, true);
        assertEqual(res.session.utilizationPct, 36.84);
        assertEqual(res.weekly.utilizationPct, 20.71);
    });
});

describe('parseQuotaSummary', () => {
    it('parses the camelCase retrieveUserQuotaSummary response', () => {
        const q = parseQuotaSummary(new TextEncoder().encode(SAMPLE_API_JSON));
        assertEqual(q.session.utilizationPct, 98.05);
        assertEqual(q.weekly.utilizationPct, 30.9);
        assertEqual(q.session.resetsAt.toISOString(), '2026-09-23T13:20:26.000Z');
    });

    it('returns null for an error body', () =>
        assertEqual(parseQuotaSummary(new TextEncoder().encode('{"error":{"code":403}}')), null));
});

describe('parseAgyToken / tokenUsable', () => {
    const raw = JSON.stringify({token: {access_token: 'abc', expiry: '2026-09-23T21:14:06.684148169+09:00'}});

    it('extracts the access token and expiry', () => {
        const t = parseAgyToken(raw);
        assertEqual(t.accessToken, 'abc');
        assertEqual(t.expiresAt.toISOString(), '2026-09-23T12:14:06.684Z');
    });

    it('returns null without an access token', () =>
        assertEqual(parseAgyToken('{"token":{}}'), null));

    it('treats a token inside the expiry skew as unusable', () => {
        const t = parseAgyToken(raw);
        assertEqual(tokenUsable(t, new Date('2026-09-23T12:00:00Z')), true);
        assertEqual(tokenUsable(t, new Date('2026-09-23T12:13:30Z')), false);
        assertEqual(tokenUsable(null, new Date()), false);
    });
});

describe('fetchSnapshot with quota API', () => {
    it('uses the API with an Antigravity User-Agent and skips agy', () => {
        withTemp((dir) => {
            let seen = null;
            const http = (opts) => {
                seen = opts;
                return Promise.resolve({status: 200, bodyBytes: new TextEncoder().encode(SAMPLE_API_JSON)});
            };
            const out = runSync(fetchSnapshot({
                cache: new Cache(dir), http, runner: versionRunner, agyPath: '/fake/agy', readToken: liveToken,
            }));
            assertEqual(out.ok, true);
            assertEqual(out.snapshot.session.utilizationPct, 98.05);
            assertEqual(seen.url, QUOTA_URL);
            assertEqual(seen.headers['User-Agent'].startsWith('antigravity/'), true);
            assertEqual(seen.headers.Authorization, 'Bearer tok');
        });
    });

    it('falls back to agy when the API call fails', () => {
        withTemp((dir) => {
            const runner = (argv) => Promise.resolve(argv[1] === '--version'
                ? {ok: true, stdout: '1.2.9'}
                : {ok: true, stdout: SAMPLE_AGY_JSON});
            const out = runSync(fetchSnapshot({
                cache: new Cache(dir),
                http: () => Promise.resolve({status: 403, bodyBytes: new Uint8Array(0)}),
                runner, agyPath: '/fake/agy', readToken: liveToken,
            }));
            assertEqual(out.ok, true);
            assertEqual(out.snapshot.session.utilizationPct, 36.84);
        });
    });

    it('runs agy instead of the API when the token is expired', () => {
        withTemp((dir) => {
            const out = runSync(fetchSnapshot({
                cache: new Cache(dir),
                http: () => Promise.reject(new Error('API should not be called')),
                runner: () => Promise.resolve({ok: true, stdout: SAMPLE_AGY_JSON}),
                agyPath: '/fake/agy',
                readToken: () => Promise.resolve({accessToken: 'old', expiresAt: new Date(Date.now() - 1000)}),
            }));
            assertEqual(out.ok, true);
            assertEqual(out.snapshot.session.utilizationPct, 36.84);
        });
    });
});

describe('fetchSnapshot with agy runner', () => {
    it('populates session and weekly from agy output and caches result', () => {
        withTemp((dir) => {
            const cache = new Cache(dir);
            const runner = () => Promise.resolve({ok: true, stdout: SAMPLE_AGY_JSON});
            const out = runSync(fetchSnapshot({
                cache,
                runner,
                agyPath: '/fake/agy',
                readToken: noToken,
                now: new Date('2026-09-23T08:50:00Z'),
            }));
            assertEqual(out.ok, true);
            assertEqual(out.snapshot.session.utilizationPct, 36.84);
            assertEqual(out.snapshot.weekly.utilizationPct, 20.71);
            assertEqual(out.snapshot.hasApiKey, true);

            // Second fetch should be served from fresh cache
            const second = runSync(fetchSnapshot({
                cache,
                runner: () => Promise.reject(new Error('should not call')),
                agyPath: '/fake/agy',
                readToken: noToken,
                now: new Date('2026-09-23T08:50:10Z'),
            }));
            assertEqual(second.ok, true);
            assertEqual(second.snapshot.session.utilizationPct, 36.84);
        });
    });

    it('falls back to the last real snapshot as stale when agy fails', () => {
        withTemp((dir) => {
            const cache = new Cache(dir);
            runSync(fetchSnapshot({
                cache,
                runner: () => Promise.resolve({ok: true, stdout: SAMPLE_AGY_JSON}),
                agyPath: '/fake/agy',
                readToken: noToken,
            }));
            const out = runSync(fetchSnapshot({
                cache,
                cacheTtlMs: 0,
                runner: () => Promise.resolve({ok: false, error: new Error('Cancelled')}),
                agyPath: '/fake/agy',
                readToken: noToken,
            }));
            assertEqual(out.ok, true);
            assertEqual(out.stale, true);
            assertEqual(out.snapshot.session.utilizationPct, 36.84);
            assertEqual(out.snapshot.session.resetsAt instanceof Date, true);
        });
    });

    it('returns an error instead of synthesized windows when agy fails with no cache', () => {
        withTemp((dir) => {
            const out = runSync(fetchSnapshot({
                cache: new Cache(dir),
                runner: () => Promise.resolve({ok: false, stdout: ''}),
                agyPath: '/fake/agy',
                readToken: noToken,
            }));
            assertEqual(out.ok, false);
            assertEqual(out.kind, 'error');
        });
    });
});

system.exit(summary());
