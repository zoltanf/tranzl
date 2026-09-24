const { parentPort, workerData } = require('worker_threads');
const { readAttachment } = require('./attachments');
readAttachment(workerData).then(file => parentPort.postMessage({ file }), error => parentPort.postMessage({ error: error.message }));
