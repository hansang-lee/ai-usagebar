import system from 'system';

import {buildSection} from '../../../../lib/vendors/gemini/section.js';
import {describe, it, assertEqual, summary} from '../../../_assert.js';

const NOW = new Date('2026-09-23T12:00:00Z');

const theme = {
    green: '#0f0',
    yellow: '#ff0',
    orange: '#f80',
    red: '#f00',
    fg: '#fff',
};

const meta = {stale: false, lastError: null, fetchedAt: NOW};

function snapshot(sessionPct, weeklyPct) {
    return {
        plan: 'PRO',
        status: 'Active',
        label: 'Google One AI Premium',
        model: 'Gemini 3.0 Pro',
        hasApiKey: true,
        session: {utilizationPct: sessionPct, resetsAt: new Date('2026-09-23T13:20:26Z')},
        weekly: {utilizationPct: weeklyPct, resetsAt: new Date('2026-09-30T04:07:09Z')},
    };
}

describe('buildSection (gemini)', () => {
    it('reports windows as used percentage, not remaining', () => {
        const rows = buildSection(snapshot(98.05, 30.9), meta, NOW, theme).rows;
        assertEqual(rows[0].title, 'Session');
        assertEqual(rows[0].pct, 98.05);
        assertEqual(rows[1].title, 'Weekly');
        assertEqual(rows[1].pct, 30.9);
    });

    it('colors each bar from its own usage', () => {
        const rows = buildSection(snapshot(98.05, 30.9), meta, NOW, theme).rows;
        assertEqual(rows[0].color, theme.red);
        assertEqual(rows[1].color, theme.green);
    });

    it('keeps the pace marker on the same scale as the bar', () => {
        const row = buildSection(snapshot(60, 10), meta, NOW, theme).rows[0];
        assertEqual(typeof row.elapsedPct, 'number');
        assertEqual(row.elapsedPct >= 0 && row.elapsedPct <= 100, true);
    });

    it('routes user-facing text through the injected translator', () => {
        const rows = buildSection(snapshot(10, 10), meta, NOW, theme, (s) => `«${s}»`).rows;
        assertEqual(rows[0].title, '«Session»');
    });
});

system.exit(summary());
