// ========================================
// 缺货统计系统 - 公共工具模块 (v20)
// 统一设备ID生成、XSS防护、公共配置等
// ========================================

// ========== 公共配置（统一入口，其他文件不再重复定义）==========
var SUPABASE_URL = "https://qswpgnnedqvuegwfbprd.supabase.co";
var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI";
var EDGE_FUNCTION_URL = SUPABASE_URL + "/functions/v1/query-shortage-data";

// ========== 设备指纹（统一实现）==========
function getDeviceId() {
    var key = 'wszh_device_id_v2';  // v2: 修正同配置设备指纹相同的问题
    var did = localStorage.getItem(key);
    if (!did) {
        // 硬件特征 + 随机数 + 时间戳，确保每台设备生成唯一ID
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

// ========== XSS 防护函数（统一实现）==========
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    if (typeof str !== 'string') str = String(str);
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/'/g, '&#39;')
        .replace(/"/g, '&quot;');
}

// ========== 安全输出函数（防止XSS）==========
function safeText(str) {
    return escapeHtml(str);
}

// ========== 安全HTML函数（用于需要部分HTML的场景）==========
function safeHtml(str, allowedTags) {
    if (str === null || str === undefined) return '';
    if (typeof str !== 'string') str = String(str);
    
    // 先转义所有
    var escaped = escapeHtml(str);
    
    // 如果有允许的标签，恢复部分标签（谨慎使用）
    if (allowedTags && allowedTags.length > 0) {
        // 只允许非常有限的标签
        var allowed = allowedTags.join('|');
        var regex = new RegExp('&lt;(' + allowed + ')\\s*([^&gt;]*)&gt;', 'gi');
        escaped = escaped.replace(regex, '<$1 $2>');
        // 闭合标签
        allowed.split('|').forEach(function(tag) {
            var closeRegex = new RegExp('&lt;/' + tag + '&gt;', 'gi');
            escaped = escaped.replace(closeRegex, '</' + tag + '>');
        });
    }
    
    return escaped;
}

// ========== 数字格式化 ==========
function formatNumber(num) {
    if (num === null || num === undefined || num === '') return '-';
    var n = parseFloat(num);
    if (isNaN(n)) return '-';
    return n.toLocaleString('zh-CN');
}

// ========== 日期格式化 ==========
function formatDate(dateStr) {
    if (!dateStr) return '-';
    try {
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) return '-';
        return d.toLocaleString('zh-CN');
    } catch(e) {
        return '-';
    }
}

// ========== 错误日志（生产环境关闭）==========
var DEBUG_MODE = false;

function logError(msg, err) {
    if (DEBUG_MODE) {
        console.error('[Error]', msg, err);
    }
}

function logInfo(msg, data) {
    if (DEBUG_MODE) {
        console.log('[Info]', msg, data);
    }
}

// ========== 按钮防抖（防止重复点击）==========
function debounceBtn(fn, delay) {
    delay = delay || 500;
    var timer = 0;
    return function() {
        if (timer) return;
        timer = setTimeout(function() { timer = 0; }, delay);
        return fn.apply(this, arguments);
    };
}

// 导出给全局使用
window.getDeviceId = getDeviceId;
window.escapeHtml = escapeHtml;
window.safeText = safeText;
window.safeHtml = safeHtml;
window.formatNumber = formatNumber;
window.formatDate = formatDate;
window.logError = logError;
window.logInfo = logInfo;
window.debounceBtn = debounceBtn;
