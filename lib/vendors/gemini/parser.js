import {severityFor} from '../../severity.js';
import {calc, paceGlyph} from '../../pacing.js';
import {format as formatCountdown} from '../../countdown.js';

export const ICON = '󰚩';
export const VENDOR_SHORT = 'gmn';
export const SESSION_MS = 5 * 3600 * 1000;
export const DAILY_MS = 24 * 3600 * 1000;
export const WEEKLY_MS = 7 * 86400 * 1000;

export class SchemaError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SchemaError';
    }
}

export function geminiSeverity(snapshot) {
    const s = snapshot?.session?.utilizationPct ?? 0;
    const d = snapshot?.daily?.utilizationPct ?? 0;
    const w = snapshot?.weekly?.utilizationPct ?? 0;
    return severityFor(Math.max(s, d, w));
}

export function geminiPeakUsage(snapshot) {
    const s = snapshot?.session?.utilizationPct ?? 0;
    const d = snapshot?.daily?.utilizationPct ?? 0;
    const w = snapshot?.weekly?.utilizationPct ?? 0;
    const maxPct = Math.max(s, d, w);
    return {
        percent: maxPct,
        resetsAt: snapshot?.session?.resetsAt ?? null,
    };
}

export function fakeSnapshot(fakePct = 0) {
    const now = new Date();
    const pct = Math.min(100, Math.max(0, Math.round(fakePct)));
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);

    return {
        plan: 'PRO',
        status: 'Active',
        label: 'Google One AI Premium',
        model: 'Gemini 3.0 Pro',
        hasApiKey: true,
        session: {
            utilizationPct: pct,
            resetsAt: new Date(now.getTime() + SESSION_MS),
        },
        daily: {
            utilizationPct: pct,
            resetsAt: midnight,
        },
        weekly: {
            utilizationPct: pct,
            resetsAt: new Date(now.getTime() + WEEKLY_MS),
        },
    };
}

function windowPlaceholders(m, prefix, win, pace, now) {
    if (win) {
        m.set(`${prefix}_pct`, String(win.utilizationPct));
        m.set(`${prefix}_reset`, formatCountdown(win.resetsAt, now));
        m.set(`${prefix}_elapsed`, String(pace ? pace.elapsedPct : 0));
    } else {
        m.set(`${prefix}_pct`, '0');
        m.set(`${prefix}_reset`, '—');
        m.set(`${prefix}_elapsed`, '0');
    }
    m.set(`${prefix}_pace`, pace ? paceGlyph(pace.ratioPace) : '');
    m.set(`${prefix}_pace_indicator`, pace ? paceGlyph(pace.pointPace) : '');
    m.set(`${prefix}_pace_pct`, pace ? pace.ratioLabel : '');
    m.set(`${prefix}_pace_pts`, pace ? pace.pointLabel : '');
    m.set(`${prefix}_pace_delta`, String(pace ? pace.delta : 0));
    m.set(`${prefix}_pace_abs_delta`, String(Math.abs(pace ? pace.delta : 0)));
}

export function placeholders(snapshot, now) {
    const m = new Map();
    m.set('icon', ICON);
    m.set('vendor_short', VENDOR_SHORT);
    m.set('plan', snapshot?.plan ?? 'PRO');
    m.set('status', snapshot?.status ?? 'Active');
    m.set('model', snapshot?.model ?? 'Gemini 3.0 Pro');

    const session = snapshot?.session ?? {
        utilizationPct: 0,
        resetsAt: new Date(now.getTime() + SESSION_MS),
    };
    const sessionPace = calc({
        usagePct: session.utilizationPct,
        reset: session.resetsAt,
        now,
        windowMs: SESSION_MS,
    });
    windowPlaceholders(m, 'session', session, sessionPace, now);

    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const daily = snapshot?.daily ?? {
        utilizationPct: 0,
        resetsAt: midnight,
    };
    const dailyPace = calc({
        usagePct: daily.utilizationPct,
        reset: daily.resetsAt,
        now,
        windowMs: DAILY_MS,
    });
    windowPlaceholders(m, 'daily', daily, dailyPace, now);

    const weekly = snapshot?.weekly ?? {
        utilizationPct: 0,
        resetsAt: new Date(now.getTime() + WEEKLY_MS),
    };
    const weeklyPace = calc({
        usagePct: weekly.utilizationPct,
        reset: weekly.resetsAt,
        now,
        windowMs: WEEKLY_MS,
    });
    windowPlaceholders(m, 'weekly', weekly, weeklyPace, now);

    return m;
}
