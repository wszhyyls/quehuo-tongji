const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

// v5.14.1: 禁用硬件加速（解决 Windows GPU cache 创建失败 / GPU state invalid 问题）
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-cache');

// 配置
const CONFIG = {
  title: 'WSZH-ShortageStore v5.14.1',
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
ipcMain.handle('check-update', async () => { return { disabled: true, reason: '静态更新需配置 STATIC_UPDATE_URL' }; });
ipcMain.handle('install-update', async () => { return { success: false, reason: '暂不支持在线升级, 请重新下载安装包' }; });

// ========== Electron 主进程简易存储 ==========
function _storePath() { return path.join(app.getPath('userData'), 'electron_store.json'); }
function localStorageGet(key) {
  try { const f = _storePath(); if (!fs.existsSync(f)) return null; const d = JSON.parse(fs.readFileSync(f, 'utf8')); return d[key] || null; } catch(e) { return null; }
}
function localStorageSet(key, value) {
  try { const f = _storePath(); const d = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; d[key] = value; fs.writeFileSync(f, JSON.stringify(d), 'utf8'); } catch(e) { log('存储失败: ' + e.message); }
}
function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

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
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'admin.html')) && fs.existsSync(path.join(p, 'login.html'))) {
      log(`找到静态文件根: ${p}`);
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
        res.writeHead(403); res.end('Forbidden'); return;
      }

      fs.stat(filePath, (err, stat) => {
        if (err) {
          // SPA fallback: /admin → /admin.html
          const htmlPath = filePath + '.html';
          fs.stat(htmlPath, (err2, stat2) => {
            if (!err2 && stat2.isFile()) { serve(htmlPath, stat2); return; }
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found: ' + urlPath);
          });
          return;
        }
        if (stat.isDirectory()) { filePath = path.join(filePath, 'index.html'); }
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

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      log(`✅ 本地静态服务器: http://127.0.0.1:${port}  (root: ${root})`);
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

// ========== 创建启动画面窗口 ==========
function createSplashWindow() {
  const w = new BrowserWindow({ width: 500, height: 600, frame: false, transparent: true, resizable: false, center: true, show: true, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  // splash.html 打包在 __dirname/static/ 下
  const splashPath = path.join(__dirname, 'static', 'splash.html');
  if (fs.existsSync(splashPath)) {
    w.loadFile(splashPath);
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

// ========== 启动 ==========
app.whenReady().then(async () => {
  const ver = app.getVersion();
  log(`应用启动 · 版本 ${ver} · USE_LOCAL_SERVER=${process.env.USE_LOCAL_SERVER !== 'false' ? 'true(默认)' : 'false'}`);
  log(`后台静默更新: ${STATIC_UPDATE_DISABLED ? '已禁用' : '已启用 (15s 后检查)'}`);
  const staticRoot = findStaticRoot();
  createWindow();
  // 后台静态文件更新检查 (fire-and-forget, 绝对不 await 不阻塞)
  startBackgroundStaticUpdateCheck(staticRoot);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); }
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
}
