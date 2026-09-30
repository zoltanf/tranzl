// Only the app's own top-level page may call the main process, so decrypted chats, history
// and file dialogs are never reachable from another document or frame.
const { pathToFileURL } = require('url');
function trustedIpc(ipcMain, page) {
  const expected = pathToFileURL(page).href;
  const trusted = event => {
    const frame = event.senderFrame;
    return Boolean(frame) && !frame.parent && frame.url.split(/[?#]/)[0] === expected;
  };
  return {
    handle: (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) throw new Error(`Blocked ${channel} from an untrusted page`);
      return handler(event, ...args);
    }),
  };
}
module.exports = { trustedIpc };
