import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {withMutex, staleResult} from '../fetch-common.js';
import {SESSION_MS, DAILY_MS, WEEKLY_MS} from './parser.js';

export const CACHE_TTL_MS = 60_000;
export const AGY_TIMEOUT_MS = 15_000;

function readOpencodeApiKey() {
    try {
        const home = GLib.get_home_dir();
        const confPath = GLib.build_filenamev([home, '.config', 'opencode', 'opencode.jsonc']);
        const file = Gio.File.new_for_path(confPath);
        const [ok, bytes] = file.load_contents(null);
        if (!ok)
            return null;
        const text = new TextDecoder().decode(bytes);
        // Strip single-line and block comments outside of string literals
        const stripped = text.replace(/(\/\*[\s\S]*?\*\/)|(\/\/[^\n\r]*)|("(\\.|[^"\\])*")/g, (_m, block, line, str) => {
            if (block || line) return '';
            return str;
        });
        const j = JSON.parse(stripped);
        return j?.provider?.google?.options?.apiKey ?? null;
    } catch (_) {
        return null;
    }
}

export function findAgyPath() {
    const inPath = GLib.find_program_in_path('agy');
    if (inPath)
        return inPath;
    const home = GLib.get_home_dir();
    const candidate = GLib.build_filenamev([home, '.local', 'bin', 'agy']);
    if (GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE))
        return candidate;
    return null;
}

export function parseAgyUsageOutput(raw) {
    if (!raw || typeof raw !== 'string')
        return null;
    let data;
    try {
        data = JSON.parse(raw);
    } catch (_) {
        return null;
    }
    const groups = data?.command?.data?.groups;
    if (!Array.isArray(groups))
        return null;

    const geminiGroup = groups.find(g =>
        typeof g?.name === 'string' && g.name.toLowerCase().includes('gemini')
    );
    if (!geminiGroup || !Array.isArray(geminiGroup.buckets))
        return null;

    let session = null;
    let weekly = null;

    for (const b of geminiGroup.buckets) {
        if (!b)
            continue;
        const remainingFraction = typeof b.remaining_fraction === 'number'
            ? b.remaining_fraction
            : null;
        if (remainingFraction === null)
            continue;

        const utilizationPct = Math.min(100, Math.max(0, Math.round((1 - remainingFraction) * 100)));
        const d = b.reset_time ? new Date(b.reset_time) : null;
        const resetsAt = (d && !isNaN(d.getTime())) ? d : null;

        if (b.window === '5h' || b.id === 'gemini-5h') {
            session = {utilizationPct, resetsAt};
        } else if (b.window === 'weekly' || b.id === 'gemini-weekly') {
            weekly = {utilizationPct, resetsAt};
        }
    }

    if (!session && !weekly)
        return null;

    return {session, weekly};
}

export function defaultAgyRunner(argv, cancellable, timeoutMs = AGY_TIMEOUT_MS) {
    return new Promise((resolve) => {
        try {
            const proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            const cancel = cancellable instanceof Gio.Cancellable ? cancellable : new Gio.Cancellable();
            let timeoutId = 0;
            let cancelId = 0;

            const cleanup = () => {
                if (timeoutId > 0) {
                    GLib.Source.remove(timeoutId);
                    timeoutId = 0;
                }
                if (cancelId > 0) {
                    cancel.disconnect(cancelId);
                    cancelId = 0;
                }
            };

            if (timeoutMs > 0) {
                timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                    timeoutId = 0;
                    try { cancel.cancel(); } catch (_) {}
                    try { proc.force_exit(); } catch (_) {}
                    return GLib.SOURCE_REMOVE;
                });
            }

            if (cancel.is_cancelled()) {
                cleanup();
                try { proc.force_exit(); } catch (_) {}
                resolve({ok: false, error: new Error('Cancelled')});
                return;
            }

            cancelId = cancel.connect(() => {
                try { proc.force_exit(); } catch (_) {}
            });

            proc.communicate_utf8_async(null, cancel, (p, res) => {
                cleanup();
                try {
                    const [, stdout, stderr] = p.communicate_utf8_finish(res);
                    resolve({
                        ok: p.get_successful(),
                        stdout: stdout ?? '',
                        stderr: stderr ?? '',
                    });
                } catch (e) {
                    resolve({ok: false, error: e});
                }
            });
        } catch (e) {
            resolve({ok: false, error: e});
        }
    });
}

export async function tryFetchAgyQuota(runner = defaultAgyRunner, signal = null, agyBin = null) {
    const bin = agyBin ?? findAgyPath();
    if (!bin)
        return null;

    try {
        const res = await runner([bin, '-p', '/usage', '--output-format', 'json'], signal);
        if (!res?.ok || !res.stdout)
            return null;
        return parseAgyUsageOutput(res.stdout);
    } catch (_) {
        return null;
    }
}

async function tryFetchGoogleQuota(http, signal) {
    if (!http)
        return null;
    try {
        const home = GLib.get_home_dir();
        const authPath = GLib.build_filenamev([home, '.local', 'share', 'opencode', 'auth.json']);
        const file = Gio.File.new_for_path(authPath);
        const [ok, bytes] = file.load_contents(null);
        if (!ok)
            return null;
        const auth = JSON.parse(new TextDecoder().decode(bytes));
        const googleAuth = auth?.google;
        const token = googleAuth?.access ?? (googleAuth?.type === 'oauth' ? googleAuth?.token : null);
        if (!token)
            return null;

        const url = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
        const res = await http(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({project: googleAuth.projectId ?? ''}),
            cancellable: signal,
        });
        if (res.status === 200 && res.body) {
            const data = JSON.parse(res.body);
            if (Array.isArray(data.buckets) && data.buckets.length > 0) {
                const b = data.buckets[0];
                const pct = typeof b.remainingFraction === 'number'
                    ? Math.min(100, Math.max(0, Math.round((1 - b.remainingFraction) * 100)))
                    : 0;
                const resetsAt = b.resetTime ? new Date(b.resetTime) : null;
                return {utilizationPct: pct, resetsAt};
            }
        }
    } catch (_) {}
    return null;
}

function nextMidnight(now) {
    const d = new Date(now);
    d.setHours(24, 0, 0, 0);
    return d;
}

function resolveWindow(prevWin, fallbackResetsAt, now) {
    let resetsAt = prevWin?.resetsAt instanceof Date ? prevWin.resetsAt : null;
    let utilizationPct = prevWin?.utilizationPct ?? 0;

    if (!resetsAt || resetsAt.getTime() <= now.getTime()) {
        resetsAt = typeof fallbackResetsAt === 'function' ? fallbackResetsAt(now) : fallbackResetsAt;
        utilizationPct = 0;
    }
    return {
        utilizationPct,
        resetsAt,
    };
}

function reviveSnapshotDates(parsed) {
    if (parsed?.session?.resetsAt && !(parsed.session.resetsAt instanceof Date))
        parsed.session.resetsAt = new Date(parsed.session.resetsAt);
    if (parsed?.daily?.resetsAt && !(parsed.daily.resetsAt instanceof Date))
        parsed.daily.resetsAt = new Date(parsed.daily.resetsAt);
    if (parsed?.weekly?.resetsAt && !(parsed.weekly.resetsAt instanceof Date))
        parsed.weekly.resetsAt = new Date(parsed.weekly.resetsAt);
    return parsed;
}

async function doFetch(deps) {
    const {cache} = deps;
    const cacheTtlMs = deps.cacheTtlMs ?? CACHE_TTL_MS;
    const now = deps.now ?? new Date();

    const fresh = await cache.freshPayload(cacheTtlMs);
    if (fresh !== null) {
        try {
            const parsed = JSON.parse(new TextDecoder().decode(fresh));
            reviveSnapshotDates(parsed);
            return {
                ok: true,
                snapshot: parsed,
                stale: false,
                lastError: null,
                cacheAgeMs: await cache.payloadAgeMs() ?? 0,
            };
        } catch (_) {
            // fall through
        }
    }

    let prev = null;
    try {
        const raw = await cache.readPayload();
        if (raw) {
            prev = JSON.parse(new TextDecoder().decode(raw));
            reviveSnapshotDates(prev);
        }
    } catch (_) {}

    let session = null;
    let weekly = null;

    const agyQuota = await tryFetchAgyQuota(
        deps.runner ?? defaultAgyRunner,
        deps.signal,
        deps.agyPath
    );
    if (agyQuota?.session?.resetsAt)
        session = agyQuota.session;
    if (agyQuota?.weekly?.resetsAt)
        weekly = agyQuota.weekly;

    if (!session) {
        const realQuota = await tryFetchGoogleQuota(deps.http, deps.signal);
        if (realQuota && realQuota.resetsAt) {
            session = realQuota;
        } else {
            session = resolveWindow(prev?.session, (n) => new Date(n.getTime() + SESSION_MS), now);
        }
    }

    if (!weekly) {
        weekly = resolveWindow(prev?.weekly, (n) => new Date(n.getTime() + WEEKLY_MS), now);
    }

    const daily = resolveWindow(prev?.daily, (n) => nextMidnight(n), now);

    const apiKey = GLib.getenv('GEMINI_API_KEY') || readOpencodeApiKey();
    const hasAgy = Boolean(deps.agyPath ?? findAgyPath());
    const snapshot = {
        plan: 'PRO',
        status: 'Active',
        label: 'Google One AI Premium',
        model: 'Gemini 3.0 Pro',
        hasApiKey: Boolean(apiKey) || hasAgy,
        session,
        daily,
        weekly,
    };

    const payload = new TextEncoder().encode(JSON.stringify(snapshot));
    cache.writePayload(payload);

    return {
        ok: true,
        snapshot,
        stale: false,
        lastError: null,
        cacheAgeMs: 0,
    };
}

export async function fetchSnapshot(deps) {
    return withMutex(deps?.cache?.dir ?? 'gemini', () => doFetch(deps));
}
