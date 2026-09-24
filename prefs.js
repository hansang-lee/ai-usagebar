import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {rgbToHex} from './lib/color.js';
import {vformat} from './lib/format.js';
import {defaultTheme} from './lib/theme.js';
import {VENDOR_IDS, vendorLabel} from './lib/vendors.js';

const INTERVAL_MIN = 5;
const INTERVAL_MAX = 86400;

const COLOR_KEY_PALETTE = {
    'color-low': 'green',
    'color-mid': 'yellow',
    'color-high': 'orange',
    'color-critical': 'red',
};

function findHeaderBar(widget) {
    if (widget instanceof Adw.HeaderBar)
        return widget;
    let child = widget.get_first_child ? widget.get_first_child() : null;
    while (child) {
        const found = findHeaderBar(child);
        if (found)
            return found;
        child = child.get_next_sibling ? child.get_next_sibling() : null;
    }
    return null;
}

// StagedSettings holds unsaved changes and commits them all at once when Apply or Save is clicked.
class StagedSettings {
    constructor(realSettings) {
        this._real = realSettings;
        this._staged = new Map();
        this._listeners = new Map(); // key -> Set of callback(value)
    }

    get_string(key) {
        return this._staged.has(key) ? this._staged.get(key) : this._real.get_string(key);
    }

    set_string(key, val) {
        this._staged.set(key, val);
        this._emitChanged(key, val);
    }

    get_int(key) {
        return this._staged.has(key) ? this._staged.get(key) : this._real.get_int(key);
    }

    set_int(key, val) {
        this._staged.set(key, val);
        this._emitChanged(key, val);
    }

    get_boolean(key) {
        return this._staged.has(key) ? this._staged.get(key) : this._real.get_boolean(key);
    }

    set_boolean(key, val) {
        this._staged.set(key, val);
        this._emitChanged(key, val);
    }

    // Staged like any other edit, so Cancel also undoes a Reset.
    reset(key) {
        const val = this._real.get_default_value(key).deep_unpack();
        this._staged.set(key, val);
        this._emitChanged(key, val);
    }

    get settings_schema() {
        return this._real.settings_schema;
    }

    _emitChanged(key, val) {
        const cbs = this._listeners.get(key);
        if (cbs) {
            for (const cb of cbs)
                cb(val);
        }
    }

    connect(signal, cb) {
        if (signal.startsWith('changed::')) {
            const key = signal.slice('changed::'.length);
            if (!this._listeners.has(key))
                this._listeners.set(key, new Set());
            this._listeners.get(key).add(cb);
            return {key, cb};
        }
        return null;
    }

    disconnect(handle) {
        if (handle && handle.key && handle.cb)
            this._listeners.get(handle.key)?.delete(handle.cb);
    }

    hasChanges() {
        return this._staged.size > 0;
    }

    clearChanges() {
        this._staged.clear();
    }

    commit() {
        if (this._staged.size === 0)
            return;
        const schema = this._real.settings_schema;
        for (const [key, val] of this._staged) {
            const keyObj = schema?.get_key(key);
            const typeStr = keyObj ? keyObj.get_value_type().dup_string() : 's';
            if (typeStr === 'b')
                this._real.set_boolean(key, val);
            else if (typeStr === 'i' || typeStr === 'u')
                this._real.set_int(key, val);
            else
                this._real.set_string(key, val);
        }
        this._staged.clear();
    }
}

export default class AiUsagebarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const realSettings = this.getSettings();
        const settings = new StagedSettings(realSettings);
        const cleanups = [];

        this._registerIconPath();
        this._loadStyles();

        window.add(this._buildGeneralPage(settings, cleanups));
        window.add(this._buildAnthropicPage(settings, cleanups));
        window.add(this._buildOpenAiPage(settings, cleanups));
        window.add(this._buildOpenRouterPage(settings, cleanups));
        window.add(this._buildGeminiPage(settings, cleanups));

        this._setupHeaderBar(window, settings);

        // Ensure preferences window is brought to front and focused
        if (typeof window.present === 'function')
            window.present();

        window.connect('close-request', () => {
            for (const disconnect of cleanups)
                disconnect();
            return false;
        });
    }

    _setupHeaderBar(window, settings) {
        const hb = findHeaderBar(window);
        if (!hb)
            return;

        const btnCancel = new Gtk.Button({
            label: _('Cancel'),
            tooltip_text: _('Discard unsaved changes and close'),
        });
        const btnApply = new Gtk.Button({
            label: _('Apply'),
            tooltip_text: _('Apply changes without closing'),
        });
        const btnSave = new Gtk.Button({
            label: _('Save'),
            css_classes: ['suggested-action'],
            tooltip_text: _('Save changes and close'),
        });

        btnCancel.connect('clicked', () => {
            settings.clearChanges();
            window.close();
        });

        btnApply.connect('clicked', () => {
            settings.commit();
            if (window.add_toast && Adw.Toast) {
                window.add_toast(new Adw.Toast({
                    title: _('Settings applied'),
                    timeout: 2,
                }));
            }
        });

        btnSave.connect('clicked', () => {
            settings.commit();
            window.close();
        });

        hb.pack_start(btnCancel);
        hb.pack_end(btnSave);
        hb.pack_end(btnApply);
    }

    _buildGeneralPage(settings, cleanups) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        const cadenceGroup = new Adw.PreferencesGroup({
            title: _('Refresh'),
            description: vformat(_('Default refresh cadence in seconds (minimum %d s). Per-vendor overrides take precedence.'), INTERVAL_MIN),
        });
        const adjustment = new Gtk.Adjustment({
            lower: INTERVAL_MIN,
            upper: INTERVAL_MAX,
            step_increment: 5,
            page_increment: 30,
        });
        const interval = new Adw.SpinRow({
            title: _('Default refresh interval (seconds)'),
            adjustment,
            digits: 0,
        });
        interval.set_value(settings.get_int('refresh-interval'));
        const intervalNotifyId = interval.connect('notify::value', () => {
            const v = Math.round(interval.get_value());
            if (settings.get_int('refresh-interval') !== v)
                settings.set_int('refresh-interval', v);
        });
        const intervalResyncId = settings.connect('changed::refresh-interval', () => {
            const v = settings.get_int('refresh-interval');
            if (Math.round(interval.get_value()) !== v)
                interval.set_value(v);
        });
        cleanups.push(() => {
            interval.disconnect(intervalNotifyId);
            settings.disconnect(intervalResyncId);
        });
        cadenceGroup.add(interval);
        page.add(cadenceGroup);

        const vendorCadenceGroup = new Adw.PreferencesGroup({
            title: _('Per-AI Refresh Intervals'),
            description: _('Override refresh interval per AI (seconds). Set to 0 to use the default refresh interval.'),
        });
        for (const id of VENDOR_IDS) {
            const row = this._vendorIntervalRow(settings, id, cleanups);
            vendorCadenceGroup.add(row);
        }
        page.add(vendorCadenceGroup);

        const labelGroup = new Adw.PreferencesGroup({
            title: _('Panel label'),
            description: _('Placeholders: {vendor_short} {session_pct}% {session_reset} {plan} {weekly_pct} {weekly_reset}'),
        });
        const barFormat = this._entryRow(settings, 'bar-format', _('Bar format'), cleanups);
        labelGroup.add(barFormat);
        page.add(labelGroup);

        const popupGroup = new Adw.PreferencesGroup({
            title: _('Popup'),
            description: _('Optional extra lines shown above the popup. Empty uses the built-in layout. Placeholders: {plan} {session_pct} {session_reset} {weekly_pct} {weekly_reset}'),
        });
        popupGroup.add(this._entryRow(settings, 'tooltip-format', _('Popup format'), cleanups));
        popupGroup.add(this._switchRow(settings, 'show-pace-marker', _('Show pace marker'), cleanups));
        page.add(popupGroup);

        const colorGroup = new Adw.PreferencesGroup({
            title: _('Severity colors'),
            description: _('Pick a color per severity tier. Reset returns a tier to its built-in default.'),
        });
        const theme = defaultTheme();
        colorGroup.add(this._colorRow(settings, 'color-low', _('Low'), theme[COLOR_KEY_PALETTE['color-low']], cleanups));
        colorGroup.add(this._colorRow(settings, 'color-mid', _('Mid'), theme[COLOR_KEY_PALETTE['color-mid']], cleanups));
        colorGroup.add(this._colorRow(settings, 'color-high', _('High'), theme[COLOR_KEY_PALETTE['color-high']], cleanups));
        colorGroup.add(this._colorRow(settings, 'color-critical', _('Critical'), theme[COLOR_KEY_PALETTE['color-critical']], cleanups));
        page.add(colorGroup);

        const notifyGroup = new Adw.PreferencesGroup({
            title: _('Notifications'),
            description: _('Show a desktop notification the first time a vendor reaches the threshold. It re-arms when usage drops back or the window resets.'),
        });
        notifyGroup.add(this._switchRow(settings, 'notify-enabled', _('Notify on high usage'), cleanups));
        const notifyAdj = new Gtk.Adjustment({
            lower: 0,
            upper: 100,
            step_increment: 5,
            page_increment: 10,
        });
        const threshold = new Adw.SpinRow({
            title: _('Notification threshold (%)'),
            adjustment: notifyAdj,
            digits: 0,
        });
        threshold.set_value(settings.get_int('notify-threshold'));
        const thresholdNotifyId = threshold.connect('notify::value', () => {
            const v = Math.round(threshold.get_value());
            if (settings.get_int('notify-threshold') !== v)
                settings.set_int('notify-threshold', v);
        });
        const thresholdResyncId = settings.connect('changed::notify-threshold', () => {
            const v = settings.get_int('notify-threshold');
            if (Math.round(threshold.get_value()) !== v)
                threshold.set_value(v);
        });
        cleanups.push(() => {
            threshold.disconnect(thresholdNotifyId);
            settings.disconnect(thresholdResyncId);
        });
        notifyGroup.add(threshold);
        page.add(notifyGroup);

        const enabledGroup = new Adw.PreferencesGroup({
            title: _('Enabled Models'),
            description: _('Choose which AI models to display in the top bar and popup menu.'),
        });
        for (const id of VENDOR_IDS)
            enabledGroup.add(this._switchRow(settings, `${id}-enabled`, vendorLabel(id), cleanups));
        page.add(enabledGroup);

        const resetGroup = new Adw.PreferencesGroup({
            title: _('Reset'),
            description: _('Restore every setting — vendor toggles, paths, keys, formats, and colors — to its built-in default.'),
        });
        let resetRow;
        if (Adw.ButtonRow) {
            resetRow = new Adw.ButtonRow({title: _('Reset all settings')});
            resetRow.add_css_class('destructive-action');
            const resetActivatedId = resetRow.connect('activated', () =>
                this._confirmResetAll(settings, resetRow.get_root()));
            cleanups.push(() => resetRow.disconnect(resetActivatedId));
        } else {
            resetRow = new Adw.ActionRow({title: _('Reset all settings')});
            const btn = new Gtk.Button({
                label: _('Reset'),
                valign: Gtk.Align.CENTER,
            });
            btn.add_css_class('destructive-action');
            const btnClickedId = btn.connect('clicked', () =>
                this._confirmResetAll(settings, resetRow.get_root()));
            cleanups.push(() => btn.disconnect(btnClickedId));
            resetRow.add_suffix(btn);
            resetRow.activatable_widget = btn;
        }
        resetGroup.add(resetRow);
        page.add(resetGroup);

        return page;
    }

    _vendorIntervalRow(settings, vendorId, cleanups) {
        const key = `${vendorId}-refresh-interval`;
        const adj = new Gtk.Adjustment({
            lower: 0,
            upper: INTERVAL_MAX,
            step_increment: 5,
            page_increment: 30,
        });
        const row = new Adw.SpinRow({
            title: vendorLabel(vendorId),
            subtitle: _('0 uses default interval'),
            adjustment: adj,
            digits: 0,
        });
        row.set_value(settings.get_int(key));
        const notifyId = row.connect('notify::value', () => {
            const v = Math.round(row.get_value());
            if (settings.get_int(key) !== v)
                settings.set_int(key, v);
        });
        const resyncId = settings.connect(`changed::${key}`, () => {
            const v = settings.get_int(key);
            if (Math.round(row.get_value()) !== v)
                row.set_value(v);
        });
        cleanups.push(() => {
            row.disconnect(notifyId);
            settings.disconnect(resyncId);
        });
        return row;
    }

    _registerIconPath() {
        const iconDir = `${this.path}/icons`;
        const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        if (!iconTheme.get_search_path().includes(iconDir))
            iconTheme.add_search_path(iconDir);
    }

    _loadStyles() {
        const provider = new Gtk.CssProvider();
        provider.load_from_string('viewswitcher button image { margin-bottom: 6px; }');
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    }

    _confirmResetAll(settings, parent) {
        const dialog = new Adw.AlertDialog({
            heading: _('Reset all settings?'),
            body: _('This restores every setting to its built-in default and cannot be undone.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('reset', _('Reset'));
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_d, response) => {
            if (response === 'reset')
                this._resetAll(settings);
        });
        dialog.present(parent);
    }

    _resetAll(settings) {
        for (const key of settings.settings_schema.list_keys())
            settings.reset(key);
    }

    _buildAnthropicPage(settings, cleanups) {
        const page = new Adw.PreferencesPage({
            title: _('Anthropic'),
            icon_name: 'ai-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: _('Anthropic'),
            description: _('Credentials path — empty uses ~/.claude/.credentials.json.'),
        });
        group.add(this._switchRow(settings, 'anthropic-enabled', _('Enabled'), cleanups));
        group.add(this._entryRow(settings, 'anthropic-credentials-path', _('Credentials path'), cleanups));
        group.add(this._vendorIntervalRow(settings, 'anthropic', cleanups));
        page.add(group);
        return page;
    }

    _buildOpenAiPage(settings, cleanups) {
        const page = new Adw.PreferencesPage({
            title: _('OpenAI'),
            icon_name: 'ai-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: _('OpenAI'),
            description: _('Codex auth path — empty uses ~/.codex/auth.json.'),
        });
        group.add(this._switchRow(settings, 'openai-enabled', _('Enabled'), cleanups));
        group.add(this._entryRow(settings, 'openai-codex-auth-path', _('Codex auth path'), cleanups));
        group.add(this._vendorIntervalRow(settings, 'openai', cleanups));
        page.add(group);
        return page;
    }

    _buildOpenRouterPage(settings, cleanups) {
        const page = new Adw.PreferencesPage({
            title: _('OpenRouter'),
            icon_name: 'ai-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: _('OpenRouter'),
            description: _('Set the API key inline or via the environment variable (env wins).'),
        });
        group.add(this._switchRow(settings, 'openrouter-enabled', _('Enabled'), cleanups));
        group.add(this._entryRow(settings, 'openrouter-api-key-env', _('API key env var'), cleanups));
        group.add(this._passwordRow(settings, 'openrouter-api-key', _('API key (inline)'), cleanups));
        group.add(this._vendorIntervalRow(settings, 'openrouter', cleanups));
        page.add(group);
        return page;
    }

    _buildGeminiPage(settings, cleanups) {
        const page = new Adw.PreferencesPage({
            title: _('Gemini'),
            icon_name: 'ai-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: _('Gemini'),
            description: _('Enabled by default; automatically queries usage via the agy CLI or API key.'),
        });
        group.add(this._switchRow(settings, 'gemini-enabled', _('Enabled'), cleanups));
        group.add(this._entryRow(settings, 'gemini-api-key-env', _('API key env var'), cleanups));
        group.add(this._passwordRow(settings, 'gemini-api-key', _('API key (inline)'), cleanups));
        group.add(this._vendorIntervalRow(settings, 'gemini', cleanups));
        page.add(group);
        return page;
    }

    _switchRow(settings, key, title, cleanups) {
        const row = new Adw.SwitchRow({title});
        row.active = settings.get_boolean(key);
        const notifyId = row.connect('notify::active', () => {
            if (settings.get_boolean(key) !== row.active)
                settings.set_boolean(key, row.active);
        });
        const resyncId = settings.connect(`changed::${key}`, () => {
            const v = settings.get_boolean(key);
            if (row.active !== v)
                row.active = v;
        });
        if (cleanups) {
            cleanups.push(() => {
                row.disconnect(notifyId);
                settings.disconnect(resyncId);
            });
        }
        return row;
    }

    _entryRow(settings, key, title, cleanups) {
        const row = new Adw.EntryRow({title});
        row.text = settings.get_string(key);
        const notifyId = row.connect('notify::text', () => {
            if (settings.get_string(key) !== row.text)
                settings.set_string(key, row.text);
        });
        const resyncId = settings.connect(`changed::${key}`, () => {
            const v = settings.get_string(key);
            if (row.text !== v)
                row.text = v;
        });
        if (cleanups) {
            cleanups.push(() => {
                row.disconnect(notifyId);
                settings.disconnect(resyncId);
            });
        }
        return row;
    }

    _colorRow(settings, key, title, defaultHex, cleanups) {
        const row = new Adw.ActionRow({title});

        const dialog = new Gtk.ColorDialog({with_alpha: false});
        const button = new Gtk.ColorDialogButton({dialog, valign: Gtk.Align.CENTER});
        const reset = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Reset to default'),
        });

        let syncing = false;

        const resync = () => {
            const value = settings.get_string(key);
            const rgba = new Gdk.RGBA();
            if (!value || !rgba.parse(value))
                rgba.parse(defaultHex);
            syncing = true;
            button.set_rgba(rgba);
            syncing = false;
            reset.sensitive = value !== '';
        };

        const pickId = button.connect('notify::rgba', () => {
            if (syncing)
                return;
            const {red, green, blue} = button.get_rgba();
            const hex = rgbToHex(red, green, blue);
            if (settings.get_string(key) !== hex)
                settings.set_string(key, hex);
        });
        const resetId = reset.connect('clicked', () => settings.set_string(key, ''));
        const changedId = settings.connect(`changed::${key}`, resync);
        cleanups.push(() => {
            button.disconnect(pickId);
            reset.disconnect(resetId);
            settings.disconnect(changedId);
        });

        resync();
        row.add_suffix(button);
        row.add_suffix(reset);
        return row;
    }

    _passwordRow(settings, key, title, cleanups) {
        const row = new Adw.PasswordEntryRow({title});
        row.text = settings.get_string(key);
        const notifyId = row.connect('notify::text', () => {
            if (settings.get_string(key) !== row.text)
                settings.set_string(key, row.text);
        });
        const resyncId = settings.connect(`changed::${key}`, () => {
            const v = settings.get_string(key);
            if (row.text !== v)
                row.text = v;
        });
        if (cleanups) {
            cleanups.push(() => {
                row.disconnect(notifyId);
                settings.disconnect(resyncId);
            });
        }
        return row;
    }
}
