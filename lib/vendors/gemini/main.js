import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {withMutex, staleResult} from '../fetch-common.js';
import {SESSION_MS, DAILY_MS, WEEKLY_MS} from './parser.js';

export const CACHE_TTL_MS = 60_000;
export const AGY_TIMEOUT_MS = 30_000;
export const QUOTA_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
// The endpoint rejects any client that does not identify as Antigravity.
const FALLBACK_AGY_VERSION = '1.2.9';
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const HTTP_TIMEOUT_MS = 10_000;

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

// Accepts both `agy /usage` JSON (snake_case) and the raw
// retrieveUserQuotaSummary response (camelCase); they carry the same groups.
export function parseQuotaGroups(groups) {
    if (!Array.isArray(groups))
        return null;

    const geminiGroup = groups.find(g => {
        const name = g?.name ?? g?.displayName;
        return typeof name === 'string' && name.toLowerCase().includes('gemini');
    });
    if (!geminiGroup || !Array.isArray(geminiGroup.buckets))
        return null;

    let session = null;
    let weekly = null;

    for (const b of geminiGroup.buckets) {
        if (!b)
            continue;
        const fraction = b.remaining_fraction ?? b.remainingFraction;
        if (typeof fraction !== 'number')
            continue;

        const utilizationPct = Math.min(100, Math.max(0, Number(((1 - fraction) * 100).toFixed(2))));
        const resetRaw = b.reset_time ?? b.resetTime;
        const d = resetRaw ? new Date(resetRaw) : null;
        const resetsAt = (d && !isNaN(d.getTime())) ? d : null;
        const id = b.id ?? b.bucketId;

        if (b.window === '5h' || id === 'gemini-5h')
            session = {utilizationPct, resetsAt};
        else if (b.window === 'weekly' || id === 'gemini-weekly')
            weekly = {utilizationPct, resetsAt};
    }

    if (!session && !weekly)
        return null;

    return {session, weekly};
}

export function parseAgyUsageOutput(raw) {
    if (!raw || typeof raw !== 'string')
        return null;
    try {
        return parseQuotaGroups(JSON.parse(raw)?.command?.data?.groups);
    } catch (_) {
        return null;
    }
}

export function parseQuotaSummary(bytes) {
    try {
        return parseQuotaGroups(JSON.parse(new TextDecoder().decode(bytes))?.groups);
    } catch (_) {
        return null;
    }
}

export function defaultAgyRunner(argv, cancellable, timeoutMs = AGY_TIMEOUT_MS) {
    return new Promise((resolve) => {
        try {
            const proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            // The caller's cancellable is shared by every vendor fetch, so a timeout
            // must only cancel this process — never the caller's cancellable.
            const outer = cancellable instanceof Gio.Cancellable ? cancellable : null;
            const cancel = new Gio.Cancellable();
            let timeoutId = 0;
            let cancelId = 0;

            const cleanup = () => {
                if (timeoutId > 0) {
                    GLib.Source.remove(timeoutId);
                    timeoutId = 0;
                }
                if (cancelId > 0) {
                    outer.disconnect(cancelId);
                    cancelId = 0;
                }
            };

            if (outer?.is_cancelled()) {
                try { proc.force_exit(); } catch (_) {}
                resolve({ok: false, error: new Error('Cancelled')});
                return;
            }

            if (timeoutMs > 0) {
                timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                    timeoutId = 0;
                    try { cancel.cancel(); } catch (_) {}
                    try { proc.force_exit(); } catch (_) {}
                    return GLib.SOURCE_REMOVE;
                });
            }

            if (outer) {
                cancelId = outer.connect(() => {
                    try { cancel.cancel(); } catch (_) {}
                    try { proc.force_exit(); } catch (_) {}
                });
            }

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

// agy keeps its Google OAuth token (Go oauth2 JSON) in the login keyring. Only
// agy refreshes it, so an expired token means "run agy once" rather than an error.
export async function readAgyToken() {
    try {
        const {default: Secret} = await import('gi://Secret?version=1');
        const schema = Secret.Schema.new('org.freedesktop.Secret.Generic', Secret.SchemaFlags.DONT_MATCH_NAME, {
            service: Secret.SchemaAttributeType.STRING,
            username: Secret.SchemaAttributeType.STRING,
        });
        const raw = await new Promise((resolve, reject) => {
            Secret.password_lookup(schema, {service: 'gemini', username: 'antigravity'}, null, (_s, res) => {
                try {
                    resolve(Secret.password_lookup_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        return parseAgyToken(raw);
    } catch (_) {
        return null;
    }
}

export function parseAgyToken(raw) {
    if (!raw)
        return null;
    try {
        const tok = JSON.parse(raw)?.token;
        if (typeof tok?.access_token !== 'string' || !tok.access_token)
            return null;
        const expiry = tok.expiry ? new Date(tok.expiry) : null;
        return {accessToken: tok.access_token, expiresAt: expiry && !isNaN(expiry.getTime()) ? expiry : null};
    } catch (_) {
        return null;
    }
}

export function tokenUsable(token, now) {
    return Boolean(token?.expiresAt) && token.expiresAt.getTime() - TOKEN_EXPIRY_SKEW_MS > now.getTime();
}

let _agyVersion = null;

async function agyVersion(runner, agyPath, signal) {
    if (_agyVersion)
        return _agyVersion;
    if (agyPath) {
        const res = await runner([agyPath, '--version'], signal).catch(() => null);
        const m = res?.ok ? /\d+\.\d+\.\d+/.exec(res.stdout ?? '') : null;
        if (m) {
            _agyVersion = m[0];
            return _agyVersion;
        }
    }
    return FALLBACK_AGY_VERSION;
}

export async function tryFetchQuotaApi(http, token, version, signal) {
    if (!http || !token)
        return null;
    try {
        const res = await http({
            method: 'POST',
            url: QUOTA_URL,
            headers: {
                Authorization: `Bearer ${token.accessToken}`,
                'User-Agent': `antigravity/${version} linux/amd64`,
                'Content-Type': 'application/json',
            },
            body: '{}',
            timeoutMs: HTTP_TIMEOUT_MS,
            cancellable: signal,
        });
        if (res.error || res.status !== 200)
            return null;
        return parseQuotaSummary(res.bodyBytes);
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
        const raw = await cache.maybePayload();
        if (raw) {
            prev = JSON.parse(new TextDecoder().decode(raw));
            reviveSnapshotDates(prev);
        }
    } catch (_) {}

    let session = null;
    let weekly = null;

    const runner = deps.runner ?? defaultAgyRunner;
    const agyPath = deps.agyPath ?? findAgyPath();

    // Fast path: call the quota API with agy's keyring token. Fall back to
    // running agy (which also refreshes that token) when it is expired or fails.
    const token = await (deps.readToken ?? readAgyToken)();
    let agyQuota = tokenUsable(token, now)
        ? await tryFetchQuotaApi(deps.http, token, await agyVersion(runner, agyPath, deps.signal), deps.signal)
        : null;
    if (!agyQuota && agyPath)
        agyQuota = await tryFetchAgyQuota(runner, deps.signal, agyPath);

    // With agy installed, a failed run must not be papered over with locally
    // synthesized windows — keep showing the last real snapshot as stale.
    if ((agyPath || token) && !agyQuota) {
        return staleResult(cache, (b) => reviveSnapshotDates(JSON.parse(new TextDecoder().decode(b))),
            {ok: false, kind: 'error', message: 'agy /usage failed'});
    }

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
    const hasAgy = Boolean(agyPath);
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
