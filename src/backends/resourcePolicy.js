// Memory policy for CPU-class targets (user decision, 2026-10-01): below the 12 GB class the
// embedded model is not offered; the 12 GB class runs a 4,096-token context; 16 GB and up run
// the full 8,192. macOS keeps its validated behaviour unchanged. Thresholds sit a little below
// the nominal sizes because systems report slightly less than their installed memory.
const os = require('node:os');
const GIB = 2 ** 30;
const FULL_CONTEXT = 8192, REDUCED_CONTEXT = 4096;
const FULL_MIN_GIB = 15, REDUCED_MIN_GIB = 11;
// Evaluation-only: lets the harness exercise another tier on any machine (documented in README).
const override = () => Number(process.env.TRANZL_EVALUATION_TOTAL_MEMORY_GIB) * GIB || null;

function resourcePolicy({ totalMemoryBytes = override() ?? os.totalmem(), platform = override() ? 'cpu-class' : process.platform } = {}) {
  const gib = totalMemoryBytes / GIB, shown = `${Math.round(gib)} GB`;
  if (platform === 'darwin') return { available: true, contextSize: FULL_CONTEXT, memoryGiB: gib };
  if (gib < REDUCED_MIN_GIB) {
    return { available: false, contextSize: null, memoryGiB: gib,
      reason: `The embedded model needs at least 12 GB of memory on this computer; it has ${shown}. Use LM Studio or Ollama instead.` };
  }
  if (gib < FULL_MIN_GIB) {
    return { available: true, contextSize: REDUCED_CONTEXT, memoryGiB: gib,
      note: `This computer has ${shown} of memory, so the embedded model uses a smaller context (${REDUCED_CONTEXT.toLocaleString('en-US')} tokens instead of ${FULL_CONTEXT.toLocaleString('en-US')}).` };
  }
  return { available: true, contextSize: FULL_CONTEXT, memoryGiB: gib };
}
module.exports = { resourcePolicy, FULL_CONTEXT, REDUCED_CONTEXT };
