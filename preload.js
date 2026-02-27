const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  // Theme
  checkMW: () => ipcRenderer.invoke('check-mw'),
  readCurrentTheme: () => ipcRenderer.invoke('read-current-theme'),
  applyTheme: (css, font) => ipcRenderer.invoke('apply-theme', { css, font }),
  restoreTheme: () => ipcRenderer.invoke('restore-theme'),
  exportCSS: (css) => ipcRenderer.invoke('export-css', { css }),
  // Chart colors
  readChartColors: () => ipcRenderer.invoke('read-chart-colors'),
  saveChartColors: (chart, bars) => ipcRenderer.invoke('save-chart-colors', { chart, bars }),
  // Presets
  loadPresets: () => ipcRenderer.invoke('load-presets'),
  savePreset: (name, data) => ipcRenderer.invoke('save-preset', { name, data }),
  deletePreset: (name) => ipcRenderer.invoke('delete-preset', { name }),
  // Share
  exportThemeJSON: (themeData) => ipcRenderer.invoke('export-theme-json', { themeData }),
  importThemeJSON: () => ipcRenderer.invoke('import-theme-json'),
  // Trading colors (workspace config)
  readTradingColors: () => ipcRenderer.invoke('read-trading-colors'),
  saveTradingColors: (data) => ipcRenderer.invoke('save-trading-colors', data),
  // Export/Import All (.mwtheme bundle)
  exportAll: (bundle) => ipcRenderer.invoke('export-all', bundle),
  importAll: () => ipcRenderer.invoke('import-all'),
  // System Preferences
  openFDASettings: () => ipcRenderer.invoke('open-fda-settings'),
  // Full theme CSS
  readUITheme: () => ipcRenderer.invoke('read-ui-theme'),
  // Undo/Redo from menu
  onUndo: (cb) => ipcRenderer.on('app-undo', cb),
  onRedo: (cb) => ipcRenderer.on('app-redo', cb),
});
