const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { exec, spawn } = require('child_process');
const os = require('os');

const MW_STYLES = '/Applications/MotiveWave.app/Contents/styles';
const MW_USER = path.join(process.env.HOME, 'Library/MotiveWave');
const MW_SETTINGS = path.join(MW_USER, 'settings.json');
const MW_WORKSPACES = path.join(MW_USER, 'workspaces');
const PRESETS_DIR = path.join(process.env.HOME, '.mw-theme-studio');
const PRESETS_FILE = path.join(PRESETS_DIR, 'presets.json');
const GITHUB_REPO = 'vbmm/mw-theme-studio';
const CURRENT_VERSION = app.getVersion();

// ==================== HELPERS ====================

function getActiveWorkspace() {
  try {
    const dirs = fs.readdirSync(MW_WORKSPACES).filter(d => {
      try { return fs.statSync(path.join(MW_WORKSPACES, d)).isDirectory(); }
      catch { return false; }
    });
    return dirs[0] || 'default';
  } catch { return 'default'; }
}

function getWorkspaceConfigPath() {
  return path.join(MW_WORKSPACES, getActiveWorkspace(), 'config', 'config.json');
}

function getWorkspaceDefaultsPath() {
  return path.join(MW_WORKSPACES, getActiveWorkspace(), 'config', 'defaults.json');
}

function rgbStrToHex(str) {
  if (!str) return '#000000';
  const p = str.split(',').map(s => parseInt(s.trim()));
  return '#' + p.slice(0, 3).map(n => Math.min(255, Math.max(0, n || 0)).toString(16).padStart(2, '0')).join('');
}

function hexToRgbStr(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return alpha !== undefined ? `${r},${g},${b},${alpha}` : `${r},${g},${b}`;
}

// CSS variable name → our color ID
const cssToId = {
  'main': 'main', 'secondary': 'secondary',
  'fx-control-inner-background': 'controlInner', 'chooser-bg': 'chooserBg',
  'mw-popup-pane-bg': 'popupBg', 'mw-popup-pane-title-bg': 'popupTitleBg',
  'mw-status-bar-bg': 'statusBar', 'mw-chart-split-pane-divider': 'divider',
  'mw-active-station': 'activeStation', 'mw-highlight': 'highlight',
  'mw-tab-selected': 'tabSelected', 'mw-tab-hover': 'tabHover',
  'mw-context-menu-bg': 'menuBg', 'mw-menu-item-bg': 'menuItemBg',
  'mw-menu-item-separator': 'menuSeparator', 'mw-context-menu-accent': 'menuAccent',
  'fx-spinner-border': 'spinnerBorder', 'toggle-btn-selected': 'toggleSelected',
  'hover-base': 'hoverBase', 'btn-pressed': 'btnPressed'
};

// ==================== PRIVILEGED WRITE ====================
// macOS TCC blocks writing inside app bundles even with sudo/root.
// Strategy: try osascript first (works when no TCC), then fall back to Terminal.

function runPrivileged(scriptPath) {
  return new Promise((resolve) => {
    // Attempt 1: osascript with administrator privileges
    const oscmd = `osascript -e 'do shell script "bash ${scriptPath}" with administrator privileges'`;
    exec(oscmd, { timeout: 30000 }, (err, stdout) => {
      if (!err) return resolve({ ok: true });

      const msg = (err.message || '') + (stdout || '');
      const isTCC = msg.includes('Operation not permitted');
      const isCancelled = msg.includes('User canceled') || msg.includes('-128');

      if (isCancelled) return resolve({ ok: false, error: 'Cancelled by user.' });

      if (isTCC) {
        // TCC blocked it — show dialog with options
        const win = BrowserWindow.getFocusedWindow();
        dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Permission Required',
          message: 'macOS blocked this action.',
          detail: 'macOS requires App Management permission to modify app files.\n\n' +
            'Option 1: Click "Open Settings" → toggle on MW Theme Studio (or Terminal)\n' +
            'Option 2: Click "Use Terminal" to run the command manually\n\n' +
            'This is a one-time setup.',
          buttons: ['Open Settings', 'Use Terminal', 'Cancel'],
          defaultId: 0
        }).then(({ response }) => {
          if (response === 0) {
            exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_AppManagement"');
            resolve({ ok: false, error: 'Grant App Management permission, then try again.' });
          } else if (response === 1) {
            // Attempt 2: Open Terminal with sudo
            const tcmd = `osascript -e 'tell application "Terminal"
activate
do script "sudo bash ${scriptPath} && echo && echo \\"Done! You can close this window.\\" && sleep 2"
end tell'`;
            exec(tcmd, (e2) => {
              resolve(e2 ? { ok: false, error: e2.message } : { ok: true, viaTerminal: true });
            });
          } else {
            resolve({ ok: false, error: 'Cancelled.' });
          }
        });
      } else {
        resolve({ ok: false, error: msg.slice(0, 200) });
      }
    });
  });
}

// ==================== WINDOW ====================

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#030712',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  win.loadFile('index.html');

  // Intercept Cmd+Z/Cmd+Shift+Z BEFORE native handling
  win.webContents.on('before-input-event', (event, input) => {
    if ((input.meta || input.control) && input.key.toLowerCase() === 'z') {
      win.webContents.executeJavaScript(`
        (function() {
          const el = document.activeElement;
          const isText = el && ((el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number' || el.type === 'search')) || el.tagName === 'TEXTAREA' || el.isContentEditable);
          if (!isText) {
            ${input.shift ? 'window.__mwts_redo && window.__mwts_redo()' : 'window.__mwts_undo && window.__mwts_undo()'};
          }
          return isText;
        })()
      `).then(() => {}).catch(() => {});
      event.preventDefault();
    }
  });

  const menu = Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]);
  Menu.setApplicationMenu(menu);
  return win;
}

// Single whenReady — creates window + starts update check
app.whenReady().then(() => {
  const win = createWindow();

  // Silent update check after 5s
  setTimeout(async () => {
    try {
      const res = await httpGet(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
      if (res.status !== 200) return;
      const release = JSON.parse(res.data);
      const latestVersion = release.tag_name || '';
      if (compareVersions(CURRENT_VERSION, latestVersion) < 0) {
        const zipAsset = release.assets?.find(a => a.name.endsWith('.zip') && a.name.includes('arm64'));
        win.webContents.send('update-available', {
          currentVersion: CURRENT_VERSION,
          latestVersion: latestVersion.replace(/^v/, ''),
          downloadUrl: zipAsset?.browser_download_url || null,
          releaseName: release.name || '',
          releaseNotes: release.body || ''
        });
      }
    } catch {}
  }, 5000);
});

app.on('window-all-closed', () => app.quit());

// ==================== IPC: THEME ====================

ipcMain.handle('check-mw', async () => {
  const installed = fs.existsSync(MW_STYLES + '/dark.css');
  const hasBackup = fs.existsSync(PRESETS_DIR + '/dark.css.backup') || fs.existsSync(MW_STYLES + '/dark.css.backup');
  return { installed, hasBackup };
});

ipcMain.handle('read-current-theme', async () => {
  try {
    const css = fs.readFileSync(MW_STYLES + '/dark.css', 'utf8');
    const colors = {};
    const regex = /-theme-color-([\w-]+?):\s*rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g;
    let m;
    while ((m = regex.exec(css)) !== null) {
      const id = cssToId[m[1]];
      if (id) colors[id] = '#' + [m[2], m[3], m[4]].map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
    }
    const fontMatch = css.match(/-fx-font-family:\s*'([^']+)'/);
    const font = fontMatch ? fontMatch[1] : 'Monaco';
    const accentMatch = css.match(/-fx-accent:\s*rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    const accent = accentMatch ? '#' + [accentMatch[1], accentMatch[2], accentMatch[3]].map(n => parseInt(n).toString(16).padStart(2, '0')).join('') : null;
    const focusMatch = css.match(/-fx-focus-color:\s*rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    const focus = focusMatch ? '#' + [focusMatch[1], focusMatch[2], focusMatch[3]].map(n => parseInt(n).toString(16).padStart(2, '0')).join('') : null;
    return { ok: true, colors, font, accent, focus };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ==================== IPC: CHART COLORS ====================

ipcMain.handle('read-chart-colors', async () => {
  try {
    if (!fs.existsSync(MW_SETTINGS)) return { ok: false, error: 'settings.json not found' };
    const settings = JSON.parse(fs.readFileSync(MW_SETTINGS, 'utf8'));
    const ct = settings.chartThemes?.[0] || {};
    const bt = settings.barThemes?.[0] || {};
    return {
      ok: true,
      chart: { background: rgbStrToHex(ct.background), axisLine: rgbStrToHex(ct.axisLine), gridLine: rgbStrToHex(ct.gridLine), crossHair: rgbStrToHex(ct.crossHair), textFg: rgbStrToHex(ct.textFg) },
      bars: { up: rgbStrToHex(bt.up), upFill: rgbStrToHex(bt.upFill), upOutline: rgbStrToHex(bt.upOutline), down: rgbStrToHex(bt.down), downFill: rgbStrToHex(bt.downFill), downOutline: rgbStrToHex(bt.downOutline) },
      _raw: { chartTheme: ct, barTheme: bt }
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('save-chart-colors', async (event, { chart, bars }) => {
  try {
    if (!fs.existsSync(MW_SETTINGS)) return { ok: false, error: 'settings.json not found' };
    const settings = JSON.parse(fs.readFileSync(MW_SETTINGS, 'utf8'));
    if (settings.chartThemes?.[0]) {
      const ct = settings.chartThemes[0];
      ct.background = hexToRgbStr(chart.background); ct.axisLine = hexToRgbStr(chart.axisLine);
      ct.gridLine = hexToRgbStr(chart.gridLine); ct.crossHair = hexToRgbStr(chart.crossHair); ct.textFg = hexToRgbStr(chart.textFg);
    }
    if (settings.barThemes?.[0]) {
      const bt = settings.barThemes[0];
      const getAlpha = (orig) => { const p = (orig || '').split(','); return p.length >= 4 ? parseInt(p[3]) : undefined; };
      bt.up = hexToRgbStr(bars.up); bt.upFill = hexToRgbStr(bars.upFill, getAlpha(bt.upFill) || 210); bt.upOutline = hexToRgbStr(bars.upOutline);
      bt.down = hexToRgbStr(bars.down); bt.downFill = hexToRgbStr(bars.downFill, getAlpha(bt.downFill) || 210); bt.downOutline = hexToRgbStr(bars.downOutline);
    }
    fs.writeFileSync(MW_SETTINGS, JSON.stringify(settings));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ==================== IPC: TRADING COLORS ====================

function parseMWFont(fontStr) {
  if (!fontStr) return null;
  const parts = fontStr.split('|');
  return { font: parts[0] || 'Monaco', size: parts[1] || '12', style: parts[2] || '', sep: parts[3] !== undefined ? parts[3] : '', fgColor: parts[4] || '', bgColor: parts[5] || '', raw: fontStr };
}

function buildMWFont(parsed, overrides) {
  const fg = overrides.fgColor !== undefined ? overrides.fgColor : parsed.fgColor;
  const bg = overrides.bgColor !== undefined ? overrides.bgColor : parsed.bgColor;
  let result = `${parsed.font}|${parsed.size}|${parsed.style}||${fg}`;
  if (bg) result += `|${bg}`;
  return result;
}

function findWidgets(widgets, type) {
  const found = [];
  if (!Array.isArray(widgets)) return found;
  for (const w of widgets) {
    if (w.type === type) found.push(w);
    if (w.widgets) found.push(...findWidgets(w.widgets, type));
  }
  return found;
}

ipcMain.handle('read-trading-colors', async () => {
  try {
    const cfgPath = getWorkspaceConfigPath();
    if (!fs.existsSync(cfgPath)) return { ok: false, error: 'Workspace config not found' };
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const table = cfg.table || {};
    const dom = cfg.dom || {};
    const buttons = { buyText: '000000', buyBg: 'FFFFFF99', sellText: 'FFFFFF', sellBg: 'A52A2A99' };
    const domBP = dom.bottomPanel;
    if (domBP && domBP.widgets) {
      const bms = findWidgets(domBP.widgets, 'BM');
      const sms = findWidgets(domBP.widgets, 'SM');
      if (bms.length && bms[0].font) { const p = parseMWFont(bms[0].font); if (p) { buttons.buyText = p.fgColor || buttons.buyText; buttons.buyBg = p.bgColor || buttons.buyBg; } }
      if (sms.length && sms[0].font) { const p = parseMWFont(sms[0].font); if (p) { buttons.sellText = p.fgColor || buttons.sellText; buttons.sellBg = p.bgColor || buttons.sellBg; } }
    }
    return {
      ok: true,
      table: { upText: table.upText || 'FFFFFF', downText: table.downText || 'FF0000', upBg: table.upBg || 'FFFFFF', downBg: table.downBg || '962323', upArrow: table.upArrow || 'FFFFFF', downArrow: table.downArrow || 'FF0000' },
      dom: { bidColor: dom.bidColor || 'FF000033', askColor: dom.askColor || 'FFFFFF33', atBidText: dom.atBidText || 'FF0000', atAskText: dom.atAskText || 'FFFFFF', atBidHighlight: dom.atBidHighlight || 'F0000066', atAskHighlight: dom.atAskHighlight || 'FFFFFF66', bgColor: dom.bgColor || '000000', priceText: dom.priceText || '969696CC', mboBidFill: dom.mboBidFill || 'FFFFFF', mboAskFill: dom.mboAskFill || 'EB3232' },
      buttons, workspace: getActiveWorkspace()
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('save-trading-colors', async (event, { table, dom, buttons }) => {
  try {
    const cfgPath = getWorkspaceConfigPath();
    if (!fs.existsSync(cfgPath)) return { ok: false, error: 'Workspace config not found' };
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (table) { if (!cfg.table) cfg.table = {}; Object.assign(cfg.table, table); }
    if (dom) { if (!cfg.dom) cfg.dom = {}; for (const [k, v] of Object.entries(dom)) cfg.dom[k] = v; }
    if (buttons) {
      const updateWidgetColors = (widgets, type, fgColor, bgColor) => {
        if (!Array.isArray(widgets)) return;
        for (const w of widgets) {
          if (w.type === type) { const p = parseMWFont(w.font || `Monaco|12|||${fgColor}|${bgColor}`); w.font = buildMWFont(p, { fgColor, bgColor }); }
          if (w.widgets) updateWidgetColors(w.widgets, type, fgColor, bgColor);
        }
      };
      if (cfg.dom?.bottomPanel?.widgets) {
        updateWidgetColors(cfg.dom.bottomPanel.widgets, 'BM', buttons.buyText, buttons.buyBg);
        updateWidgetColors(cfg.dom.bottomPanel.widgets, 'SM', buttons.sellText, buttons.sellBg);
      }
      if (cfg.tradePanel?.panels) {
        for (const panel of cfg.tradePanel.panels) {
          if (panel.widgets) { updateWidgetColors(panel.widgets, 'BM', buttons.buyText, buttons.buyBg); updateWidgetColors(panel.widgets, 'SM', buttons.sellText, buttons.sellBg); }
        }
      }
    }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ==================== IPC: EXPORT/IMPORT ====================

ipcMain.handle('export-all', async (event, bundle) => {
  try {
    bundle.files = {};
    if (fs.existsSync(MW_SETTINGS)) bundle.files.settings = JSON.parse(fs.readFileSync(MW_SETTINGS, 'utf8'));
    const defaultsPath = getWorkspaceDefaultsPath();
    if (fs.existsSync(defaultsPath)) bundle.files.defaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
    const configPath = getWorkspaceConfigPath();
    if (fs.existsSync(configPath)) bundle.files.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    bundle.workspace = getActiveWorkspace();
    const result = await dialog.showSaveDialog({ defaultPath: 'my-mw-theme.mwtheme', filters: [{ name: 'MW Theme Bundle', extensions: ['mwtheme'] }] });
    if (!result.canceled && result.filePath) { fs.writeFileSync(result.filePath, JSON.stringify(bundle, null, 2)); return { ok: true, path: result.filePath }; }
    return { ok: false };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('import-all', async () => {
  try {
    const result = await dialog.showOpenDialog({ filters: [{ name: 'MW Theme', extensions: ['mwtheme', 'json'] }], properties: ['openFile'] });
    if (!result.canceled && result.filePaths[0]) { return { ok: true, data: JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8')) }; }
    return { ok: false };
  } catch (e) { return { ok: false, error: 'Invalid theme file: ' + e.message }; }
});

ipcMain.handle('open-fda-settings', async () => {
  exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_AppManagement"');
  return { ok: true };
});

// ==================== IPC: CUSTOM PRESETS ====================

ipcMain.handle('load-presets', async () => {
  try {
    if (!fs.existsSync(PRESETS_FILE)) return { ok: true, presets: {} };
    return { ok: true, presets: JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')) };
  } catch { return { ok: true, presets: {} }; }
});

ipcMain.handle('save-preset', async (event, { name, data }) => {
  try {
    fs.mkdirSync(PRESETS_DIR, { recursive: true });
    let presets = {};
    if (fs.existsSync(PRESETS_FILE)) presets = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
    presets[name] = data;
    fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('delete-preset', async (event, { name }) => {
  try {
    if (!fs.existsSync(PRESETS_FILE)) return { ok: true };
    const presets = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
    delete presets[name];
    fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('export-theme-json', async (event, { themeData }) => {
  const result = await dialog.showSaveDialog({ defaultPath: 'my-mw-theme.json', filters: [{ name: 'Theme', extensions: ['json'] }] });
  if (!result.canceled && result.filePath) { fs.writeFileSync(result.filePath, JSON.stringify(themeData, null, 2)); return { ok: true, path: result.filePath }; }
  return { ok: false };
});

ipcMain.handle('import-theme-json', async () => {
  const result = await dialog.showOpenDialog({ filters: [{ name: 'Theme', extensions: ['json'] }], properties: ['openFile'] });
  if (!result.canceled && result.filePaths[0]) {
    try { return { ok: true, data: JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8')) }; }
    catch (e) { return { ok: false, error: 'Invalid theme file' }; }
  }
  return { ok: false };
});

// ==================== IPC: INSTALL THEME ====================

ipcMain.handle('apply-theme', async (event, { css, font }) => {
  try {
    fs.writeFileSync('/tmp/mw-theme-dark.css', css);
    const fontBlock = [
      '', '/* === MW THEME STUDIO FONT OVERRIDE === */',
      `* { -fx-font-family: "${font}"; }`,
      `.label, .button, .toggle-button, .menu-item, .menu, .text, .text-input, .combo-box, .choice-box, .tab-pane .tab-label, .titled-pane > .title, .tool-bar, .status-bar, .dock-tab, .table-cell, .tree-cell, .list-cell { -fx-font-family: "${font}"; }`,
      '/* === END MW THEME STUDIO === */', ''
    ].join('\n');
    fs.writeFileSync('/tmp/mw-theme-font.txt', fontBlock);

    const script = `#!/bin/bash
STYLES="${MW_STYLES}"
BACKUP="$HOME/.mw-theme-backup"
mkdir -p "$BACKUP"
[ ! -f "$BACKUP/dark.css.backup" ] && cp "$STYLES/dark.css" "$BACKUP/dark.css.backup" 2>/dev/null
[ ! -f "$BACKUP/ui_theme.css.backup" ] && cp "$STYLES/ui_theme.css" "$BACKUP/ui_theme.css.backup" 2>/dev/null
cp /tmp/mw-theme-dark.css "$STYLES/dark.css" || { echo "FAIL"; exit 1; }
sed -i '' "s/-fx-font-family: '[^']*'/-fx-font-family: '${font}'/" "$STYLES/ui_theme.css"
sed -i '' '/=== MW THEME STUDIO FONT OVERRIDE ===/,/=== END MW THEME STUDIO ===/d' "$STYLES/ui_theme.css"
cat /tmp/mw-theme-font.txt >> "$STYLES/ui_theme.css"
echo "OK"`;
    fs.writeFileSync('/tmp/mw-theme-install.sh', script, { mode: 0o755 });

    return await runPrivileged('/tmp/mw-theme-install.sh');
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('restore-theme', async () => {
  try {
    const script = `#!/bin/bash
STYLES="${MW_STYLES}"
BACKUP="$HOME/.mw-theme-backup"
[ -f "$BACKUP/dark.css.backup" ] && cp "$BACKUP/dark.css.backup" "$STYLES/dark.css" || { echo "FAIL"; exit 1; }
[ -f "$BACKUP/ui_theme.css.backup" ] && cp "$BACKUP/ui_theme.css.backup" "$STYLES/ui_theme.css"
echo "OK"`;
    fs.writeFileSync('/tmp/mw-theme-restore.sh', script, { mode: 0o755 });

    return await runPrivileged('/tmp/mw-theme-restore.sh');
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('export-css', async (event, { css }) => {
  const result = await dialog.showSaveDialog({ defaultPath: 'mw-theme-dark.css', filters: [{ name: 'CSS', extensions: ['css'] }] });
  if (!result.canceled && result.filePath) { fs.writeFileSync(result.filePath, css); return { ok: true, path: result.filePath }; }
  return { ok: false };
});

ipcMain.handle('read-ui-theme', async () => {
  try {
    const uiPath = MW_STYLES + '/ui_theme.css';
    const darkPath = MW_STYLES + '/dark.css';
    let uiCSS = '', darkCSS = '';
    if (fs.existsSync(uiPath)) uiCSS = fs.readFileSync(uiPath, 'utf8');
    if (fs.existsSync(darkPath)) darkCSS = fs.readFileSync(darkPath, 'utf8');
    return { ok: true, uiCSS, darkCSS };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ==================== HTTP HELPERS ====================

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'MW-Theme-Studio/' + CURRENT_VERSION, 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpDownload(url, dest) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'MW-Theme-Studio/' + CURRENT_VERSION };
    if (url.includes('github.com') || url.includes('github-releases')) {
      headers['Accept'] = 'application/octet-stream';
    }
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpDownload(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

function compareVersions(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

// ==================== AUTO-UPDATE ====================

ipcMain.handle('get-app-version', () => CURRENT_VERSION);

ipcMain.handle('check-for-update', async () => {
  try {
    const res = await httpGet(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    if (res.status !== 200) return { available: false, error: 'Could not check for updates' };
    const release = JSON.parse(res.data);
    const latestVersion = release.tag_name || '';
    const newer = compareVersions(CURRENT_VERSION, latestVersion) < 0;
    const zipAsset = release.assets?.find(a => a.name.endsWith('.zip') && a.name.includes('arm64'));
    return {
      available: newer,
      currentVersion: CURRENT_VERSION,
      latestVersion: latestVersion.replace(/^v/, ''),
      releaseNotes: release.body || '',
      downloadUrl: zipAsset?.browser_download_url || null,
      releaseName: release.name || ''
    };
  } catch (e) { return { available: false, error: e.message }; }
});

ipcMain.handle('install-update', async (event, downloadUrl) => {
  if (!downloadUrl) return { ok: false, error: 'No download URL' };
  const win = BrowserWindow.getFocusedWindow();
  try {
    const zipPath = '/tmp/mw-theme-studio-update.zip';
    const extractDir = '/tmp/mw-theme-studio-update';

    win?.webContents.send('update-progress', 'Downloading...');
    await httpDownload(downloadUrl, zipPath);

    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });

    win?.webContents.send('update-progress', 'Installing...');

    const appPath = app.getPath('exe').replace(/\/Contents\/MacOS\/.*$/, '');
    const updateScript = `#!/bin/bash
cd "${extractDir}" && unzip -o "${zipPath}" > /dev/null 2>&1
xattr -cr "${extractDir}/MW Theme Studio.app" 2>/dev/null
rm -rf "${appPath}"
mv "${extractDir}/MW Theme Studio.app" "${appPath}"
rm -f "${zipPath}"
rm -rf "${extractDir}"
rm -f /tmp/mw-theme-studio-updater.sh
echo "OK"`;
    fs.writeFileSync('/tmp/mw-theme-studio-updater.sh', updateScript, { mode: 0o755 });

    // Use the same runPrivileged helper
    const result = await runPrivileged('/tmp/mw-theme-studio-updater.sh');
    if (result.ok && !result.viaTerminal) {
      // Relaunch the new version
      spawn('open', [appPath], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => app.quit(), 500);
    } else if (result.ok && result.viaTerminal) {
      // Terminal is handling it — quit so the script can replace the app
      win?.webContents.send('update-progress', 'Terminal is installing. Quitting...');
      setTimeout(() => app.quit(), 2000);
    } else {
      win?.webContents.send('update-progress', '');
    }
    return result;
  } catch (e) {
    win?.webContents.send('update-progress', '');
    return { ok: false, error: e.message };
  }
});

// ==================== ISSUE REPORTER ====================

ipcMain.handle('report-issue', async (event, { title, body }) => {
  const sysInfo = [
    `**App Version:** ${CURRENT_VERSION}`,
    `**macOS:** ${os.release()} (${os.arch()})`,
    `**MotiveWave:** ${fs.existsSync(MW_STYLES) ? 'Installed' : 'Not found'}`,
    `**Workspace:** ${getActiveWorkspace()}`,
    ''
  ].join('\n');
  const fullBody = body ? `${sysInfo}\n---\n\n${body}` : sysInfo;
  const url = `https://github.com/${GITHUB_REPO}/issues/new?` +
    `title=${encodeURIComponent(title || 'Bug report')}` +
    `&body=${encodeURIComponent(fullBody)}` +
    `&labels=bug`;
  shell.openExternal(url);
  return { ok: true };
});
