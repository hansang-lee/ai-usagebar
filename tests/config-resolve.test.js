import system from 'system';

import {
    emptyToNull,
    resolveApiKey,
    isEnabled,
    enabledVendors,
    normalizePrimary,
    normalizeActive,
    cycleVendor,
} from '../lib/config-resolve.js';
import {describe, it, assertEqual, assertDeepEqual, summary} from './_assert.js';

function snapshot(overrides = {}) {
    const enabled = {
        anthropic: true,
        openai: true,
        openrouter: true,
        gemini: false,
        ...overrides.enabled,
    };
    return {
        primaryVendor: overrides.primaryVendor ?? 'anthropic',
        activeVendor: overrides.activeVendor ?? '',
        vendors: {
            anthropic: {enabled: enabled.anthropic},
            openai: {enabled: enabled.openai},
            openrouter: {enabled: enabled.openrouter},
            gemini: {enabled: enabled.gemini},
        },
    };
}

function fakeGetenv(map) {
    return name => (name in map ? map[name] : null);
}

describe('emptyToNull', () => {
    it("'' → null", () => assertEqual(emptyToNull(''), null));
    it('non-empty passes through', () => assertEqual(emptyToNull('x'), 'x'));
});

describe('isEnabled / enabledVendors — defaults', () => {
    it('defaults enable all but Gemini in test snapshot', () => {
        const s = snapshot();
        assertEqual(isEnabled(s, 'anthropic'), true);
        assertEqual(isEnabled(s, 'openai'), true);
        assertEqual(isEnabled(s, 'openrouter'), true);
        assertEqual(isEnabled(s, 'gemini'), false);
    });
    it('enabledVendors preserves canonical order, omits Gemini when disabled', () =>
        assertDeepEqual(
            enabledVendors(snapshot()),
            ['anthropic', 'openai', 'openrouter']
        ));
    it('Gemini appears when enabled', () =>
        assertDeepEqual(
            enabledVendors(snapshot({enabled: {gemini: true}})),
            ['anthropic', 'openai', 'openrouter', 'gemini']
        ));
});

describe('resolveApiKey', () => {
    it('prefers env over inline', () =>
        assertEqual(
            resolveApiKey('OpenRouter', 'OPENROUTER_API_KEY', 'inline-key', fakeGetenv({OPENROUTER_API_KEY: 'from-env'})),
            'from-env'
        ));
    it('falls back to inline when env unset', () =>
        assertEqual(
            resolveApiKey('OpenRouter', 'OPENROUTER_API_KEY', 'inline-key', fakeGetenv({})),
            'inline-key'
        ));
    it('treats empty env as unset', () =>
        assertEqual(
            resolveApiKey('OpenRouter', 'OR_KEY', 'inline', fakeGetenv({OR_KEY: ''})),
            'inline'
        ));
    it('throws naming the env var and the API key when both missing', () => {
        let msg = null;
        try {
            resolveApiKey('OpenRouter', 'OPENROUTER_API_KEY', null, fakeGetenv({}));
        } catch (e) {
            msg = e.message;
        }
        assertEqual(msg !== null, true, 'expected throw');
        assertEqual(msg.includes('OPENROUTER_API_KEY'), true, 'names env var');
        assertEqual(msg.includes('API key'), true, 'names API key');
    });
});

describe('normalizePrimary', () => {
    it('returns the primary when it is enabled', () =>
        assertEqual(normalizePrimary(snapshot({primaryVendor: 'openrouter'})), 'openrouter'));
    it('falls back to first enabled when primary disabled', () =>
        assertEqual(
            normalizePrimary(snapshot({primaryVendor: 'openai', enabled: {anthropic: false, openai: false}})),
            'openrouter'
        ));
    it('falls back to anthropic when nothing is enabled', () =>
        assertEqual(
            normalizePrimary(snapshot({
                primaryVendor: 'openai',
                enabled: {anthropic: false, openai: false, openrouter: false, gemini: false},
            })),
            'anthropic'
        ));
});

describe('normalizeActive', () => {
    it('returns the active vendor when it is enabled', () =>
        assertEqual(
            normalizeActive(snapshot({primaryVendor: 'anthropic', activeVendor: 'openrouter'})),
            'openrouter'
        ));
    it('falls back to primary when the active vendor is disabled', () =>
        assertEqual(
            normalizeActive(snapshot({
                primaryVendor: 'openai',
                activeVendor: 'gemini',
            })),
            'openai'
        ));
    it('falls back through normalizePrimary when both active and primary are disabled', () =>
        assertEqual(
            normalizeActive(snapshot({
                primaryVendor: 'openai',
                activeVendor: 'gemini',
                enabled: {openai: false},
            })),
            'anthropic'
        ));
    it('falls back to primary when active is unset (empty string)', () =>
        assertEqual(
            normalizeActive(snapshot({primaryVendor: 'openrouter', activeVendor: ''})),
            'openrouter'
        ));
});

describe('cycleVendor', () => {
    const list = ['anthropic', 'openai', 'openrouter'];
    it('steps forward', () => assertEqual(cycleVendor(list, 'anthropic', +1), 'openai'));
    it('steps backward', () => assertEqual(cycleVendor(list, 'openai', -1), 'anthropic'));
    it('wraps forward past the end', () => assertEqual(cycleVendor(list, 'openrouter', +1), 'anthropic'));
    it('wraps backward past the start', () => assertEqual(cycleVendor(list, 'anthropic', -1), 'openrouter'));
    it('returns the first element for +1 when current is absent', () =>
        assertEqual(cycleVendor(list, 'gemini', +1), 'anthropic'));
    it('returns the last element for -1 when current is absent', () =>
        assertEqual(cycleVendor(list, 'gemini', -1), 'openrouter'));
    it('single-element list returns itself', () =>
        assertEqual(cycleVendor(['openrouter'], 'openrouter', +1), 'openrouter'));
    it('empty list returns current unchanged', () =>
        assertEqual(cycleVendor([], 'openrouter', +1), 'openrouter'));
});

system.exit(summary());
