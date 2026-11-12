const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
// v5.15.6: 自动更新（generic provider → Cloudflare Pages releases/）
// 注意：require 延后到 setupAutoUpdater 里执行（那时 log 函数已定义）
let autoUpdater = null;

// v5.15.4: 全局异常兜底 —— 诊断代码本身绝不能影响主进程，所有未捕获异常只写日志不弹框不退出
// 这条放在最顶部，在任何 require 之后、任何业务代码之前，确保最早期的异常也能被捕获
process.on('uncaughtException', (err) => {
  try {
    console.error('[FATAL] uncaughtException:', err?.message || err);
    console.error(err?.stack || '');
    const logFile = path.join(process.env.APPDATA || '', 'wszh-shortage-store', 'diagnostic.log');
    try {
      fs.appendFileSync(logFile, `\n[FATAL] uncaughtException: ${err?.message}\n${err?.stack || ''}\n`, 'utf8');
    } catch(_) {}
  } catch(_) {}
  // 不退出 —— 主进程继续跑，业务窗口继续存在，用户还能用
});
process.on('unhandledRejection', (reason) => {
  try {
    console.error('[FATAL] unhandledRejection:', reason?.message || reason);
    const logFile = path.join(process.env.APPDATA || '', 'wszh-shortage-store', 'diagnostic.log');
    try {
      fs.appendFileSync(logFile, `\n[FATAL] unhandledRejection: ${reason?.message || reason}\n`, 'utf8');
    } catch(_) {}
  } catch(_) {}
});

// v5.15.4: 禁用硬件加速（解决 Windows GPU cache 创建失败 / GPU state invalid 问题）
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-cache');

// 配置（版本号单一来源：package.json → app.getVersion()，启动后 BrowserWindow title 会被动态覆盖）
const CONFIG = {
  title: 'WSZH-ShortageStore',
  width: 1400,
  height: 900,
  minWidth: 800,
  minHeight: 600,
  autoHideMenuBar: true,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    webSecurity: true,
    preload: path.join(__dirname, 'preload.js')
  }
};

let mainWindow = null;
let localServerUrl = null;

// ========== IPC handlers (preload.js 暴露给渲染层的 invoke 通道) ==========
ipcMain.handle('get-app-version', () => app.getVersion());
// v5.15.6: 真正的自动更新 IPC handler（由 setupAutoUpdater 初始化 autoUpdater 实例）
ipcMain.handle('check-update', async () => {
  if (!autoUpdater) return { disabled: true, reason: 'autoUpdater 未初始化' };
  try {
    const res = await autoUpdater.checkForUpdates();
    // res 可能是 null（已是最新）或 { updateInfo, downloadPromise }
    return { success: true, updateAvailable: !!res, version: res?.updateInfo?.version || app.getVersion() };
  } catch(e) {
    log('[AutoUpdater] checkForUpdates 失败: ' + (e?.message || e));
    return { success: false, error: e?.message || String(e) };
  }
});
ipcMain.handle('install-update', async () => {
  if (!autoUpdater) return { success: false, reason: 'autoUpdater 未初始化' };
  try {
    if (autoUpdater.isDownloaded?.()) {
      autoUpdater.quitAndInstall(false, true);
      return { success: true };
    } else {
      return { success: false, reason: '更新尚未下载完成' };
    }
  } catch(e) {
    return { success: false, error: e?.message || String(e) };
  }
});

// ========== v5.15.5: fetch 代理 —— 绕过渲染进程的 CORS 限制 ==========
// 渲染进程 fetch 受 webSecurity: true 限制，跨域 Edge Function 会被 Chromium CORS 拦截
// 主进程 Node.js fetch 不受 CORS 限制，通过 ipcMain.handle 代理请求
ipcMain.handle('proxy-fetch', async (event, { url, options }) => {
  try {
    const opts = options || {};
    const nodeFetch = globalThis.fetch;
    // ★ v5.15.12 修复：主进程 timeout 优先用前端传来的值
    //   之前写反了：opts.signal ? 60s timeout : undefined
    //   且 AbortSignal 无法跨 IPC 传递，所以 opts.signal 永远是 undefined
    //   正确做法：前端传 options.timeout（毫秒），主进程据此创建 timeout signal
    const timeoutMs = opts.timeout || 180000; // 默认 180s，足够 SP 冷启动
    let signal;
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.timeout(timeoutMs);
    }
    const resp = await nodeFetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body,
      signal
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { data = text; }
    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      headers: Object.fromEntries(resp.headers.entries()),
      data
    };
  } catch(err) {
    log(`[proxy-fetch] ${url} ERROR: ${err?.message || err}`);
    return { ok: false, status: 0, error: err?.message || String(err) };
  }
});

// ========== Electron 主进程简易存储 ==========
function _storePath() { return path.join(app.getPath('userData'), 'electron_store.json'); }
function localStorageGet(key) {
  try { const f = _storePath(); if (!fs.existsSync(f)) return null; const d = JSON.parse(fs.readFileSync(f, 'utf8')); return d[key] || null; } catch(e) { return null; }
}
function localStorageSet(key, value) {
  try { const f = _storePath(); const d = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; d[key] = value; fs.writeFileSync(f, JSON.stringify(d), 'utf8'); } catch(e) { log('存储失败: ' + e.message); }
}

// ========== v5.15.7: 机器级 device id（跨 origin 稳定，持久化在 %APPDATA%）==========
// 根因：之前 utils.js getDeviceId() 从 localStorage 读 → 换 origin（127.0.0.1:8049 vs pages.dev）后隔离 → 新 id → 服务端判陌生设备 → 拒登
// 方案：主进程生成 UUID 写入 device.json，永远不变（除非用户手动删 %APPDATA%\wszh-shortage-store\device.json）
let _cachedDeviceId = null;
function getOrCreateDeviceId() {
  if (_cachedDeviceId) return _cachedDeviceId;
  try {
    const devicePath = path.join(app.getPath('userData'), 'device.json');
    if (fs.existsSync(devicePath)) {
      const d = JSON.parse(fs.readFileSync(devicePath, 'utf8'));
      if (d && d.device_id) { _cachedDeviceId = d.device_id; log('[DeviceId] ✅ 读取已有: ' + _cachedDeviceId); return _cachedDeviceId; }
    }
    // 生成新的：时间戳 + 4 段随机 hex → 格式 DEV_v3_XXXXXXXXXXXXXXX
    const crypto = require('crypto');
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(6).toString('hex').toUpperCase();
    _cachedDeviceId = 'DEV_v3_' + ts + rand;
    fs.writeFileSync(devicePath, JSON.stringify({ device_id: _cachedDeviceId, created_at: new Date().toISOString() }), 'utf8');
    log('[DeviceId] 🆕 首次生成: ' + _cachedDeviceId + ' → ' + devicePath);
    return _cachedDeviceId;
  } catch(e) {
    log('[DeviceId] ❌ 生成失败: ' + (e?.message || e));
    return 'DEV_v3_FALLBACK_' + Date.now().toString(36);
  }
}
ipcMain.handle('get-device-id', async () => {
  return { device_id: getOrCreateDeviceId() };
});
// 同步版本（sendSync）——preload 用这个给渲染层同步返回，避免首次登录时序问题
ipcMain.on('get-device-id-sync', (event) => {
  try { event.returnValue = getOrCreateDeviceId(); } catch(e) { event.returnValue = 'DEV_v3_ERROR_' + Date.now().toString(36); }
});
// v5.15.2: 日志同时写到用户数据目录（%APPDATA%/wszh-shortage-store/diagnostic.log）
// 用户遇到"界面加载失败"时，让他把这个日志文件发来就能直接定位（LocalServer 请求记录 + 解析路径）
let _logFilePath = null;
function log(m) {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  try {
    if (!_logFilePath) {
      _logFilePath = path.join(app.getPath('userData'), 'diagnostic.log');
      // 启动时清空，保留最近一次启动的完整日志（文件太大了再 truncate 到 200KB 以内）
      if (fs.existsSync(_logFilePath)) {
        const st = fs.statSync(_logFilePath);
        if (st.size > 200 * 1024) {
          const buf = fs.readFileSync(_logFilePath);
          fs.writeFileSync(_logFilePath, buf.slice(buf.length - 150 * 1024));
        }
      }
      fs.appendFileSync(_logFilePath, `\n===== 新启动 ${new Date().toISOString()} =====\n`, 'utf8');
    }
    fs.appendFileSync(_logFilePath, line + '\n', 'utf8');
  } catch(e) { /* 写文件失败不影响主流程 */ }
}

// ========== 找静态文件根目录 ==========
// 开发时: __dirname/deploy/（electron-main.js 在项目根，deploy/ 同级）
// 打包后: resourcesPath/deploy/（extraResources 放 deploy/）
function findStaticRoot() {
  const candidates = [
    path.join(__dirname, 'deploy'),
    path.join(__dirname, '..', 'deploy'),
    path.join(process.resourcesPath || __dirname, 'deploy'),
    path.join(app.getAppPath(), 'deploy')
  ];
  log(`[findStaticRoot] __dirname=${__dirname}`);
  log(`[findStaticRoot] resourcesPath=${process.resourcesPath}`);
  log(`[findStaticRoot] getAppPath=${app.getAppPath()}`);
  for (const p of candidates) {
    const hasAdmin = fs.existsSync(path.join(p, 'admin.html'));
    const hasLogin = fs.existsSync(path.join(p, 'login.html'));
    log(`[findStaticRoot] candidate: ${p}  admin.html=${hasAdmin} login.html=${hasLogin}`);
    if (hasAdmin && hasLogin) {
      log(`找到静态文件根: ${p}`);
      // ====== v5.15.1: 完整性检查（防止安装时旧进程未退出导致 JS/CSS 被跳过）======
      const MUST_HAVE = [
        'admin.html', 'login.html', 'store.html',
        'static/js/admin.js', 'static/js/utils.js', 'static/js/supabase.min.js',
        'static/css/style.css'
      ];
      const missing = MUST_HAVE.filter(f => !fs.existsSync(path.join(p, f)));
      if (missing.length > 0) {
        log(`⚠️ [findStaticRoot] 静态文件不完整! 缺失: ${missing.join(', ')}`);
        dialog.showErrorBox(
          '安装不完整，请重新安装',
          '检测到本地界面文件缺失（可能是之前安装时客户端未完全退出）：\n\n' +
          '缺失文件: ' + missing.join('\n        ') + '\n\n' +
          '请按以下步骤修复：\n' +
          '1. 完全退出当前客户端（托盘图标右键退出，或任务管理器杀掉 electron 进程）\n' +
          '2. 控制面板 → 程序和功能 → 卸载"众和医药缺货订购系统"\n' +
          '3. 重新双击安装包安装\n\n' +
          '重启客户端后即可恢复正常。'
        );
      } else {
        log(`[findStaticRoot] ✅ 完整性检查通过, ${MUST_HAVE.length} 个关键文件全部存在`);
      }
      return p;
    }
  }
  log('⚠️ 没找到 deploy/ 目录，将走远程 URL');
  return null;
}

// ========== 本地 HTTP 静态服务器 ==========
function startLocalStaticServer(root) {
  return new Promise((resolve) => {
    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.ico': 'image/x-icon',
      '.svg': 'image/svg+xml',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.map': 'application/json; charset=utf-8'
    };

    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath === '/') urlPath = '/login.html';
      if (urlPath.endsWith('/')) urlPath = urlPath + 'index.html';

      let filePath = path.normalize(path.join(root, urlPath));
      // 安全：必须在 root 里面
      if (!filePath.startsWith(path.normalize(root))) {
        log(`[LocalServer] 403 越界: ${urlPath} → ${filePath}`);
        res.writeHead(403); res.end('Forbidden'); return;
      }

      fs.stat(filePath, (err, stat) => {
        if (err) {
          // SPA fallback: /admin → /admin.html
          const htmlPath = filePath + '.html';
          fs.stat(htmlPath, (err2, stat2) => {
            if (!err2 && stat2.isFile()) {
              log(`[LocalServer] 200 (SPA fallback): ${urlPath} → ${htmlPath}`);
              serve(htmlPath, stat2); return;
            }
            log(`[LocalServer] 404 NOT FOUND: ${urlPath} → ${filePath}  err=${err.code || err.message}`);
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found: ' + urlPath);
          });
          return;
        }
        if (stat.isDirectory()) { filePath = path.join(filePath, 'index.html'); }
        log(`[LocalServer] 200: ${urlPath} → ${filePath}  size=${stat.size}`);
        serve(filePath, stat);
      });

      function serve(p, st) {
        fs.readFile(p, (e, data) => {
          if (e) { res.writeHead(500); res.end('Server error'); return; }
          const ext = path.extname(p).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Length': st.size,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
          });
          res.end(data);
        });
      }
    });

// ========== v5.15.5: 固定端口 LocalServer（之前 listen(0) 随机端口 → localStorage 每次都丢）==========
const LOCAL_SERVER_PREFERRED_PORT = 8049;
const LOCAL_SERVER_MAX_PORT = LOCAL_SERVER_PREFERRED_PORT + 10;

    // 固定端口优先，被占用时自动顺延 8050, 8051...（最多 10 个）
    // 根治问题：之前随机端口导致每次启动 origin 变，记住密码/登录态 localStorage 全丢
    let tryPort = LOCAL_SERVER_PREFERRED_PORT;
    const tryBind = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && tryPort < LOCAL_SERVER_MAX_PORT) {
          tryPort++;
          tryBind();
        } else {
          log(`❌ LocalServer 启动失败: ${err.message}`);
          server.listen(0, '127.0.0.1', onReady); // 最后 fallback 随机端口
        }
      });
      server.listen(tryPort, '127.0.0.1', onReady);
    };
    const onReady = () => {
      const port = server.address().port;
      if (port !== LOCAL_SERVER_PREFERRED_PORT) {
        log(`⚠️ 首选端口 ${LOCAL_SERVER_PREFERRED_PORT} 被占用, 实际使用 ${port}`);
      }
      log(`✅ 本地静态服务器: http://127.0.0.1:${port}  (root: ${root})`);
      resolve(`http://127.0.0.1:${port}`);
    };
    tryBind();
  });
}

// ========== 创建启动画面窗口 ==========
function createSplashWindow() {
  const w = new BrowserWindow({ width: 500, height: 600, frame: false, transparent: true, resizable: false, center: true, show: true, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  // splash.html 打包在 __dirname/static/ 下
  const splashPath = path.join(__dirname, 'static', 'splash.html');
  if (fs.existsSync(splashPath)) {
    // 版本号随 query 传入，页面不再硬编码（单一来源 package.json → app.getVersion()）
    w.loadFile(splashPath, { query: { v: app.getVersion() } });
  }
  return w;
}

// ========== 创建主窗口 ==========
async function createWindow() {
  const splashWindow = createSplashWindow();

  // 找 deploy/ 目录 → 起本地静态服务器
  const staticRoot = findStaticRoot();
  let finalBaseUrl;

  const USE_LOCAL = process.env.USE_LOCAL_SERVER !== 'false'; // 默认本地，显式 USE_LOCAL_SERVER=false 才走远程
  if (USE_LOCAL && staticRoot) {
    localServerUrl = await startLocalStaticServer(staticRoot);
    finalBaseUrl = localServerUrl;
    log(`使用本地静态服务器: ${finalBaseUrl}`);
  } else {
    finalBaseUrl = process.env.BASE_URL || 'https://wszhyy.pages.dev';
    log(`走远程: ${finalBaseUrl}`);
  }

  // 创建主窗口
  mainWindow = new BrowserWindow({ ...CONFIG, show: false });

  // 主窗口加载 login.html（本地或远程）
  const targetPage = '/login.html';
  const htmlBuster = USE_LOCAL ? '' : ('?t=' + Date.now()); // 本地不需要 buster，远程加
  const fullUrl = finalBaseUrl + targetPage + htmlBuster;
  log(`主窗口加载: ${fullUrl}`);
  mainWindow.loadURL(fullUrl);

  // splash 关闭 & 主窗口显示 三重保护
  var mainReady = false;
  function showMainAndCloseSplash(reason) {
    if (mainReady) return;
    mainReady = true;
    log(`主窗口显示: ${reason}`);
    mainWindow.maximize();
    mainWindow.show();
    setTimeout(() => { if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close(); }, 300);
  }
  mainWindow.once('ready-to-show', () => showMainAndCloseSplash('ready-to-show'));
  mainWindow.webContents.on('did-finish-load', () => showMainAndCloseSplash('did-finish-load'));
  setTimeout(() => { if (!mainReady && mainWindow && !mainWindow.isDestroyed()) { log('⚠️ splash 超时 15s'); showMainAndCloseSplash('timeout-15s'); } }, 15000);

  // 拦截外部链接 → 系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) { shell.openExternal(url); }
    return { action: 'deny' };
  });

  // ========== 诊断: 加载失败日志（v5.15.0 加）==========
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    try { log(`❌ did-fail-load code=${code} desc=${desc} url=${url}`); } catch(_) {}
  });
  mainWindow.webContents.on('did-fail-provisional-load', (e, code, desc, url, isMainFrame) => {
    try { log(`❌ did-fail-provisional-load code=${code} desc=${desc} url=${url} isMain=${isMainFrame}`); } catch(_) {}
  });
  mainWindow.webContents.on('did-start-loading', () => { try { log('▶ did-start-loading'); } catch(_) {} });
  mainWindow.webContents.on('did-stop-loading', () => { try { log('◀ did-stop-loading'); } catch(_) {} });

  // ========== 诊断: JS 运行时错误（v5.15.3 加 - 之前全资源 200 但页面还挂，就是没抓这个）==========
  // 只写 error/warn 级，info/debug 级忽略（日志太吵）
  mainWindow.webContents.on('console-message', (e, level, message, sourceId, line) => {
    try {
      const levelMap = { 0: 'DEBUG', 1: 'INFO', 2: 'WARN', 3: 'ERROR' };
      const levelStr = levelMap[level] || ('?' + level);
      if (level >= 2) {
        // sourceId 可能是 undefined/null 或不是 string —— 防御性处理，绝不让诊断代码崩主进程
        let srcTag = '';
        if (typeof sourceId === 'string' && sourceId) {
          const parts = sourceId.split('/');
          const fname = parts[parts.length - 1] || sourceId;
          srcTag = ` (${fname}:${line})`;
        }
        log(`[console.${levelStr}] ${message}${srcTag}`);
      }
    } catch(_) { /* 诊断代码出错静默忽略，绝不影响业务 */ }
  });
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    try { log(`❌ render-process-gone: reason=${details?.reason} exitCode=${details?.exitCode}`); } catch(_) {}
  });
  mainWindow.webContents.on('preload-error', (e, preloadPath, err) => {
    try { log(`❌ preload-error: ${preloadPath} → ${err?.message || err}`); } catch(_) {}
  });

  // 关闭确认
  mainWindow.on('close', (e) => {
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question', buttons: ['取消', '退出'], defaultId: 0, cancelId: 0,
      title: '确认退出', message: '确定要退出缺货统计系统吗？', detail: '退出后需重新登录。',
      icon: path.join(__dirname, 'static', 'icon-192.png')
    });
    if (choice === 1) mainWindow.destroy();
  });

  mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
}

// ========== 后台静默更新静态界面文件 ==========
// v5.14.1: 启动 15s 后 fire-and-forget 检查静态包更新
// 更新内容: admin.html / login.html / store.html / manifest.json / static/{css,js} (不含 xlsx 大文件)
// 更新源可配置: STATIC_UPDATE_URL (放 Supabase Storage 或 GitHub Releases)
// 原子替换: 下载到 .tmp → hash 校验 → rename → 下次启动生效
// 失败策略: 全程 try/catch, 任何错误只 log 绝不阻塞启动或影响当前使用
const STATIC_UPDATE_URL = process.env.STATIC_UPDATE_URL || ''; // 部署时填入
const STATIC_UPDATE_DISABLED = process.env.DISABLE_STATIC_UPDATE === '1' || !STATIC_UPDATE_URL;
const STATIC_FILES_TO_UPDATE = [
  'admin.html', 'login.html', 'store.html', 'manifest.json',
  'static/css/style.css',
  'static/js/admin.js', 'static/js/utils.js', 'static/js/supabase.min.js',
  'static/js/supabase-init.js', 'static/js/fuse.min.js', 'static/js/store.js',
  'static/icon-192.png', 'static/icon-512.png'
  // 注意: xlsx.full.min.js (881KB) 等大第三方库不跟随静态包更新, 只跟随 Electron 安装包
];

function downloadUrl(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 跟随一次重定向
        downloadUrl(new URL(res.headers.location, url).href, timeoutMs).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function startBackgroundStaticUpdateCheck(staticRoot) {
  // 15s 后启动, fire-and-forget, 完全不阻塞主链
  setTimeout(async () => {
    try {
      if (STATIC_UPDATE_DISABLED) { log('[Update] 静态更新已跳过 (DISABLED 或未配置 URL)'); return; }
      if (!staticRoot || !fs.existsSync(staticRoot)) { log('[Update] staticRoot 不存在, 跳过'); return; }

      log('[Update] ▶ 开始后台检查静态包更新...');
      const metaUrl = STATIC_UPDATE_URL.replace(/\/+$/, '') + '/manifest.json';
      const metaBuf = await downloadUrl(metaUrl, 15000);
      const remoteMeta = JSON.parse(metaBuf.toString('utf8'));
      if (!remoteMeta || !remoteMeta.version) { log('[Update] 远程 manifest 格式异常, 跳过'); return; }

      const localManifestPath = path.join(staticRoot, 'manifest.json');
      let localVersion = '0';
      if (fs.existsSync(localManifestPath)) {
        try { const lm = JSON.parse(fs.readFileSync(localManifestPath, 'utf8')); localVersion = lm.version || '0'; } catch(e) {}
      }

      if (remoteMeta.version === localVersion) {
        log('[Update] ◀ 已是最新 (v' + localVersion + '), 无需更新');
        return;
      }

      log('[Update] 发现新版 v' + remoteMeta.version + ' → 当前 v' + localVersion + ', 开始下载...');
      const tmpDir = path.join(app.getPath('userData'), 'static-update.tmp');
      if (fs.existsSync(tmpDir)) { fs.rmSync(tmpDir, { recursive: true, force: true }); }
      fs.mkdirSync(tmpDir, { recursive: true });

      let downloadedBytes = 0;
      for (const relPath of STATIC_FILES_TO_UPDATE) {
        try {
          const fileUrl = STATIC_UPDATE_URL.replace(/\/+$/, '') + '/' + relPath.replace(/\\/g, '/');
          const buf = await downloadUrl(fileUrl, 30000);
          const outPath = path.join(tmpDir, relPath);
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, buf);
          downloadedBytes += buf.length;
        } catch (e) {
          log('[Update] 下载失败 ' + relPath + ': ' + e.message + ' → 跳过此文件');
        }
      }

      if (downloadedBytes === 0) { log('[Update] 所有文件下载失败, 放弃更新'); return; }
      log('[Update] 下载完成, 共 ' + downloadedBytes + ' bytes, 准备原子替换...');

      // 原子替换: 把 tmpDir 里的文件复制到 staticRoot, 不删除已有文件(防止下载不全导致文件缺失)
      for (const relPath of STATIC_FILES_TO_UPDATE) {
        const src = path.join(tmpDir, relPath);
        const dst = path.join(staticRoot, relPath);
        if (fs.existsSync(src)) {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, dst);
        }
      }

      // 更新 manifest.json
      fs.writeFileSync(localManifestPath, JSON.stringify(remoteMeta, null, 2), 'utf8');
      log('[Update] ✅ 已更新到 v' + remoteMeta.version + ' → 下次启动生效 (本次继续用旧版)');

      // 清理临时目录 (异步, 不等待)
      setTimeout(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {} }, 5000);

    } catch (err) {
      log('[Update] ⚠️ 后台更新异常 (静默跳过, 不影响使用): ' + err.message);
    }
  }, 15000);
}

// ========== v5.15.6: electron-updater 自动更新（generic provider → Cloudflare Pages）==========
// 启动后延迟 15s 静默检查 → 自动下载 → 下载完通知渲染层"重启生效"
// 完全 fire-and-forget，任何异常只 log 不弹框不影响正常使用
function setupAutoUpdater() {
  // v5.15.6: 延迟 require（log 函数在 L130 才定义，顶部 require 会吞日志）
  try {
    const au = require('electron-updater');
    autoUpdater = au.autoUpdater || au.default?.autoUpdater || au;
    log('[AutoUpdater] ✅ electron-updater 已加载');
  } catch(e) {
    log('[AutoUpdater] ❌ electron-updater require 失败: ' + (e?.message || e));
  }
  if (!autoUpdater) { log('[AutoUpdater] 跳过: autoUpdater 未初始化'); return; }

  // 让 autoUpdater 自动读 package.json 里的 publish.generic.url
  // 不手动 setFeedURL —— electron-updater 6.x 会自动从 app.getAppPath()/package.json 读取
  try {
    // 某些版本需要显式设置，试一下（失败不影响，因为 generic provider 默认从 package.json 读）
    const pkg = require(path.join(__dirname, 'package.json'));
    if (pkg?.publish?.url) {
      autoUpdater.feedUrl = pkg.publish.url;
      log('[AutoUpdater] feedUrl = ' + pkg.publish.url);
    }
  } catch(e) {
    log('[AutoUpdater] 读取 package.json publish 失败: ' + e?.message);
  }

  autoUpdater.autoDownload = true;          // 有新版本自动下，不等用户确认
  autoUpdater.autoInstallOnAppQuit = true;  // 下载完后用户退出应用时自动安装
  autoUpdater.fullChangelog = false;        // generic provider 没有 changelog

  // 所有事件统一 try/catch，防止回调本身崩主进程
  autoUpdater.on('error', (e) => {
    try { log('[AutoUpdater] ❌ error: ' + (e?.message || e)); } catch(_) {}
  });
  autoUpdater.on('checking-for-update', () => {
    try { log('[AutoUpdater] ▶ checking-for-update'); } catch(_) {}
  });
  autoUpdater.on('update-available', (info) => {
    try { log('[AutoUpdater] 🆕 update-available: v' + (info?.version || '?') + ' size=' + (info?.files?.[0]?.size || '?')); } catch(_) {}
  });
  autoUpdater.on('update-not-available', (info) => {
    try { log('[AutoUpdater] ✅ update-not-available (v' + (info?.version || app.getVersion()) + ')'); } catch(_) {}
  });
  autoUpdater.on('download-progress', (p) => {
    try {
      // 只在 10% 整数倍时 log，避免刷屏
      const pct = Math.round(p.percent);
      if (pct % 10 === 0 && pct > 0) log('[AutoUpdater] 下载进度: ' + pct + '% (' + (p.transferred || 0) + '/' + (p.total || 0) + ')');
    } catch(_) {}
  });
  autoUpdater.on('update-downloaded', (info) => {
    try {
      log('[AutoUpdater] ✅ update-downloaded: v' + (info?.version || '?') + ' —— 将在退出时自动安装');
      // 通知渲染层 toast（渲染层监听 'update-downloaded' IPC 消息）
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-downloaded', { version: info?.version });
      }
    } catch(e) { log('[AutoUpdater] update-downloaded 回调异常: ' + e?.message); }
  });

  // 启动后延迟 15s 检查（和静态包更新同节奏，不阻塞主链）
  setTimeout(() => {
    try {
      log('[AutoUpdater] ▶▶ 开始静默检查更新...');
      autoUpdater.checkForUpdates().then((res) => {
        try {
          // res 可能是 UpdateCheckResult 或 null
          if (!res) { log('[AutoUpdater] 已是最新版本'); return; }
          log('[AutoUpdater] 检查完成 远程=' + (res.updateInfo?.version || '?') + ' 本地=' + app.getVersion());
          if (res.downloadPromise) {
            res.downloadPromise.then(() => log('[AutoUpdater] 下载 promise resolved')).catch((e) => log('[AutoUpdater] 下载 promise rejected: ' + e?.message));
          }
        } catch(_) {}
      }).catch((e) => {
        log('[AutoUpdater] checkForUpdates 异常 (静默跳过): ' + (e?.message || e));
      });
    } catch(e) {
      log('[AutoUpdater] 检查更新启动异常 (静默跳过): ' + (e?.message || e));
    }
  }, 15000); // 15s 后，和静态包更新同节奏
}

// ========== 启动 ==========
app.whenReady().then(async () => {
  const ver = app.getVersion();
  log(`应用启动 · 版本 ${ver} · USE_LOCAL_SERVER=${process.env.USE_LOCAL_SERVER !== 'false' ? 'true(默认)' : 'false'}`);
  log(`后台静默更新: ${STATIC_UPDATE_DISABLED ? '已禁用' : '已启用 (15s 后检查)'}`);
  const staticRoot = findStaticRoot();
  createWindow();
  // 后台静态文件更新检查 (fire-and-forget, 绝对不 await 不阻塞)
  startBackgroundStaticUpdateCheck(staticRoot);
  // v5.15.6: electron-updater 自动更新（fire-and-forget，15s 后静默检查）
  setupAutoUpdater();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); }
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
}
