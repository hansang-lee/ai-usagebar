import system from 'system';

import {VENDOR_IDS, VENDOR_LABELS, isVendorId, vendorLabel} from '../lib/vendors.js';
import {describe, it, assertEqual, assertDeepEqual, summary} from './_assert.js';

describe('VENDOR_IDS — canonical order', () => {
    it('lists vendors in fixed order', () =>
        assertDeepEqual(
            [...VENDOR_IDS],
            ['anthropic', 'openai', 'openrouter', 'gemini']
        ));
    it('is frozen', () => assertEqual(Object.isFrozen(VENDOR_IDS), true));
});

describe('VENDOR_LABELS', () => {
    it('aligns length with VENDOR_IDS', () =>
        assertEqual(VENDOR_LABELS.length, VENDOR_IDS.length));
    it('is frozen', () => assertEqual(Object.isFrozen(VENDOR_LABELS), true));
    it('is ordered to match VENDOR_IDS', () =>
        assertDeepEqual(
            [...VENDOR_LABELS],
            ['Anthropic', 'OpenAI', 'OpenRouter', 'Gemini']
        ));
});

describe('isVendorId', () => {
    it('accepts a known id', () => assertEqual(isVendorId('gemini'), true));
    it('rejects an unknown id', () => assertEqual(isVendorId('unknown_ai'), false));
    it('rejects non-strings', () => assertEqual(isVendorId(null), false));
});

describe('vendorLabel', () => {
    it('maps a known id to its display name', () =>
        assertEqual(vendorLabel('gemini'), 'Gemini'));
    it('maps each id to its aligned label', () =>
        assertDeepEqual(VENDOR_IDS.map(vendorLabel), [...VENDOR_LABELS]));
    it('falls back to the id for an unknown vendor', () =>
        assertEqual(vendorLabel('unknown_ai'), 'unknown_ai'));
});

system.exit(summary());
