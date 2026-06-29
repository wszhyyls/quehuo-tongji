// ========================================
// 缺货统计系统 - 公共工具模块 (v21)
// 统一设备ID生成、XSS防护、API调用、状态渲染、全局错误边界等
// ========================================

// ========== 公共配置（统一入口）==========
var SUPABASE_URL = "https://qswpgnnedqvuegwfbprd.supabase.co";
var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI";
var EDGE_FUNCTION_URL = SUPABASE_URL + "/functions/v1/query-shortage-data";

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
var ORDER_STATUSES = ['待处理', '已订购', '已到货', '已完成', '待付款', '厂家断货'];
var STATUS_BADGE_CLASS = {
    '待处理': 'replenish-pending',
    '配货中': 'replenish-in-transit', 
    '已订购': 'replenish-ordered',
    '已到货': 'replenish-arrived',
    '已完成': 'replenish-completed',
    '待付款': 'replenish-payment',
    '厂家断货': 'replenish-outstock'
};

window.isCompletedStatus = function(status) {
    return status === '已完成' || status === '厂家断货';
};

// 获取补货状态徽章HTML（全局统一）
function getReplenishBadge(status) {
    var cls = 'replenish-badge ';
    var label = status || '待处理';
    if (label === '已完成') cls += 'replenish-completed';
    else if (label === '已审批') cls += 'replenish-completed';
    else if (label === '已驳回') cls += 'replenish-rejected';
    else if (label === '已订购' || label === '已下单') cls += 'replenish-ordered';
    else if (label === '配货中' || label === '在途') cls += 'replenish-in-transit';
    else if (label === '已到货' || label === '到货') cls += 'replenish-arrived';
    else if (label === '待处理') cls += 'replenish-pending';
    else if (label === '待付款') cls += 'replenish-payment';
    else if (label === '厂家断货') cls += 'replenish-outstock';
    else cls += 'replenish-text';
    return '<span class="' + cls + '">' + label + '</span>';
}

// 获取紧急程度徽章HTML（全局统一）
function getUrgencyBadge(level) {
    var cls = 'urgency-badge ';
    if (level === '紧急') cls += 'urgency-urgent';
    else if (level === '加急') cls += 'urgency-expedite';
    else cls += 'urgency-normal';
    return '<span class="' + cls + '">' + (level || '普通') + '</span>';
}

// ========== 设备指纹（v2: 防同配置冲突）==========
function getDeviceId() {
    var key = 'wszh_device_id_v2';
    var did = localStorage.getItem(key);
    if (!did) {
        var fp = [navigator.userAgent, screen.width+'x'+screen.height,
            screen.colorDepth, navigator.language, (new Date()).getTimezoneOffset(),
            navigator.hardwareConcurrency||'',
            Math.random().toString(36),
            Date.now().toString(36)].join('|');
        var h = 0;
        for (var i = 0; i < fp.length; i++) { h = ((h<<5)-h)+fp.charCodeAt(i); }
        did = 'DEV_v2_' + Math.abs(h).toString(36).substring(0, 8).toUpperCase();
        localStorage.setItem(key, did);
    }
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

function callEdgeFunction(action, params, options) {
    options = options || {};
    var retryCount = options.retryCount || 0;
    var maxRetries = options.maxRetries || 0;
    var signal = options.signal || null;
    var token = localStorage.getItem('token');

    // 如果传了 signal 但未传入 options.signal，从 AbortController 获取
    if (!signal && options.abortable !== false) {
        // 不为每个请求都创建 AbortController，由调用方传入
    }

    return fetch(EDGE_FUNCTION_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ action: action, params: params }),
        signal: signal
    }).then(function(resp) {
        if (!resp.ok) {
            // JWT过期自动续期
            if ((resp.status === 401 || resp.status === 403) && retryCount === 0 && window.supabase) {
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
            return resp.json().catch(function() { return {}; }).then(function(body) {
                var errMsg = body.error || body.message || ('请求失败: ' + resp.status);
                var err = new Error(errMsg);
                if (body.conn_timeout === true) err._connTimeout = true;
                throw err;
            });
        }
        return resp.json();
    }).catch(function(err) {
        // 网络错误自动重试
        if (retryCount < maxRetries && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.name === 'AbortError')) {
            if (err.name === 'AbortError') {
                console.log('[callEdgeFunction] 请求被取消: ' + action);
                return { success: false, error: '请求已取消' };
            }
            var delay = (retryCount + 1) * 1000;
            console.log('[callEdgeFunction] 网络错误，' + delay + 'ms后重试(' + (retryCount+1) + '/' + maxRetries + ')');
            return new Promise(function(resolve) {
                setTimeout(function() {
                    resolve(callEdgeFunction(action, params, { retryCount: retryCount + 1, maxRetries: maxRetries, signal: signal }));
                }, delay);
            });
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
