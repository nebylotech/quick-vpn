import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

const SHELL_VERSION = Number.parseInt(Config.PACKAGE_VERSION.split('.')[0], 10);

function getMihomoPath(storePath) {
    const candidates = [
        `${GLib.get_home_dir()}/.local/share/quick-vpn/bin/mihomo`,
        '/usr/local/bin/mihomo',
        '/usr/bin/mihomo',
        `${storePath}/bin/mihomo`,
    ];
    for (const c of candidates) {
        if (GLib.file_test(c, GLib.FileTest.IS_EXECUTABLE)) return c;
    }
    const inPath = GLib.find_program_in_path('mihomo');
    if (inPath) return inPath;
    const metaInPath = GLib.find_program_in_path('clash-meta');
    if (metaInPath) return metaInPath;
    return null;
}

function boxOrientation(isVertical = true) {
    if (SHELL_VERSION >= 51) {
        return {
            orientation: isVertical
                ? Clutter.Orientation.VERTICAL
                : Clutter.Orientation.HORIZONTAL,
        };
    }
    return { vertical: isVertical };
}

function bytesToGB(bytes) {
    if (!bytes) return '0.0';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

function formatDate(ts) {
    if (!ts) return '∞';
    return new Date(ts).toLocaleDateString();
}

function decodeNodeName(text) {
    if (!text) return '';
    try {
        return decodeURIComponent(text).trim();
    } catch {
        return text.trim();
    }
}

function extractConfigUrl(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('flclashx://install-config?url=')) {
        try {
            const uri = GLib.Uri.parse(trimmed, GLib.UriFlags.NONE);
            const query = uri.get_query();
            if (query) {
                const params = GLib.Uri.parse_params(query, -1, '&', GLib.UriParamsFlags.NONE);
                const configUrl = params.url;
                if (configUrl) return configUrl;
            }
        } catch {}
    }
    if (trimmed.startsWith('happ://add/')) {
        return trimmed.slice('happ://add/'.length);
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return trimmed;
    }
    return null;
}

function logCrash(storePath, message, stderr) {
    if (!storePath) return;
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const logFile = `${storePath}/crash.log`;
    let entry = `[${ts}] ${message}`;
    if (stderr) entry += `\n  stderr: ${stderr}`;
    entry += '\n';
    console.log(entry.trim());
    try {
        const [ok, data] = GLib.file_get_contents(logFile);
        let existing = '';
        if (ok && data) {
            existing = typeof data === 'string' ? data : new TextDecoder().decode(data);
        }
        if (existing.length > 100000) {
            existing = existing.substring(existing.length - 100000);
        }
        GLib.file_set_contents(logFile, existing + entry);
    } catch {}
}

function getDeviceHwid(storePath) {
    const hwidFile = `${storePath}/.hwid`;
    try {
        const [ok, data] = GLib.file_get_contents(hwidFile);
        if (ok && data) {
            const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
            const trimmed = str.trim();
            if (trimmed) return trimmed;
        }
    } catch {}
    const hwid = Array.from({ length: 16 }, () =>
        '0123456789ABCDEF'[Math.floor(Math.random() * 16)]
    ).join('');
    try {
        GLib.file_set_contents(hwidFile, hwid);
    } catch {}
    return hwid;
}

function pingHost(host) {
    return new Promise((resolve) => {
        try {
            const proc = Gio.Subprocess.new(
                ['ping', '-c', '1', '-W', '2', host],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    const [, stdout] = proc.communicate_utf8_finish(res);
                    const match = stdout.match(/time=(\d+\.?\d*)\s*ms/);
                    resolve(match ? Math.round(parseFloat(match[1])) : null);
                } catch {
                    resolve(null);
                }
            });
        } catch {
            resolve(null);
        }
    });
}

const QuickVpnButton = GObject.registerClass(
class QuickVpnButton extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Quick VPN'));
        this._extension = extension;
        this._storePath = extension.path;

        this._profiles = [];
        this._activeProfileId = null;
        this._isConnected = false;
        this._isFetching = false;
        this._isInstallingCore = false;
        this._nodePingLabels = new Map();
        this._nodeItems = [];
        this._signals = [];
        this._timeouts = [];

        // Top bar widget
        this._box = new St.BoxLayout({ style_class: 'panel-status-indicators-box' });
        this._icon = new St.Icon({
            gicon: Gio.FileIcon.new(Gio.File.new_for_path(`${extension.path}/icons/quickvpn-symbolic.svg`)),
            style_class: 'system-status-icon',
        });
        this._box.add_child(this._icon);

        this._panelLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
            style: 'margin-left: 5px; font-weight: bold; font-size: 11px;',
        });
        this._box.add_child(this._panelLabel);
        this.add_child(this._box);

        this.menu.box.add_style_class_name('quickvpn-menu');

        this._loadProfiles();
        this._buildUi();
    }

    _loadProfiles() {
        try {
            const [ok, contents] = GLib.file_get_contents(`${this._storePath}/profiles.json`);
            if (ok && contents) {
                const str = typeof contents === 'string' ? contents : new TextDecoder().decode(contents);
                const profiles = JSON.parse(str);
                for (const p of profiles) {
                    if (p.selectedNode) p.selectedNode = decodeNodeName(p.selectedNode);
                    if (p.nodes) {
                        for (const n of p.nodes) {
                            n.name = decodeNodeName(n.name);
                        }
                    }
                }
                this._profiles = profiles;
                return;
            }
        } catch (e) {
            logCrash(this._storePath, `Load error: ${e}`);
        }
        this._profiles = [];
    }

    _saveProfiles() {
        try {
            GLib.file_set_contents(
                `${this._storePath}/profiles.json`,
                JSON.stringify(this._profiles, null, 2)
            );
        } catch (e) {
            logCrash(this._storePath, `Save error: ${e}`);
        }
    }

    _connectSignal(actor, signal, callback) {
        const id = actor.connect(signal, callback);
        this._signals.push({ actor, id });
        return id;
    }

    _addTimeout(interval, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            this._timeouts = this._timeouts.filter(t => t !== id);
            return callback();
        });
        this._timeouts.push(id);
        return id;
    }

    destroy() {
        for (const { actor, id } of this._signals) {
            try {
                actor.disconnect(id);
            } catch {}
        }
        this._signals = [];
        for (const id of this._timeouts) {
            try {
                GLib.Source.remove(id);
            } catch {}
        }
        this._timeouts = [];
        super.destroy();
    }

    _downloadAndInstallCore(downloadBtn, progressBox, progressText, percentLabel, progressTrack, progressFill, statusLabel) {
        if (this._isInstallingCore) return;
        this._isInstallingCore = true;

        const updateProgress = (pct, msg) => {
            if (percentLabel) percentLabel.text = `${pct}%`;
            if (progressText && msg) progressText.text = msg;
            if (progressTrack && progressFill) {
                const totalWidth = progressTrack.get_width() > 50 ? progressTrack.get_width() : 300;
                const targetWidth = Math.max(12, Math.round((totalWidth * pct) / 100));
                try {
                    progressFill.ease({
                        width: targetWidth,
                        duration: 250,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                } catch {
                    progressFill.width = targetWidth;
                }
            }
        };

        updateProgress(2, _('Подключение к GitHub...'));

        const scriptPath = `${this._storePath}/mihomo_helper.py`;
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['python3', scriptPath, this._storePath, 'install_core'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (e) {
            this._isInstallingCore = false;
            downloadBtn.visible = true;
            progressBox.visible = false;
            logCrash(this._storePath, `Subprocess launch error: ${e}`);
            return;
        }

        const stdoutPipe = proc.get_stdout_pipe();
        const stdoutStream = new Gio.DataInputStream({ base_stream: stdoutPipe });

        const readLine = () => {
            stdoutStream.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
                try {
                    const [line] = stream.read_line_finish_utf8(res);
                    if (line !== null) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('PROGRESS:')) {
                            const parts = trimmed.split(':');
                            const pct = parseInt(parts[1], 10);
                            const msg = parts.slice(2).join(':');
                            updateProgress(pct, msg);
                        }
                        readLine();
                    }
                } catch {}
            });
        };
        readLine();

        proc.wait_check_async(null, (proc, res) => {
            this._isInstallingCore = false;
            try {
                proc.wait_check_finish(res);
                updateProgress(100, _('Ядро успешно установлено!'));
                Main.notify(_('Quick VPN'), _('✅ Ядро Mihomo успешно установлено!'));
                this._addTimeout(800, () => {
                    this._buildUi();
                    return GLib.SOURCE_REMOVE;
                });
            } catch (e) {
                downloadBtn.visible = true;
                progressBox.visible = false;
                downloadBtn.reactive = true;
                downloadBtn.label = _('❌ Ошибка установки. Повторить?');
                if (statusLabel) {
                    statusLabel.text = `Ошибка установки ядра: ${e.message || e}`;
                }
                logCrash(this._storePath, `Install core failed: ${e}`);
            }
        });
    }

    _buildUi() {
        this.menu.removeAll();
        this._nodePingLabels.clear();
        this._nodeItems = [];

        const mihomoPath = getMihomoPath(this._storePath);

        // 1. Header Card with Quick Toggle
        const headerCard = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        headerCard.add_style_class_name('quickvpn-card');

        const headerBox = new St.BoxLayout({ ...boxOrientation(false), x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        
        const titleBox = new St.BoxLayout({ ...boxOrientation(true), x_expand: true });
        const appTitle = new St.Label({
            text: _('Quick VPN'),
            style_class: 'quickvpn-title',
        });
        titleBox.add_child(appTitle);

        let statusText = this._isConnected ? _('● Подключено') : _('○ Отключено');
        let statusClass = this._isConnected ? 'quickvpn-badge-connected' : 'quickvpn-badge-disconnected';
        if (!mihomoPath) {
            statusText = _('⚠️ Ядро не найдено');
            statusClass = 'quickvpn-badge-warning';
        }

        this._statusBadge = new St.Label({
            text: statusText,
            style_class: statusClass,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleBox.add_child(this._statusBadge);
        headerBox.add_child(titleBox);

        // Power Switch
        this._switch = new PopupMenu.Switch(this._isConnected && !!mihomoPath);
        this._switch.reactive = !!mihomoPath;
        this._connectSignal(this._switch, 'notify::state', () => {
            if (this._switch.state) {
                this._connectActive();
            } else {
                this._disconnect();
            }
        });
        headerBox.add_child(this._switch);

        headerCard.add_child(headerBox);
        this.menu.addMenuItem(headerCard);

        // Missing Core Card (if Mihomo is not yet downloaded)
        if (!mihomoPath) {
            const coreCard = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
            coreCard.add_style_class_name('quickvpn-card');
            coreCard.style = 'background-color: rgba(220, 165, 0, 0.12); border: 1px solid rgba(220, 165, 0, 0.35); border-radius: 12px; margin: 6px; padding: 12px;';

            const coreBox = new St.BoxLayout({ ...boxOrientation(true), x_expand: true });

            const coreHeader = new St.Label({
                text: _('⚙️ Требуется ядро Mihomo'),
                style: 'font-weight: 800; font-size: 13px; color: #f6d32d; margin-bottom: 4px;',
            });
            coreBox.add_child(coreHeader);

            const coreDesc = new St.Label({
                text: _('Для работы VPN требуется ядро Mihomo (Clash.Meta). Чтобы соответствовать правилам каталога GNOME Extensions, бинарник не поставляется внутри архива.\nНажмите кнопку ниже, чтобы установить его автоматически в ~/.local/share/quick-vpn/bin/'),
                style: 'font-size: 11px; color: #deddda; margin-bottom: 10px;',
            });
            coreDesc.clutter_text.set_line_wrap(true);
            coreBox.add_child(coreDesc);

            const downloadBtn = new St.Button({
                label: this._isInstallingCore ? _('⏳ Установка ядра...') : _('📥 Скачать и установить ядро автоматически'),
                style_class: 'quickvpn-action-btn',
                style: 'background-color: #3584e4; color: white; font-weight: bold; padding: 8px 12px; border-radius: 8px; text-align: center;',
                can_focus: !this._isInstallingCore,
                reactive: !this._isInstallingCore,
                visible: !this._isInstallingCore,
            });

            // Animated Progress Bar Container
            const progressBox = new St.BoxLayout({ ...boxOrientation(true), x_expand: true, visible: this._isInstallingCore, style: 'margin-top: 6px;' });

            const progressHeader = new St.BoxLayout({ ...boxOrientation(false), x_expand: true });
            const progressText = new St.Label({
                text: _('Подготовка...'),
                style: 'font-size: 11px; font-weight: 600; color: #deddda;',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            progressHeader.add_child(progressText);

            const percentLabel = new St.Label({
                text: '0%',
                style: 'font-size: 11px; font-weight: 800; color: #3584e4;',
                y_align: Clutter.ActorAlign.CENTER,
            });
            progressHeader.add_child(percentLabel);
            progressBox.add_child(progressHeader);

            // Track & Fill bar
            const progressTrack = new St.Bin({
                style_class: 'quickvpn-progress-track',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const progressFill = new St.Bin({
                style_class: 'quickvpn-progress-fill',
                x_align: Clutter.ActorAlign.START,
            });
            progressFill.width = 12;
            progressTrack.set_child(progressFill);
            progressBox.add_child(progressTrack);

            this._connectSignal(downloadBtn, 'clicked', () => {
                downloadBtn.visible = false;
                progressBox.visible = true;
                this._downloadAndInstallCore(downloadBtn, progressBox, progressText, percentLabel, progressTrack, progressFill, coreDesc);
            });
            coreBox.add_child(downloadBtn);
            coreBox.add_child(progressBox);

            coreCard.add_child(coreBox);
            this.menu.addMenuItem(coreCard);
        }

        if (this._profiles.length === 0) {
            const emptyItem = new PopupMenu.PopupMenuItem(_('Нет добавленных подписок'), { reactive: false });
            emptyItem.style = 'text-align: center; color: #9a9996; padding: 16px 0;';
            this.menu.addMenuItem(emptyItem);
            this._buildAddSection();
            return;
        }

        const activeProfile = this._profiles.find(p => p.id === this._activeProfileId) || this._profiles[0];
        if (!this._activeProfileId) this._activeProfileId = activeProfile.id;

        // Multi-Profile Switcher (if multiple subscriptions exist)
        if (this._profiles.length > 1) {
            const selectorItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
            selectorItem.style = 'padding: 4px 6px;';
            const selectorBox = new St.BoxLayout({ ...boxOrientation(false), x_expand: true });

            for (const p of this._profiles) {
                const isSelected = p.id === activeProfile.id;
                const pBtn = new St.Button({
                    label: p.label || _('Подписка'),
                    style_class: 'quickvpn-badge',
                    style: `margin-right: 6px; padding: 4px 10px; border-radius: 8px; ${isSelected ? 'background-color: #3584e4; color: white; font-weight: bold;' : 'color: #deddda;'}`,
                    can_focus: true,
                });
                this._connectSignal(pBtn, 'clicked', () => {
                    this._activeProfileId = p.id;
                    this._buildUi();
                });
                selectorBox.add_child(pBtn);
            }
            selectorItem.add_child(selectorBox);
            this.menu.addMenuItem(selectorItem);
        }

        // 2. Profile Card (Adwaita Card style)
        const profileCard = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        profileCard.add_style_class_name('quickvpn-card');

        const profileBox = new St.BoxLayout({ ...boxOrientation(true), x_expand: true });
        
        // Profile Name Row
        const profileTop = new St.BoxLayout({ ...boxOrientation(false), x_expand: true });
        const profileName = new St.Label({
            text: activeProfile.label || _('Подписка'),
            style: 'font-weight: 800; font-size: 13px;',
            x_expand: true,
        });
        profileTop.add_child(profileName);

        const nodesCountBadge = new St.Label({
            text: `${activeProfile.nodes?.length || 0} серверов`,
            style_class: 'quickvpn-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });
        profileTop.add_child(nodesCountBadge);
        profileBox.add_child(profileTop);

        // Traffic & Expiry Badges Row
        const statsRow = new St.BoxLayout({ ...boxOrientation(false), style: 'margin-top: 6px;' });
        const usedGB = bytesToGB((activeProfile.upload || 0) + (activeProfile.download || 0));
        const totalGB = bytesToGB(activeProfile.total || 0);
        const trafficText = activeProfile.total ? `${usedGB} / ${totalGB} GB` : `${usedGB} GB`;

        const trafficBadge = new St.Label({
            text: `📊 ${trafficText}`,
            style_class: 'quickvpn-badge',
            style: 'margin-right: 6px;',
        });
        statsRow.add_child(trafficBadge);

        const expireDateStr = formatDate(activeProfile.expire);
        const expireBadge = new St.Label({
            text: `⏳ до ${expireDateStr}`,
            style_class: 'quickvpn-badge',
        });
        statsRow.add_child(expireBadge);

        profileBox.add_child(statsRow);
        profileCard.add_child(profileBox);
        this.menu.addMenuItem(profileCard);

        // 3. Search Bar & Ping Action Header
        const controlsItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        controlsItem.style = 'padding: 4px 6px;';
        const controlsBox = new St.BoxLayout({ ...boxOrientation(false), x_expand: true });

        const searchEntry = new St.Entry({
            hint_text: _('🔍 Поиск сервера...'),
            can_focus: true,
            x_expand: true,
            style_class: 'quickvpn-search-entry',
            style: 'margin-right: 8px;',
        });
        this._connectSignal(searchEntry.clutter_text, 'text-changed', () => {
            const query = searchEntry.get_text().toLowerCase().trim();
            for (const item of this._nodeItems) {
                const match = !query || item._nodeName.toLowerCase().includes(query);
                item.actor.visible = match;
            }
        });
        controlsBox.add_child(searchEntry);

        const pingBtn = new St.Button({
            label: _('⚡ Пинг'),
            style_class: 'quickvpn-action-btn',
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
        });
        this._connectSignal(pingBtn, 'clicked', () => this._runLivePing(activeProfile, pingBtn));
        controlsBox.add_child(pingBtn);

        controlsItem.add_child(controlsBox);
        this.menu.addMenuItem(controlsItem);

        // 4. Scrollable Nodes List
        const scrollSection = new PopupMenu.PopupMenuSection();
        const scrollView = new St.ScrollView({
            style_class: 'quickvpn-nodes-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        const nodesContainer = new PopupMenu.PopupMenuSection();
        scrollView.add_child(nodesContainer.actor);
        scrollSection.actor.add_child(scrollView);
        this.menu.addMenuItem(scrollSection);

        const currentSelected = decodeNodeName(activeProfile.selectedNode);

        for (const node of (activeProfile.nodes || [])) {
            const cleanName = decodeNodeName(node.name);
            const isSelected = cleanName === currentSelected || node.name === activeProfile.selectedNode;

            const nodeItem = new PopupMenu.PopupBaseMenuItem({
                style_class: `quickvpn-node-row ${isSelected ? 'quickvpn-node-selected' : ''}`,
            });
            nodeItem._nodeName = cleanName;

            const rowBox = new St.BoxLayout({ ...boxOrientation(false), x_expand: true, y_align: Clutter.ActorAlign.CENTER });

            // Radio bullet / dot
            const radioLabel = new St.Label({
                text: isSelected ? '●' : '○',
                style: `margin-right: 8px; font-size: 13px; color: ${isSelected ? '#3584e4' : '#9a9996'};`,
            });
            rowBox.add_child(radioLabel);

            // Server Flag + Name
            const nameLabel = new St.Label({
                text: cleanName,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-weight: 600; font-size: 12px;',
            });
            rowBox.add_child(nameLabel);

            // Protocol Badge
            if (node.type) {
                const protoBadge = new St.Label({
                    text: node.type.toUpperCase(),
                    style_class: 'quickvpn-type-badge',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                rowBox.add_child(protoBadge);
            }

            // Inline Live Ping Label!
            const pingLabel = new St.Label({
                text: '—',
                style_class: 'quickvpn-badge',
                style: 'min-width: 42px; text-align: right;',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._nodePingLabels.set(cleanName, pingLabel);
            rowBox.add_child(pingLabel);

            nodeItem.add_child(rowBox);

            nodeItem.connect('activate', () => {
                activeProfile.selectedNode = cleanName;
                this._saveProfiles();
                if (this._isConnected) {
                    this._extension.callMihomo('switch', activeProfile.id, cleanName);
                    this._updateStatusUi(activeProfile);
                } else {
                    this._connectActive();
                }
                this._buildUi();
            });

            this._nodeItems.push(nodeItem);
            nodesContainer.addMenuItem(nodeItem);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 5. Actions: Remove profile / Add subscription
        const footerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const footerBox = new St.BoxLayout({ ...boxOrientation(false), x_expand: true });

        const removeBtn = new St.Button({
            label: _('🗑 Удалить профиль'),
            style_class: 'quickvpn-action-btn',
            style: 'color: #e01b24; margin-right: 8px;',
            can_focus: true,
        });
        this._connectSignal(removeBtn, 'clicked', () => {
            this._removeProfile(activeProfile);
        });
        footerBox.add_child(removeBtn);

        footerItem.add_child(footerBox);
        this.menu.addMenuItem(footerItem);

        this._buildAddSection();
    }

    _buildAddSection() {
        const addSection = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        addSection.style = 'padding: 6px;';
        const addBox = new St.BoxLayout({ ...boxOrientation(false), x_expand: true });

        const urlEntry = new St.Entry({
            hint_text: _('Вставьте ссылку подписки...'),
            can_focus: true,
            x_expand: true,
            style_class: 'quickvpn-search-entry',
            style: 'margin-right: 6px;',
        });
        addBox.add_child(urlEntry);

        const addBtn = new St.Button({
            label: _('➕ Добавить'),
            style_class: 'quickvpn-action-btn',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._connectSignal(addBtn, 'clicked', () => {
            const text = urlEntry.get_text().trim();
            if (!text) return;
            const configUrl = extractConfigUrl(text);
            if (!configUrl) {
                Main.notify(_('Quick VPN'), _('Некорректная ссылка подписки'));
                return;
            }
            this._fetchAndAddProfile(configUrl);
            urlEntry.set_text('');
        });
        addBox.add_child(addBtn);

        addSection.add_child(addBox);
        this.menu.addMenuItem(addSection);
    }

    _runLivePing(profile, pingBtn) {
        if (!profile.nodes || profile.nodes.length === 0) return;
        pingBtn.set_label(_('⏳...'));

        const promises = profile.nodes.map(async (n) => {
            const cleanName = decodeNodeName(n.name);
            const pingLabel = this._nodePingLabels.get(cleanName);
            if (pingLabel) pingLabel.text = '...';

            const ms = await pingHost(n.server);
            if (pingLabel) {
                if (ms !== null) {
                    pingLabel.text = `${ms} ms`;
                    if (ms < 100) pingLabel.style_class = 'quickvpn-ping-good';
                    else if (ms < 200) pingLabel.style_class = 'quickvpn-ping-med';
                    else pingLabel.style_class = 'quickvpn-ping-bad';
                } else {
                    pingLabel.text = '✗';
                    pingLabel.style_class = 'quickvpn-ping-bad';
                }
            }
            return { cleanName, ms };
        });

        Promise.all(promises).then(() => {
            pingBtn.set_label(_('⚡ Пинг'));
        });
    }

    _connectActive() {
        const activeProfile = this._profiles.find(p => p.id === this._activeProfileId) || this._profiles[0];
        if (!activeProfile) return;

        if (!activeProfile.selectedNode && activeProfile.nodes?.length) {
            activeProfile.selectedNode = decodeNodeName(activeProfile.nodes[0].name);
            this._saveProfiles();
        }

        this._isConnected = true;
        this._switch.setToggleState(true);
        this._extension.callMihomo('start', activeProfile.id);
        this._extension.enableProxy();
        this._updateStatusUi(activeProfile);
    }

    _disconnect() {
        this._isConnected = false;
        this._switch.setToggleState(false);
        this._extension.callMihomo('stop');
        this._extension.disableProxy();
        this._updateStatusUi(null);
    }

    _updateStatusUi(profile) {
        if (this._isConnected && profile) {
            const nodeName = decodeNodeName(profile.selectedNode || '');
            this._statusBadge.text = `● ${nodeName}`;
            this._statusBadge.style_class = 'quickvpn-badge-connected';
            this._panelLabel.text = nodeName.substring(0, 16);
            this._panelLabel.visible = true;
        } else {
            this._statusBadge.text = _('○ Отключено');
            this._statusBadge.style_class = 'quickvpn-badge-disconnected';
            this._panelLabel.text = '';
            this._panelLabel.visible = false;
        }
    }

    _removeProfile(profile) {
        if (this._activeProfileId === profile.id && this._isConnected) {
            this._disconnect();
        }
        this._profiles = this._profiles.filter(p => p.id !== profile.id);
        this._activeProfileId = this._profiles.length > 0 ? this._profiles[0].id : null;
        this._saveProfiles();
        this._buildUi();
    }

    _fetchAndAddProfile(url) {
        if (this._isFetching) return;
        this._isFetching = true;
        Main.notify(_('Quick VPN'), _('Загрузка подписки...'));

        const hwid = getDeviceHwid(this._storePath);
        const args = [
            'curl', '-s', '-L', '-f', '-D', '-',
            '-H', `user-agent: FlClash X/v1.19.25 Platform/Linux`,
            '-H', `x-hwid: ${hwid}`,
            '-H', 'x-device-os: Linux',
            '-H', 'x-ver-os: 6.8',
            '-H', 'x-device-model: Arch Linux',
            url,
        ];

        try {
            const proc = Gio.Subprocess.new(args, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (proc, res) => {
                this._isFetching = false;
                try {
                    const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                    if (!proc.get_successful()) {
                        Main.notify(_('Quick VPN'), `Ошибка загрузки: ${(stderr || '').trim()}`);
                        return;
                    }

                    const output = stdout || '';
                    const idx = output.lastIndexOf('\r\n\r\n');
                    const headerSection = idx !== -1 ? output.substring(0, idx) : '';
                    const body = idx !== -1 ? output.substring(idx + 4) : output;

                    let subInfoRaw = '';
                    let profileTitleRaw = '';
                    for (const line of headerSection.split('\r\n')) {
                        const lline = line.toLowerCase();
                        if (lline.startsWith('subscription-userinfo:')) {
                            subInfoRaw = line.substring('subscription-userinfo:'.length).trim();
                        } else if (lline.startsWith('profile-title:')) {
                            profileTitleRaw = line.substring('profile-title:'.length).trim();
                        }
                    }

                    this._processConfig(url, body, subInfoRaw, profileTitleRaw);
                } catch (e) {
                    logCrash(this._storePath, `Download callback error: ${e}`);
                    Main.notify(_('Quick VPN'), _('Ошибка при разборе ответа'));
                }
            });
        } catch (e) {
            this._isFetching = false;
            logCrash(this._storePath, `Curl error: ${e}`);
            Main.notify(_('Quick VPN'), _('Не удалось запустить curl'));
        }
    }

    _processConfig(url, body, subInfoRaw, profileTitleRaw) {
        const tmpFile = `${this._storePath}/tmp_config_${Date.now()}`;
        try {
            GLib.file_set_contents(tmpFile, body);
            const script = `${this._storePath}/parse_config.py`;
            const proc = Gio.Subprocess.new(
                ['python3', script, tmpFile, subInfoRaw || '', profileTitleRaw || ''],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            proc.communicate_utf8_async(null, null, (proc, res) => {
                let stdout = '';
                try {
                    const [, out] = proc.communicate_utf8_finish(res);
                    stdout = out;
                    const result = JSON.parse(stdout);
                    const id = String(Date.now());
                    const label = result.label || 'VPN Profile';

                    const profile = {
                        id,
                        label,
                        url,
                        upload: result.upload || 0,
                        download: result.download || 0,
                        total: result.total || 0,
                        expire: result.expire || 0,
                        nodes: (result.proxies || []).map(n => ({
                            ...n,
                            name: decodeNodeName(n.name),
                        })),
                        selectedNode: result.proxies?.[0] ? decodeNodeName(result.proxies[0].name) : '',
                    };

                    this._profiles.push(profile);
                    this._activeProfileId = id;
                    this._saveConfig(id, body);
                    this._saveProfiles();
                    this._buildUi();

                    Main.notify(_('Quick VPN'), `Добавлено: ${label} (${profile.nodes.length} серверов)`);
                } catch (e) {
                    logCrash(this._storePath, `Parse error: ${e}\nstdout: ${stdout}`);
                    Main.notify(_('Quick VPN'), _('Ошибка разбора конфига'));
                } finally {
                    GLib.remove(tmpFile);
                }
            });
        } catch (e) {
            logCrash(this._storePath, `File error: ${e}`);
            Main.notify(_('Quick VPN'), _('Ошибка сохранения конфига'));
        }
    }

    _saveConfig(profileId, body) {
        try {
            const configDir = `${this._storePath}/configs`;
            GLib.mkdir_with_parents(configDir, 0o755);
            GLib.file_set_contents(`${configDir}/${profileId}.yaml`, body);
        } catch (e) {
            logCrash(this._storePath, `Save config error: ${e}`);
        }
    }
});

export default class QuickVpnExtension extends Extension {
    callMihomo(action, profileId, nodeName) {
        const scriptPath = `${this.path}/mihomo_helper.py`;
        const args = ['python3', scriptPath, this.path, action];
        if (profileId) args.push(profileId);
        if (nodeName) args.push(nodeName);

        try {
            const proc = Gio.Subprocess.new(args, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                    if (stdout?.trim()) logCrash(this.path, `mihomo: ${stdout.trim()}`);
                    if (!proc.get_successful() && stderr?.trim()) {
                        logCrash(this.path, `mihomo error: ${stderr.trim()}`);
                    }
                } catch (e) {
                    logCrash(this.path, `mihomo callback error: ${e}`);
                }
            });
        } catch (e) {
            logCrash(this.path, `Failed to run mihomo: ${e}`);
        }
    }

    _saveProxyState() {
        const s = new Gio.Settings({ schema_id: 'org.gnome.system.proxy' });
        this._savedProxyMode = s.get_string('mode');
        this._savedProxySame = s.get_boolean('use-same-proxy');
        this._savedHttpHost = s.get_string('http-host');
        this._savedHttpPort = s.get_int('http-port');
        this._savedHttpsHost = s.get_string('https-host');
        this._savedHttpsPort = s.get_int('https-port');
        this._savedSocksHost = s.get_string('socks-host');
        this._savedSocksPort = s.get_int('socks-port');
    }

    enableProxy() {
        this._saveProxyState();
        const s = new Gio.Settings({ schema_id: 'org.gnome.system.proxy' });
        s.set_boolean('use-same-proxy', false);
        s.set_string('mode', 'manual');
        s.set_string('http-host', '127.0.0.1');
        s.set_int('http-port', 7890);
        s.set_string('https-host', '127.0.0.1');
        s.set_int('https-port', 7890);
        s.set_string('socks-host', '127.0.0.1');
        s.set_int('socks-port', 7891);
        this._proxyEnabled = true;
    }

    disableProxy() {
        if (!this._proxyEnabled) return;
        this._proxyEnabled = false;
        const s = new Gio.Settings({ schema_id: 'org.gnome.system.proxy' });
        s.set_boolean('use-same-proxy', this._savedProxySame ?? true);
        s.set_string('mode', this._savedProxyMode || 'none');
        s.set_string('http-host', this._savedHttpHost || '');
        s.set_int('http-port', this._savedHttpPort ?? 0);
        s.set_string('https-host', this._savedHttpsHost || '');
        s.set_int('https-port', this._savedHttpsPort ?? 0);
        s.set_string('socks-host', this._savedSocksHost || '');
        s.set_int('socks-port', this._savedSocksPort ?? 0);
    }

    enable() {
        this._proxyEnabled = false;

        try {
            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            const stylesheetFile = Gio.File.new_for_path(`${this.path}/stylesheet.css`);
            this._stylesheetId = themeContext.get_theme().load_stylesheet(stylesheetFile);
        } catch (e) {
            console.log(`Quick VPN: stylesheet load error: ${e}`);
        }

        // Add standalone indicator button directly to top panel status area!
        this._button = new QuickVpnButton(this);
        Main.panel.addToStatusArea('quick-vpn', this._button);
    }

    disable() {
        this.callMihomo('stop');
        this.disableProxy();

        if (this._button) {
            this._button.destroy();
            this._button = null;
        }

        if (this._stylesheetId != null) {
            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            themeContext.get_theme().unload_stylesheet(this._stylesheetId);
            this._stylesheetId = null;
        }
    }
}
