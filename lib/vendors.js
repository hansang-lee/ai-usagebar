export const VENDOR_IDS = Object.freeze([
    'anthropic',
    'openai',
    'openrouter',
    'gemini',
]);

export const VENDOR_LABELS = Object.freeze([
    'Anthropic',
    'OpenAI',
    'OpenRouter',
    'Gemini',
]);

export function isVendorId(s) {
    return VENDOR_IDS.includes(s);
}

export function vendorLabel(id) {
    const i = VENDOR_IDS.indexOf(id);
    return i === -1 ? id : VENDOR_LABELS[i];
}
