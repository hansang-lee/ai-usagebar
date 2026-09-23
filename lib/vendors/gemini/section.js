import {fillColors} from '../../pace-fill.js';
import {calc, paceGlyph} from '../../pacing.js';
import {format as formatCountdown} from '../../countdown.js';
import {vformat} from '../../format.js';
import {httpErrorRow, footerRow} from '../section-common.js';
import {SESSION_MS, DAILY_MS, WEEKLY_MS} from './parser.js';

const ICON_SESSION = 'alarm-symbolic';
const ICON_DAILY = 'appointment-soon-symbolic';
const ICON_WEEKLY = 'x-office-calendar-symbolic';
const ICON_STAR = 'starred-symbolic';

function windowRow(icon, title, win, windowMs, now, theme, _) {
    const remainingPct = Math.max(0, 100 - win.utilizationPct);
    const pace = windowMs === null
        ? null
        : calc({usagePct: win.utilizationPct, reset: win.resetsAt, now, windowMs});
    const reset = formatCountdown(win.resetsAt, now, _);
    const {base, over} = fillColors(win.utilizationPct, pace ? pace.elapsedPct : null, theme);
    return {
        kind: 'window',
        icon,
        title,
        pct: remainingPct,
        color: base,
        reset,
        subtitle: vformat(_('Resets in %s'), reset),
        paceGlyph: pace ? paceGlyph(pace.ratioPace) : '',
        ...(pace ? {elapsedPct: pace.elapsedPct, paceColor: over} : {}),
    };
}

export function buildSection(snapshot, meta, now, theme, _ = (s) => s) {
    const rows = [];

    if (snapshot.session) {
        rows.push(windowRow(ICON_SESSION, _('Session'), snapshot.session, SESSION_MS, now, theme, _));
    }
    if (snapshot.daily) {
        rows.push(windowRow(ICON_DAILY, _('Daily'), snapshot.daily, DAILY_MS, now, theme, _));
    }
    if (snapshot.weekly) {
        rows.push(windowRow(ICON_WEEKLY, _('Weekly'), snapshot.weekly, WEEKLY_MS, now, theme, _));
    }

    rows.push({
        kind: 'text',
        icon: ICON_STAR,
        text: _('Google One AI Premium (Gemini Advanced)'),
        tone: 'normal',
    });

    const err = httpErrorRow(meta, theme, _);
    if (err)
        rows.push(err);

    rows.push(footerRow(meta, _));

    return {title: 'Gemini Pro', plan: 'PRO', rows};
}
