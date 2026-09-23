import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {withMutex, staleResult} from '../fetch-common.js';
import {SESSION_MS, DAILY_MS, WEEKLY_MS} from './parser.js';

export const CACHE_TTL_MS = 60_000;

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
    const realQuota = await tryFetchGoogleQuota(deps.http, deps.signal);
    if (realQuota && realQuota.resetsAt) {
        session = realQuota;
    } else {
        session = resolveWindow(prev?.session, (n) => new Date(n.getTime() + SESSION_MS), now);
    }
    const daily = resolveWindow(prev?.daily, (n) => nextMidnight(n), now);
    const weekly = resolveWindow(prev?.weekly, (n) => new Date(n.getTime() + WEEKLY_MS), now);

    const apiKey = GLib.getenv('GEMINI_API_KEY') || readOpencodeApiKey();
    const snapshot = {
        plan: 'PRO',
        status: 'Active',
        label: 'Google One AI Premium',
        model: 'Gemini 3.0 Pro',
        hasApiKey: Boolean(apiKey),
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
