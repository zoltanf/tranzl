const fs = require('node:fs');
const { createServerRuntime } = require('./serverRuntime');
const assets = require('./embeddedAssets');
const { resourcePolicy } = require('./resourcePolicy');

// getCompute: 'auto' | 'cpu', read when a runtime is created (so release() + preload() applies a change).
function createEmbeddedBackend({ dir, assetManager = assets, makeRuntime = createServerRuntime, contextSize = resourcePolicy().contextSize, getCompute = () => 'auto' }) {
  let runtime = null, selectedModel = null, status = { state: 'idle' }, statusCallback = null;
  function publish(value) { status = value; statusCallback?.(value); }
  // Status always reflects the live runtime (effective context, compute, fallback), not the policy defaults.
  const snapshot = (state, extra = {}) => {
    const live = runtime?.state();
    return { state, contextSize: live?.contextSize ?? contextSize, compute: live?.compute, fallback: live?.fallback ?? null, contextReduced: live?.contextReduced ?? null, ...extra };
  };
  function getRuntime(modelPath) {
    if (!modelPath) throw new Error('Download the embedded model in Settings first.');
    if (contextSize == null) throw new Error('The embedded model is not available on this computer (see Settings).');
    if (runtime && selectedModel !== modelPath) throw new Error('The embedded model changed. Restart Tranzl to load the new model.');
    if (!runtime) {
      const { binary, projector } = assetManager.paths(dir);
      selectedModel = modelPath;
      runtime = makeRuntime({ binary, projectorPath: projector, modelPath, contextSize, gpu: getCompute(),
        prepareAssets: async options => {
          publish({ state: 'loading' });
          await assetManager.prepare({ ...options, dir, modelPath });
        },
        // The runtime may report a reduced effective context (see serverRuntime recovery).
        onStatus: value => publish({ ...value, contextSize: value.contextSize ?? contextSize }),
      });
    }
    return runtime;
  }
  async function invoke(method, options) {
    try { return await getRuntime(options.modelPath)[method](options); }
    catch (error) {
      if (options.signal?.aborted) publish(snapshot(runtime?.state().ready ? 'ready' : 'idle'));
      else publish(snapshot('error', { error: error.message }));
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
    // Releases the runtime that exists now; a runtime created meanwhile (e.g. by a later preload) is kept.
    async release() {
      const releasing = runtime;
      await releasing?.stop();
      if (runtime === releasing) { runtime = null; selectedModel = null; publish({ state: 'idle' }); }
    },
  };
}
module.exports = { createEmbeddedBackend };
