const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

// 禁用硬件加速
app.disableHardwareAcceleration();

// 配置
const CONFIG = {
  title: 'WSZH-ShortageStore v3.17',
  width: 1400,
  height: 900,
  minWidth: 800,
  minHeight: 600,
  autoHideMenuBar: true,
  icon: path.join(__dirname, 'static', 'icon-512.png'),
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    webSecurity: true,
    preload: path.join(__dirname, 'preload.js')  // 预加载脚本
  }
};

// 更新服务器地址（Supabase Edge Function）
const UPDATE_CHECK_URL = process.env.UPDATE_CHECK_URL || 
  'https://your-project.supabase.co/functions/v1/check-update';

let mainWindow = null;

// 日志函数
function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

// 创建启动画面窗口
function createSplashWindow() {
  const splashWindow = new BrowserWindow({
    width: 500,
    height: 600,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,  // 居中显示
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  var BASE_URL = process.env.BASE_URL || 'https://wszhyy.pages.dev';
  splashWindow.loadURL(path.join(BASE_URL, '/static/splash.html'));

  return splashWindow;
}

// 创建主窗口
function createWindow() {
  // 先创建启动画面
  const splashWindow = createSplashWindow();

  // 创建主窗口（隐藏状态，不最大化）
  mainWindow = new BrowserWindow({
    ...CONFIG,
    show: false  // 初始隐藏
  });

  // 加载登录页面（从服务器加载，支持热更新）
  var BASE_URL = process.env.BASE_URL || 'https://wszhyy.pages.dev';
  var cacheBuster = '?v=' + new Date().getTime();
  mainWindow.loadURL(BASE_URL + '/login.html' + cacheBuster);

  // 页面加载完成后关闭启动画面并最大化主窗口
  mainWindow.webContents.on('did-finish-load', () => {
    // 先关闭启动画面
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    // 然后显示并最大化主窗口
    mainWindow.maximize();
    mainWindow.show();
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
