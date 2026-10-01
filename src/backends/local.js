// Lazy facade: external backends can launch without loading embedded assets.
const path = require('node:path');
const { createEmbeddedBackend } = require('./embeddedBackend');
let backend, compute = 'auto';
function service() {
  backend ??= createEmbeddedBackend({ dir: path.join(require('electron').app.getPath('userData'), 'multimodal'), getCompute: () => compute });
  return backend;
}
module.exports = {
  MODEL_LABEL: 'Gemma 4 E4B (embedded)', DOWNLOAD_SIZE_TEXT: '~4.6 GB',
  isReady: modelPath => Boolean(modelPath) && require('node:fs').existsSync(modelPath),
  availability: () => require('./embeddedAssets').availability(),
  modelState: () => backend?.modelState() || { state: 'idle' },
  download: options => require('./embeddedAssets').downloadModel(options),
  // Installs and probes the runtime (no model); call before offering the model download.
  prepareRuntime: options => require('./embeddedAssets').prepareRuntime({ ...options, dir: path.join(require('electron').app.getPath('userData'), 'multimodal') }),
  preload: (...args) => service().preload(...args),
  chat: options => service().chat(options),
  translate: options => service().translate(options),
  countTokens: options => service().countTokens(options),
  release: async () => { await backend?.release(); },
  // 'auto' | 'cpu'; takes effect when the runtime is next created (release() then preload()).
  setCompute: mode => { compute = mode; },
  compute: () => compute,
};
