import {defaultCredsPath} from './oauth/anthropic.js';
import {defaultAuthPath} from './oauth/openai.js';
import {emptyToNull} from './config-resolve.js';

export function readConfig(settings) {
    const s = key => settings.get_string(key);
    const b = key => settings.get_boolean(key);

    return {
        primaryVendor: s('primary-vendor'),
        activeVendor: s('active-vendor'),
        refreshIntervalSecs: settings.get_int('refresh-interval'),
        barFormat: s('bar-format'),
        tooltipFormat: emptyToNull(s('tooltip-format')),
        showPaceMarker: b('show-pace-marker'),
        notifications: {
            enabled: b('notify-enabled'),
            threshold: settings.get_int('notify-threshold'),
        },
        colors: {
            low: emptyToNull(s('color-low')),
            mid: emptyToNull(s('color-mid')),
            high: emptyToNull(s('color-high')),
            critical: emptyToNull(s('color-critical')),
        },
        vendors: {
            anthropic: {
                enabled: b('anthropic-enabled'),
                credentialsPath: emptyToNull(s('anthropic-credentials-path')),
                refreshIntervalSecs: settings.get_int('anthropic-refresh-interval'),
            },
            openai: {
                enabled: b('openai-enabled'),
                codexAuthPath: emptyToNull(s('openai-codex-auth-path')),
                adminKeyEnv: s('openai-admin-key-env'),
                refreshIntervalSecs: settings.get_int('openai-refresh-interval'),
            },
            openrouter: {
                enabled: b('openrouter-enabled'),
                apiKeyEnv: s('openrouter-api-key-env'),
                apiKey: emptyToNull(s('openrouter-api-key')),
                refreshIntervalSecs: settings.get_int('openrouter-refresh-interval'),
            },
            gemini: {
                enabled: b('gemini-enabled'),
                apiKeyEnv: s('gemini-api-key-env'),
                apiKey: emptyToNull(s('gemini-api-key')),
                refreshIntervalSecs: settings.get_int('gemini-refresh-interval'),
            },
        },
    };
}

// Manual refresh bypasses the poll cache but still collapses rapid repeat clicks.
export const MANUAL_REFRESH_CACHE_TTL_MS = 5_000;

// Half the poll interval: a cache written at the end of one tick must already be
// expired by the next tick, or every other tick would be served from cache.
export function pollCacheTtlMs(intervalSecs) {
    return Math.max(1_000, Math.floor(intervalSecs * 1000 / 2));
}

export function vendorRefreshIntervalSecs(snapshot, vendorId) {
    const vendorSecs = snapshot.vendors?.[vendorId]?.refreshIntervalSecs;
    if (typeof vendorSecs === 'number' && vendorSecs >= 5)
        return vendorSecs;
    return snapshot.refreshIntervalSecs;
}

export function anthropicCredsPath(snapshot) {
    return snapshot.vendors.anthropic.credentialsPath ?? defaultCredsPath();
}

export function codexAuthPath(snapshot) {
    return snapshot.vendors.openai.codexAuthPath ?? defaultAuthPath();
}
