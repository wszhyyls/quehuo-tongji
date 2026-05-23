const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

// 配置
const CONFIG = {
  title: 'WSZH-ShortageStore v3.19.0',
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

// 更新服务器地址
const UPDATE_CHECK_URL = 'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/check-update';
const UPDATE_FILES_URL = 'https://github.com/wszhyyls/quehuo-tongji/releases/download/v3.19.0/';  // GitHub Releases

let mainWindow = null;

// 日志函数
function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

// 创建启动画面窗口（最先执行，秒开）
function createSplashWindow() {
  const splashWindow = new BrowserWindow({
    width: 500,
    height: 600,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    show: true,  // 立即显示，不等待内容加载
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // 使用本地文件加载（更快）
  var splashPath = path.join(__dirname, 'static', 'splash.html');
  splashWindow.loadFile(splashPath);

  return splashWindow;
}

// 创建主窗口（async：先清缓存再加载）
async function createWindow() {
  // 立即创建启动画面（不等待任何资源）
  const splashWindow = createSplashWindow();

  // 清除 HTTP 缓存和 cookies（保留 localStorage 中的设备码）
  var { session } = require('electron');
  try {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData({ storages: ['cookies', 'cachestorage'] });
    log('缓存和cookies已清除（localStorage已保留）');
  } catch(err) {
    log('清除缓存失败: ' + err.message);
  }

  // 创建主窗口（隐藏状态）
  mainWindow = new BrowserWindow({
    ...CONFIG,
    show: false
  });

  // 从 Cloudflare 加载（带强制缓存绕过）
  var BASE_URL = process.env.BASE_URL || 'https://wszhyy.pages.dev';
  var cacheBuster = 'v=3.18.7&t=' + Date.now();
  mainWindow.loadURL(BASE_URL + '/login.html?' + cacheBuster, {
    extraHeaders: 'Cache-Control: no-cache, no-store, must-revalidate\nPragma: no-cache'
  });

  // 页面加载完成后显示主窗口
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.maximize();
    mainWindow.show();
    
    // 延长过渡时间，确保动画完整播放后平滑过渡
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
      }
    }, 800);
  });

  // 关闭窗口时弹出确认提示
  mainWindow.on('close', (e) => {
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['取消', '退出'],
      defaultId: 0,
      cancelId: 0,
      title: '确认退出',
      message: '确定要退出缺货统计系统吗？',
      detail: '退出后需重新登录。',
      icon: path.join(__dirname, 'static', 'icon-192.png')
    });
    if (choice === 1) {
      mainWindow.destroy();
    }
  });

  // 窗口销毁后退出应用
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

// 检查更新（自己实现版本检测，不依赖 electron-updater 的 generic provider）
async function checkForUpdates() {
  try {
    log('开始检查更新...');
    const currentVersion = app.getVersion();
    
    // 调用 check-update Edge Function 获取最新版本信息
    const response = await fetch(UPDATE_CHECK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: currentVersion })
    });
    
    if (!response.ok) {
      log(`更新检查失败: HTTP ${response.status}`);
      return;
    }
    
    const result = await response.json();
    log(`服务器版本: ${result.data?.version}, 当前版本: ${currentVersion}`);
    
    if (result.success && result.data?.updateAvailable) {
      log(`发现新版本: ${result.data.version}`);
      
      // 向渲染进程发送更新通知
      if (mainWindow) {
        mainWindow.webContents.send('update-available', {
          version: result.data.version,
          releaseNotes: result.data.releaseNotes,
          downloadUrl: result.data.downloadUrl
        });
      }
      
      // 使用 electron-updater 通用提供者下载
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: UPDATE_FILES_URL
      });
      
      autoUpdater.on('download-progress', (progress) => {
        if (mainWindow) {
          mainWindow.webContents.send('update-progress', { percent: progress.percent });
        }
      });
      
      autoUpdater.on('update-downloaded', (info) => {
        log('更新下载完成');
        if (mainWindow) {
          mainWindow.webContents.send('update-downloaded', { version: info.version });
        }
      });
      
      autoUpdater.on('error', (error) => {
        log(`下载错误: ${error.message}`);
        // 下载失败时仍通知用户手动下载
        if (mainWindow) {
          mainWindow.webContents.send('update-available', {
            version: result.data.version,
            releaseNotes: result.data.releaseNotes + '\n\n(自动下载失败，请手动下载)',
            downloadUrl: result.data.downloadUrl
          });
        }
      });
      
      await autoUpdater.downloadUpdate();
    } else {
      log('已是最新版本');
    }
    
  } catch (error) {
    log(`检查更新失败: ${error.message}`);
  }
}

// 安装更新并重启
function installUpdate() {
  log('开始安装更新并重启...');
  autoUpdater.quitAndInstall(false, true);
}

// IPC 处理器
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('check-update', async () => {
  await checkForUpdates();
});

ipcMain.handle('install-update', () => {
  installUpdate();
});

// 应用就绪
app.whenReady().then(() => {
  log('应用启动');
  createWindow();

  // macOS 特殊处理
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // 启动后检查更新（非阻塞）
  setTimeout(() => {
    checkForUpdates();
  }, 3000); // 3秒后检查更新
});

// 所有窗口关闭
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 阻止多实例
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
