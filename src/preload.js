const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tranzl', {
  clipboardImage: () => ipcRenderer.invoke('clipboard-image'),
  chatModelInfo: (model) => ipcRenderer.invoke('chat-model-info', model),
  chatSend: (options) => ipcRenderer.invoke('chat-send', options),
  chatStop: () => ipcRenderer.invoke('chat-stop'),
  chatLoad: () => ipcRenderer.invoke('chat-load'),
  chatSave: (data) => ipcRenderer.invoke('chat-save', data),
  chatAttach: () => ipcRenderer.invoke('chat-attach'),
  onChatEvent: (callback) => ipcRenderer.on('chat-event', (_event, data) => callback(data)),
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
