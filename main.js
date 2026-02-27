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
let selectedWorkspace = '';

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
  const ws = selectedWorkspace || getActiveWorkspace();
  return path.join(MW_WORKSPACES, ws, 'config', 'config.json');
}

function getWorkspaceDefaultsPath() {
  const ws = selectedWorkspace || getActiveWorkspace();
  return path.join(MW_WORKSPACES, ws, 'config', 'defaults.json');
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

// ==================== TERMINAL SUDO ====================
// Write temp files, open Terminal with sudo script. User enters password. Done.

function runInTerminal(scriptPath, successMsg) {
  return new Promise((resolve) => {
    const tcmd = `osascript -e 'tell application "Terminal"
activate
do script "sudo bash ${scriptPath} && echo && echo \\"${successMsg}\\" && sleep 2 && exit"
end tell'`;
    exec(tcmd, (err) => {
      // Terminal opened — we can't know if sudo succeeded from here,
      // but if the script runs, it works. Resolve ok.
      resolve(err ? { ok: false, error: err.message } : { ok: true });
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
    // Write CSS + font to temp files
    fs.writeFileSync('/tmp/mw-theme-dark.css', css);
    const fontBlock = '\n/* === MW THEME STUDIO FONT OVERRIDE === */\n' +
      `* { -fx-font-family: "${font}"; }\n` +
      `.label, .button, .toggle-button, .menu-item, .menu, .text, .text-input, .combo-box, .choice-box, .tab-pane .tab-label, .titled-pane > .title, .tool-bar, .status-bar, .dock-tab, .table-cell, .tree-cell, .list-cell { -fx-font-family: "${font}"; }\n` +
      '/* === END MW THEME STUDIO === */\n';
    fs.writeFileSync('/tmp/mw-theme-font.txt', fontBlock);

    // Build install script
    const script = `#!/bin/bash
STYLES="${MW_STYLES}"
BACKUP="$HOME/.mw-theme-backup"
mkdir -p "$BACKUP"
[ ! -f "$BACKUP/dark.css.backup" ] && cp "$STYLES/dark.css" "$BACKUP/dark.css.backup" 2>/dev/null
[ ! -f "$BACKUP/ui_theme.css.backup" ] && cp "$STYLES/ui_theme.css" "$BACKUP/ui_theme.css.backup" 2>/dev/null
cp /tmp/mw-theme-dark.css "$STYLES/dark.css"
sed -i '' "s/-fx-font-family: '[^']*'/-fx-font-family: '${font}'/" "$STYLES/ui_theme.css"
sed -i '' '/=== MW THEME STUDIO FONT OVERRIDE ===/,/=== END MW THEME STUDIO ===/d' "$STYLES/ui_theme.css"
cat /tmp/mw-theme-font.txt >> "$STYLES/ui_theme.css"
echo "Theme installed!"`;
    fs.writeFileSync('/tmp/mw-theme-install.sh', script, { mode: 0o755 });

    return await runInTerminal('/tmp/mw-theme-install.sh', 'Theme installed! Restart MotiveWave.');
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('restore-theme', async () => {
  try {
    const script = `#!/bin/bash
STYLES="${MW_STYLES}"
BACKUP="$HOME/.mw-theme-backup"
[ -f "$BACKUP/dark.css.backup" ] && cp "$BACKUP/dark.css.backup" "$STYLES/dark.css"
[ -f "$BACKUP/ui_theme.css.backup" ] && cp "$BACKUP/ui_theme.css.backup" "$STYLES/ui_theme.css"
echo "Restored!"`;
    fs.writeFileSync('/tmp/mw-theme-restore.sh', script, { mode: 0o755 });

    return await runInTerminal('/tmp/mw-theme-restore.sh', 'Restored! Restart MotiveWave.');
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

    win?.webContents.send('update-progress', 'Extracting...');

    // Extract zip
    await new Promise((res, rej) => {
      exec(`cd "${extractDir}" && unzip -o "${zipPath}"`, (err) => err ? rej(err) : res());
    });

    // Remove quarantine
    exec(`xattr -cr "${extractDir}/MW Theme Studio.app"`, () => {});

    win?.webContents.send('update-progress', 'Installing...');

    // Write a small script that waits for us to quit, then replaces the app and relaunches
    const appPath = app.getPath('exe').replace(/\/Contents\/MacOS\/.*$/, '');
    const script = `#!/bin/bash
sleep 1
rm -rf "${appPath}"
mv "${extractDir}/MW Theme Studio.app" "${appPath}"
xattr -cr "${appPath}" 2>/dev/null
open "${appPath}"
rm -f "${zipPath}" /tmp/mw-update.sh
rm -rf "${extractDir}"
`;
    fs.writeFileSync('/tmp/mw-update.sh', script, { mode: 0o755 });

    // Launch updater detached, then quit
    spawn('bash', ['/tmp/mw-update.sh'], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 300);
    return { ok: true };
  } catch (e) {
    win?.webContents.send('update-progress', '');
    return { ok: false, error: e.message };
  }
});

// ==================== IPC: INDICATOR SCANNER ====================

// Parse MW color formats into {hex, alpha}
function parseMWColor(val) {
  if (!val) return null;
  if (typeof val !== 'string') return null;
  // Format: "R,G,B" or "R,G,B,A"
  if (val.includes(',')) {
    const parts = val.split(',').map(s => parseInt(s.trim()));
    if (parts.length >= 3) {
      const hex = '#' + parts.slice(0, 3).map(n => Math.min(255, Math.max(0, n || 0)).toString(16).padStart(2, '0')).join('');
      return { hex, alpha: parts[3] !== undefined ? parts[3] : 255 };
    }
  }
  // Format: "RRGGBB" or "RRGGBBAA" (no #)
  const clean = val.replace(/^#/, '');
  if (/^[0-9A-Fa-f]{6,8}$/.test(clean)) {
    const hex = '#' + clean.slice(0, 6).toLowerCase();
    const alpha = clean.length === 8 ? parseInt(clean.slice(6, 8), 16) : 255;
    return { hex, alpha };
  }
  // Format: "N,RRGGBB" (prefix + hex)
  const prefixMatch = val.match(/^[A-Z],([0-9A-Fa-f]{6})$/);
  if (prefixMatch) return { hex: '#' + prefixMatch[1].toLowerCase(), alpha: 255 };
  return null;
}

// Convert hex+alpha back to MW format based on original format
function toMWColor(hex, alpha, originalFormat) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (!originalFormat) return `${r},${g},${b},${alpha}`;
  if (originalFormat.includes(',') && !originalFormat.match(/^[A-Z],/)) {
    // RGB string format
    const parts = originalFormat.split(',');
    return parts.length >= 4 ? `${r},${g},${b},${alpha}` : `${r},${g},${b}`;
  }
  if (originalFormat.match(/^[A-Z],/)) {
    // Prefix format
    return originalFormat[0] + ',' + hex.slice(1).toUpperCase();
  }
  // Hex format
  const h = hex.slice(1).toUpperCase();
  return originalFormat.length === 8 ? h + (alpha || 255).toString(16).toUpperCase().padStart(2, '0') : h;
}

// Study ID → display name mapping
const SID_NAMES = {
  'VIMPRINT': 'Volume Imprint',
  'SMA': 'Simple Moving Average',
  'EMA': 'Exponential Moving Average',
  'WMA': 'Weighted Moving Average',
  'DEMA': 'Double EMA',
  'TEMA': 'Triple EMA',
  'VWAP': 'VWAP',
  'VOLUME': 'Volume',
  'ORDER_HEATMAP': 'Order Heatmap',
  'BID_TRADES': 'Bid Trades',
  'ASK_TRADES': 'Ask Trades',
  'HARMONIC': 'Harmonic Patterns',
  'HURST_CYCLES': 'Hurst Cycles',
  'ELLIOTT_WAVE': 'Elliott Wave',
  'RSI': 'RSI',
  'MACD': 'MACD',
  'STOCHASTIC': 'Stochastic',
  'BOLLINGER': 'Bollinger Bands',
  'ATR': 'ATR',
  'ADX': 'ADX',
  'CCI': 'CCI',
  'MFI': 'Money Flow Index',
  'OBV': 'On Balance Volume',
  'ICHIMOKU': 'Ichimoku Cloud',
  'PIVOT': 'Pivot Points',
  'TPO': 'TPO Profile',
  'VPOC': 'VPOC',
  'DELTA': 'Delta',
  'CUM_DELTA': 'Cumulative Delta',
  'FOOTPRINT': 'Footprint',
  'DOM': 'DOM',
  'TIME_SALES': 'Time & Sales',
  'IMBALANCE': 'Imbalance',
  'KELTNER': 'Keltner Channel',
  'DONCHIAN': 'Donchian Channel',
  'PARABOLIC': 'Parabolic SAR',
  'SUPERTREND': 'SuperTrend',
  'WILLIAMS_R': 'Williams %R',
  'FIBS': 'Fibonacci',
  'VOL_PROFILE': 'Volume Profile',
  'MARKET_PROFILE': 'Market Profile',
};

// Settings type → display name (fallback)
const STYPE_NAMES = {
  'profile': 'Volume Profile',
  'bidAsk': 'Bid/Ask Footprint',
  'study': 'Study',
  'heatmap': 'Heatmap',
};

// Drawing tool / default ID → display name
const DRAWING_NAMES = {
  'fib_range': 'Fibonacci Range',
  'fib_retracement': 'Fibonacci Retracement',
  'fib_extension': 'Fibonacci Extension',
  'fib_expansion': 'Fibonacci Expansion',
  'fib_fan': 'Fibonacci Fan',
  'fib_channel': 'Fibonacci Channel',
  'fib_circle': 'Fibonacci Circle',
  'fib_arc': 'Fibonacci Arc',
  'gann_retracement': 'Gann Retracement',
  'gann_extension': 'Gann Extension',
  'gann_fan': 'Gann Fan',
  'labelLine': 'Label Line',
  'label': 'Label',
  'box': 'Box',
  'rectangle': 'Rectangle',
  'pl1_buy': 'PL Buy Order',
  'pl1_sell': 'PL Sell Order',
  'pl_buy': 'PL Buy',
  'pl_sell': 'PL Sell',
  'trendLine': 'Trend Line',
  'hLine': 'Horizontal Line',
  'vLine': 'Vertical Line',
  'ray': 'Ray',
  'channel': 'Channel',
  'pitchfork': 'Pitchfork',
};

function extractColors(settings) {
  const colors = [];
  // Extract from settings.colors array
  if (Array.isArray(settings.colors)) {
    for (const c of settings.colors) {
      if (c.name && c.color) {
        const parsed = parseMWColor(c.color);
        if (parsed) {
          colors.push({
            key: c.name,
            label: c.name.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim(),
            hex: parsed.hex, alpha: parsed.alpha,
            enabled: c.enabled !== false, original: c.color
          });
        }
      }
    }
  }
  // Extract inline color properties
  for (const [k, v] of Object.entries(settings)) {
    if (typeof v === 'string' && (k.toLowerCase().includes('color') || k.toLowerCase().includes('fill'))
        && k !== 'adjLadderColor' && k !== 'colorMap') {
      const parsed = parseMWColor(v);
      if (parsed) {
        colors.push({
          key: k,
          label: k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim(),
          hex: parsed.hex, alpha: parsed.alpha,
          enabled: true, original: v, inlineKey: k
        });
      }
    }
  }
  // Extract colorMap (heatmaps)
  if (settings.colorMap && settings.colorMap.colors) {
    settings.colorMap.colors.forEach((c, i) => {
      const parsed = parseMWColor(c);
      if (parsed) {
        colors.push({
          key: `colorMap_${i}`, label: `Heatmap Color ${i + 1}`,
          hex: parsed.hex, alpha: parsed.alpha,
          enabled: true, original: c, mapIndex: i
        });
      }
    });
  }
  // Extract path colors (line, bar, indicator colors)
  if (Array.isArray(settings.paths)) {
    for (const p of settings.paths) {
      if (p.c1) {
        const parsed = parseMWColor(p.c1);
        if (parsed) {
          colors.push({
            key: `path_${p.name}_c1`, label: `${(p.name || 'Line').replace(/([A-Z])/g, ' $1').trim()} Color`,
            hex: parsed.hex, alpha: parsed.alpha,
            enabled: p.enabled !== false, original: p.c1
          });
        }
      }
    }
  }
  // Extract font colors (Bid Trades, etc use fonts[] with color + bg)
  if (Array.isArray(settings.fonts)) {
    for (const f of settings.fonts) {
      if (f.color) {
        const parsed = parseMWColor(f.color);
        if (parsed) {
          colors.push({
            key: `font_${f.name}_fg`, label: `${(f.name || 'Font').replace(/([A-Z])/g, ' $1').replace(/\d+/, ' $&').trim()} Text`,
            hex: parsed.hex, alpha: parsed.alpha, enabled: true, original: f.color
          });
        }
      }
      if (f.bg) {
        const parsed = parseMWColor(f.bg);
        if (parsed) {
          colors.push({
            key: `font_${f.name}_bg`, label: `${(f.name || 'Font').replace(/([A-Z])/g, ' $1').replace(/\d+/, ' $&').trim()} Background`,
            hex: parsed.hex, alpha: parsed.alpha, enabled: true, original: f.bg
          });
        }
      }
    }
  }
  // Extract indicator label colors
  if (Array.isArray(settings.indicators)) {
    for (const ind of settings.indicators) {
      if (ind.labelColor) {
        const parsed = parseMWColor(ind.labelColor);
        if (parsed) {
          colors.push({
            key: `ind_${ind.name}_label`, label: `${(ind.name || 'Indicator').replace(/([A-Z])/g, ' $1').trim()} Label`,
            hex: parsed.hex, alpha: parsed.alpha, enabled: true, original: ind.labelColor
          });
        }
      }
    }
  }
  return colors;
}

function getSidDisplayName(sid) {
  if (!sid) return '';
  // Handle namespaced IDs (e.g. "com.clawd;PO3_GOLDBACH_LEVELS" or "com.motivewave;VWAP")
  if (sid.includes(';')) {
    const parts = sid.split(';');
    const name = parts[parts.length - 1];
    return SID_NAMES[name] || name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  return SID_NAMES[sid] || DRAWING_NAMES[sid] || sid.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function scanStudiesFromJSON(obj, sourceFile, results, depth = 0) {
  if (depth > 30 || !obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) scanStudiesFromJSON(item, sourceFile, results, depth + 1);
    return;
  }

  // Check if this object has a 'figures' array (chart graph container)
  if (Array.isArray(obj.figures)) {
    for (const fig of obj.figures) {
      if (!fig || typeof fig !== 'object') continue;
      const sid = fig.sid || '';
      if (!sid) continue; // No study ID, skip
      const ns = fig.ns || '';
      const settings = (fig.settings && typeof fig.settings === 'object') ? fig.settings : {};

      const colors = extractColors(settings);

      const displayName = getSidDisplayName(sid) || STYPE_NAMES[settings.type] || settings.type || 'Unknown';
      const instrument = extractInstrument(obj, fig);

      results.push({
        source: sourceFile,
        type: settings.type || 'study',
        sid: sid,
        ns: ns,
        id: `${sid}_${fig.id || results.length}`,
        name: sid,
        displayName: instrument ? `${displayName} (${instrument})` : displayName,
        colors: colors
      });
    }
    // Don't return — keep scanning nested objects
  }

  // Also handle non-figure settings with colors (DOM, table, etc from config.json)
  if (obj.settings && typeof obj.settings === 'object' && !Array.isArray(obj.settings) && !obj.sid) {
    const colors = extractColors(obj.settings);
    if (colors.length > 0 && !Array.isArray(obj.figures)) {
      results.push({
        source: sourceFile,
        type: obj.settings.type || obj.type || '',
        sid: '',
        ns: '',
        id: `cfg_${obj.type || ''}_${results.length}`,
        name: obj.settings.type || obj.type || '',
        displayName: STYPE_NAMES[obj.settings.type] || obj.settings.type || obj.type || 'Config',
        colors: colors
      });
    }
  }

  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') scanStudiesFromJSON(v, sourceFile, results, depth + 1);
  }
}

// Try to extract the instrument symbol from the JSON path context
function extractInstrument(graphObj, fig) {
  // The instrument is often a key like "EPH26.CQG:1" in the parent
  // We check the parent object for keys that look like instrument symbols
  if (!graphObj) return '';
  for (const key of Object.keys(graphObj)) {
    if (key.match(/^[A-Z0-9]+\.[A-Z]+/) || key.match(/^[A-Z]{2,}\d/)) {
      // Extract just the root symbol (e.g., "EPH26" from "EPH26.CQG:1")
      return key.split('.')[0];
    }
  }
  return '';
}

ipcMain.handle('list-workspaces', async () => {
  try {
    const dirs = fs.readdirSync(MW_WORKSPACES).filter(d => {
      try { return fs.statSync(path.join(MW_WORKSPACES, d)).isDirectory(); }
      catch { return false; }
    });
    return { ok: true, workspaces: dirs, active: dirs[0] || '' };
  } catch (e) { return { ok: false, workspaces: [], error: e.message }; }
});

ipcMain.handle('set-workspace', async (event, ws) => {
  if (ws) selectedWorkspace = ws;
  return { ok: true, workspace: selectedWorkspace };
});

ipcMain.handle('scan-indicators', async (event, wsOverride) => {
  try {
    const wsName = wsOverride || selectedWorkspace || getActiveWorkspace();
    if (wsName === 'default') return { ok: false, error: 'No MotiveWave workspace found. Open MotiveWave first.' };
    selectedWorkspace = wsName;

    const wsConfig = path.join(MW_WORKSPACES, wsName, 'config');
    const studies = [];
    const files = ['windows.json', 'defaults.json', 'config.json'];

    for (const file of files) {
      const fp = path.join(wsConfig, file);
      if (!fs.existsSync(fp)) continue;
      const raw = fs.readFileSync(fp, 'utf8').trim();
      if (!raw || raw === '{}' || raw === '[]') continue;
      try {
        const data = JSON.parse(raw);
        scanStudiesFromJSON(data, file, studies);
      } catch {}
    }

    // Scan defaults.json — array of {id, data: {settings, sid, ...}}
    const defaultsPath = path.join(wsConfig, 'defaults.json');
    if (fs.existsSync(defaultsPath)) {
      try {
        const raw = fs.readFileSync(defaultsPath, 'utf8').trim();
        if (raw && raw !== '[]') {
          const defaults = JSON.parse(raw);
          if (Array.isArray(defaults)) {
            for (const def of defaults) {
              const data = def.data || def;
              if (!data || typeof data !== 'object') continue;
              const sid = data.sid || data.cid || def.id || '';
              const settings = (data.settings && typeof data.settings === 'object') ? data.settings : {};
              const colors = extractColors(settings);

              // Also extract ratio colors for drawing tools (fibs, etc)
              const ratios = data.ratios;
              if (Array.isArray(ratios)) {
                for (const r of ratios) {
                  if (r.c1) {
                    const parsed = parseMWColor(r.c1);
                    if (parsed) colors.push({
                      key: `ratio_${r.value || r.name || ratios.indexOf(r)}_c1`,
                      label: `${r.value || r.name || 'Level'} Line`,
                      hex: parsed.hex, alpha: parsed.alpha, enabled: r.enabled !== false, original: r.c1
                    });
                  }
                  if (r.fillColor) {
                    const parsed = parseMWColor(r.fillColor);
                    if (parsed) colors.push({
                      key: `ratio_${r.value || r.name || ratios.indexOf(r)}_fill`,
                      label: `${r.value || r.name || 'Level'} Fill`,
                      hex: parsed.hex, alpha: parsed.alpha, enabled: true, original: r.fillColor
                    });
                  }
                }
              }

              // Extract path/line colors from settings
              if (settings.c1) {
                const parsed = parseMWColor(settings.c1);
                if (parsed) colors.push({ key: 'line_c1', label: 'Line Color', hex: parsed.hex, alpha: parsed.alpha, enabled: true, original: settings.c1 });
              }
              if (settings.fillColor) {
                const parsed = parseMWColor(settings.fillColor);
                if (parsed) colors.push({ key: 'fillColor', label: 'Fill Color', hex: parsed.hex, alpha: parsed.alpha, enabled: true, original: settings.fillColor });
              }

              const displayName = getSidDisplayName(sid) || STYPE_NAMES[settings.type] || sid || 'Default';
              const isDrawing = !!data.cid || !!DRAWING_NAMES[sid] || !!DRAWING_NAMES[def.id];
              studies.push({
                source: 'defaults.json', type: isDrawing ? 'drawing' : (settings.type || 'default'),
                sid, ns: '', id: `default_${sid}_${studies.length}`,
                name: sid, displayName: `${displayName} (default)`, colors
              });
            }
          }
        }
      } catch {}
    }

    // Scan templates.json — array of {name, settings, graphs: [{figures}]}
    const templatesPath = path.join(wsConfig, 'templates.json');
    if (fs.existsSync(templatesPath)) {
      try {
        const raw = fs.readFileSync(templatesPath, 'utf8').trim();
        if (raw && raw !== '[]') {
          const templates = JSON.parse(raw);
          if (Array.isArray(templates)) {
            for (const tpl of templates) {
              // Template-level settings
              if (tpl.settings && typeof tpl.settings === 'object') {
                const colors = extractColors(tpl.settings);
                if (colors.length > 0) {
                  studies.push({
                    source: 'templates.json', type: 'template',
                    sid: '', ns: '', id: `tpl_${tpl.name || tpl.id || studies.length}`,
                    name: tpl.name || '', displayName: `Template: ${tpl.name || 'Unnamed'}`, colors
                  });
                }
              }
              // Figures inside template graphs
              if (Array.isArray(tpl.graphs)) {
                scanStudiesFromJSON({ graphs: tpl.graphs }, 'templates.json', studies);
              }
            }
          }
        }
      } catch {}
    }

    // Also check settings.json for chart/bar themes with extra detail
    if (fs.existsSync(MW_SETTINGS)) {
      try {
        const settings = JSON.parse(fs.readFileSync(MW_SETTINGS, 'utf8'));
        if (settings.chartThemes) {
          for (const ct of settings.chartThemes) {
            const study = { source: 'settings.json', type: 'chartTheme', id: `chartTheme_${ct.name || 'default'}`, name: ct.name || '', displayName: `Chart Theme: ${ct.name || 'Default'}`, colors: [] };
            for (const [k, v] of Object.entries(ct)) {
              if (typeof v === 'string' && k !== 'name') {
                const parsed = parseMWColor(v);
                if (parsed) study.colors.push({ key: k, label: k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim(), hex: parsed.hex, alpha: parsed.alpha, enabled: true, original: v, inlineKey: k });
              }
            }
            if (study.colors.length) studies.push(study);
          }
        }
        if (settings.barThemes) {
          for (const bt of settings.barThemes) {
            const study = { source: 'settings.json', type: 'barTheme', id: `barTheme_${bt.name || 'default'}`, name: bt.name || '', displayName: `Bar Theme: ${bt.name || 'Default'}`, colors: [] };
            for (const [k, v] of Object.entries(bt)) {
              if (typeof v === 'string' && k !== 'name') {
                const parsed = parseMWColor(v);
                if (parsed) study.colors.push({ key: k, label: k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim(), hex: parsed.hex, alpha: parsed.alpha, enabled: true, original: v, inlineKey: k });
              }
            }
            if (study.colors.length) studies.push(study);
          }
        }
      } catch {}
    }

    // Deduplicate by type+name, merge colors
    const deduped = {};
    for (const s of studies) {
      const key = `${s.type}__${s.name || s.displayName}`;
      if (!deduped[key]) {
        deduped[key] = s;
      } else {
        // Merge any new colors not already present
        const existing = new Set(deduped[key].colors.map(c => c.key));
        for (const c of s.colors) {
          if (!existing.has(c.key)) {
            deduped[key].colors.push(c);
            existing.add(c.key);
          }
        }
      }
    }

    return { ok: true, workspace: wsName, studies: Object.values(deduped) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('save-indicator-colors', async (event, { studyId, changes }) => {
  try {
    const wsName = selectedWorkspace || getActiveWorkspace();
    const wsConfig = path.join(MW_WORKSPACES, wsName, 'config');

    // Re-scan to find the study
    const studies = [];
    const fileData = {};
    const files = ['windows.json', 'defaults.json', 'config.json', 'templates.json'];

    for (const file of files) {
      const fp = path.join(wsConfig, file);
      if (!fs.existsSync(fp)) continue;
      const raw = fs.readFileSync(fp, 'utf8').trim();
      if (!raw || raw === '{}' || raw === '[]') continue;
      try { fileData[file] = JSON.parse(raw); } catch { continue; }
    }

    // Also handle settings.json
    if (fs.existsSync(MW_SETTINGS)) {
      try { fileData['settings.json'] = JSON.parse(fs.readFileSync(MW_SETTINGS, 'utf8')); } catch {}
    }

    // Apply changes by walking the JSON and finding matching color entries
    let applied = 0;
    const changeMap = {};
    for (const c of changes) changeMap[c.key] = c;

    function applyChanges(obj, depth = 0) {
      if (depth > 30 || !obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (const item of obj) applyChanges(item, depth + 1);
        return;
      }
      const settings = obj.settings;
      if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
        // Update colors array
        if (Array.isArray(settings.colors)) {
          for (const c of settings.colors) {
            if (c.name && changeMap[c.name]) {
              const ch = changeMap[c.name];
              c.color = toMWColor(ch.hex, ch.alpha, c.color);
              applied++;
            }
          }
        }
        // Update inline color props
        for (const [k, v] of Object.entries(settings)) {
          if (changeMap[k] && typeof v === 'string') {
            const ch = changeMap[k];
            settings[k] = toMWColor(ch.hex, ch.alpha, v);
            applied++;
          }
        }
        // Update colorMap
        if (settings.colorMap && settings.colorMap.colors) {
          for (let i = 0; i < settings.colorMap.colors.length; i++) {
            const mapKey = `colorMap_${i}`;
            if (changeMap[mapKey]) {
              const ch = changeMap[mapKey];
              settings.colorMap.colors[i] = toMWColor(ch.hex, ch.alpha, settings.colorMap.colors[i]);
              applied++;
            }
          }
        }
      }
      // Handle chart/bar themes in settings.json
      if (obj.chartThemes || obj.barThemes) {
        for (const themes of [obj.chartThemes, obj.barThemes]) {
          if (!Array.isArray(themes)) continue;
          for (const theme of themes) {
            for (const [k, v] of Object.entries(theme)) {
              if (changeMap[k] && typeof v === 'string' && k !== 'name') {
                const ch = changeMap[k];
                theme[k] = toMWColor(ch.hex, ch.alpha, v);
                applied++;
              }
            }
          }
        }
      }
      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') applyChanges(v, depth + 1);
      }
    }

    for (const [file, data] of Object.entries(fileData)) {
      // For defaults.json, walk into each entry's data.settings
      if (file === 'defaults.json' && Array.isArray(data)) {
        for (const def of data) {
          const d = def.data || def;
          if (d && d.settings) applyChanges({ settings: d.settings });
        }
      }
      applyChanges(data);
      const fp = file === 'settings.json' ? MW_SETTINGS : path.join(wsConfig, file);
      fs.writeFileSync(fp, JSON.stringify(data));
    }

    return { ok: true, applied };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ==================== WORKSPACE BACKUP/RESTORE ====================

ipcMain.handle('backup-workspace', async () => {
  try {
    const wsName = selectedWorkspace || getActiveWorkspace();
    const wsConfig = path.join(MW_WORKSPACES, wsName, 'config');
    const backupDir = path.join(PRESETS_DIR, 'backups');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(backupDir, `${wsName}_${timestamp}`);

    fs.mkdirSync(backupPath, { recursive: true });

    // Copy all JSON config files
    const files = fs.readdirSync(wsConfig).filter(f => f.endsWith('.json'));
    for (const file of files) {
      fs.copyFileSync(path.join(wsConfig, file), path.join(backupPath, file));
    }

    return { ok: true, path: backupPath, workspace: wsName, files: files.length };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('restore-workspace-backup', async () => {
  try {
    const backupDir = path.join(PRESETS_DIR, 'backups');
    if (!fs.existsSync(backupDir)) return { ok: false, error: 'No backups found.' };

    const backups = fs.readdirSync(backupDir).filter(d => {
      try { return fs.statSync(path.join(backupDir, d)).isDirectory(); }
      catch { return false; }
    }).sort().reverse();

    if (backups.length === 0) return { ok: false, error: 'No backups found.' };

    // Show picker dialog with backup list
    const win = BrowserWindow.getFocusedWindow();
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Restore Backup',
      message: `Restore workspace from backup?`,
      detail: `Latest: ${backups[0]}\n${backups.length} backup(s) available.\n\nThis will overwrite the current workspace config.`,
      buttons: ['Restore Latest', 'Choose...', 'Cancel'],
      defaultId: 2
    });

    let chosenBackup;
    if (response === 0) {
      chosenBackup = backups[0];
    } else if (response === 1) {
      const result = await dialog.showOpenDialog(win, {
        defaultPath: backupDir,
        properties: ['openDirectory'],
        title: 'Choose backup folder'
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false };
      chosenBackup = path.basename(result.filePaths[0]);
    } else {
      return { ok: false };
    }

    const backupPath = path.join(backupDir, chosenBackup);
    const wsName = selectedWorkspace || getActiveWorkspace();
    const wsConfig = path.join(MW_WORKSPACES, wsName, 'config');

    const files = fs.readdirSync(backupPath).filter(f => f.endsWith('.json'));
    for (const file of files) {
      fs.copyFileSync(path.join(backupPath, file), path.join(wsConfig, file));
    }

    return { ok: true, workspace: wsName, files: files.length, backup: chosenBackup };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ==================== EXPORT/IMPORT INDICATOR COLORS ====================

ipcMain.handle('export-indicator-colors', async (event, studies) => {
  try {
    const result = await dialog.showSaveDialog({
      defaultPath: `mw-indicator-colors.mwcolors`,
      filters: [{ name: 'MW Colors', extensions: ['mwcolors', 'json'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false };

    const bundle = {
      version: CURRENT_VERSION,
      workspace: selectedWorkspace || getActiveWorkspace(),
      exportDate: new Date().toISOString(),
      studies: studies
    };
    fs.writeFileSync(result.filePath, JSON.stringify(bundle, null, 2));
    return { ok: true, path: result.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('import-indicator-colors', async () => {
  try {
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'MW Colors', extensions: ['mwcolors', 'json'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false };
    const data = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message }; }
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
