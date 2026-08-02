// Renders build/icon.html to a transparent 1024px PNG using Electron itself
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });
  await win.loadFile(path.join(__dirname, 'icon.html'));
  await new Promise((r) => setTimeout(r, 600));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(__dirname, 'icon_1024.png'), image.toPNG());
  console.log('written build/icon_1024.png', image.getSize());
  app.exit(0);
});
