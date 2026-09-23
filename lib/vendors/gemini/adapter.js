import {fetchSnapshot} from './main.js';
import {
    ICON,
    VENDOR_SHORT,
    placeholders,
    geminiSeverity,
    geminiPeakUsage,
    fakeSnapshot,
} from './parser.js';
import {buildSection} from './section.js';

export const geminiAdapter = {
    id: 'gemini',
    cacheId: 'gemini',
    icon: ICON,
    vendorShort: VENDOR_SHORT,
    fetchSnapshot(ctx) {
        return fetchSnapshot({
            cache: ctx.cache,
            http: ctx.http,
            signal: ctx.signal,
            now: ctx.now,
        });
    },
    severity: geminiSeverity,
    peakUsage: geminiPeakUsage,
    placeholders,
    buildSection,
    fakeSnapshot,
};
