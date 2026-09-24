import {anthropicAdapter} from './anthropic/adapter.js';
import {openaiAdapter} from './openai/adapter.js';
import {openrouterAdapter} from './openrouter/adapter.js';
import {geminiAdapter} from './gemini/adapter.js';

export const ADAPTERS = Object.freeze({
    anthropic: anthropicAdapter,
    openai: openaiAdapter,
    openrouter: openrouterAdapter,
    gemini: geminiAdapter,
});

export function getAdapter(id) {
    const adapter = ADAPTERS[id];
    if (adapter)
        return adapter;
    console.warn(`ai-usagebar: no adapter registered for '${id}', falling back to anthropic`);
    return ADAPTERS.anthropic;
}
