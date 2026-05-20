const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

// 配置（优化：延迟加载 icon）
const CONFIG = {
  title: 'WSZH-ShortageStore v3.18.6',
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

// 更新服务器地址（Supabase Edge Function）
const UPDATE_CHECK_URL = 'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/check-update';

let mainWindow = null;

// 日志函数
function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

// 创建启动画面窗口（优化：更快显示）
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

// 创建主窗口
function createWindow() {
  // 立即创建启动画面（不等待任何资源）
  const splashWindow = createSplashWindow();

  // 立即创建主窗口（隐藏状态）
  mainWindow = new BrowserWindow({
    ...CONFIG,
    show: false
  });

  // 异步加载登录页面
  var BASE_URL = process.env.BASE_URL || 'https://wszhyy.pages.dev';
  mainWindow.loadURL(BASE_URL + '/login.html?v=' + new Date().getTime());

  // 页面加载完成后显示主窗口
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.maximize();
    mainWindow.show();
    
    // 延迟关闭启动画面
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
      }
    }, 200);
  });

  // 窗口关闭时退出应用
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

// 检查更新
async function checkForUpdates() {
  try {
    log('开始检查更新...');
    
    // 配置 autoUpdater
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    
    // 设置更新源（使用 JSON 文件）
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: UPDATE_CHECK_URL
    });

    // 监听更新事件
    autoUpdater.on('checking-for-update', () => {
      log('正在检查更新...');
    });

    autoUpdater.on('update-available', async (info) => {
      log(`发现新版本: ${info.version}`);
      
      // 向渲染进程发送更新通知
      if (mainWindow) {
        mainWindow.webContents.send('update-available', {
          version: info.version,
          releaseNotes: info.releaseNotes
        });
      }
      
      // 自动下载
      autoUpdater.downloadUpdate();
    });

    autoUpdater.on('update-not-available', () => {
      log('已是最新版本');
    });

    autoUpdater.on('download-progress', (progress) => {
      log(`下载进度: ${progress.percent.toFixed(1)}%`);
      if (mainWindow) {
        mainWindow.webContents.send('update-progress', {
          percent: progress.percent
        });
      }
    });

    autoUpdater.on('update-downloaded', (info) => {
      log('更新下载完成，准备安装');
      
      // 询问用户是否立即安装
      if (mainWindow) {
        mainWindow.webContents.send('update-downloaded', {
          version: info.version
        });
      }
    });

    autoUpdater.on('error', (error) => {
      log(`更新错误: ${error.message}`);
    });

    // 执行检查
    await autoUpdater.checkForUpdates();
    
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
