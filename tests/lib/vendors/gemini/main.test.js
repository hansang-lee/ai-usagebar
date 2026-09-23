import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import system from 'system';

import {Cache} from '../../../../lib/cache.js';
import {
    fetchSnapshot,
    parseAgyUsageOutput,
    tryFetchAgyQuota,
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
        assertEqual(parsed.session.utilizationPct, 37);
        assertEqual(parsed.session.resetsAt.toISOString(), '2026-09-23T13:20:26.000Z');
        assertEqual(parsed.weekly.utilizationPct, 21);
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
        assertEqual(res.session.utilizationPct, 37);
        assertEqual(res.weekly.utilizationPct, 21);
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
                now: new Date('2026-09-23T08:50:00Z'),
            }));
            assertEqual(out.ok, true);
            assertEqual(out.snapshot.session.utilizationPct, 37);
            assertEqual(out.snapshot.weekly.utilizationPct, 21);
            assertEqual(out.snapshot.hasApiKey, true);

            // Second fetch should be served from fresh cache
            const second = runSync(fetchSnapshot({
                cache,
                runner: () => Promise.reject(new Error('should not call')),
                agyPath: '/fake/agy',
                now: new Date('2026-09-23T08:50:10Z'),
            }));
            assertEqual(second.ok, true);
            assertEqual(second.snapshot.session.utilizationPct, 37);
        });
    });
});

system.exit(summary());
