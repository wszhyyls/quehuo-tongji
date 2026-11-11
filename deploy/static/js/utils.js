// ========================================
// 缺货统计系统 - 公共工具模块 (v21)
// 统一设备ID生成、XSS防护、API调用、状态渲染、全局错误边界等
// ========================================

// ========== 公共配置（统一入口）==========
var SUPABASE_URL = "https://qswpgnnedqvuegwfbprd.supabase.co";
var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI";
var EDGE_FUNCTION_URL = SUPABASE_URL + "/functions/v1/query-shortage-data";

// ========== v5.15.5: 全局 fetch 拦截 —— 所有 Supabase Edge Functions 调用走主进程代理 ==========
// admin.js 行 292 有裸 fetch('...scheduled-task')，不走 callEdgeFunction，导致 CORS 报错
// 全局拦截确保所有 fetch('...supabase.co/functions/v1/...') 都走主进程 proxy-fetch
(function _installGlobalFetchProxy() {
    if (typeof window === 'undefined') return;
    var _origFetch = window.fetch;
    if (typeof _origFetch !== 'function') return;
    // 已安装过就不再装
    if (_origFetch.__wszh_proxied) return;
    // 检测 Electron 环境
    var invoke = window.electron && window.electron.ipcRenderer && window.electron.ipcRenderer.invoke;
    if (typeof invoke !== 'function') return; // 浏览器环境不拦截
    window.fetch = function(url, opts) {
        // 只拦截 Supabase Edge Functions 的 URL，其他 fetch（Google Fonts、CDN 等）不动
        if (typeof url === 'string' && url.indexOf('supabase.co/functions/v1/') !== -1) {
            return invoke('proxy-fetch', { url: url, options: opts || {} }).then(function(r) {
                // 转换成 fetch Response
                return new Response(
                    typeof r.data === 'string' ? r.data : JSON.stringify(r.data),
                    {
                        status: r.status,
                        statusText: r.statusText || '',
                        headers: r.headers || {}
                    }
                );
            });
        }
        return _origFetch.apply(this, arguments);
    };
    window.fetch.__wszh_proxied = true;
})();

// ========== 全局版本号（单一来源：Electron 下读 app.getVersion()，浏览器 fallback 常量）==========
// v5.15.0: 改成动态获取 —— package.json.version 为唯一真相，界面通过这里注入
var APP_VERSION = 'v5.15.0'; // 浏览器访问时的 fallback 常量（也要和 package.json 同步）
// Electron 环境下异步覆盖 APP_VERSION（单一来源，防止硬编码漂移）
(function electronVersionInject() {
    if (window.electron && window.electron.ipcRenderer && typeof window.electron.ipcRenderer.invoke === 'function') {
        try {
            window.electron.ipcRenderer.invoke('get-app-version').then(function(v) {
                if (v && typeof v === 'string') {
                    APP_VERSION = 'v' + v;
                    console.log('[APP_VERSION] Electron 注入版本: ' + APP_VERSION);
                    // 重新注入所有 [data-version] 元素
                    var els = document.querySelectorAll('[data-version]');
                    for (var i = 0; i < els.length; i++) {
                        var el = els[i];
                        var suffix = el.getAttribute('data-version-suffix') || '';
                        el.textContent = APP_VERSION + suffix;
                    }
                }
            }).catch(function(e) {
                console.warn('[APP_VERSION] Electron get-app-version 失败, 用 fallback:', e.message);
            });
        } catch (e) { /* 非 Electron 环境或 preload 没暴露, 静默忽略 */ }
    }
})();

// ========== 门店配置（全局唯一，新增门店只需在此处添加）==========
var STORE_CONFIG = [
    { id: 'wszhyy02', name: '02第二药店', deviceLimit: 2 },
    { id: 'wszhyy03', name: '03第三药店', deviceLimit: 1 },
    { id: 'wszhyy04', name: '04第四药店', deviceLimit: 1 },
    { id: 'wszhyy06', name: '06常口店',   deviceLimit: 1 },
    { id: 'wszhyy08', name: '08第八药店', deviceLimit: 1 },
    { id: 'wszhyy09', name: '09第九药店', deviceLimit: 1 },
    { id: 'wszhyy14', name: '14第十四药店', deviceLimit: 1 },
    { id: 'wszhyy16', name: '16凤凰山药店', deviceLimit: 1 },
    { id: 'wszhyy17', name: '17益丰店',   deviceLimit: 1 },
    { id: 'wszhyy21', name: '21富源店',   deviceLimit: 1 }
];

// 快速查找函数
function getStoreName(storeId) {
    var s = STORE_CONFIG.find(function(c) { return c.id === storeId; });
    return s ? s.name : storeId;
}
function getStoreDeviceLimit(storeId) {
    var s = STORE_CONFIG.find(function(c) { return c.id === storeId; });
    return s ? s.deviceLimit : 1;
}

// ========== 补货状态定义（全局唯一）v4.2==========
// 包含所有可能的实际值：中间态 + 终态
var ORDER_STATUSES = ['待处理', '已订购', '待付款', '已到货', '已完成', '已配送', '已关闭', '厂家断货'];
window.isCompletedStatus = function(status) {
    // "已到货" 不算完成（仓库有货但还没到门店，仍需关注）
    // "已关闭" 是 90 天超期自动关闭，也是终态，不计入待处理汇总
    // "已配送" 是配送到店数量 ≥ 需求数量，也是终态
    return status === '已完成' || status === '厂家断货' || status === '已关闭' || status === '已配送';
};
// 显示 label 映射：逻辑值 → 用户可见文案（逻辑值不变，只改显示）
var STATUS_LABEL_MAP = {
    '已完成': '已入库',
    '已配送': '已完成',
    '已关闭': '已关闭'
};
window.statusLabel = function(status) {
    if (!status) return '';
    return STATUS_LABEL_MAP[status] || status;
};
var STATUS_BADGE_CLASS = {
    '待处理': 'replenish-pending',
    '配货中': 'replenish-in-transit', 
    '已订购': 'replenish-ordered',
    '已到货': 'replenish-arrived',
    '已完成': 'replenish-completed',
    '已配送': 'replenish-completed',
    '待付款': 'replenish-payment',
    '厂家断货': 'replenish-outstock'
};

// 获取补货状态徽章HTML（全局统一）
// 注意：status 是逻辑值（后端返回），label 是用户可见文案（已映射）
function getReplenishBadge(status) {
    var cls = 'replenish-badge ';
    var label = statusLabel(status) || status || '待处理';
    if (status === '已完成' || status === '已配送') cls += 'replenish-completed';
    else if (status === '已审批') cls += 'replenish-completed';
    else if (status === '已驳回') cls += 'replenish-rejected';
    else if (status === '已订购' || status === '已下单') cls += 'replenish-ordered';
    else if (status === '配货中' || status === '在途') cls += 'replenish-in-transit';
    else if (status === '已到货' || status === '到货') cls += 'replenish-arrived';
    else if (status === '待处理') cls += 'replenish-pending';
    else if (status === '待付款') cls += 'replenish-payment';
    else if (status === '厂家断货') cls += 'replenish-outstock';
    else cls += 'replenish-text';
    var tip;
    if (!status) tip = 'DB 原始值: 未设置';
    else if (label !== status) tip = 'DB 原始值: ' + status + '  →  界面显示: ' + label;
    else tip = 'DB 原始值: ' + status;
    return '<span class="' + cls + '" title="' + escapeHtml(tip) + '">' + label + '</span>';
}

// 获取紧急程度徽章HTML（全局统一）
function getUrgencyBadge(level) {
    var cls = 'urgency-badge ';
    if (level === '紧急') cls += 'urgency-urgent';
    else if (level === '加急') cls += 'urgency-expedite';
    else cls += 'urgency-normal';
    return '<span class="' + cls + '">' + (level || '普通') + '</span>';
}

// ========== 设备指纹（v3: 机器级稳定，跨 origin 不变）==========
// 根因：v2 从 localStorage 读 → 换 origin（127.0.0.1:8049 vs pages.dev）后隔离 → 生成新 id → 服务端判陌生设备 → 拒登
// 方案：Electron 环境下通过 preload.sendSync 同步从主进程拿机器级 UUID（%APPDATA%持久化）
// 浏览器环境 fallback 到 localStorage（同 origin 稳定）
var _cachedDeviceId = null;
function getDeviceId() {
    if (_cachedDeviceId) return _cachedDeviceId;
    // Electron 环境：同步从主进程拿（机器级稳定，跨 origin 不变）
    if (window.electron && window.electron.getDeviceIdSync) {
        var did = null;
        try { did = window.electron.getDeviceIdSync(); } catch(_) {}
        if (did) { _cachedDeviceId = did; return did; }
    }
    // 浏览器 / fallback：localStorage 同 origin 稳定
    var key = 'wszh_device_id_v3';
    did = localStorage.getItem(key);
    if (!did) {
        did = 'DEV_v3_browser_' + Math.random().toString(36).substring(2, 10).toUpperCase();
        localStorage.setItem(key, did);
    }
    _cachedDeviceId = did;
    return did;
}

// ========== XSS 防护 ==========
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    if (typeof str !== 'string') str = String(str);
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;').replace(/"/g,'&quot;');
}
function safeText(str) { return escapeHtml(str); }

function safeHtml(str, allowedTags) {
    if (str === null || str === undefined) return '';
    if (typeof str !== 'string') str = String(str);
    var escaped = escapeHtml(str);
    if (allowedTags && allowedTags.length > 0) {
        var allowed = allowedTags.join('|');
        var regex = new RegExp('&lt;(' + allowed + ')\\s*([^&gt;]*)&gt;', 'gi');
        escaped = escaped.replace(regex, '<$1 $2>');
        allowed.split('|').forEach(function(tag) {
            var closeRegex = new RegExp('&lt;/' + tag + '&gt;', 'gi');
            escaped = escaped.replace(closeRegex, '</' + tag + '>');
        });
    }
    return escaped;
}

// ========== 格式化 ==========
function formatNumber(num) {
    if (num === null || num === undefined || num === '') return '-';
    var n = parseFloat(num); if (isNaN(n)) return '-';
    return n.toLocaleString('zh-CN');
}
function formatDate(dateStr) {
    if (!dateStr) return '-';
    try { var d = new Date(dateStr); if (isNaN(d.getTime())) return '-'; return d.toLocaleString('zh-CN'); }
    catch(e) { return '-'; }
}

// ========== 错误日志 ==========
var DEBUG_MODE = false;
function logError(msg, err) { if (DEBUG_MODE) console.error('[Error]', msg, err); }
function logInfo(msg, data) { if (DEBUG_MODE) console.log('[Info]', msg, data); }

// ========== 按钮防抖 ==========
function debounceBtn(fn, delay) {
    delay = delay || 500;
    var timer = 0;
    return function() {
        if (timer) return;
        timer = setTimeout(function() { timer = 0; }, delay);
        return fn.apply(this, arguments);
    };
}

// ========== 客户端错误信息通俗化二次过滤 ==========
// connTimeout: 服务端返回的 conn_timeout 标识，用于区分连接超时与其他错误
function friendlyErrorClient(errMsg, connTimeout) {
    if (!errMsg) return '操作失败，请重试';
    var m = String(errMsg);
    // 连接超时专用提示
    if (connTimeout === true) return '远程业务数据库无法连通，请检查服务器端口与防火墙';
    if (m.includes('远程业务数据库无法连通')) return m.substring(0, 80);
    // 服务器已转义过的友好消息直接返回
    if (m.length <= 80) return m;
    // 明确的技术错误模式匹配
    if (m.includes('Invalid object name') || m.includes('找不到对象')) return '数据源连接异常，请刷新页面重试';
    if (m.includes('timeout') || m.includes('Timeout') || m.includes('超时')) return '数据查询超时，请稍后重试';
    if (m.includes('ECONNREFUSED') || m.includes('ETIMEOUT') || m.includes('ConnectionError')) return '远程业务数据库无法连通，请检查服务器端口与防火墙';
    if (m.includes('Failed to fetch') || m.includes('NetworkError')) return '网络连接异常，请检查网络后重试';
    if (m.includes('500') || m.includes('Internal Server Error')) return '系统繁忙，请稍后重试';
    if (m.includes('socket hang up') || m.includes('ECONNRESET')) return '网络连接中断，请检查网络后重试';
    if (m.includes('\n    at ') || m.includes('stack') || m.includes('Traceback')) return '系统繁忙，请稍后重试';
    return m.substring(0, 120);
}

// ========== 全局错误边界（捕获未处理异常）==========
window.addEventListener('error', function(e) {
    console.error('[GlobalError]', e.error || e.message);
    var bar = document.getElementById('versionBar');
    var msg = document.getElementById('versionMsg');
    if (bar && msg && e.error) {
        msg.textContent = '⚠ 页面出现异常，请尝试刷新页面';
        bar.style.display = 'block';
        bar.style.background = '#f44336';
        setTimeout(function() { bar.style.display = 'none'; }, 5000);
    }
});
window.addEventListener('unhandledrejection', function(e) {
    console.error('[UnhandledRejection]', e.reason);
});

// ========== Toast 轻提示（非阻断式）==========
function showToast(msg, type) {
    type = type || 'info';
    var toast = document.getElementById('globalToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'globalToast';
        toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);padding:10px 24px;border-radius:8px;font-size:14px;z-index:10000;transition:all 0.3s;pointer-events:none;opacity:0;';
        document.body.appendChild(toast);
    }
    var colors = { success: '#4CAF50', error: '#f44336', info: '#2196F3', warning: '#ff9800' };
    toast.style.background = colors[type] || colors.info;
    toast.style.color = '#fff';
    toast.textContent = msg;
    toast.style.opacity = '1';
    toast.style.top = '20px';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function() {
        toast.style.opacity = '0';
        toast.style.top = '10px';
    }, 3000);
}

// ========== 统一 Alert 弹窗（使用页面已有模态框）==========
function showAlert(msg) {
    var modal = document.getElementById('alertModal');
    var msgEl = document.getElementById('alertMsg');
    if (modal && msgEl) {
        msgEl.textContent = msg;
        modal.classList.add('show');
    } else {
        alert(msg);
    }
}

// ========== 统一 Confirm 弹窗 ==========
function showConfirm(msg, onYes, onNo, yesText, noText) {
    var modal = document.getElementById('confirmModal');
    var msgEl = document.getElementById('confirmMsg');
    var yesBtn = document.getElementById('confirmYesBtn');
    var noBtn = document.getElementById('confirmNoBtn');
    if (modal && msgEl && yesBtn && noBtn) {
        msgEl.textContent = msg;
        modal.classList.add('show');
        yesBtn.textContent = yesText || '确认';
        noBtn.textContent = noText || '取消';
        yesBtn.onclick = function() { modal.classList.remove('show'); if (onYes) onYes(); };
        noBtn.onclick = function() { modal.classList.remove('show'); if (onNo) onNo(); };
    } else {
        if (confirm(msg)) { if (onYes) onYes(); } else { if (onNo) onNo(); }
    }
}

// ========== 统一 Prompt 弹窗（替代浏览器原生 prompt，避免 Electron 拦截） ==========
function showPrompt(title, msg, defaultValue, onOk, onCancel) {
    var modal = document.getElementById('promptModal');
    var titleEl = document.getElementById('promptTitle');
    var msgEl = document.getElementById('promptMsg');
    var inputEl = document.getElementById('promptInput');
    var okBtn = document.getElementById('promptOkBtn');
    var cancelBtn = document.getElementById('promptCancelBtn');
    if (modal && inputEl && okBtn && cancelBtn) {
        if (titleEl) titleEl.textContent = title || '输入';
        if (msgEl) msgEl.textContent = msg || '';
        inputEl.value = (defaultValue !== undefined && defaultValue !== null) ? String(defaultValue) : '';
        modal.classList.add('show');
        // 自动聚焦输入框
        setTimeout(function() { try { inputEl.focus(); inputEl.select(); } catch(e) {} }, 50);
        // 清理旧 handler
        var newOk = function() {
            modal.classList.remove('show');
            var v = inputEl.value;
            okBtn.onclick = null;
            cancelBtn.onclick = null;
            inputEl.onkeydown = null;
            if (onOk) onOk(v);
        };
        var newCancel = function() {
            modal.classList.remove('show');
            okBtn.onclick = null;
            cancelBtn.onclick = null;
            inputEl.onkeydown = null;
            if (onCancel) onCancel();
        };
        okBtn.onclick = newOk;
        cancelBtn.onclick = newCancel;
        inputEl.onkeydown = function(e) {
            if (e.key === 'Enter') newOk();
            else if (e.key === 'Escape') newCancel();
        };
    } else {
        // fallback: 退到浏览器原生
        var v = window.prompt(msg || title || '请输入', defaultValue || '');
        if (v === null) { if (onCancel) onCancel(); } else { if (onOk) onOk(v); }
    }
}

// ========== 按钮 Loading 状态 ==========
function setBtnLoading(btn, loadingText) {
    if (!btn) return function(){};
    var origText = btn.textContent;
    var origDisabled = btn.disabled;
    btn.disabled = true;
    btn.textContent = loadingText || '处理中...';
    btn._loading = true;
    return function() {
        btn.disabled = origDisabled;
        btn.textContent = origText;
        btn._loading = false;
    };
}

// ========== 统合 Edge Function 调用（含JWT自动续期、重试、AbortController）==========
var _edgeAbortController = null;

// ========== v5.15.5: Electron 主进程 fetch 代理（绕过渲染进程 CORS 限制）==========
// 所有跨域 Edge Function 调用都走主进程 Node.js fetch（不受 CORS 限制）
// 浏览器环境仍走原生 fetch（localhost:5173 开发时 Edge Function 已放白名单）
function _proxiedFetch(url, options) {
    // 检测 Electron 环境：preload.js 暴露了 window.electron.ipcRenderer.invoke
    var electronInvoke = window.electron && window.electron.ipcRenderer && window.electron.ipcRenderer.invoke;
    if (typeof electronInvoke === 'function') {
        // 走主进程 proxy-fetch
        return electronInvoke('proxy-fetch', { url: url, options: options }).then(function(result) {
            // 转换成 fetch Response-like 对象（后面 .then(resp => ...) 逻辑不动）
            return {
                ok: result.ok,
                status: result.status,
                statusText: result.statusText || '',
                headers: new Headers(result.headers || {}),
                _body: result.data,
                json: function() {
                    if (typeof result.data === 'string') {
                        try { return Promise.resolve(JSON.parse(result.data)); }
                        catch(e) { return Promise.reject(new Error('Invalid JSON')); }
                    }
                    return Promise.resolve(result.data);
                },
                text: function() {
                    return Promise.resolve(typeof result.data === 'string' ? result.data : JSON.stringify(result.data));
                }
            };
        }).catch(function(err) {
            // proxy-fetch 本身抛错（如 ipc 通道不可用），fallback 到原生 fetch
            console.warn('[callEdgeFunction] proxy-fetch 失败，fallback 原生 fetch:', err?.message || err);
            return fetch(url, options);
        });
    }
    // 浏览器环境：原生 fetch
    return fetch(url, options);
}

function callEdgeFunction(action, params, options) {
    options = options || {};
    var retryCount = options.retryCount || 0;
    var maxRetries = options.maxRetries !== undefined ? options.maxRetries : 1; // v5.8.1+ 默认重试 1 次（冷启动超时自动重试）
    var signal = options.signal || null;
    var timeoutMs = options.timeout || 60000; // 默认 60 秒超时（v5.8.1+ 兼容冷启动）
    var token = localStorage.getItem('token');

    // 如果传了 signal 但未传入 options.signal，从 AbortController 获取
    if (!signal && options.abortable !== false) {
        // 不为每个请求都创建 AbortController，由调用方传入
    }

    // 自动注入超时（如果调用方没传 signal 的话）
    var internalController = null;
    var finalSignal = signal;
    if (!signal) {
        internalController = new AbortController();
        finalSignal = internalController.signal;
        setTimeout(function() {
            if (internalController) {
                // v5.8.1+ 改为 LOG 而非 WARN：超时是预期的（冷启动），会自动重试，不应惊扰用户
                console.log('[callEdgeFunction] ' + action + ' 首次响应慢（>' + timeoutMs + 'ms），自动重试');
                try { internalController.abort(); } catch(e) {}
            }
        }, timeoutMs);
    }

    return _proxiedFetch(EDGE_FUNCTION_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ action: action, params: params }),
        signal: finalSignal
    }).then(function(resp) {
        if (!resp.ok) {
            // 统一解析错误体（提前取出来，后面分支都要用）
            return resp.json().catch(function() { return {}; }).then(function(body) {
                var errMsg = body.error || body.message || ('请求失败: ' + resp.status);
                // 403 鉴权失败：把技术错误转成人话（所有 ADMIN_WRITABLE_ACTIONS 鉴权失败统一提示）
                if (resp.status === 403) {
                    if (errMsg.includes('无权限执行此操作') || errMsg.includes('需要管理员身份')) {
                        errMsg = '当前登录身份已失效，请重新登录后再试';
                    } else if (errMsg.includes('该账号已在另一台电脑登录') || errMsg.includes('已绑定')) {
                        // 设备绑定拒绝：保留原文（对用户有意义）
                    } else if (errMsg.includes('该设备未授权') || errMsg.includes('待授权')) {
                        // 旧审批流程的提示（以后不会出现，但保留）
                    }
                }
                // 只有真正的 JWT 失效（401 且后端明确标了 code='TOKEN_EXPIRED'）才尝试自动续期
                // 403 一律视为业务拒绝（无权限/参数错误等），原样抛出，绝不能清空 localStorage 或跳登录页
                if (resp.status === 401 && body.code === 'TOKEN_EXPIRED' && retryCount === 0 && window.supabase) {
                    console.log('[AutoRelogin] Token过期，尝试自动续期...');
                    return window.supabase.auth.refreshSession().then(function(r) {
                        if (r.data && r.data.session) {
                            localStorage.setItem('token', r.data.session.access_token);
                            console.log('[AutoRelogin] 续期成功，重试');
                            return callEdgeFunction(action, params, { retryCount: retryCount + 1, maxRetries: maxRetries, signal: signal });
                        } else {
                            console.warn('[AutoRelogin] 续期失败:', r.error);
                            alert('登录已过期，请重新登录');
                            localStorage.removeItem('token');
                            localStorage.removeItem('user');
                            window.location.href = './login.html';
                            return { success: false, error: '登录已过期，请重新登录' };
                        }
                    }).catch(function(e) {
                        console.warn('[AutoRelogin] 续期异常:', e.message);
                        alert('登录已过期，请重新登录');
                        localStorage.removeItem('token');
                        localStorage.removeItem('user');
                        window.location.href = './login.html';
                        return { success: false, error: '登录已过期，请重新登录' };
                    });
                }
                var err = new Error(errMsg);
                if (body.conn_timeout === true) err._connTimeout = true;
                err._status = resp.status;
                throw err;
            });
        }
        return resp.json();
    }).catch(function(err) {
        // v5.8.1+ 超时/网络错误自动重试（冷启动期间第一次超时，重试用更短超时）
        if (retryCount < maxRetries && (
            err.message.includes('Failed to fetch') || 
            err.message.includes('NetworkError') || 
            err.name === 'AbortError'
        )) {
            // 超时重试：第1次失败后连接可能已热，用短超时（60s）快速重试
            var retryTimeout = Math.min(timeoutMs, 120000);
            return callEdgeFunction(action, params, { 
                retryCount: retryCount + 1, 
                maxRetries: maxRetries,
                timeout: retryTimeout
            });
        }
        if (err.name === 'AbortError') {
            // 重试用尽仍失败 - 这才是真正需要警告的场景
            console.warn('[callEdgeFunction] ' + action + ' 重试 ' + maxRetries + ' 次后仍超时');
            return { success: false, error: '请求超时，已放弃重试' };
        }
        logError('Edge Function调用失败', err);
        return { success: false, error: err.message, _connTimeout: err._connTimeout || false };
    });
}

// ========== 带取消功能的 Edge Function 调用 ==========
function callEdgeFunctionAbortable(action, params) {
    // 取消上一次未完成的请求
    if (_edgeAbortController) {
        _edgeAbortController.abort();
    }
    _edgeAbortController = new AbortController();
    return callEdgeFunction(action, params, {
        signal: _edgeAbortController.signal,
        maxRetries: 1  // 网络错误重试1次
    });
}

// ========== 导出到全局 ==========
window.getDeviceId = getDeviceId;
window.escapeHtml = escapeHtml;
window.safeText = safeText;
window.safeHtml = safeHtml;
window.formatNumber = formatNumber;
window.formatDate = formatDate;
window.logError = logError;
window.logInfo = logInfo;
window.debounceBtn = debounceBtn;
window.getReplenishBadge = getReplenishBadge;
window.getUrgencyBadge = getUrgencyBadge;
window.getStoreName = getStoreName;
window.getStoreDeviceLimit = getStoreDeviceLimit;
window.showToast = showToast;
window.showAlert = showAlert;
window.showConfirm = showConfirm;
window.setBtnLoading = setBtnLoading;
window.callEdgeFunction = callEdgeFunction;
window.callEdgeFunctionAbortable = callEdgeFunctionAbortable;
window.friendlyErrorClient = friendlyErrorClient;
window.STORE_CONFIG = STORE_CONFIG;
window.APP_VERSION = APP_VERSION;

// ========== 自定义 Tooltip（替代原生 title，自适应定位、多行、键盘可访问）==========
(function initTooltipSystem() {
    // 等待 body 就绪再操作，避免 <head> 同步加载时 document.body 为 null
    if (!document.body) {
        document.addEventListener('DOMContentLoaded', initTooltipSystem);
        return;
    }
    console.log('🔧 [utils.js v603] 自定义 tooltip 系统初始化开始');
    // 1) 注入 tooltip 样式
    var _css = [
        '.custom-tip{position:fixed;z-index:99999;max-width:360px;padding:8px 12px;border-radius:6px;',
        'background:rgba(33,33,33,0.92);color:#fff;font-size:12.5px;line-height:1.55;',
        'word-break:break-word;white-space:pre-line;box-shadow:0 4px 14px rgba(0,0,0,0.25);',
        'pointer-events:none;opacity:0;transform:translateY(-4px);transition:opacity 0.15s,transform 0.15s;',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}',
        '.custom-tip.show{opacity:1;transform:translateY(0);}',
        '.custom-tip::after{content:"";position:absolute;width:0;height:0;}',
        '.custom-tip.tip-bottom::after{top:-5px;left:14px;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:5px solid rgba(33,33,33,0.92);}',
        '.custom-tip.tip-top::after{bottom:-5px;left:14px;border-left:5px solid transparent;border-right:5px solid transparent;border-top:5px solid rgba(33,33,33,0.92);}',
        '.custom-tip.tip-right::after{left:-5px;top:14px;border-top:5px solid transparent;border-bottom:5px solid transparent;border-right:5px solid rgba(33,33,33,0.92);}',
        '.custom-tip.tip-left::after{right:-5px;top:14px;border-top:5px solid transparent;border-bottom:5px solid transparent;border-left:5px solid rgba(33,33,33,0.92);}'
    ].join('');
    var _style = document.createElement('style');
    _style.textContent = _css;
    (document.head || document.documentElement).appendChild(_style);

    // 2) 创建 tooltip 元素（全局唯一）
    var _tip = document.createElement('div');
    _tip.className = 'custom-tip';
    _tip.setAttribute('role', 'tooltip');
    document.body.appendChild(_tip);

    var _showTimer = null, _hideTimer = null, _currentEl = null;

    function showTip(el) {
        clearTimeout(_hideTimer);
        var text = el.getAttribute('data-tip');
        if (!text) { console.log('[tooltip] showTip: element has no data-tip, skip'); return; }
        console.log('[tooltip] showTip:', text.length > 40 ? text.substring(0,40)+'...' : text);
        _tip.textContent = text;
        _tip.className = 'custom-tip'; // 重置方向 class
        _tip.style.display = 'block';
        // 先让它渲染出来拿到尺寸
        var rect = el.getBoundingClientRect();
        var tipW = _tip.offsetWidth, tipH = _tip.offsetHeight;
        var vw = window.innerWidth, vh = window.innerHeight;
        var gap = 8;

        // 方向优先级：下方 > 上方 > 右方 > 左方
        var top = 0, left = 0, dir = 'tip-bottom';
        if (rect.bottom + tipH + gap <= vh) {
            top = rect.bottom + gap;
            left = rect.left;
            dir = 'tip-bottom';
        } else if (rect.top - tipH - gap >= 0) {
            top = rect.top - tipH - gap;
            left = rect.left;
            dir = 'tip-top';
        } else if (rect.right + tipW + gap <= vw) {
            top = rect.top;
            left = rect.right + gap;
            dir = 'tip-right';
        } else {
            top = rect.top;
            left = Math.max(0, rect.left - tipW - gap);
            dir = 'tip-left';
        }
        // 水平边界修正：超出右侧则贴右，超出左侧则贴左
        if (left + tipW > vw - 4) left = vw - tipW - 4;
        if (left < 4) left = 4;
        // 垂直边界修正
        if (top + tipH > vh - 4) top = vh - tipH - 4;
        if (top < 4) top = 4;

        _tip.style.top = top + 'px';
        _tip.style.left = left + 'px';
        _tip.classList.add(dir);
        _tip.classList.add('show');
        _currentEl = el;
    }

    function hideTip() {
        _tip.classList.remove('show');
        _hideTimer = setTimeout(function() {
            _tip.style.display = 'none';
            _currentEl = null;
        }, 150);
    }

    function onEnter(e) {
        var el = e.target;
        // 向上冒泡找最近的带 data-tip 的元素
        while (el && el !== document.body) {
            if (el.getAttribute && el.getAttribute('data-tip')) {
                clearTimeout(_showTimer);
                _showTimer = setTimeout(function() { showTip(el); }, 120);
                return;
            }
            el = el.parentElement;
        }
    }
    function onLeave(e) {
        clearTimeout(_showTimer);
        hideTip();
    }
    function onFocus(e) {
        var el = e.target;
        if (el && el.getAttribute && el.getAttribute('data-tip')) {
            clearTimeout(_showTimer);
            _showTimer = setTimeout(function() { showTip(el); }, 80);
        }
    }
    function onBlur(e) {
        if (_currentEl && (e.target === _currentEl || _currentEl.contains(e.target))) {
            hideTip();
        }
    }
    function onClick(e) {
        // 点击任何元素都隐藏 tooltip（避免遮挡操作）
        if (_currentEl) hideTip();
    }

    // 事件委托——document 级别监听，兼容动态插入的元素
    document.addEventListener('mouseover', onEnter);
    document.addEventListener('mouseout', onLeave);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onBlur);
    document.addEventListener('click', onClick, true); // capture 阶段先拿到
    // 触摸：touchstart 显示，touchend 或 tap 隐藏
    document.addEventListener('touchstart', function(e) {
        var el = e.target;
        while (el && el !== document.body) {
            if (el.getAttribute && el.getAttribute('data-tip')) { showTip(el); return; }
            el = el.parentElement;
        }
    }, { passive: true });
    document.addEventListener('touchend', hideTip, { passive: true });

    // 页面滚动时隐藏（tooltip 会跟着元素位置变，不如直接隐藏）
    window.addEventListener('scroll', hideTip, { passive: true });
    window.addEventListener('resize', hideTip);
    console.log('✅ [utils.js v603] 自定义 tooltip 系统初始化完成，事件委托已绑定');
})();

// ========== 页面加载完成后自动把版本号注入到所有 data-version 元素 ==========
(function initVersionInject() {
    function doInject() {
        var els = document.querySelectorAll('[data-version]');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            var suffix = el.getAttribute('data-version-suffix') || '';
            el.textContent = APP_VERSION + suffix;
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', doInject);
    } else {
        doInject();
    }
    // SPA 场景兜底（虽然我们不是 SPA）
    window.addEventListener('load', doInject);
})();
