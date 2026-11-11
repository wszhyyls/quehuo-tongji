const { contextBridge, ipcRenderer, shell } = require('electron');

// 暴露安全的 API 到渲染进程
contextBridge.exposeInMainWorld('electron', {
    // 在系统默认浏览器中打开链接
    openExternal: (url) => {
        if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
            shell.openExternal(url);
        }
    },
    ipcRenderer: {
        // 发送消息
        send: (channel, data) => {
            const validChannels = ['check-update', 'install-update'];
            if (validChannels.includes(channel)) {
                ipcRenderer.send(channel, data);
            }
        },
        // 监听消息
        on: (channel, func) => {
            const validChannels = ['update-available', 'update-progress', 'update-downloaded', 'update-error'];
            if (validChannels.includes(channel)) {
                ipcRenderer.on(channel, (event, ...args) => func(...args));
            }
        },
        // 异步调用
        invoke: (channel, data) => {
            const validChannels = ['get-app-version', 'check-update', 'install-update'];
            if (validChannels.includes(channel)) {
                return ipcRenderer.invoke(channel, data);
            }
        },
        // 移除监听器
        removeListener: (channel, func) => {
            const validChannels = ['update-available', 'update-progress', 'update-downloaded'];
            if (validChannels.includes(channel)) {
                ipcRenderer.removeListener(channel, func);
            }
        }
    }
});
