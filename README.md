# MW Theme Studio

Customize MotiveWave's colors, fonts, and trading panel — all from one app.

![macOS](https://img.shields.io/badge/macOS-arm64-blue) ![Electron](https://img.shields.io/badge/Electron-34-47848F) ![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **6 Built-in Presets** — OLED Black, Stock Dark, Midnight, Charcoal, Purple, Forest
- **Auto Theme Generator** — Pick a base + accent color, get a full 20+ color palette
- **Full Color Control** — Backgrounds, UI elements, menus, charts, candles, DOM, buy/sell buttons
- **CSS Variable Explorer** — Browse and override every CSS variable in MotiveWave's theme
- **Selector Browser** — Edit individual CSS class properties
- **Raw CSS Editor** — Write freeform JavaFX CSS overrides
- **10 Fonts** — Monaco, SF Mono, Menlo, Inter, JetBrains Mono, and more
- **Live Preview** — Interactive mockup updates in real-time; click elements to edit
- **Custom Presets** — Save, load, and manage your own themes
- **Export / Import** — Share themes as `.mwtheme` bundles (includes all settings)
- **Undo / Redo** — Full history with Cmd+Z / Cmd+Shift+Z
- **Built-in Help** — Navigable help system explaining every feature

## Install

### Download

Grab the latest zip from [Releases](../../releases).

### Terminal Install

```bash
cd ~/Downloads
unzip -o MW-Theme-Studio-v4.zip
xattr -cr "MW Theme Studio.app"
mv -f "MW Theme Studio.app" /Applications/
open "/Applications/MW Theme Studio.app"
```

> **Note:** `xattr -cr` is required because the app is not notarized (no Apple Developer account). This removes the quarantine flag so macOS allows it to open.

## First Time Setup

macOS requires **App Management** permission to modify MotiveWave's files:

1. Open **System Settings → Privacy & Security → App Management**
2. Toggle on **MW Theme Studio**
3. Click **Save & Apply** in the app — enter your admin password when prompted

## Usage

1. Pick a **preset** or use the **Auto Theme Generator** as a starting point
2. Tweak colors in the sidebar — the preview updates live
3. Click elements in the **preview** to jump to their settings
4. Click the **⚙** gear to reveal advanced tabs (Variables, Selectors, Raw CSS)
5. Hit **Save & Apply** — restart MotiveWave to see changes

## After Applying

Restart MotiveWave for changes to take effect. The app writes to:
- `/Applications/MotiveWave.app/Contents/styles/dark.css` — color theme
- `/Applications/MotiveWave.app/Contents/styles/ui_theme.css` — font override
- `~/Library/MotiveWave/workspaces/*/config/` — chart, trading, and DOM colors

## Build from Source

```bash
git clone https://github.com/vbmm/mw-theme-studio.git
cd mw-theme-studio
npm install
npm start        # Run in dev mode
npm run pack     # Build .app (output in dist/)
```

## Uninstall

```bash
trash "/Applications/MW Theme Studio.app"
```

To restore the original MW theme, use the **Restore** button before uninstalling, or manually:
```bash
cp ~/.mw-theme-backup/dark.css.backup "/Applications/MotiveWave.app/Contents/styles/dark.css"
cp ~/.mw-theme-backup/ui_theme.css.backup "/Applications/MotiveWave.app/Contents/styles/ui_theme.css"
```

## Requirements

- macOS (Apple Silicon)
- [MotiveWave](https://www.motivewave.com/) installed at `/Applications/MotiveWave.app`

## License

MIT
