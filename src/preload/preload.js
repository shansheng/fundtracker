// 前端通过 fetch 直接访问本地 Express 服务 (http://127.0.0.1:3456/api)
// 注意：必须用 127.0.0.1 而非 localhost —— 服务端只监听 127.0.0.1(IPv4)，
// 而 Chromium 对 localhost 优先解析到 IPv6 ::1 且常不回退，会导致 Electron 窗口连不上后端、表格空白。
// 注意：不要在此用 contextBridge.exposeInMainWorld('api', ...) 暴露名为 'api' 的对象，
// 否则会与渲染进程 app.js 中的 `const api` 全局声明冲突，导致 "Identifier 'api' has already been declared"。
window.API_BASE = 'http://127.0.0.1:3456/api';
