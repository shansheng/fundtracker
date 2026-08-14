const { app, BrowserWindow } = require('electron');
const path = require('path');
const { startServer, stopServer } = require('../server/index');

// 在部分无显卡/沙箱环境下，Chromium GPU 进程会初始化失败并打印错误。
// 禁用 GPU 与软件光栅化可消除该报错（不影响本应用功能）。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 开发时指向本地服务，生产时加载打包后的前端
  // 必须用 127.0.0.1 而非 localhost：服务端只监听 127.0.0.1(IPv4)，
  // Chromium 对 localhost 优先解析到 IPv6 ::1 且常不回退，会导致窗口连不上后端、显示无数据。
  const serverUrl = process.env.FUNDTRACKER_API || 'http://127.0.0.1:3456';
  mainWindow.loadURL(serverUrl);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});
