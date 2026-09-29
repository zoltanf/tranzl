const fs = require('node:fs');
const { createServerRuntime } = require('./serverRuntime');
const assets = require('./embeddedAssets');

function createEmbeddedBackend({ dir, assetManager = assets, makeRuntime = createServerRuntime }) {
  let runtime = null, selectedModel = null, status = { state: 'idle' }, statusCallback = null;
  function publish(value) { status = value; statusCallback?.(value); }
  function getRuntime(modelPath) {
    if (!modelPath) throw new Error('Download the embedded model in Settings first.');
    if (runtime && selectedModel !== modelPath) throw new Error('The embedded model changed. Restart Tranzl to load the new model.');
    if (!runtime) {
      const { binary, projector } = assetManager.paths(dir);
      selectedModel = modelPath;
      runtime = makeRuntime({ binary, projectorPath: projector, modelPath, contextSize: 8192,
        prepareAssets: async options => {
          publish({ state: 'loading' });
          await assetManager.prepare({ ...options, dir, modelPath });
        },
        onStatus: value => publish({ ...value, contextSize: 8192 }),
      });
    }
    return runtime;
  }
  async function invoke(method, options) {
    try { return await getRuntime(options.modelPath)[method](options); }
    catch (error) {
      if (options.signal?.aborted) publish({ state: runtime?.state().ready ? 'ready' : 'idle', contextSize: 8192 });
      else publish({ state: 'error', error: error.message });
      throw error;
    }
  }
  return {
    MODEL_LABEL: 'Gemma 4 E4B (embedded)', DOWNLOAD_SIZE_TEXT: '~4.6 GB',
    isReady: modelPath => Boolean(modelPath) && fs.existsSync(modelPath),
    download: options => assetManager.downloadModel(options),
    modelState: () => status,
    preload(modelPath, callback) {
      if (callback) statusCallback = callback;
      // Errors are delivered through status, never an unhandled background rejection.
      return invoke('load', { modelPath }).catch(() => {});
    },
    chat: options => invoke('chat', options),
    translate: options => invoke('chat', { ...options, messages: options.messages || [...(options.history || []), { role: 'user', content: options.text }] }),
    countTokens: options => invoke('countTokens', options),
    async release() { await runtime?.stop(); runtime = null; selectedModel = null; publish({ state: 'idle' }); },
  };
}
module.exports = { createEmbeddedBackend };
