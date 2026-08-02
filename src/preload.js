const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tranzl', {
  translate: (options) => ipcRenderer.invoke('translate', options),
  onTranslationEvent: (callback) =>
    ipcRenderer.on('translation-event', (_event, data) => callback(data)),
  listModels: () => ipcRenderer.invoke('list-models'),
  getSetup: () => ipcRenderer.invoke('get-setup'),
  chooseBackend: (backend) => ipcRenderer.invoke('choose-backend', backend),
  downloadModel: () => ipcRenderer.invoke('download-model'),
  onSetupEvent: (callback) =>
    ipcRenderer.on('setup-event', (_event, data) => callback(data)),
  onBackendStatus: (callback) =>
    ipcRenderer.on('backend-status', (_event, data) => callback(data)),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  cancelTranslate: () => ipcRenderer.invoke('cancel-translate'),
  loadHistory: () => ipcRenderer.invoke('history-load'),
  saveHistory: (entries) => ipcRenderer.invoke('history-save', entries),
});
