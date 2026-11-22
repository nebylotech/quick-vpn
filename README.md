# Quick VPN

Manage VPN subscriptions from GNOME quick settings panel.

## Features

- Add VPN subscriptions via URL (supports Clash/mihomo format)
- Supports **FlClashX** (`flclashx://install-config?url=...`) and **HAPP** (`happ://add/...`) links
- Browse and switch between proxy nodes
- Ping test for all nodes
- Auto-enables system proxy (HTTP/SOCKS) on connect
- Restores original proxy settings on disconnect
- Traffic usage and expiration info

## Requirements

- GNOME Shell 50, 51
- Python 3
- Mihomo core (can be installed with 1-click directly from the extension menu, or via `python3 mihomo_helper.py . install_core` or system package `mihomo`)

## Installation

```bash
git clone https://github.com/nebylotech/quick-vpn.git
cp -r quick-vpn ~/.local/share/gnome-shell/extensions/quick-vpn@nolune
gnome-extensions enable quick-vpn@nolune
```

If Mihomo core is not installed on your system, open the Quick VPN menu in the top bar and click **"Скачать и установить ядро автоматически"**.

Restart GNOME Shell or log out and log back in, then enable the extension:
```bash
gnome-extensions enable quick-vpn@nolune
```

## License

GNU General Public License v2.0
