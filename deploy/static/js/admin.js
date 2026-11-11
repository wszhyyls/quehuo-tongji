// ========================================
// 缺货统计系统 - 管理后台 v5.15.0 (2026-11-11 本地加载版)
// 版本号显示在页面右上角 + 控制台可查
// ========================================
console.log('[缺货统计系统] admin.js v5.15.0');
if (window.user) console.log('[缺货统计系统] 当前用户:', window.user.username || window.user.name, 'role:', window.user.role);

var token = localStorage.getItem('token');
var user = null;
try {
    user = JSON.parse(localStorage.getItem('user') || 'null');
} catch(e) { window.location.href = './'; }
if (!token || !user || (user.role !== 'admin' && user.role !== 'super_admin')) { window.location.href = './'; }

var summaryData = null;
var currentEditProduct = null;
var selectedProducts = {};
var autoRefreshTimer = null;
var autoRefreshInterval = 60000;
var currentPage = 1, pageSize = 20;
var filteredData = [], completedData = [], currentFilterStatus = '';
var isLoadingSummary = false; // 防重加载锁
var selectedSuppliers = []; // 供货商多选列表
var orderStatusCache = {}; // 入库/配送状态缓存 { buyMap:{}, sendMap:{}, stuckMap:{} }
// 从 localStorage 恢复缓存（校验结构完整性）
(function() {
    try {
        var saved = localStorage.getItem('orderStatusCache');
        if (saved) {
            var parsed = JSON.parse(saved);
            if (parsed && typeof parsed === 'object') {
                orderStatusCache = parsed;
                if (!orderStatusCache.buyMap) orderStatusCache.buyMap = {};
                if (!orderStatusCache.sendMap) orderStatusCache.sendMap = {};
                if (!orderStatusCache.stuckMap) orderStatusCache.stuckMap = {};
            }
        }
    } catch(e) {}
})();
var supplierSearchKeyword = ''; // 供货商关键字模糊搜索

var themes = ['purple', 'blue', 'green', 'dark', 'orange'];
var themeLabels = { purple: '💜 紫韵', blue: '🌊 海蓝', green: '🌿 翠绿', dark: '🌙 暗夜', orange: '🌅 暖橙' };

var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ========== 权限系统 ==========
var defaultPermissions = { view_summary:true, edit_status:true, manage_order:true, manage_employees:true, manage_devices:true, manage_stores:true, manage_admins:false, sync_data:true, view_audit_log:true, notify_refresh:true, view_delivery_todo:true };
function getPermissions() { return user.role === 'super_admin' ? Object.assign({}, defaultPermissions, { manage_admins:true }) : Object.assign({}, defaultPermissions, user.permissions || {}); }
function hasPermission(perm) { return getPermissions()[perm] === true; }
function checkPermission(perm, msg) { if (!hasPermission(perm)) { showAlert(msg || '您没有该操作的权限'); return false; } return true; }

// ========== 北京时间工具（与后端 toBjDate 一致）==========
function bjToday() { var d = new Date(); var bj = new Date(d.getTime() + 8 * 3600000); return bj.toISOString().substring(0, 10); }
function toBjDate(utcInput) { if (!utcInput) return ''; var d = typeof utcInput === 'string' ? new Date(utcInput) : utcInput; if (isNaN(d.getTime())) return ''; var bjMs = d.getTime() + 8 * 3600000; return new Date(bjMs).toISOString().substring(0, 10); }

function initPermissionUI() {
    var perms = getPermissions();
    var adminsTab = document.getElementById('adminsTabBtn'); if (adminsTab) adminsTab.style.display = user.role === 'super_admin' ? '' : 'none';
    var empTab = document.querySelector('[data-tab="employees"]'); if (empTab && !perms.manage_employees) empTab.style.display = 'none';
    var devTab = document.querySelector('[data-tab="devices"]'); if (devTab && !perms.manage_devices) devTab.style.display = 'none';
    var storeTab = document.querySelector('[data-tab="users"]'); if (storeTab && !perms.manage_stores) storeTab.style.display = 'none';
    var auditTab = document.querySelector('[data-tab="audit"]'); if (auditTab && !perms.view_audit_log) auditTab.style.display = 'none';
    var syncBtn = document.getElementById('syncPlanBtn'); if (syncBtn && !perms.sync_data) syncBtn.style.display = 'none';
    var notifyBtn = document.getElementById('notifyRefreshBtn'); if (notifyBtn && !perms.notify_refresh) notifyBtn.style.display = 'none';
    var todoBtn = document.getElementById('deliveryTodoBtn'); if (todoBtn && !perms.view_delivery_todo) todoBtn.style.display = 'none';
    var selectAllTh = document.querySelector('#summaryTable th:first-child'); if (selectAllTh && !perms.edit_status) selectAllTh.style.display = 'none';
}

var savedTheme = localStorage.getItem('appTheme') || 'purple';
document.documentElement.setAttribute('data-theme', savedTheme);
document.getElementById('themeBtn').addEventListener('click', function() {
    var idx = themes.indexOf(document.documentElement.getAttribute('data-theme') || 'purple');
    var next = themes[(idx + 1) % themes.length];
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('appTheme', next); this.textContent = themeLabels[next];
});
document.getElementById('themeBtn').textContent = themeLabels[savedTheme];

document.getElementById('logoutBtn').addEventListener('click', async function() {
    showConfirm('确定退出登录？', async function() {
        try { await callEdgeFunction('logout_device', { target_type:'store', target_id:user.username, device_id:getDeviceId() }); } catch(e) {}
        localStorage.removeItem('token'); localStorage.removeItem('user'); window.location.href = './';
    }, null, '确定退出', '留在页面');
});

// Tab 切换
document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        this.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        var targetEl = document.getElementById('tab-' + (this.dataset.tab || ''));
        if (targetEl) targetEl.classList.add('active');
        if (this.dataset.tab === 'employees') loadEmployees();
        if (this.dataset.tab === 'devices') { loadPendingDevices(); loadAuthorizedDevices(); }
        if (this.dataset.tab === 'users') loadStores();
        if (this.dataset.tab === 'audit') loadLogs();
        stopAutoRefresh();
    });
});

// 自动刷新
document.getElementById('autoRefreshInterval').addEventListener('change', function() { var i = parseInt(this.value); if (i > 0) startAutoRefresh(i); else stopAutoRefresh(); });
document.getElementById('refreshBtn').addEventListener('click', async function() {
    var restore = setBtnLoading(this, '刷新中...');
    try { await loadSummary(); } finally { restore(); }
});
document.getElementById('refreshNewBtn').addEventListener('click', loadSummary);

function startAutoRefresh(interval) { stopAutoRefresh(); autoRefreshInterval = interval * 1000; document.getElementById('refreshIndicator').style.display = 'inline'; autoRefreshTimer = setInterval(function() { loadSummary(true); }, autoRefreshInterval); }
function stopAutoRefresh() { if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; } document.getElementById('refreshIndicator').style.display = 'none'; }

// 批量选择
window.isBatchOperating = false;
window.toggleSelectAll = function() { var cb = document.getElementById('selectAllCheckbox'); document.querySelectorAll('.product-checkbox').forEach(function(cb2) { cb2.checked = cb.checked; var pc = cb2.dataset.productCode; if (cb.checked) selectedProducts[pc] = true; else delete selectedProducts[pc]; }); updateBatchToolbar(); };
window.toggleProductSelect = function(pc) { if (selectedProducts[pc]) delete selectedProducts[pc]; else selectedProducts[pc] = true; updateBatchToolbar(); var allC = true; document.querySelectorAll('.product-checkbox').forEach(function(cb) { if (!cb.checked) allC = false; }); document.getElementById('selectAllCheckbox').checked = allC; };
function updateBatchToolbar() { var c = Object.keys(selectedProducts).length; document.getElementById('selectedCount').textContent = c; document.getElementById('batchToolbar').style.display = c > 0 ? 'flex' : 'none'; }
window.clearSelection = function() { selectedProducts = {}; document.querySelectorAll('.product-checkbox').forEach(function(cb) { cb.checked = false; }); document.getElementById('selectAllCheckbox').checked = false; updateBatchToolbar(); };

window.batchSetStatus = async function() {
    if (!checkPermission('edit_status', '您没有批量修改状态的权限')) return;
    var codes = Object.keys(selectedProducts); if (codes.length === 0) return;
    if (window.isBatchOperating) return;
    var sel = document.getElementById('batchTargetStatus');
    var targetStatus = sel ? sel.value : '已完成';
    if (!targetStatus) { showAlert('请选择目标状态'); return; }
    if (!confirm('确定将选中 ' + codes.length + ' 个商品标记为「' + targetStatus + '」？')) return;
    window.isBatchOperating = true;
    var restore = setBtnLoading(document.getElementById('batchSetStatusBtn'), '处理中...');
    try {
        var result = await callEdgeFunction('batch_update_status', { product_codes: codes, target_status: targetStatus, operator: (user && (user.username || user.name)) || '管理员' });
        if (result.success) { showToast('批量标记完成！成功 ' + (result.data.success_count || codes.length) + ' 项', 'success'); }
        else { showAlert('批量标记失败：' + (result.error || '未知')); }
        clearSelection(); loadSummary(true);
    } finally { window.isBatchOperating = false; restore(); }
};

// 弹窗事件
document.getElementById('detailModalClose').addEventListener('click', function() { document.getElementById('detailModal').classList.remove('show'); });
document.getElementById('detailModal').addEventListener('click', function(e) { if (e.target === this) this.classList.remove('show'); });
document.getElementById('alertOkBtn').addEventListener('click', function() { var m = document.getElementById('alertModal'); m.classList.remove('show'); var mc = m.querySelector('.modal-content'); if (mc) mc.style.maxWidth = ''; });

// ========== 需求明细实时配送数据刷新 ==========
async function refreshTransitData(productCode, stores) {
    if (!stores || stores.length === 0) return null;

    // v5.15.6: 从 summaryData 批量结果复用配送量（省掉重复的 Edge Function 请求）
    // loadSummary 的 setTimeout 已经跑了批量 get_realtime_transit（45s 超时，fire-and-forget），
    // 结果写入 summaryData.shortage_by_product[].stores[sid].transit
    // 如果批量结果已经覆盖所有门店，直接构造 transitMap，省一次网络请求
    var _cachedMap = null;
    if (summaryData && summaryData.shortage_by_product) {
        var pMatch = summaryData.shortage_by_product.find(function(p) { return p.product_code === productCode; });
        if (pMatch && pMatch.stores) {
            var _map = {};
            var _allHit = true;
            stores.forEach(function(s) {
                var sid = s.sid || s.id;
                var v = pMatch.stores[sid]?.transit;
                if (v !== undefined && v !== null) {
                    _map[s.name] = Number(v);
                } else {
                    _allHit = false;
                }
            });
            if (_allHit && Object.keys(_map).length > 0) {
                _cachedMap = _map;
                console.log('[refreshTransitData] ✅ 复用 summaryData 批量配送结果，省一次请求: ' + productCode + ' (' + Object.keys(_map).length + ' 门店)');
            }
        }
    }

    // 统一的 DOM 更新函数 —— ★ 只填空单元格，绝不覆盖已有数字
    // 弹窗渲染时已同步写好 s.transit 的值（data-transit="10" 或 data-transit=""）
    // 这里只补 data-transit="" 的（之前渲染为 "-" 的空单元格）
    function _applyMap(map) {
        var cells = document.querySelectorAll('#detailTbody td.real-transit');
        cells.forEach(function(cell) {
            // 只处理 data-transit 为空的单元格（showShortageDetail 同步渲染时标记的缓存缺失）
            if (cell.getAttribute('data-transit') !== '' && cell.getAttribute('data-transit') !== null) return;
            var name = cell.getAttribute('data-store');
            var val = map ? map[name] : undefined;
            if (val === undefined || val === null || isNaN(Number(val))) {
                cell.textContent = 0; cell.style.color = '#999'; cell.style.fontWeight = '600'; cell.setAttribute('data-transit', '0');
            } else {
                var n = Number(val);
                cell.textContent = n; cell.style.color = n > 0 ? '#27ae60' : '#999'; cell.style.fontWeight = '600'; cell.setAttribute('data-transit', String(n));
            }
        });
        updateDetailStatusCells();
        return map;
    }

    // 如果批量结果已全部命中 → 直接返回 map（showShortageDetail 已经同步渲染好了，不需要再调 _applyMap）
    if (_cachedMap) { return _cachedMap; }

    // v5.8.2+ 修复：since 用每家门店自己的 report_time（按"上报日期之后"的配送计算）
    // 上报日期之前的配送不计入"已配送"——因为门店在上报时把过去配送的货算成库存了
    // 如果用商品全局最早，会把 14 第十四药店 7/19 上报前 7/18 的 2 配送也算入，但门店已经把这 2 当作库存
    var items = stores.map(function(s) {
        var since = '2026-01-01';
        if (s.report_time) {
            var d = new Date(s.report_time);
            since = d.getFullYear() + '-' +
                String(d.getMonth() + 1).padStart(2, '0') + '-' +
                String(d.getDate()).padStart(2, '0');
        }
        return { store_name: s.name, since: since };
    });
    try {
        var resp = await callEdgeFunction('get_realtime_transit', { product_code: productCode, items: items });
        if (!resp.success || !resp.data || !resp.data.transitMap) {
            return _applyMap(null);
        }
        var map = resp.data.transitMap;
        return _applyMap(map);
    } catch(e) {
        console.warn('实时配送查询失败', e);
        return _applyMap(null);
    }
}

// 根据"已配送"和"需求"实时计算每行的"完成状态"和行高亮（严格按已配送判断）
function updateDetailStatusCells() {
    var rows = document.querySelectorAll('#detailTbody tr');
    rows.forEach(function(row) {
        var transitCell = row.querySelector('td.real-transit');
        var demandCell = row.querySelector('td.detail-demand');
        var statusCell = row.querySelector('td.detail-status');
        if (!transitCell || !demandCell || !statusCell) return;
        var transit = parseInt(transitCell.getAttribute('data-transit') || '0') || 0;
        var demand = parseInt(demandCell.getAttribute('data-demand') || '0') || 0;
        var rowBg = '';
        if (demand > 0 && transit >= demand) {
            statusCell.innerHTML = '<span style="color:#27ae60;font-weight:700;">✓ 已入库</span>';
            rowBg = '#e8f5e9';
            row.setAttribute('data-row-status', 'completed');
        } else if (transit > 0 && transit < demand) {
            statusCell.innerHTML = '<span style="color:#ef6c00;font-weight:600;">⚠ 部分</span>';
            rowBg = '#fff3e0';
            row.setAttribute('data-row-status', 'partial');
        } else {
            statusCell.innerHTML = '<span style="color:#999;">未配送</span>';
            row.setAttribute('data-row-status', 'pending');
        }
        row.style.background = rowBg;
    });
    // 应用过滤
    applyHideCompletedFilter();
}

// 切换"只看未完成"过滤
window.toggleHideCompleted = function() { applyHideCompletedFilter(); };
function applyHideCompletedFilter() {
    var cb = document.getElementById('detailHideCompleted');
    if (!cb) return;
    var rows = document.querySelectorAll('#detailTbody tr');
    rows.forEach(function(row) {
        var status = row.getAttribute('data-row-status');
        row.style.display = (cb.checked && status === 'completed') ? 'none' : '';
    });
}

// ========== 状态变更日志 ==========
document.getElementById('statusLogQueryBtn').addEventListener('click', function() { fetchStatusChangeLog(document.getElementById('statusLogProductCode').value.trim() || null); });
document.getElementById('statusLogProductCode').addEventListener('keypress', function(e) { if (e.key === 'Enter') fetchStatusChangeLog(document.getElementById('statusLogProductCode').value.trim() || null); });

async function fetchStatusChangeLog(productCode) {
    var tbody = document.getElementById('statusLogTbody'); tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">⏳ 查询中...</td></tr>';
    try {
        var params = { top: 100 }; if (productCode) params.log_product_code = productCode;
        var result = await callEdgeFunction('get_status_change_log', params);
        if (!result.success) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">查询失败</td></tr>'; return; }
        var logs = result.data || [];
        if (logs.length === 0) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">暂无记录</td></tr>'; return; }
        tbody.innerHTML = '';
        logs.forEach(function(l) {
            var ds = l.变更时间 ? new Date(l.变更时间).toLocaleString('zh-CN') : '-';
            var ob = l.原状态 ? '<span class="replenish-badge replenish-text">' + safeText(statusLabel(l.原状态)) + '</span>' : '-';
            var nb = '<span class="replenish-badge replenish-' + getBadgeClass(l.新状态) + '">' + safeText(statusLabel(l.新状态)) + '</span>';
            tbody.innerHTML += '<tr><td style="font-size:12px;">'+safeText(ds)+'</td><td>'+safeText(l.商品编码||'-')+'</td><td>'+ob+'</td><td>'+nb+'</td><td>'+safeText(l.操作人||'-')+'</td><td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;">'+safeText(l.备注||'')+'</td></tr>';
        });
    } catch(e) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">查询出错</td></tr>'; }
}
function getBadgeClass(status) { var m = { '待处理':'pending','已订购':'ordered','已到货':'arrived','已完成':'completed','已配送':'completed','待付款':'payment','厂家断货':'outstock' }; return m[status] || 'text'; }

// 订货管理弹窗
document.getElementById('orderModalClose').addEventListener('click', function() { document.getElementById('orderModal').classList.remove('show'); });
document.getElementById('orderModal').addEventListener('click', function(e) { if (e.target === this) this.classList.remove('show'); });
document.getElementById('omCancelBtn').addEventListener('click', function() { document.getElementById('orderModal').classList.remove('show'); });
document.getElementById('omSaveBtn').addEventListener('click', handleOrderSave);

// ========== 一键同步（分步进度提示）v2：完成判定 ==========
// v5.15.6: desc 提升到模块级 —— 之前定义在 IIFE 里 onclick 外部引用 → ReferenceError
var _SYNC_DESC = '重新跑一遍缺货判定：按仓库采购入库数量核对各门店缺货汇总，把已满足的单据从待处理改为已入库；会把状态真的改掉，改完就保存，刷新页面依然生效；不会推送系统内通知；通常 30 秒到 3 分钟';

// 页面加载时从缓存读取上次手动同步时间 + 异步拉取自动同步状态
(function() {
    var btn = document.getElementById('syncPlanBtn');
    var manualTime = localStorage.getItem('lastSyncTime');
    var manualText = manualTime ? new Date(parseInt(manualTime)).toLocaleString('zh-CN') : '从未';
    
    // 先显示本地缓存的手动同步时间（秒开）
    btn.setAttribute('data-tip', _SYNC_DESC + '\n手动同步：' + manualText + '\n自动同步：加载中...');
    
    // 异步拉取自动同步状态
    fetch('https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/scheduled-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_last_sync' })
    }).then(function(r) { return r.json(); }).then(function(data) {
        if (!data.success) { btn.setAttribute('data-tip', _SYNC_DESC + '\n手动同步：' + manualText); return; }
        var autoText = data.auto_sync && data.auto_sync.start_time ? data.auto_sync.start_time + (data.auto_sync.status === 'succeeded' ? ' ✅' : ' ⚠️') : '暂无记录';
        var nextText = data.next_sync_beijing || '';
        var tip = _SYNC_DESC + '\n手动同步：' + manualText + '\n自动同步：' + autoText;
        if (nextText) tip += '\n下次自动：' + nextText;
        btn.setAttribute('data-tip', tip);
    }).catch(function(e) {
        // v5.15.5: scheduled-task get_last_sync 失败时也打 console.error
        console.warn('[同步状态 fetch] scheduled-task/get_last_sync 失败:', e?.message || e);
        btn.setAttribute('data-tip', _SYNC_DESC + '\n手动同步：' + manualText);
    });
})();
document.getElementById('syncPlanBtn').addEventListener('click', async function() {
    if (!checkPermission('sync_data', '您没有同步数据的权限')) return;
    var btn = this, restore = setBtnLoading(btn);
    btn.classList.add('btn-loading');
    var stages = ['① 商品缓存同步...', '② 完成判定中...', '同步完成...'];
    var stageIdx = 0;
    var stageTimer = setInterval(function() {
        if (stageIdx < stages.length) {
            btn.textContent = stages[stageIdx++];
        }
    }, 1200);
    try {
        var r = await callEdgeFunction('sync_with_auto_status', { operator: (user && (user.username || user.name)) || '管理员' }, { timeout: 180000, maxRetries: 1 });
        clearInterval(stageTimer);
        if (!r.success) {
            var errMsg = r.error || '未知';
            if (errMsg.indexOf('超时') >= 0) {
                showToast('同步请求超时，正在尝试加载最新数据...', 'info');
                btn.classList.remove('btn-loading'); restore();
                localStorage.setItem('lastSyncTime', Date.now());
                await loadSummary(true);
                return;
            } else {
                showAlert('检测失败：' + errMsg);
                restore(); return;
            }
        }
        btn.classList.remove('btn-loading'); btn.classList.add('btn-success');
        var now = Date.now();
        localStorage.setItem('lastSyncTime', now);
        // v5.15.6: 拼成功提示带上真实结果数（后端返回的 detect_details 长度 / changed_count）
        var changed = (r.data && r.data.detect_details) ? r.data.detect_details.length : 0;
        var tipText = _SYNC_DESC + '\n上次同步：' + new Date(now).toLocaleString('zh-CN');
        if (changed > 0) tipText += '\n本次检测到 ' + changed + ' 条状态变化';
        btn.setAttribute('data-tip', tipText);
        var successMsg = r.message || ('判定完成！检测到 ' + changed + ' 条状态变化');
        showToast(successMsg, 'success');
        var detail = r.data?.detect_details || [];
        if (detail.length > 0) {
            var modal = document.getElementById('alertModal'), msgEl = document.getElementById('alertMsg');
            if (modal && msgEl) { msgEl.textContent = detail.join('\n'); modal.classList.add('show'); }
        }
        localStorage.removeItem('summaryData');
        await loadSummary(true);
    } catch(e) {
        // v5.15.5: 把真实错误写到 console.error（diagnostic.log 会抓），toast 带原因
        var _errMsg = (e && (e.message || e.error || JSON.stringify(e).slice(0, 200))) || '未知';
        console.error('[一键同步 ❌] sync_with_auto_status 抛错:', _errMsg, e);
        showToast('同步异常：' + _errMsg.slice(0, 80), 'error');
        btn.classList.remove('btn-loading'); restore();
        try { await loadSummary(true); } catch(_) {}
    }
    finally { setTimeout(function() { restore(); btn.classList.remove('btn-success'); }, 1500); }
});

// ========== 通知刷新（独立按钮：手动触发到货通知） ==========
document.getElementById('notifyRefreshBtn').addEventListener('click', async function() {
    if (!checkPermission('notify_refresh', '您没有发送到货通知的权限')) return;
    var btn = this, restore = setBtnLoading(btn, '通知发送中...');
    try {
        var r = await callEdgeFunction('notify_refresh', { operator: (user && (user.username || user.name)) || '管理员' }, { timeout: 180000, maxRetries: 1 });
        if (!r.success) { showAlert('发送到货通知失败：' + (r.error || '未知')); restore(); return; }
        showToast('发送到货通知完成：发送 ' + (r.data?.notified || 0) + ' 条，跳过 ' + (r.data?.skipped || 0) + ' 条', 'success');
    } catch(e) {
        showToast('发送到货通知异常，请重试', 'error');
    } finally { restore(); }
});

// ========== 配送待办：数据/筛选/导出辅助 ==========
var deliveryTodoData = [];

function todoRowHtml(t, i) {
    var bg = (i % 2 === 1) ? ' style="background:#fafafa;"' : '';
    return '<tr' + bg + '><td style="padding:4px 8px;border:1px solid #d9d9d9;white-space:nowrap;">' + safeText(t.product_code) + '</td>'
        + '<td style="padding:4px 8px;border:1px solid #d9d9d9;"><div style="max-width:190px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + escapeHtml(t.product_name || '') + '">' + safeText(t.product_name) + '</div></td>'
        + '<td style="padding:4px 8px;border:1px solid #d9d9d9;white-space:nowrap;">' + safeText(t.product_spec || '-') + '</td>'
        + '<td style="padding:4px 8px;border:1px solid #d9d9d9;"><div style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + escapeHtml(t.manufacturer || '') + '">' + safeText(t.manufacturer || '-') + '</div></td>'
        + '<td style="padding:4px 8px;border:1px solid #d9d9d9;white-space:nowrap;">' + safeText(t.store_name) + '</td>'
        + '<td style="padding:4px 8px;text-align:center;border:1px solid #d9d9d9;white-space:nowrap;">' + t.demand + '</td>'
        + '<td style="padding:4px 8px;text-align:center;border:1px solid #d9d9d9;white-space:nowrap;">' + t.store_stock + '</td>'
        + '<td style="padding:4px 8px;text-align:center;border:1px solid #d9d9d9;white-space:nowrap;">' + (t.transit || 0) + '</td>'
        + '<td style="padding:4px 8px;text-align:center;border:1px solid #d9d9d9;white-space:nowrap;">' + t.wh_stock + '</td></tr>';
}

function getFilteredTodo(filter) {
    return filter ? deliveryTodoData.filter(function(t) { return t.store_name === filter; }) : deliveryTodoData;
}

function redrawTodoRows(filter) {
    var tbody = document.querySelector('#alertModal table tbody');
    if (!tbody) return;
    var rows = getFilteredTodo(filter);
    if (rows.length === 0) { tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#999;padding:20px;">该门店暂无待配送商品</td></tr>'; return; }
    tbody.innerHTML = rows.map(function(t, i) { return todoRowHtml(t, i); }).join('');
}

function exportDeliveryTodoExcel(filter) {
    var rows = getFilteredTodo(filter);
    if (rows.length === 0) { showToast('没有可导出的数据', 'error'); return; }
    var data = rows.map(function(t, i) {
        return { '序号': i + 1, '编码': t.product_code || '', '品名': t.product_name || '', '规格': t.product_spec || '', '厂家': t.manufacturer || '', '门店': t.store_name || '', '需求': t.demand, '门店库存': t.store_stock, '在途': t.transit || 0, '仓库库存': t.wh_stock };
    });
    var fname = '配送待办' + (filter ? '_' + filter : '') + '_' + new Date().toISOString().slice(0, 10) + '.xlsx';
    if (typeof XLSX !== 'undefined') {
        try {
            var ws = XLSX.utils.json_to_sheet(data);
            ws['!cols'] = [{wch:5},{wch:10},{wch:26},{wch:12},{wch:30},{wch:14},{wch:6},{wch:9},{wch:6},{wch:9}];
            var wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, '配送待办');
            XLSX.writeFile(wb, fname);
            return;
        } catch (e) { /* 降级 CSV */ }
    }
    var headers = Object.keys(data[0]);
    var csv = '\ufeff' + headers.join(',') + '\n' + data.map(function(row) {
        return headers.map(function(h) { var v = String(row[h] == null ? '' : row[h]); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
    }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname.replace('.xlsx', '.csv');
    a.click();
    URL.revokeObjectURL(a.href);
}

// ========== 配送待办（已完成但未配送到店）==========
document.getElementById('deliveryTodoBtn').addEventListener('click', async function() {
    if (!checkPermission('view_delivery_todo', '您没有查看配送待办的权限')) return;
    var btn = this, PAGE_SIZE = 200, MAX_PAGES = 200;
    var restore = setBtnLoading(btn, '正在升级配送状态 (第 1 页)...');
    var totalUpgraded = 0, totalPages = 0, totalSkipped = 0;
    var startTs = Date.now();
    var finalError = null;
    try {
        // ========== Phase 1: 循环升级 ==========
        var offset = 0;
        while (totalPages < MAX_PAGES) {
            totalPages++;
            // 更新按钮进度（每页都刷一次）
            btn.textContent = '正在升级配送状态 (第 ' + totalPages + ' 页, 累计 ' + totalUpgraded + ' 条)';
            var r;
            try {
                r = await callEdgeFunction('upgrade_to_delivered', { offset: offset, max_records: PAGE_SIZE }, { timeout: 120000, maxRetries: 1 });
            } catch (netErr) {
                // 网络层错误：记录后 break（后端可能挂了，重试也没用）
                finalError = '第 ' + totalPages + ' 页网络失败: ' + (netErr?.message || '未知');
                console.error('[配送升级]', finalError);
                break;
            }
            if (!r || !r.success) {
                // 业务层错误：记录后尝试继续（可能是某一页数据脏了）
                var errMsg = (r && r.error) || '未知';
                finalError = '第 ' + totalPages + ' 页失败: ' + errMsg + '（已处理 ' + totalUpgraded + ' 条）';
                console.warn('[配送升级]', finalError);
                // 业务错误 break（避免死循环同一页）
                break;
            }
            var data = r.data || {};
            totalUpgraded += data.actually_upgraded || 0;
            totalSkipped += (data.total_completed || 0) - (data.to_upgrade || 0);
            // has_more=false 或本页没拉满（说明后面没了）→ 结束
            if (!data.has_more || (data.total_completed || 0) < PAGE_SIZE) break;
            offset = data.next_offset || (offset + PAGE_SIZE);
        }

        // ========== Phase 2: 查配送待办（刷新后更准）==========
        btn.textContent = '正在加载待办清单...';
        var r2 = await callEdgeFunction('get_delivery_todo', {}, { timeout: 180000, maxRetries: 1 });
        if (!r2.success) { showAlert('加载待办失败：' + (r2.error || '未知')); return; }
        var todo = r2.data?.todo || [];
        deliveryTodoData = todo || [];

        // ========== Phase 3: 构建弹窗 ==========
        var summaryEl = '';
        var elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
        if (finalError) {
            summaryEl = '<div style="padding:10px 14px;background:#fff3cd;border:1px solid #ffe58f;border-radius:6px;margin-bottom:10px;font-size:13px;color:#856404;">'
                + '⚠ ' + escapeHtml(finalError) + '<br>已完成 ' + totalUpgraded + ' 条 / ' + totalPages + ' 页 / ' + elapsed + ' 秒，可再点一次继续'
                + '</div>';
        } else if (totalUpgraded > 0) {
            summaryEl = '<div style="padding:10px 14px;background:#d4edda;border:1px solid #c3e6cb;border-radius:6px;margin-bottom:10px;font-size:13px;color:#155724;">'
                + '✅ 本次升级 ' + totalUpgraded + ' 条 / ' + totalPages + ' 页 / ' + elapsed + ' 秒（跳过 ' + totalSkipped + ' 条配送量不足）'
                + '</div>';
        } else if (totalPages > 1) {
            summaryEl = '<div style="padding:10px 14px;background:#e2e3e5;border:1px solid #d6d8db;border-radius:6px;margin-bottom:10px;font-size:13px;color:#383d41;">'
                + '本次无新增可升级记录（已扫 ' + totalPages + ' 页 / ' + elapsed + ' 秒）'
                + '</div>';
        }

        var html;
        if (todo.length === 0) {
            html = summaryEl + '<div style="text-align:center;color:#999;padding:20px;">暂无待配送商品</div>';
        } else {
            html = summaryEl + '<div style="max-height:60vh;overflow-y:auto;"><table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #d9d9d9;">'
                + '<thead><tr style="background:#f5f5f5;"><th style="padding:5px 8px;text-align:left;border:1px solid #d9d9d9;white-space:nowrap;position:sticky;top:0;z-index:1;background:#f5f5f5;box-shadow:inset -1px 0 0 #d9d9d9,inset 0 -1px 0 #d9d9d9;">编码</th><th style="padding:5px 8px;text-align:left;border:1px solid #d9d9d9;white-space:nowrap;position:sticky;top:0;z-index:1;background:#f5f5f5;box-shadow:inset -1px 0 0 #d9d9d9,inset 0 -1px 0 #d9d9d9;">品名</th><th style="padding:5px 8px;text-align:left;border:1px solid #d9d9d9;white-space:nowrap;position:sticky;top:0;z-index:1;background:#f5f5f5;box-shadow:inset -1px 0 0 #d9d9d9,inset 0 -1px 0 #d9d9d9;">规格</th><th style="padding:5px 8px;text-align:left;border:1px solid #d9d9d9;white-space:nowrap;position:sticky;top:0;z-index:1;background:#f5f5f5;box-shadow:inset -1px 0 0 #d9d9d9,inset 0 -1px 0 #d9d9d9;">厂家</th><th style="padding:5px 8px;text-align:left;border:1px solid #d9d9d9;white-space:nowrap;position:sticky;top:0;z-index:1;background:#f5f5f5;box-shadow:inset -1px 0 0 #d9d9d9,inset 0 -1px 0 #d9d9d9;">门店</th><th style="padding:5px 8px;text-align:center;border:1px solid #d9d9d9;white-space:nowrap;position:sticky;top:0;z-index:1;background:#f5f5f5;box-shadow:inset -1px 0 0 #d9d9d9,inset 0 -1px 0 #d9d9d9;">需求</th><th style="padding:5px 8px;text-align:center;border:1px solid #d9d9d9;white-space:nowrap;position:sticky;top:0;z-index:1;background:#f5f5f5;box-shadow:inset -1px 0 0 #d9d9d9,inset 0 -1px 0 #d9d9d9;">门店库存</th><th style="padding:5px 8px;text-align:center;border:1px solid #d9d9d9;white-space:nowrap;position:sticky;top:0;z-index:1;background:#f5f5f5;box-shadow:inset -1px 0 0 #d9d9d9,inset 0 -1px 0 #d9d9d9;">在途</th><th style="padding:5px 8px;text-align:center;border:1px solid #d9d9d9;white-space:nowrap;position:sticky;top:0;z-index:1;background:#f5f5f5;box-shadow:inset -1px 0 0 #d9d9d9,inset 0 -1px 0 #d9d9d9;">仓库库存</th></tr></thead><tbody>';
            todo.forEach(function(t, i) {
                var bg = (i % 2 === 1) ? ' style="background:#fafafa;"' : '';
                html += '<tr' + bg + '><td style="padding:4px 8px;border:1px solid #d9d9d9;white-space:nowrap;">' + safeText(t.product_code) + '</td>'
                    + '<td style="padding:4px 8px;border:1px solid #d9d9d9;"><div style="max-width:190px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + escapeHtml(t.product_name || '') + '">' + safeText(t.product_name) + '</div></td>'
                    + '<td style="padding:4px 8px;border:1px solid #d9d9d9;white-space:nowrap;">' + safeText(t.product_spec || '-') + '</td>'
                    + '<td style="padding:4px 8px;border:1px solid #d9d9d9;"><div style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + escapeHtml(t.manufacturer || '') + '">' + safeText(t.manufacturer || '-') + '</div></td>'
                    + '<td style="padding:4px 8px;border:1px solid #d9d9d9;white-space:nowrap;">' + safeText(t.store_name) + '</td>'
                    + '<td style="padding:4px 8px;text-align:center;border:1px solid #d9d9d9;white-space:nowrap;">' + t.demand + '</td>'
                    + '<td style="padding:4px 8px;text-align:center;border:1px solid #d9d9d9;white-space:nowrap;">' + t.store_stock + '</td>'
                    + '<td style="padding:4px 8px;text-align:center;border:1px solid #d9d9d9;white-space:nowrap;">' + (t.transit || 0) + '</td>'
                    + '<td style="padding:4px 8px;text-align:center;border:1px solid #d9d9d9;white-space:nowrap;">' + t.wh_stock + '</td></tr>';
            });
            html += '</tbody></table></div>';
        }
        var modal = document.getElementById('alertModal'), msgEl = document.getElementById('alertMsg');
        if (modal && msgEl) {
            var mc = modal.querySelector('.modal-content'); if (mc) mc.style.maxWidth = '1100px';
            msgEl.innerHTML = html; modal.classList.add('show');
            // 工具栏：门店筛选 + 导出 Excel
            var stores = [];
            deliveryTodoData.forEach(function(t) { if (t.store_name && stores.indexOf(t.store_name) < 0) stores.push(t.store_name); });
            stores.sort();
            var opts = '<option value="">全部门店（' + deliveryTodoData.length + ' 条）</option>';
            stores.forEach(function(s) {
                var cnt = deliveryTodoData.filter(function(t) { return t.store_name === s; }).length;
                opts += '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '（' + cnt + ' 条）</option>';
            });
            var bar = document.createElement('div');
            bar.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;';
            bar.innerHTML = '<span style="font-size:13px;color:#666;">门店筛选：</span>'
                + '<select id="todoStoreFilter" style="padding:4px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;min-width:150px;">' + opts + '</select>'
                + '<button id="todoExportBtn" style="margin-left:auto;padding:5px 16px;background:#27ae60;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;">导出 Excel</button>';
            msgEl.insertBefore(bar, msgEl.firstChild);
            var sel = bar.querySelector('#todoStoreFilter');
            if (sel) sel.onchange = function() { redrawTodoRows(sel.value); };
            var exp = bar.querySelector('#todoExportBtn');
            if (exp) exp.onclick = function() { exportDeliveryTodoExcel(sel ? sel.value : ''); };
            // 刷新角标
            refreshDeliveryTodoCount({ silent: true });
        }
    } catch(e) {
        showToast('加载待办异常，请重试', 'error');
    } finally { restore(); }
});

// ========== 配送待办数量角标（静默刷新，60秒节流） ==========
var _todoCountLast = 0;
async function refreshDeliveryTodoCount(opts) {
    opts = opts || {};
    if (opts.skipIfCached) { console.log('[v30] refreshDeliveryTodoCount 跳过（合并数据已覆盖）'); return; }
    var now = Date.now();
    if (now - _todoCountLast < 60000) return;
    _todoCountLast = now;
    try {
        var r = await callEdgeFunction('get_delivery_todo', {}, { timeout: 60000, maxRetries: 0 });
        var el = document.getElementById('arrivedCount');
        if (el && r && r.success && r.data) el.textContent = String((r.data.todo || []).length);
    } catch(e) { /* 静默失败，保持 '-' */ }
}

async function refreshWarehouseStock() {
    var activeItems = (summaryData && summaryData.shortage_by_product) || [];
    var completedItems = (summaryData && summaryData.completed_by_product) || [];
    var items = activeItems.concat(completedItems);
    if (items.length === 0) return;
    var codes = items.map(function(p) { return p.product_code; }).filter(Boolean);
    codes = [...new Set(codes)];
    if (codes.length === 0) return;
    try {
        var resp = await callEdgeFunction('get_warehouse_stock', { product_codes: codes }, { timeout: 120000, maxRetries: 1 });
        if (!resp.success) return;
        var map = resp.data.warehouseStockMap || {};
        items.forEach(function(p) {
            if (map[p.product_code] !== undefined) p.warehouse_stock = map[p.product_code];
        });
        renderSummaryPage(); renderCompletedSection();
    } catch(e) { console.warn('刷新仓库库存失败', e); }
}

async function refreshRealtimeStock(returnResult) {
    var activeItems = (summaryData && summaryData.shortage_by_product) || [];
    var completedItems = (summaryData && summaryData.completed_by_product) || [];
    var allItems = activeItems.concat(completedItems);
    if (allItems.length === 0) return returnResult ? { stockMap: {}, transitMap: {} } : null;
    // 构建 (product_code, store_id, since) 元组（用前端 summaryData 的最新数据传过去）
    var items = [];
    allItems.forEach(function(p) {
        if (!p.product_code) return;
        for (var sid in p.stores) {
            var s = p.stores[sid];
            if (s && s.report_time) {
                var d = new Date(s.report_time);
                var since = d.getFullYear() + '-' +
                    String(d.getMonth() + 1).padStart(2, '0') + '-' +
                    String(d.getDate()).padStart(2, '0');
                items.push({ product_code: p.product_code, store_id: sid, since: since });
            }
        }
    });
    if (items.length === 0) return returnResult ? { stockMap: {}, transitMap: {} } : null;
    try {
        // get_realtime_stock 查 vBuySendSumDetail 视图，量大时 60s 可能不够
        var resp = await callEdgeFunction('get_realtime_stock', { items: items }, { timeout: 180000, maxRetries: 1 });
        if (!resp.success) {
            console.warn('[Refresh] get_realtime_stock 失败:', resp.error);
            return returnResult ? { stockMap: {}, transitMap: {} } : null;
        }
        var stockMap = resp.data.realtimeStockMap || {}, transitMap = resp.data.realtimeTransitMap || {};
        // 【v25】如果传了 returnResult=true，只返回数据，由调用方合并后统一渲染
        if (returnResult) {
            return { stockMap: stockMap, transitMap: transitMap };
        }
        // 默认行为：更新 shortage_by_product 和 completed_by_product 的 stores 并重绘
        allItems.forEach(function(p) {
            for (var sid in p.stores) {
                var key = p.product_code + '||' + sid;
                if (stockMap[key] !== undefined) p.stores[sid].stock = stockMap[key];
                if (transitMap[key] !== undefined) p.stores[sid].transit = transitMap[key];
            }
        });
        renderSummaryPage(); renderCompletedSection();
    } catch(e) { console.warn('刷新实时库存失败', e); return returnResult ? { stockMap: {}, transitMap: {} } : null; }
}

async function refreshSuppliers() {
    var activeItems = (summaryData && summaryData.shortage_by_product) || [];
    var completedItems = (summaryData && summaryData.completed_by_product) || [];
    var items = activeItems.concat(completedItems);
    if (items.length === 0) return;
    // 先从缓存读，缺失的才请求
    var cached = {};
    try { cached = JSON.parse(localStorage.getItem('supplierCache') || '{}') || {}; } catch(e) {}
    var missing = [];
    items.forEach(function(p) {
        var sup = cached[p.product_code] || cached[(p.product_code||'').replace(/^0+/,'')];
        if (sup) { p.supplier = sup; } else { missing.push(p.product_code); }
    });
    if (missing.length > 0) {
        try {
            var resp = await callEdgeFunction('get_suppliers', { product_codes: [...new Set(missing)] });
            if (resp.success) {
                var lookup = resp.data.supplierLookup || {};
                missing.forEach(function(c) { var s = lookup[c] || lookup[c.replace(/^0+/,'')] || ''; if (s) { cached[c] = s; cached[c.replace(/^0+/,'')] = s; } });
                localStorage.setItem('supplierCache', JSON.stringify(cached));
                items.forEach(function(p) { var s = cached[p.product_code] || cached[(p.product_code||'').replace(/^0+/,'')]; if (s) p.supplier = s; });
            }
        } catch(e) { console.warn('刷新供货商失败', e); }
    }
    renderSummaryPage(); renderCompletedSection();
}
function clearSupplierCache() { localStorage.removeItem('supplierCache'); }

// ========== 检测入库状态（提取核心逻辑供一键同步自动调用）==========
async function autoCheckOrderStatus(silent) {
    var items = (summaryData && summaryData.shortage_by_product) || [];
    if (items.length === 0) return;
    var checkItems = filteredData.length > 0 ? filteredData : items;
    var codes = checkItems.map(function(p) { return p.product_code; });
    if (codes.length === 0) return;
    var storePosNames = {}, demands = {};
    var storeNameById = {};
    STORE_CONFIG.forEach(function(s) { storeNameById[s.id] = s.name; });
    checkItems.forEach(function(p) {
        var names = [];
        for (var sid in p.stores) { var sn = storeNameById[sid] || ''; if (sn && names.indexOf(sn) < 0) names.push(sn); }
        if (names.length > 0) storePosNames[p.product_code] = names;
        demands[p.product_code] = p.stores || {}; // 门店ID→需求数
    });
    try {
        var resp = await callEdgeFunction('check_order_status', { product_codes: codes, store_pos_names: storePosNames, demands: demands });
        if (!resp.success) return;
        orderStatusCache = resp.data;
        localStorage.setItem('orderStatusCache', JSON.stringify(orderStatusCache));
        renderSummaryPage();
        if (!silent) {
            var noStock = codes.filter(function(c) { return !(resp.data.buyMap || {})[c]; });
            var stuck = codes.filter(function(c) { return (resp.data.stuckMap || {})[c]; });
            if (noStock.length > 0 || stuck.length > 0) {
                showAlert('检测汇总：\n\n仓库未入库：' + noStock.length + ' 个商品（配送中心无库存）\n已入库未配送：' + stuck.length + ' 个商品（仓库有货但未发往门店）\n\n请查看表格中的红色标记');
            } else {
                showToast('全部正常！所有商品均已入库并配送中', 'success');
            }
        }
    } catch(e) { if (!silent) showAlert('检测异常：' + (e.message || '')); }
}

// 检测入库状态已合并到一键同步，保留函数供内部调用


// 打开订货管理弹窗
window.showOrderManage = async function(productCode, productName) {
    if (!checkPermission('manage_order', '您没有管理订货数量的权限')) return;
    if (!productCode) return; currentEditProduct = productCode;
    var result = await callEdgeFunction('get_purchase_plan', { plan_product_code: productCode });
    var data = null;
    if (result.success && result.data) { var raw = result.data.plan ? result.data.plan[0] : result.data[0]; if (raw && raw[0]) data = raw[0]; }
    document.getElementById('omProductCode').textContent = productCode || '-';
    document.getElementById('omProductName').textContent = productName || (data ? data.商品名称 : '-');
    document.getElementById('omStock').textContent = data ? data.仓库库存数量 : '-';
    document.getElementById('omSuggested').textContent = data ? data.建议订货数量 : '-';
    document.getElementById('omCurrentStatus').innerHTML = data ? getReplenishBadge(data.补货状态) : getReplenishBadge('待处理');
    document.getElementById('omActualQty').value = (data && data.实际订货数量 > 0) ? data.实际订货数量 : '';
    document.getElementById('omTargetStatus').value = ''; document.getElementById('omRemark').value = (data && data.备注信息) || '';
    document.getElementById('orderModalTitle').textContent = '订货管理 - ' + (productName || productCode);
    // 从当前汇总数据中查找该商品的门店总需求
    var totalDemand = '-';
    if (summaryData && summaryData.shortage_by_product) {
        for (var i = 0; i < summaryData.shortage_by_product.length; i++) {
            if (summaryData.shortage_by_product[i].product_code === productCode) {
                totalDemand = summaryData.shortage_by_product[i].total_demand || 0;
                break;
            }
        }
    }
    document.getElementById('omTotalDemand').textContent = totalDemand !== '-' ? safeText(totalDemand) : '未知';
    document.getElementById('orderModal').classList.add('show');
};

async function handleOrderSave() {
    if (!checkPermission('manage_order', '您没有管理订货数量的权限')) return;
    if (!currentEditProduct) return;
    var aq = document.getElementById('omActualQty').value.trim(), ts = document.getElementById('omTargetStatus').value;
    var rk = document.getElementById('omRemark').value.trim(), op = (user && (user.username || user.name)) || '管理员';
    // 状态选"已订购"但未填写实际数量时，弹窗要求输入订购数量
    if (ts === '已订购' && (aq === '' || parseInt(aq) === 0)) {
        var totalDemand = document.getElementById('omTotalDemand').textContent;
        var suggested = document.getElementById('omSuggested').textContent;
        // 显示当前门店总需求和状态判断提示
        var promptMsg = '当前门店总需求：' + totalDemand + '\n建议订货：' + (suggested !== '-' ? suggested : '未知');
        if (totalDemand !== '-' && totalDemand !== '未知' && parseInt(totalDemand) > 0) {
            promptMsg += '\n⚠ 订购量不足时，后续同步将自动回退为「待处理」';
        }
        promptMsg += '\n\n请输入实际订购数量：';
        var qtyStr = prompt(promptMsg, '');
        if (qtyStr === null) return; // 用户取消
        aq = qtyStr.trim();
        if (aq === '' || parseInt(aq) <= 0) { showAlert('订购数量必须大于0'); return; }
        document.getElementById('omActualQty').value = aq;
    }
    if ((aq === '' || parseInt(aq) === 0) && !ts) { showAlert('请至少填写「实际订货数量」或选择「手动修改状态」'); return; }
    if (aq !== '') { var sqr = await callEdgeFunction('set_actual_order_qty', { product_code: currentEditProduct, actual_qty: parseInt(aq)||0, operator: op }); if (!sqr.success) { showAlert('设置订货数量失败'); return; } }
    if (ts) { var mr = await callEdgeFunction('manual_update_status', { product_code: currentEditProduct, target_status: ts, operator: op, remark: rk }); if (!mr.success) { showAlert('修改状态失败'); return; } }
    var msgs = []; if (aq !== '') msgs.push('订货数量已更新'); if (ts) msgs.push('状态改为「' + ts + '」');
    showAlert(msgs.join('\n') || '操作完成');
    document.getElementById('orderModal').classList.remove('show'); loadSummary(true);
}

// ========== 缺货汇总 ==========
async function loadSummary(keepFilters) {
    if (isLoadingSummary) return;
    // 保存当前筛选状态
    var savedFilter = currentFilterStatus;
    var savedCode = (document.getElementById('productCodeSearch') || {}).value || '';
    var savedSuppliers = selectedSuppliers.slice();
    var savedPage = currentPage;
    var savedScroll = window.scrollY;
    isLoadingSummary = true;
    // 只有非 keepFilters 才弹全屏遮罩
    var _ov = document.getElementById('refreshOverlay');
    var _ovTitle = document.getElementById('refreshOverlayTitle');
    var _ovSub = document.getElementById('refreshOverlaySub');
    var _ovShowed = false;
    if (_ov && !keepFilters) {
        _ov.style.opacity = '0';
        _ov.style.display = 'flex';
        _ovShowed = true;
        setTimeout(function() { _ov.style.opacity = '1'; }, 50);
    }
    function _ovUpdate(title, sub) { if (_ovTitle && title) _ovTitle.textContent = title; if (_ovSub && sub !== undefined) _ovSub.textContent = sub; }
    function _ovHide() { if (_ov && _ovShowed) { _ov.style.opacity = '0'; setTimeout(function() { _ov.style.display = 'none'; }, 300); } }
    try {
        _ovUpdate('正在从 ERP 拉取缺货汇总...', '首次加载可能需要 30-60 秒，请勿关闭页面');
        // 【v26】用 get_realtime_transit（已验证可用）循环查所有商品的实时配送
        // get_realtime_stock Edge Function 401 有问题，用 transit 替代（库存用 SQL 快照即可）
        // ★ 2026-11-10 回退 v3.21 active_only（后端已验证全量稳定 927 WH / 152 PR）
        // activeOnly 虽然省体但 SQL 并行化仍偶发 bug，先全量稳定
        console.log('[loadSummary] ▶ 开始 get_summary（全量，timeout=120s）');
        var getSummaryPromise = callEdgeFunction('get_summary', {});
        var resp = await getSummaryPromise;
        console.log('[loadSummary] ◀ get_summary 返回: success=' + resp.success + ' keys=' + (resp.data ? Object.keys(resp.data).join(',') : 'null'));
        if (!resp.success) throw new Error(resp.error || '获取汇总失败');
        var reports = resp.data.reports || [], planRows = [], supplierLookup = resp.data.supplierLookup || {};
        // v3.21: completed_summary 合并逻辑保留但不传 active_only 时后端不会返回，走不到
        if (resp.data.completed_summary && resp.data.completed_summary.length) {
            var _termEnhanced = resp.data.completed_summary.map(function(r) {
                return Object.assign({}, r, {
                    product_name: r.product_name || '',
                    specification: r.specification || '',
                    manufacturer: r.manufacturer || '',
                    reporter_name: r.reporter_name || '',
                    reporter_phone: r.reporter_phone || '',
                    current_stock: r.current_stock || 0,
                    in_transit: r.in_transit || 0,
                    urgency_level: r.urgency_level || '普通'
                });
            });
            var _beforeLen = reports.length;
            reports = reports.concat(_termEnhanced);
            console.log('[loadSummary] activeOnly merge: active=' + _beforeLen + ' + terminal=' + resp.data.completed_summary.length + ' = total=' + reports.length);
        } else {
            console.log('[loadSummary] reports 总数: ' + reports.length + '（无 completed_summary）');
        }
        if (resp.data.plan && resp.data.plan[0]) planRows = resp.data.plan[0];
        var planMap = {};
        if (planRows.length) planRows.forEach(function(p) { var nc = (p.商品编码||'').replace(/^0+/, ''); if (nc) planMap[nc] = p; });

        // ====== v30 优化：吃 Edge Function 合并返回的数据，避免重复查询 ======
        var _hasMergedWH = false, _hasMergedApprovals = false, _hasMergedTodo = false;

        // 仓库实时库存（合并版：plan 里已有 dc_stock，但 warehouseStockMap 是 SQL 实时版）
        if (resp.data.warehouseStockMap) {
            console.log('[v30] 使用合并仓库库存（' + Object.keys(resp.data.warehouseStockMap).length + ' 个商品）');
            _hasMergedWH = true;
        }

        // 审批列表
        if (resp.data.approvals) {
            resp.data.approvals.forEach(function(a) {
                if (a.product_code) newProductApprovals[a.product_code] = a;
            });
            console.log('[v30] 使用合并审批列表（' + resp.data.approvals.length + ' 条）');
            _hasMergedApprovals = true;
        }

        // 配送待办角标
        if (resp.data.deliveryTodoCount != null) {
            var _todoEl = document.getElementById('deliveryTodoBadge');
            if (_todoEl) {
                var cnt = resp.data.deliveryTodoCount;
                _todoEl.textContent = cnt > 0 ? cnt : '';
                _todoEl.style.display = cnt > 0 ? 'inline-block' : 'none';
            }
            _hasMergedTodo = true;
            console.log('[v30] 使用合并配送待办计数：' + resp.data.deliveryTodoCount);
        }

        var storeNames = {}; STORE_CONFIG.forEach(function(s) { storeNames[s.id] = s.name; });

        summaryData = { overview: { reports_count: reports.length, stores: storeNames }, shortage_by_product: [], completed_by_product: [], new_products: [], new_products_grouped: [], all_reports: reports };
        var sbp = {}, cbp = {}, np = [], npg = {};

        // 交叉补全：从 reports 中的有效 product_name 建立映射，补全缺名的记录
        var reportNameMap = {};
        reports.forEach(function(r) { if (r.product_code && r.product_name) { reportNameMap[r.product_code] = r.product_name; reportNameMap[r.product_code.replace(/^0+/, '')] = r.product_name; } });

        reports.forEach(function(r) {
            // 需求为 0 或负数的记录直接跳过（后端已拦截新增，这里兜底过滤历史脏数据）
            if ((r.demand_quantity || 0) <= 0) return;
            var ri = r.reporter_name || '';
            if (r.order_type === '缺货订购') {
                var key = r.product_code, nk = key.replace(/^0+/, ''), pi = planMap[nk] || planMap[key];
                var sup = (pi && pi.供货商) || supplierLookup[nk] || supplierLookup[key] || '';
                var rs = r.replenish_status || '待处理';
                // 已关闭(90天超时) 和 厂家断货 是终态但不是"完成"，不进 sbp 也不进 cbp
                if (rs !== '已关闭' && rs !== '厂家断货') {
                var completed = isCompletedStatus(rs);
                var pname = (pi&&pi.商品名称) || r.product_name || reportNameMap[key] || reportNameMap[nk] || '';
                var dt = new Date(r.created_at || '');
                var sinceDate = dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
                if (completed) {
                    // ★ 已入库列表：每条 report 独立一行，不再按 (商品+门店) 合并
                    // 这样每行都有自己的 demand_quantity / replenish_status / since 起点
                    cbp['_r'+r.id] = {
                        _report_id: r.id,
                        _since: sinceDate,
                        _store_key: r.store_id || r.store_name || '',
                        product_code: r.product_code,
                        store_id: r.store_id,
                        store_name: r.store_name || '',
                        product_name: pname,
                        specification: (pi&&pi.规格)||r.specification,
                        manufacturer: (pi&&pi.生产企业)||r.manufacturer,
                        supplier: sup,
                        total_demand: r.demand_quantity,
                        demand_quantity: r.demand_quantity,
                        replenish_status: rs,
                        replenish_manual: (pi&&pi.实际订货数量)||0,
                        dc_stock: (pi&&pi.仓库库存)||0,
                        stores: (function() {
                            var o = {};
                            o[r.store_id] = {
                                stock: r.current_stock || 0, transit: r.in_transit || 0,
                                demand: r.demand_quantity || 0,
                                urgency_level: r.urgency_level||'普通',
                                replenish_status: rs, reporter: ri,
                                report_time: r.created_at
                            };
                            return o;
                        })(),
                        latest_report_time: r.created_at || '',
                        status_changed_at: r.status_changed_at || '',
                        status_remark: r.status_remark || '',
                        status_changed_by: r.status_changed_by || ''
                    };
                } else {
                    // 缺货汇总主表：仍按商品编码合并（跨门店累加需求）
                    target = sbp;
                    var mapKey = key;
                    if (!target[mapKey]) {
                        target[mapKey] = { product_code:r.product_code, store_id:r.store_id, product_name:pname, specification:(pi&&pi.规格)||r.specification, manufacturer:(pi&&pi.生产企业)||r.manufacturer, supplier:sup, total_demand:0, replenish_status:rs, replenish_manual:(pi&&pi.实际订货数量)||0, dc_stock:(pi&&pi.仓库库存)||0, stores:{}, latest_report_time:'', status_changed_at:r.status_changed_at || '', status_remark:r.status_remark || '', status_changed_by:r.status_changed_by || '' };
                    }
                    var rt = r.created_at || '';
                    if (rt > (target[mapKey].latest_report_time||'')) target[mapKey].latest_report_time = rt;
                    var sa = r.status_changed_at || '';
                    if (sa && sa >= (target[mapKey].status_changed_at || '')) {
                        target[mapKey].status_changed_at = sa;
                        target[mapKey].replenish_status = rs;
                    }
                    if (sa) { if (!target[mapKey].status_changed_by) target[mapKey].status_changed_by = r.status_changed_by || ''; }
                    if (!target[mapKey].status_remark && r.status_remark) target[mapKey].status_remark = r.status_remark;
                    target[mapKey].total_demand += r.demand_quantity;
                    if (!target[mapKey].stores[r.store_id]) {
                        target[mapKey].stores[r.store_id] = { stock:0, transit:0, demand:0, urgency_level:r.urgency_level||'普通', replenish_status:r.replenish_status||'待处理', reporter:ri, report_time:r.created_at, _report_count:0 };
                    }
                    var ss = target[mapKey].stores[r.store_id];
                    ss.demand += r.demand_quantity;
                    ss._report_count += 1;
                    if ((r.created_at||'') >= (ss.report_time||'')) {
                        ss.stock = r.current_stock;
                    ss.transit = r.in_transit;
                    ss.report_time = r.created_at;
                    ss.reporter = ri;
                }
            } // FIXED: close if rs !== 已关闭
                } // close: 已关闭/厂家断货 过滤
            } else {
                np.push({ store_id:r.store_id, store_name:storeNames[r.store_id]||r.store_id, product_name:r.new_product_name, specification:r.new_specification, manufacturer:r.new_manufacturer, price_min:r.price_min, price_max:r.price_max, demand_quantity:r.demand_quantity, remark:r.remark, reporter:ri });
                var gk = r.new_product_name+'|'+r.new_specification;
                var sn = storeNames[r.store_id] || r.store_id;
                if (!npg[gk]) npg[gk] = { product_code: gk, product_name:r.new_product_name, specification:r.new_specification, manufacturer:r.new_manufacturer, total_demand:0, stores:[], latest_report_time:'', store_names:{}, reporter_names:{} };
                npg[gk].total_demand += r.demand_quantity; npg[gk].stores.push({ store_id:r.store_id, demand:r.demand_quantity });
                if ((r.created_at||'') > (npg[gk].latest_report_time||'')) npg[gk].latest_report_time = r.created_at||'';
                if (sn) npg[gk].store_names[sn] = true;
                if (ri) npg[gk].reporter_names[ri] = true;
            }
        });

        summaryData.shortage_by_product = Object.values(sbp).sort(function(a,b) { return (b.latest_report_time||'').localeCompare(a.latest_report_time||''); });
        // ★ cbp 双保险过滤：即使循环里有完成态误判，这里也踢掉 isCompletedStatus=false 的条目
        summaryData.completed_by_product = Object.values(cbp)
            .filter(function(item) { return isCompletedStatus(item.replenish_status); })
            .sort(function(a,b) {
                var ta = a.status_changed_at || '0000';
                var tb = b.status_changed_at || '0000';
                return tb.localeCompare(ta); // 按完成时间降序
            });
        summaryData.new_products = np; summaryData.new_products_grouped = Object.values(npg);

        // v30: 用合并的 warehouseStockMap 赋值到 shortage/completed 数组（等价于 refreshWarehouseStock 做的事）
        if (_hasMergedWH && resp.data.warehouseStockMap) {
            var whMap = resp.data.warehouseStockMap;
            var allProds = summaryData.shortage_by_product.concat(summaryData.completed_by_product);
            allProds.forEach(function(p) {
                if (whMap[p.product_code] !== undefined) p.warehouse_stock = whMap[p.product_code];
            });
        }

        // v31: FIFO 剩余采购池（扣减后）→ 注意这是"剩余量"不是"可抵扣量"！
        if (resp.data.poolRemainingMap) {
            var prMap = resp.data.poolRemainingMap;
            summaryData.shortage_by_product.forEach(function(p) {
                p.pool_remaining = prMap[p.product_code] !== undefined ? prMap[p.product_code] : 0;
            });
        }

        // v5.15.9 ★ 有效采购入库总量（未扣减）→ 真正的可抵扣量
        //   effectivePurchaseMap = 满足 anchor 规则（入库日期>=最早待处理report日期）的采购入库合计
        //   gap = max(0, totalDemand - max(effectivePurchase, warehouse_stock))
        if (resp.data.effectivePurchaseMap) {
            var epMap = resp.data.effectivePurchaseMap;
            summaryData.shortage_by_product.forEach(function(p) {
                p.effective_purchase = epMap[p.product_code] !== undefined ? epMap[p.product_code] : 0;
            });
        }

        var storeSet = {}; summaryData.shortage_by_product.forEach(function(p) { for (var sid in p.stores) storeSet[sid] = true; });
        var allForStats = summaryData.shortage_by_product;
        var completedForStats = (summaryData && summaryData.completed_by_product) || [];
        // 卡片统计
        var ordered = allForStats.filter(function(p) { return p.replenish_status === '已订购'; }).length;
        var payment = allForStats.filter(function(p) { return p.replenish_status === '待付款'; }).length;
        var completedTotal = completedForStats.filter(function(p) { return p.replenish_status === '已完成'; }).length;
        var delivered = completedForStats.filter(function(p) { return p.replenish_status === '已配送'; }).length;
        var pending = allForStats.filter(function(p) { return p.replenish_status === '待处理'; }).length;
        var today = bjToday();
        var todayReports = reports.filter(function(r) { return toBjDate(r.created_at) === today; }).length;
        document.getElementById('orderedCount').textContent = ordered;
        document.getElementById('paymentCount').textContent = payment;
        document.getElementById('completedTotalCount').textContent = completedTotal;
        document.getElementById('pendingCount').textContent = pending;
        document.getElementById('deliveredCount').textContent = delivered;
        document.getElementById('todayCount').textContent = todayReports;
        document.getElementById('newTotalCount').textContent = summaryData.new_products.reduce(function(s,n) { return s+n.demand_quantity; }, 0);
        document.getElementById('newProductCount').textContent = summaryData.new_products_grouped.length;
        document.getElementById('newTodayCount').textContent = reports.filter(function(r) { return r.order_type === '新品订购' && toBjDate(r.created_at) === today; }).length;

        var allItems = summaryData.shortage_by_product;
        completedData = summaryData.completed_by_product;
        var activeData = allItems;

        // v5.15.5 ★ 修复：loadSummary 完成后必须重新赋值 filteredData + 触发首次渲染
        // 之前只赋值了 completedData，filteredData 仍是 L21 初始化的 [] → renderSummaryPage 空表
        // 用当前筛选状态（currentFilterStatus）应用 applyStatusFilter
        try {
            // 恢复用户之前的筛选状态（如果有）
            var el = document.getElementById('statusFilter');
            if (el && currentFilterStatus) el.value = currentFilterStatus;
            applyStatusFilter();
        } catch(_) {
            // applyStatusFilter 可能依赖的 DOM 还没 ready，fallback 给全部
            filteredData = activeData.slice();
            completedData = summaryData.completed_by_product;
            try { renderSummaryPage(); } catch(_) {}
        }

        // v5.15.6 ★ 修复：新品汇总表 —— 卡片计数有了但表格从不渲染
        // renderNewProductsTable 之前只在 loadApprovals() 里调用（切 tab 才触发）
        try { renderNewProductsTable(); } catch(_) {}

        // v30 优化：setTimeout 里只跑合并版没覆盖到的
        // ★ 2026-11-10 修复：把 get_realtime_transit 也移到 setTimeout 里
        // 之前它在 try 块内 await + timeout=120s + maxRetries=1 → 最坏 4 分钟阻塞 finally → 遮罩永久不消失
        // 现在改成 fire-and-forget：遮罩先关（用户立刻能看到列表），后台慢慢查配送量
        setTimeout(function() {
            // v29 批量 get_realtime_transit（45s 超时，1次重试，最坏 90s，且已不在遮罩阻塞）
            var REQ_TIMEOUT = 45000;
            var transitTasks = summaryData.shortage_by_product.map(function(p) {
                if (!p.product_code) return null;
                var storesList = [];
                for (var sid in p.stores) {
                    var s = p.stores[sid];
                    var sname = (STORE_CONFIG.find(function(c) { return c.id === sid; }) || {}).name || sid;
                    var since = '2026-01-01';
                    if (s && s.report_time) {
                        var d = new Date(s.report_time);
                        since = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
                    }
                    storesList.push({ store_name: sname, since: since, sid: sid });
                }
                if (storesList.length === 0) return null;
                return { p: p, storesList: storesList, product_code: p.product_code };
            }).filter(Boolean);
            if (transitTasks.length > 0) {
                var batchPayload = {
                    product_codes: transitTasks.map(function(t) { return t.product_code; }),
                    all_items: transitTasks.flatMap(function(t) {
                        return t.storesList.map(function(s) {
                            return { product_code: t.product_code, store_name: s.store_name, since: s.since, _sid: s.sid };
                        });
                    })
                };
                console.log('[v3.21] 后台批量查询 get_realtime_transit，' + transitTasks.length + ' 个商品');
                callEdgeFunction('get_realtime_transit', batchPayload, { timeout: REQ_TIMEOUT, maxRetries: 1 }).then(function(_batchResp) {
                    if (_batchResp && _batchResp.success && _batchResp.data && _batchResp.data.batchResult) {
                        var br = _batchResp.data.batchResult;
                        var transitResultMap = {};
                        transitTasks.forEach(function(task) {
                            var code = task.product_code;
                            var stores = {};
                            for (var i = 0; i < task.storesList.length; i++) {
                                var s = task.storesList[i];
                                var v = br[code] && br[code][s.store_name];
                                if (v !== undefined && v !== null) stores[s.sid] = Number(v);
                            }
                            transitResultMap[code] = stores;
                        });
                        if (Object.keys(transitResultMap).length > 0) {
                            summaryData.shortage_by_product.forEach(function(p) {
                                var tr = transitResultMap[p.product_code];
                                if (tr) { for (var sid in tr) { if (p.stores[sid]) p.stores[sid].transit = tr[sid]; } }
                            });
                            // v5.15.9 ★ B3 修复：批量查询后自动 mark_store_completed
                            //   五重保护：只升不降 / 查询成功兜底 / 失败不阻塞 / 防重复写 / 性能日志
                            var _markStart = Date.now();
                            var _markSessionSet = window._autoCompletedSessionSet || (window._autoCompletedSessionSet = new Set());
                            var autoCompleteItems = [];
                            var SKIP_STATUSES = ['已完成', '已配送', '厂家断货', '已关闭'];
                            summaryData.shortage_by_product.forEach(function(p) {
                                var tr = transitResultMap[p.product_code];
                                if (!tr) return;
                                for (var sid in p.stores) {
                                    var s = p.stores[sid];
                                    // ① 只升不降：已经是终态的绝不碰
                                    if (SKIP_STATUSES.indexOf(s.replenish_status) !== -1) continue;
                                    // ② 查询成功兜底：transit 必须是有效数字且 > 0，且必须 >= demand
                                    var transit = tr[sid] !== undefined ? Number(tr[sid]) : (s.transit !== undefined ? Number(s.transit) : 0);
                                    if (isNaN(transit) || transit <= 0) continue;
                                    if (transit < Number(s.demand || 0)) continue;
                                    // ④ 防重复写：会话内同一 (code, sid) 已经写过就不再写
                                    var _key = p.product_code + '||' + sid;
                                    if (_markSessionSet.has(_key)) continue;
                                    _markSessionSet.add(_key);
                                    autoCompleteItems.push({ product_code: p.product_code, store_id: sid, transit: transit, demand: Number(s.demand || 0) });
                                }
                            });
                            var _markCollectMs = Date.now() - _markStart;
                            if (autoCompleteItems.length > 0) {
                                console.log('[v5.15.9] mark_collect耗时=' + _markCollectMs + 'ms, 判定' + autoCompleteItems.length + '条 → 准备写 DB');
                                callEdgeFunction('mark_store_completed', {
                                    items: autoCompleteItems,
                                    operator: (user && (user.username || user.name)) || '管理员'
                                }).then(function(markResp) {
                                    var _writeMs = Date.now() - _markStart - _markCollectMs;
                                    var _ok = markResp?.data?.updated?.length || 0;
                                    var _fail = markResp?.data?.failed?.length || 0;
                                    // ③ 失败只记日志，不阻塞渲染
                                    if (!markResp || !markResp.success) {
                                        console.warn('[v5.15.9] mark_store_completed 失败:', markResp?.error || '未知错误 (耗时=' + _writeMs + 'ms)');
                                    } else {
                                        console.log('[v5.15.9] mark_store_completed 写成功=' + _ok + ' 失败=' + _fail + ' (写入耗时=' + _writeMs + 'ms, 总耗时=' + (_markCollectMs + _writeMs) + 'ms)');
                                    }
                                    if (_ok > 0) {
                                        autoCompleteItems.forEach(function(t) {
                                            var p = summaryData.shortage_by_product.find(function(x) { return x.product_code === t.product_code; });
                                            if (p && p.stores[t.store_id]) {
                                                delete p.stores[t.store_id];
                                                p.total_demand = Math.max(0, (p.total_demand || 0) - t.demand);
                                            }
                                        });
                                        summaryData.shortage_by_product = summaryData.shortage_by_product.filter(function(p) { return Object.keys(p.stores || {}).length > 0; });
                                        renderSummaryPage();
                                    }
                                }).catch(function(e) {
                                    // ③ catch 也只记日志，不阻塞
                                    console.warn('[v5.15.9] mark_store_completed 异常:', e?.message || e, '(耗时=' + (Date.now() - _markStart) + 'ms)');
                                });
                            } else {
                                console.log('[v5.15.9] mark_collect耗时=' + _markCollectMs + 'ms, 判定0条（无可升级）');
                            }
                            renderSummaryPage();
                            console.log('[v3.21] 后台合并配送量成功 ' + Object.keys(transitResultMap).length + '/' + transitTasks.length);
                        }
                    }
                }).catch(function(e) { console.warn('[v3.21] 后台批量配送查询超时/异常:', e?.message); });
            }
            if (!_hasMergedWH) { console.log('[v30] 独立调用 refreshWarehouseStock'); refreshWarehouseStock(); }
            if (!_hasMergedApprovals) { console.log('[v30] 独立调用 loadApprovals'); loadApprovals(); }
            refreshSuppliers();
        }, 300); // 300ms 让遮罩先淡出

        // 更新角标
        var ps = allItems.filter(function(p) { return p.replenish_status === '待处理'; }).length;
        var sb = document.getElementById('shortageBadge'); if (sb) { sb.textContent = ps > 0 ? ps : ''; sb.style.display = ps > 0 ? 'inline-block' : 'none'; }
        var nb = document.getElementById('newBadge'); if (nb) { var nc = summaryData.new_products_grouped.length; nb.textContent = nc > 0 ? nc : ''; nb.style.display = nc > 0 ? 'inline-block' : 'none'; }
    } catch(err) {
        logError('加载汇总数据失败', err);
        var _errMsg = friendlyErrorClient(err.message || err);
        console.error('[loadSummary ❌]', _errMsg, err);
        showAlert('加载失败：' + _errMsg);
        if (typeof window.__showErr === 'function') window.__showErr('数据加载失败: ' + _errMsg);
    }
    finally { isLoadingSummary = false; try { _ovHide(); } catch(_) {} }
}

var newProductApprovals = {}; // { product_code: { status, reason } }
function renderNewProductsTable() {
    var tbody = document.getElementById('newGroupTbody'); if (!tbody) return; tbody.innerHTML = '';
    if (!summaryData) return;
    summaryData.new_products_grouped.forEach(function(g, idx) {
        var approval = newProductApprovals[g.product_code] || {};
        var statusHtml = '';
        if (approval.status === '已审批') {
            statusHtml = '<span class="badge badge-approved" title="' + safeText(approval.reason || '') + '">已审批</span>';
        } else if (approval.status === '已驳回') {
            statusHtml = '<span class="badge badge-rejected" title="' + safeText(approval.reason || '') + '" style="cursor:pointer" onclick="showAlert(\'驳回原因：' + escapeHtml(approval.reason || '无') + '\')">已驳回</span>';
        } else {
            var canApprove = hasPermission('edit_status');
            statusHtml = canApprove
                ? '<button class="btn-sm btn-approve" onclick="approveNewProduct(\'' + escapeHtml(g.product_code) + '\')">审批</button><button class="btn-sm btn-reject" onclick="rejectNewProduct(\'' + escapeHtml(g.product_code) + '\')">驳回</button>'
                : '<span class="badge badge-pending">待处理</span>';
        }
        var delBtn = '<button class="btn-detail" style="color:#f44336;" onclick="deleteNewProduct(\'' + escapeHtml(g.product_code) + '\',\'' + escapeHtml(g.product_name || '') + '\')">删除</button>';
        var reportDate = (g.latest_report_time || '').slice(0, 10);
        var stores = Object.keys(g.store_names || {}).join('、');
        var reporters = Object.keys(g.reporter_names || {}).join('、');
        tbody.innerHTML += '<tr><td>'+safeText(g.product_name)+'</td><td>'+safeText(g.specification)+'</td><td>'+safeText(g.manufacturer)+'</td><td>'+getUrgencyBadge('普通')+'</td><td><span class="type-badge type-new">'+safeText(g.total_demand)+'</span></td><td>'+safeText(reportDate)+'</td><td title="'+escapeHtml(stores)+'">'+safeText(stores)+'</td><td>'+safeText(reporters)+'</td><td>'+statusHtml+'</td><td>'+delBtn+'</td></tr>';
    });
}

function renderSummaryPage() {
    var tbody = document.getElementById('summaryTbody'); tbody.innerHTML = '';
    var canEdit = hasPermission('edit_status'), allItems = summaryData.shortage_by_product;
    var totalPages = Math.ceil(filteredData.length / pageSize) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    var start = (currentPage - 1) * pageSize, pageItems = filteredData.slice(start, start + pageSize);

    // 恢复索引映射
    var idxMap = {};
    pageItems.forEach(function(p) {
        for (var j = 0; j < allItems.length; j++) { if (allItems[j].product_code === p.product_code) { idxMap[p.product_code] = j; break; } }
    });

    pageItems.forEach(function(p) {
        var tr = document.createElement('tr'), isSel = selectedProducts[p.product_code] ? 'checked' : '';
        var statusDisplay, statusOptions = '';
        ORDER_STATUSES.forEach(function(s) { statusOptions += '<option value="'+s+'"'+(p.replenish_status===s?' selected':'')+'>'+statusLabel(s)+'</option>'; });
        statusDisplay = canEdit ? '<select class="status-select" data-status="'+p.replenish_status+'" data-product-code="'+safeText(p.product_code)+'" onchange="updateReplenishStatus(this)" title="修改这一条的补货状态：改完立即保存；会把状态真的改掉，刷新页面依然生效；不会推送系统内通知；1 秒内保存">'+statusOptions+'</select>' : getReplenishBadge(p.replenish_status);
        var cbHtml = canEdit ? '<td><input type="checkbox" class="product-checkbox" data-product-code="'+safeText(p.product_code)+'" '+isSel+' onchange="toggleProductSelect(\''+escapeHtml(p.product_code)+'\')"></td>' : '<td></td>';
        var origIdx = idxMap[p.product_code] !== undefined ? idxMap[p.product_code] : 0;
        var ft = escapeHtml((p.product_code||'')+' '+(p.product_name||'')+' '+(p.specification||'')+' '+(p.manufacturer||''));
        var displayName = p.product_name || p.product_code || '';
        var nc = '<td title="'+escapeHtml(ft)+'"><span class="history-name">'+safeText(displayName)+'</span></td>';
        var codeTd = '<td title="'+escapeHtml(ft)+'" style="padding-left:0;padding-right:4px;">'+safeText(p.product_code)+'</td>';
        var specTd = '<td title="'+escapeHtml(ft)+'">'+safeText(p.specification||'')+'</td>';
        var sc = '<td style="white-space:nowrap;"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;max-width:55px;text-align:left;" title="'+escapeHtml(p.supplier||'')+'">'+safeText(p.supplier||'-')+'</span></td>';
        // 需求 = 各门店 max(0, demand - transit) 之和（与明细行"剩余需求"逻辑一致）
        // 这样无论 total_demand 累加是否正确，汇总行都能反映真实的"待配送"总量
        var totalDelivered = 0;
        var totalDemandRaw = 0;
        var displayDemand = 0;
        for (var sid2 in p.stores) {
            var s2 = p.stores[sid2];
            var d2 = Number(s2.demand) || 0;
            var t2 = Number(s2.transit) || 0;
            totalDemandRaw += d2;
            totalDelivered += t2;
            displayDemand += Math.max(0, d2 - t2);
        }
        var hasDelivered = totalDelivered > 0;
        // v5.15.9 ★★★ 修复二次扣减 bug
        //   根因：poolRemainingMap 是"有效入库 - FIFO已分配demand"（扣减后剩余），之前被当成"可抵扣量"又从需求里减了一遍
        //   正确公式：gap = max(0, totalDemand - max(effectivePurchase, warehouse_stock))
        //   effectivePurchase = 满足 anchor 规则（入库日期>=最早pending report）的有效入库总量（未扣减）
        var efPurchase = Number(p.effective_purchase) || 0;
        var poolRemain = Number(p.pool_remaining) || 0;     // 扣减后剩余（仅用于展示参考）
        var whOnly = Number(p.warehouse_stock) || 0;
        var effectiveAvailable = Math.max(efPurchase, whOnly);
        var realPurchaseNeed = Math.max(0, totalDemandRaw - effectiveAvailable);
        var hasDeductible = effectiveAvailable > 0;
        var deductSrc = effectiveAvailable === efPurchase && efPurchase > whOnly ? '有效入库('+efPurchase+')'
                       : effectiveAvailable === whOnly && whOnly > efPurchase ? '仓库库存('+whOnly+')'
                       : (effectiveAvailable === 0 ? '无' : '两者相等('+effectiveAvailable+')');
        var storeCount = 0; for (var _sc in p.stores) { if (p.stores[_sc].demand) storeCount++; }
        var demandTooltip = '本商品共 ' + storeCount + ' 家门店上报\n' +
            '总需求：' + totalDemandRaw + '\n' +
            (hasDeductible
                ? '可抵扣：' + effectiveAvailable + '（取大值，来源：' + deductSrc + '）\n'
                : '可抵扣：0（仓库无货，采购入库无可配）\n') +
            '  有效入库总量：' + efPurchase + ' | FIFO剩余：' + poolRemain + ' | 仓库库存：' + whOnly + '\n' +
            '缺口：' + realPurchaseNeed;
        // v5.15.7 ★ 主显示：只显示缺口一个数字
        //   缺口>0 且有可抵扣 → 红色（说明本来可以顶掉一部分还是有缺）
        //   缺口>0 但无可抵扣 → 黑色（纯粹没货）
        //   缺口=0 → 灰色（已顶满）
        var demandColor = '';
        if (realPurchaseNeed > 0 && hasDeductible) {
            demandColor = 'color:#d32f2f;font-weight:700;';   // 红：有可抵扣但还缺
        } else if (realPurchaseNeed > 0) {
            demandColor = 'color:#333;font-weight:600;';     // 黑：无可抵扣直接缺
        } else {
            demandColor = 'color:#999;font-weight:500;';      // 灰：缺口为 0
        }
        var demandCell = '<td title="'+escapeHtml(demandTooltip)+'"><span class="type-badge type-shortage" style="' + demandColor + '">' + safeText(realPurchaseNeed) + '</span></td>';
        var mfgTd = '<td title="'+escapeHtml(ft)+'" style="max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+safeText(p.manufacturer||'')+'</td>';
        tr.innerHTML = cbHtml + sc + codeTd + nc + mfgTd + specTd + demandCell + '<td>'+statusDisplay+'</td><td><button class="btn-detail" onclick="showShortageDetail('+origIdx+')">明细</button></td>';
        tbody.appendChild(tr);
    });

    var pb = document.getElementById('paginationBar'), pi = document.getElementById('pageInfo');
    var prev = document.getElementById('prevPageBtn'), next = document.getElementById('nextPageBtn');
    if (filteredData.length > pageSize) {
        pb.style.display = 'flex'; pi.textContent = '第 '+currentPage+' / '+totalPages+' 页（共 '+filteredData.length+' 条）';
        prev.disabled = currentPage <= 1; next.disabled = currentPage >= totalPages;
        var ji = document.getElementById('pageJumpInput');
        if (ji) { ji.max = totalPages; ji.value = currentPage; }
        // 生成页码按钮
        var pn = document.getElementById('pageNumbers');
        if (pn) {
            var html = '';
            var range = 2; // 当前页左右各显示几个
            for (var i = 1; i <= totalPages; i++) {
                var show = i === 1 || i === totalPages || (i >= currentPage - range && i <= currentPage + range);
                if (!show) {
                    // 检查是否需要省略号
                    if (i === currentPage - range - 1 || i === currentPage + range + 1) {
                        html += '<span style="padding:0 4px;color:#999;">...</span>';
                    }
                    continue;
                }
                // 重新渲染前清理重复省略号（把连续...合并）
                if (html.endsWith('<span style="padding:0 4px;color:#999;">...</span>') && i === currentPage - range) {
                    // 前一个已添加省略号，当前要显示的就直接追加，不重复加省略号
                }
                if (i === currentPage) {
                    html += '<button class="btn-pagenum active" onclick="goToPage(' + i + ')">' + i + '</button>';
                } else {
                    html += '<button class="btn-pagenum" onclick="goToPage(' + i + ')">' + i + '</button>';
                }
            }
            pn.innerHTML = html;
        }
    } else { pb.style.display = 'none'; }
}

window.changePage = function(delta) { currentPage += delta; renderSummaryPage(); };
window.goToPage = function(page) { currentPage = page; renderSummaryPage(); };
window.jumpToPage = function() {
    var inp = document.getElementById('pageJumpInput');
    var page = parseInt(inp.value);
    if (isNaN(page) || page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    currentPage = page;
    renderSummaryPage();
};

var completedPage = 1, completedPageSize = 20;
// ★ 已入库列表每行独立 report 的配送量缓存：key = "product_code||store_name||since"
var completedTransitMap = {};
// ★ 2026-11-10 优化：一次批量调用后端 get_realtime_transit batchMode
// 后端已有实现（query-shortage-data Line 7082-7133），传 { product_codes, all_items }
function loadCompletedTransitBatch(items) {
    if (!items || items.length === 0) return Promise.resolve({});
    var missing = items.filter(function(p) {
        var k = (p.product_code||'') + '||' + (p.store_name||p._store_key||'') + '||' + (p._since||'');
        return completedTransitMap[k] === undefined;
    });
    if (missing.length === 0) return Promise.resolve(completedTransitMap);
    // 去重收集所有 { product_code, store_name, since } 配对
    var seen = {};
    var all_items = [], product_codes = [];
    missing.forEach(function(p) {
        var pc = p.product_code || '';
        var sn = p.store_name || p._store_key || '';
        var since = p._since || '';
        var ak = pc + '||' + sn + '||' + since;
        if (!seen[ak]) {
            seen[ak] = true;
            all_items.push({ product_code: pc, store_name: sn, since: since });
            if (product_codes.indexOf(pc) === -1) product_codes.push(pc);
        }
    });
    if (product_codes.length === 0) return Promise.resolve(completedTransitMap);
    // 后端 SQL 有 WHERE vs.BillDate >= minSince，会把早于该 since 的配送过滤掉
    // 再在前端用每条自己的 since 精过滤（和后端逻辑一致）
    return callEdgeFunction('get_realtime_transit', {
        product_codes: product_codes,
        all_items: all_items
    }).then(function(resp) {
        var batchResult = resp && resp.success && resp.data && resp.data.batchResult ? resp.data.batchResult : {};
        all_items.forEach(function(it) {
            var k = it.product_code + '||' + it.store_name + '||' + it.since;
            var pm = batchResult[it.product_code] || {};
            // batchResult 里每个 store_name 对应的是从 minSince 起的总量
            // 但后端已按每条自己的 since 精过滤过（Line 7121-7126 里 new Date 比较）
            completedTransitMap[k] = pm[it.store_name] !== undefined ? pm[it.store_name] : 0;
        });
        return completedTransitMap;
    }).catch(function() { return completedTransitMap; });
}

function renderCompletedSection() {
    var cc = document.getElementById('completedCard'), ct = document.getElementById('completedTbody'), cn = document.getElementById('completedCount');
    var cp = document.getElementById('completedPagination');
    if (completedData.length === 0) { cc.style.display = 'none'; return; }
    cc.style.display = '';
    var totalPages = Math.ceil(completedData.length / completedPageSize) || 1;
    if (completedPage > totalPages) completedPage = totalPages;
    if (completedPage < 1) completedPage = 1;
    var start = (completedPage - 1) * completedPageSize, pageItems = completedData.slice(start, start + completedPageSize);
    cn.textContent = '（共 '+completedData.length+' 条，'+completedPage+'/'+totalPages+' 页）'; ct.innerHTML = '';
    pageItems.forEach(function(p) {
        // ★ 现在 cbp 每条都是独立 report，用 _report_id 定位
        var globalIdx = p._report_id !== undefined
            ? (summaryData.completed_by_product || []).findIndex(function(x) { return x._report_id === p._report_id; })
            : (summaryData.completed_by_product || []).indexOf(p);
        var tr = document.createElement('tr');
        tr.setAttribute('data-report-idx', globalIdx);
        var ft = escapeHtml((p.product_code||'')+' '+(p.product_name||'')+' '+(p.specification||'')+' '+(p.manufacturer||''));
        var so = ''; ORDER_STATUSES.forEach(function(s) { so += '<option value="'+s+'"'+(p.replenish_status===s?' selected':'')+'>'+statusLabel(s)+'</option>'; });
        // 完成时间 & 备注
        var changedAt = p.status_changed_at || '';
        var changedStr = '-';
        if (changedAt) {
            var dt = new Date(changedAt);
            var y = dt.getFullYear();
            var m = String(dt.getMonth() + 1).padStart(2, '0');
            var d = String(dt.getDate()).padStart(2, '0');
            var hh = String(dt.getHours()).padStart(2, '0');
            var mm = String(dt.getMinutes()).padStart(2, '0');
            changedStr = y + '/' + m + '/' + d + ' ' + hh + ':' + mm;
        }
        var remark = (p.status_remark && p.status_remark !== 'null' && p.status_remark !== 'undefined') ? p.status_remark : '-';
        // ★ 需求 = 这条 report 自己的 demand_quantity（不累加）
        var demandNum = p.demand_quantity !== undefined ? p.demand_quantity : (p.total_demand || 0);
        // ★ 已配送 = 按这条 report 的 _since 起点查（upgrade_to_delivered 同口径）
        var transKey = (p.product_code||'') + '||' + (p.store_name||p._store_key||'') + '||' + (p._since||'');
        var transNum = completedTransitMap[transKey];
        var transHtml;
        if (transNum === undefined) {
            // v5.15.9 B1 修复：不再显示"查询中..."占位，异步查询完自动刷新
            transHtml = '<td class="completed-transit" data-tkey="'+escapeHtml(transKey)+'" style="color:#bbb;text-align:center;font-weight:400;">-</td>';
        } else {
            var trColor = transNum >= demandNum ? '#2e7d32' : (transNum > 0 ? '#e65100' : '#999');
            transHtml = '<td class="completed-transit" data-tkey="'+escapeHtml(transKey)+'" style="color:'+trColor+';text-align:center;font-weight:600;">'+safeText(transNum)+'</td>';
        }
        var demandHtml = '<td title="需求 = 这条 report 自己的 demand_quantity（不累加）" style="text-align:center;font-weight:600;color:var(--primary);">'+safeText(demandNum)+'</td>';
        tr.innerHTML = '<td title="'+escapeHtml(p.supplier||'')+'" style="white-space:nowrap;text-align:left;"><span style="max-width:60px;overflow:hidden;text-overflow:ellipsis;display:block;">'+safeText(p.supplier||'-')+'</span></td><td title="'+escapeHtml(ft)+'" style="padding-left:0;padding-right:4px;text-align:center;">'+safeText(p.product_code)+'</td><td title="'+escapeHtml(ft)+'" style="white-space:nowrap;max-width:135px;overflow:hidden;text-overflow:ellipsis;text-align:left;">'+safeText(p.product_name)+'</td><td title="'+escapeHtml(ft)+'" style="padding-left:4px;max-width:82px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;">'+safeText(p.specification||'')+'</td>'+demandHtml+transHtml+'<td style="min-width:80px;text-align:center;"><select class="status-select" style="min-width:75px;" data-status="'+p.replenish_status+'" data-product-code="'+safeText(p.product_code)+'" data-report-id="'+(p._report_id||'')+'" onchange="updateReplenishStatus(this)" title="修改这一条的补货状态">'+so+'</select></td><td style="text-align:center;width:56px;"><button class="btn-detail" style="cursor:pointer;" onclick="showShortageDetail('+globalIdx+',true)">明细</button></td><td title="完成时间: '+escapeHtml(changedStr)+'" style="font-size:12px;white-space:nowrap;text-align:center;">'+safeText(changedStr)+'</td><td title="操作人: '+escapeHtml(p.status_changed_by||'-')+'" style="font-size:12px;white-space:nowrap;text-align:center;">'+safeText(p.status_changed_by||'-')+'</td><td title="备注: '+escapeHtml(remark)+'" style="font-size:12px;max-width:132px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;">'+safeText(remark)+'</td>';
        ct.appendChild(tr);
    });
    // ★ 异步批量查配送量，填入 transNum 为 undefined 的单元格
    var needQuery = pageItems.filter(function(p) {
        var k = (p.product_code||'') + '||' + (p.store_name||p._store_key||'') + '||' + (p._since||'');
        return completedTransitMap[k] === undefined;
    });
    if (needQuery.length > 0) {
        loadCompletedTransitBatch(needQuery).then(function() {
            pageItems.forEach(function(p) {
                var k = (p.product_code||'') + '||' + (p.store_name||p._store_key||'') + '||' + (p._since||'');
                var trVal = completedTransitMap[k];
                if (trVal !== undefined) {
                    var cell = ct.querySelector('.completed-transit[data-tkey="'+k.replace(/"/g,'\\"')+'"]');
                    if (cell) {
                        var dn = p.demand_quantity !== undefined ? p.demand_quantity : (p.total_demand || 0);
                        var c = trVal >= dn ? '#2e7d32' : (trVal > 0 ? '#e65100' : '#999');
                        cell.style.color = c;
                        cell.textContent = trVal;
                        cell.style.fontWeight = '600';
                    }
                }
            });
        });
    }
    // 翻页按钮（与缺货汇总一致）
    if (cp) {
        if (totalPages > 1) {
            cp.style.display = 'flex';
            var prevDisabled = completedPage <= 1 ? 'disabled' : '';
            var nextDisabled = completedPage >= totalPages ? 'disabled' : '';
            var html = '<span style="margin-right:12px;">第 '+completedPage+' / '+totalPages+' 页（共 '+completedData.length+' 条）</span>';
            html += '<button class="btn-pagenum" onclick="changeCompletedPage(-1)" '+prevDisabled+'>◀ 上一页</button>';
            // 快速页码（最多显示 5 个）
            var pageRange = 2;
            var startPage = Math.max(1, completedPage - pageRange);
            var endPage = Math.min(totalPages, completedPage + pageRange);
            if (startPage > 1) {
                html += '<button class="btn-pagenum" onclick="jumpToCompletedPage(1)">1</button>';
                if (startPage > 2) html += '<span style="padding:0 4px;">...</span>';
            }
            for (var i = startPage; i <= endPage; i++) {
                html += '<button class="btn-pagenum'+(i===completedPage?' active':'')+'" onclick="jumpToCompletedPage('+i+')">'+i+'</button>';
            }
            if (endPage < totalPages) {
                if (endPage < totalPages - 1) html += '<span style="padding:0 4px;">...</span>';
                html += '<button class="btn-pagenum" onclick="jumpToCompletedPage('+totalPages+')">'+totalPages+'</button>';
            }
            html += '<button class="btn-pagenum" onclick="changeCompletedPage(1)" '+nextDisabled+'>下一页 ▶</button>';
            html += '<span style="margin-left:16px;">跳至 <input id="completedPageJumpInput" type="number" min="1" max="'+totalPages+'" value="'+completedPage+'" style="width:50px;padding:2px 6px;font-size:12px;border-radius:4px;border:1px solid var(--input-border);"> 页 <button class="btn-pagenum" onclick="goToCompletedPage()">GO</button></span>';
            cp.innerHTML = html;
        } else {
            cp.style.display = 'none';
        }
    }
    document.getElementById('completedBody').style.display = 'block';
    document.getElementById('completedToggle').textContent = '▲ 收起';
}
window.changeCompletedPage = function(delta) { completedPage += delta; renderCompletedSection(); };
window.jumpToCompletedPage = function(p) { completedPage = p; renderCompletedSection(); };
window.goToCompletedPage = function() {
    var inp = document.getElementById('completedPageJumpInput');
    if (!inp) return;
    var p = parseInt(inp.value);
    if (isNaN(p) || p < 1) p = 1;
    if (p > Math.ceil(completedData.length / completedPageSize)) p = Math.ceil(completedData.length / completedPageSize);
    completedPage = p;
    renderCompletedSection();
};

async function backfillStatusTime() {
    var btn = document.getElementById('backfillTimeBtn');
    if (!btn) return;
    var restore = setBtnLoading(btn, '回填中...');
    try {
        var resp = await callEdgeFunction('backfill_status_time', { operator: (user && (user.username || user.name)) || '管理员' });
        if (resp.success) {
            showToast('已回填 ' + (resp.data?.backfilled || 0) + ' 条', 'success');
            loadSummary(true);
        } else {
            showAlert('回填失败：' + (resp.error || '未知'));
        }
    } catch(e) { showAlert('回填失败：' + e.message); }
    finally { restore(); }
}
window.backfillStatusTime = backfillStatusTime;

window.toggleCompletedSection = function() {
    var body = document.getElementById('completedBody'), toggle = document.getElementById('completedToggle');
    if (body.style.display === 'none') { body.style.display = ''; toggle.textContent = '▲ 收起'; }
    else { body.style.display = 'none'; toggle.textContent = '▼ 展开'; }
};

window.applyStatusFilter = function(keepPage) {
    if (!summaryData) return;  // 数据未加载完时直接返回，避免 null 引用
    var sv = document.getElementById('statusFilter').value;
    currentFilterStatus = sv;
    highlightQuickFilter(sv);
    var activeItems = summaryData.shortage_by_product || [];
    var completedItems = summaryData.completed_by_product || [];

    // 供货商筛选
    function filterBySupplier(list) {
        if (selectedSuppliers.length > 0) {
            return list.filter(function(p) { return selectedSuppliers.indexOf(p.supplier || '') >= 0; });
        }
        var kw = document.getElementById('supplierSearchInput').value.trim();
        if (kw) {
            return list.filter(function(p) { return p.supplier && p.supplier.toLowerCase().indexOf(kw.toLowerCase()) !== -1; });
        }
        return list;
    }
    // 商品编码筛选
    var codeKw = (document.getElementById('productCodeSearch') || {}).value || '';
    function filterByCode(list) {
        if (codeKw) {
            var k = codeKw.trim();
            if (!k) return list;
            return list.filter(function(p) { return (p.product_code || '').indexOf(k) >= 0; });
        }
        return list;
    }
    var filteredActive = filterByCode(filterBySupplier(activeItems));
    var filteredCompleted = filterByCode(filterBySupplier(completedItems));

    // sv = DB 状态值：已完成(显示为"已入库")、已配送(显示为"已完成") 在 completed_by_product 里
    //       待处理、已订购、待付款 在 shortage_by_product 里
    if (sv === '已完成' || sv === '已配送') {
        // 点已入库/已完成卡片：主表清空、已入库订单区块按 DB 状态筛
        filteredData = [];
        completedData = filteredCompleted.filter(function(p) { return p.replenish_status === sv; });
    } else if (!sv) {
        filteredData = filteredActive;
        completedData = filteredCompleted;
    } else {
        // 点待处理/已订购/待付款：主表按状态筛、已入库订单区块全部
        filteredData = filteredActive.filter(function(p) { return p.replenish_status === sv; });
        completedData = filteredCompleted;
    }
    if (!keepPage) currentPage = 1;
    renderSummaryPage(); renderCompletedSection();
};

// 商品编码输入触发
window.onProductCodeChange = function() { applyStatusFilter(); };
// 双重保险：用 addEventListener 绑定，避免 HTML attribute 失效
(function() {
    var pcs = document.getElementById('productCodeSearch');
    if (pcs && !pcs.__bound) {
        pcs.addEventListener('input', function() { try { applyStatusFilter(); } catch(e) { console.warn(e); } });
        pcs.__bound = true;
    }
})();

// 已完成列表商品编码筛选
window.onCompletedCodeChange = function() {
    var kw = (document.getElementById('completedCodeSearch') || {}).value || '';
    var list = summaryData.completed_by_product || [];
    if (kw) {
        var k = kw.trim();
        list = list.filter(function(p) { return (p.product_code || '').indexOf(k) >= 0; });
    }
    completedData = list;
    completedPage = 1;
    renderCompletedSection();
};

// 点击统计卡片 / 状态快速按钮触发筛选
window.filterByStat = function(sv) {
    // 今日上报：特殊处理（按日期筛选，不按状态）
    if (sv === '今日上报') {
        document.getElementById('statusFilter').value = '';
        currentFilterStatus = '__today__';
        highlightQuickFilter('__today__');
        var activeItems = (summaryData && summaryData.shortage_by_product) || [];
        var completedItems = (summaryData && summaryData.completed_by_product) || [];
        var today = new Date().toISOString().slice(0, 10);
        // 通过 latest_report_time 过滤
        function matchToday(p) {
            return (p.latest_report_time || '').slice(0, 10) === today;
        }
        filteredData = activeItems.filter(matchToday);
        completedData = completedItems.filter(matchToday);
        currentPage = 1; renderSummaryPage(); renderCompletedSection();
        return;
    }
    // 清除筛选
    if (!sv) {
        document.getElementById('statusFilter').value = '';
    } else {
        document.getElementById('statusFilter').value = sv;
    }
    // 点已完成/已配送时自动展开已入库订单区块（数据在那边）
    if (sv === '已完成' || sv === '已配送') {
        var _cc = document.getElementById('completedBody');
        var _ct = document.getElementById('completedToggle');
        if (_cc && _cc.style.display === 'none') { _cc.style.display = 'block'; if (_ct) _ct.textContent = '▲ 收起'; }
        var _sc = document.getElementById('summaryBody');
        if (_sc) _sc.style.display = 'none';  // 主表清空，隐藏主表区块更直观
    } else {
        var _sc2 = document.getElementById('summaryBody');
        if (_sc2) _sc2.style.display = 'block';
    }
    applyStatusFilter();
};

function highlightQuickFilter(sv) {
    // 高亮状态快速按钮
    document.querySelectorAll('.status-quick-btn').forEach(function(btn) {
        if (btn.getAttribute('data-status') === sv) btn.classList.add('active');
        else btn.classList.remove('active');
    });
    // 高亮统计卡片
    document.querySelectorAll('.stat-card-clickable').forEach(function(c) {
        if (c.getAttribute('onclick') && c.getAttribute('onclick').indexOf("'" + sv + "'") > 0) c.classList.add('active');
        else c.classList.remove('active');
    });
}

// ========== 高级多条件筛选 ==========
var advFilterConditions = []; // [{field, op, value}]

// 切换高级筛选折叠
window.toggleAdvSection = function() {
    var sec = document.getElementById('advSection');
    var icon = document.getElementById('advToggleIcon');
    var isOpen = sec.style.display !== 'none';
    sec.style.display = isOpen ? 'none' : 'block';
    if (icon) icon.textContent = isOpen ? '▼' : '▲';
    if (!isOpen) {
        if (advFilterConditions.length === 0) addAdvFilterRow();
        renderAdvFilterRows();
    }
};

// 更新条件计数显示
function updateAdvCount() {
    var el = document.getElementById('advCondCount');
    if (el) {
        var cnt = advFilterConditions.filter(function(c) { return c.value && c.value.trim(); }).length;
        el.textContent = cnt > 0 ? '（'+cnt+'条生效）' : '';
    }
}

window.addAdvFilterRow = function() {
    advFilterConditions.push({ field: 'supplier', op: 'contains', value: '' });
    renderAdvFilterRows();
};

window.removeAdvFilterRow = function(idx) {
    advFilterConditions.splice(idx, 1);
    renderAdvFilterRows();
};

function renderAdvFilterRows() {
    var container = document.getElementById('advFilterRows');
    if (!container) return;
    var fields = [
        { key: 'supplier', label: '供货商' },
        { key: 'product_name', label: '品名' },
        { key: 'product_code', label: '编码' },
        { key: 'specification', label: '规格' },
        { key: 'replenish_status', label: '状态' }
    ];
    var ops = [
        { key: 'contains', label: '包含' },
        { key: 'equals', label: '等于' },
        { key: 'not_equals', label: '不等于' },
        { key: 'starts_with', label: '开头是' }
    ];
    var html = '';
    advFilterConditions.forEach(function(cond, i) {
        var fo = fields.map(function(f) {
            return '<option value="'+f.key+'"'+(cond.field===f.key?' selected':'')+'>'+f.label+'</option>';
        }).join('');
        var oo = ops.map(function(o) {
            return '<option value="'+o.key+'"'+(cond.op===o.key?' selected':'')+'>'+o.label+'</option>';
        }).join('');
        html += '<div style="display:flex;align-items:center;gap:4px;margin-bottom:6px;">' +
            '<select onchange="advFilterConditions['+i+'].field=this.value" style="width:72px;height:28px;font-size:12px;border-radius:4px;">'+fo+'</select>' +
            '<select onchange="advFilterConditions['+i+'].op=this.value" style="width:68px;height:28px;font-size:12px;border-radius:4px;">'+oo+'</select>' +
            '<input value="'+escapeHtml(cond.value)+'" oninput="advFilterConditions['+i+'].value=this.value" placeholder="输入值..." style="flex:1;height:28px;font-size:12px;border-radius:4px;border:1px solid var(--input-border);padding:0 6px;">' +
            '<button onclick="removeAdvFilterRow('+i+')" style="width:26px;height:26px;font-size:14px;border:none;background:#e74c3c;color:#fff;border-radius:4px;cursor:pointer;">✕</button>' +
            '</div>';
    });
    // AND 标记
    if (advFilterConditions.length > 1) {
        for (var j = 1; j < advFilterConditions.length; j++) {
            var markerIdx = html.indexOf('<div style="display:flex', html.indexOf('<div style="display:flex', 0) + 100 * (j - 1) + 1);
            // Better to insert AND marker between rows
        }
        // Simpler: wrap each subsequent row with AND prefix
        var rows = html.split('</div>');
        html = '';
        advFilterConditions.forEach(function(cond, i) {
            if (i > 0) html += '<div style="text-align:center;font-size:11px;color:var(--accent);font-weight:600;padding:2px 0;">AND</div>';
            html += rows[i] + '</div>';
        });
    }
    container.innerHTML = html;
    updateAdvCount();
}

window.applyAdvFilter = function() {
    var active = (summaryData && summaryData.shortage_by_product) || [];
    var completed = (summaryData && summaryData.completed_by_product) || [];
    if (!active.length && !completed.length) { showAlert('请先加载数据'); return; }
    // 过滤出有效条件
    var valid = advFilterConditions.filter(function(c) { return c.value && c.value.trim(); });
    if (valid.length === 0) { showAlert('请输入至少一个筛选条件'); return; }
    function match(p) {
        return valid.every(function(c) {
            var fieldVal = (p[c.field] || '').toString().toLowerCase();
            var condVal = (c.value || '').toLowerCase();
            switch (c.op) {
                case 'contains': return fieldVal.indexOf(condVal) >= 0;
                case 'equals': return fieldVal === condVal;
                case 'not_equals': return fieldVal !== condVal;
                case 'starts_with': return fieldVal.indexOf(condVal) === 0;
                default: return true;
            }
        });
    }
    var sfActive = active.filter(match);
    var sfCompleted = completed.filter(match);
    var sv = document.getElementById('statusFilter').value;
    currentFilterStatus = sv;
    if (sv === '已完成') { filteredData = []; completedData = sfCompleted; }
    else if (!sv) { filteredData = sfActive; completedData = sfCompleted; }
    else { filteredData = sfActive.filter(function(p) { return p.replenish_status === sv; }); completedData = sfCompleted; }
    currentPage = 1; renderSummaryPage(); renderCompletedSection();
    updateAdvCount();
    showToast('高级筛选已应用（'+(sfActive.length+sfCompleted.length)+' 条）', 'success');
};

window.clearAdvFilter = function() {
    advFilterConditions = [];
    renderAdvFilterRows();
    updateAdvCount();
    selectedSuppliers = [];
    updateSupplierDisplay();
    document.getElementById('supplierSearchInput').value = '';
    applyStatusFilter();
    showToast('筛选已清除', 'success');
};

// ========== 单商品立即判定（行级按钮）==========
window.checkSingleNow = async function(productCode) {
    if (!productCode) return;
    if (!checkPermission('edit_status')) return;
    showToast('正在判定 ' + productCode + '...', 'info');
    try {
        var resp = await callEdgeFunction('check_single_product', {
            product_code: productCode,
            operator: user.username || user.name || '管理员'
        });
        if (resp && resp.success) {
            var msg = '✅ ' + resp.completed + '/' + resp.checked + ' 条已自动判定为已入库';
            showToast(msg, 'success');
            // 立即刷新列表（整页重载，简单可靠）
            loadSummary(true);
        } else {
            showToast('❌ 判定失败：' + (resp?.error || '未知错误'), 'error');
        }
    } catch (e) {
        console.error('[checkSingleNow] 异常:', e);
        showToast('❌ 判定异常：' + (e?.message || String(e)), 'error');
    }
};

window.updateReplenishStatus = async function(selectEl) {
    if (!checkPermission('edit_status', '您没有修改补货状态的权限')) return;
    var pc = selectEl.getAttribute('data-product-code'), ns = selectEl.value, os = selectEl.getAttribute('data-status')||'';
    if (!pc) return; selectEl.setAttribute('data-status', ns);
    // v5.8.1+ 标记"已订购"时弹出订购数量输入框
    var orderQty = 0;
    if (ns === '已订购') {
        // v5.8.2+ 改用自定义 showPrompt 弹框（避免浏览器/Electron 拦截原生 prompt）
        // 同步方式：把后续流程封装在回调里
        var proceedWithStatus = function(qty) {
            orderQty = qty;
            continueUpdateStatus();
        };
        showPrompt(
            '请输入订购数量',
            '请输入「' + pc + '」的实际订购数量（取消=不填数量，只改状态）：',
            '',
            function(v) { proceedWithStatus(parseInt(String(v).trim()) || 0); },
            function() { proceedWithStatus(0); }
        );
        return;  // 异步执行，实际逻辑在 proceedWithStatus 完成后调用 continueUpdateStatus
    }

    continueUpdateStatus();
    return;

    function continueUpdateStatus() {
        // 校验、确认、调用后端
        if (!confirm('确定将 "'+pc+'" 状态改为 "'+ns+'"' + (orderQty>0 ? '（订购'+orderQty+'盒）' : '') + '？')) {
            selectEl.value = os;
            selectEl.setAttribute('data-status', os);
            return;
        }
        if (orderQty > 0) {
            callEdgeFunction('set_actual_order_qty', { product_code: pc, actual_qty: orderQty, operator: (user && (user.username || user.name)) || '管理员' }).then(function(qtyResult) {
                if (qtyResult && !qtyResult.success) { showAlert('设置订购数量失败：'+(qtyResult.error||'未知')); selectEl.value = os; selectEl.setAttribute('data-status', os); return; }
                callManualUpdate();
            }).catch(function(err) { showAlert('设置订购数量异常：'+err); selectEl.value = os; selectEl.setAttribute('data-status', os); });
        } else {
            callManualUpdate();
        }

        function callManualUpdate() {
            callEdgeFunction('manual_update_status', { product_code: pc, target_status: ns, operator: (user && (user.username || user.name)) || '管理员' }).then(function(result) {
                if (!result || !result.success) {
                    showAlert('更新失败：'+((result && result.error) || '未知错误'));
                    selectEl.value = os;
                    selectEl.setAttribute('data-status', os);
                    return;
                }
                showToast('状态更新成功', 'success');
                try { selectEl.setAttribute('data-status', ns); } catch(e) {}
                // 更新内存数据
                if (summaryData) {
                    [summaryData.shortage_by_product, summaryData.completed_by_product].forEach(function(list) {
                        if (!list) return;
                        var item = list.find(function(p) { return p.product_code === pc; });
                        if (item) { item.replenish_status = ns; }
                    });
                }
                if (typeof isCompletedStatus === 'function' && (isCompletedStatus(ns) || isCompletedStatus(os))) {
                    // 跨完成边界需重新加载数据，保持筛选和页码
                    loadSummary(true);
                } else {
                    try { applyStatusFilter(true); } catch(e) {}
                }
            }).catch(function(err) {
                showAlert('更新异常：'+err);
                selectEl.value = os;
                selectEl.setAttribute('data-status', os);
            });
        }
    }
};

window.showShortageDetail = function(idx, fromCompleted) {
    if (!summaryData) return;
    var p = fromCompleted ? summaryData.completed_by_product[idx] : summaryData.shortage_by_product[idx];
    if (!p) return;
    var displayName = p.product_name || p.product_code || '';
    // 如果名称仍是编码，从 all_reports 中最后尝试补全
    if (displayName === p.product_code) {
        var ar = summaryData.all_reports || [];
        for (var i = 0; i < ar.length; i++) { if (ar[i].product_code === p.product_code && ar[i].product_name) { displayName = ar[i].product_name; break; } }
    }
    document.getElementById('detailTitle').textContent = '需求明细';
    var ih = '<span style="font-weight:600;color:#1565c0;">'+safeText(p.product_code)+'</span> <span style="font-weight:600;color:#1565c0;">'+safeText(displayName)+'</span>';
    var sm = []; if (p.specification) sm.push(safeText(p.specification)); if (p.manufacturer) sm.push(safeText(p.manufacturer));
    if (sm.length > 0) ih += ' <span style="font-size:11px;color:#666;">('+sm.join(' | ')+')</span>';
    document.getElementById('detailProductInfo').innerHTML = ih;
    var tbody = document.getElementById('detailTbody'); tbody.innerHTML = '';
    var sns = summaryData.overview.stores, phoneToStore = { '15305479520':'wszhyy02' };
    function gsn(rid) { var mi = phoneToStore[rid]||rid; return sns[mi]||rid; }
    var sa = []; for (var sid in p.stores) { var s = p.stores[sid]; sa.push({ sid:sid, name:gsn(sid), stock:s.stock, transit:s.transit, demand:s.demand, report_time:s.report_time||'', reporter:s.reporter||'' }); }
    sa.sort(function(a,b) { return (b.report_time||'').localeCompare(a.report_time||''); });
    // v5.15.6 ★ 同步渲染：弹窗打开时立刻写已知的 transit 数字，绝不显示"查询中..."
    // s.transit 来自 p.stores[sid].transit —— loadSummary 的 setTimeout 批量 get_realtime_transit 已经填过
    // 如果批量查询还没跑完，s.transit 是 undefined → 写 "-"，不要写"查询中..."
    var _emptyStores = []; // 哪些门店需要补查
    sa.forEach(function(s) {
        var _transitVal;
        if (s.transit !== undefined && s.transit !== null) {
            _transitVal = Number(s.transit);
        } else {
            _transitVal = null;
            _emptyStores.push(s.sid);
        }
        var _transitCell;
        if (_transitVal !== null) {
            var _tColor = _transitVal > 0 ? '#27ae60' : '#999';
            _transitCell = '<td class="real-transit" data-store="'+safeText(s.name)+'" data-transit="'+_transitVal+'" style="color:'+_tColor+';font-weight:600;">'+_transitVal+'</td>';
        } else {
            _transitCell = '<td class="real-transit" data-store="'+safeText(s.name)+'" data-transit="" style="color:#bbb;font-weight:400;">-</td>';
        }
        tbody.innerHTML += '<tr><td style="font-size:12px;color:#555;">'+safeText(s.report_time?new Date(s.report_time).toLocaleDateString('zh-CN'):'-')+'</td><td style="font-size:13px;">'+safeText(s.name)+'</td><td class="detail-stock" data-stock="'+safeText(s.stock)+'">'+safeText(s.stock)+'</td>'+_transitCell+'<td class="detail-status" style="text-align:center;font-size:11px;">-</td><td class="detail-demand" data-demand="'+safeText(s.demand)+'" style="font-weight:600;color:var(--primary);text-align:center;">'+safeText(s.demand)+'</td><td style="font-size:12px;color:var(--text-muted);">'+safeText(s.reporter||'-')+'</td></tr>';
    });
    // 立刻计算状态列（因为已有 transit 数据）
    updateDetailStatusCells();
    // 重置过滤复选框
    var cb = document.getElementById('detailHideCompleted'); if (cb) cb.checked = false;
    document.getElementById('detailModal').classList.add('show');
    // v5.15.6 ★ 条件刷新：缓存未命中的门店才补查；命中则完全跳过 refreshTransitData
    // 两个分支都要算 auto-transfer（已配送>=需求 → 自动转入已完成）
    function _doAutoTransfer(transitMap) {
        if (fromCompleted) return; // 已入库列表里的明细弹窗不触发
        var toComplete = [];
        sa.forEach(function(s) {
            if (!s.sid || !p.stores[s.sid]) return;
            var tr;
            if (transitMap) {
                // Edge Function 返回的实时值（补查路径）
                tr = Number(transitMap[s.name]);
            } else {
                // 全缓存命中路径：直接用 sa 里的 s.transit（已在渲染前读过）
                tr = Number(s.transit);
            }
            if (isNaN(tr) || tr <= 0) return;
            if (tr >= Number(s.demand)) {
                toComplete.push({ sid: s.sid, name: s.name, transit: tr, demand: Number(s.demand) });
            }
        });
        if (toComplete.length === 0) return;
        callEdgeFunction('mark_store_completed', {
            items: toComplete.map(function(t) { return { product_code: p.product_code, store_id: t.sid, transit: t.transit, demand: t.demand }; }),
            operator: (user && (user.username || user.name)) || '管理员'
        }).then(function(resp) {
            if (!resp || !resp.success) { console.warn('[mark_store_completed] 失败:', resp && resp.error); return; }
            // 1) 把 stores[sid] 从当前 p（sbp）里删掉，加到 cbp 里
            toComplete.forEach(function(t) {
                if (!p.stores[t.sid]) return;
                var storeData = p.stores[t.sid];
                delete p.stores[t.sid];
                // p.total_demand 减去已完成的 demand（同时也是 s.demand）
                if (p.total_demand) p.total_demand = Math.max(0, p.total_demand - t.demand);
                // 加到 completed_by_product
                if (summaryData && Array.isArray(summaryData.completed_by_product)) {
                    var mapKey = p.product_code + '||' + t.sid;
                    if (!summaryData.completed_by_product.find(function(x) {
                        return x.product_code === p.product_code && x.store_id === t.sid;
                    })) {
                        summaryData.completed_by_product.push({
                            product_code: p.product_code,
                            store_id: t.sid,
                            product_name: p.product_name,
                            specification: p.specification,
                            manufacturer: p.manufacturer,
                            supplier: p.supplier,
                            total_demand: t.demand,
                            replenish_status: '已完成',
                            stores: (function() { var o = {}; o[t.sid] = storeData; return o; })(),
                            status_changed_at: new Date().toISOString(),
                            status_changed_by: (user && (user.name || user.username)) || '管理员',
                            status_remark: '自动判定（已配送' + t.transit + '≥需求' + t.demand + '）'
                        });
                    }
                }
                // 2) 从明细 DOM 中移除该行
                var detailRow = document.querySelector('#detailTbody td[data-store-original="' + t.sid + '"]');
                if (detailRow) {
                    var trEl = detailRow.closest('tr');
                    if (trEl && trEl.parentNode) trEl.parentNode.removeChild(trEl);
                } else {
                    // 按门店名匹配（更稳）
                    var rows = document.querySelectorAll('#detailTbody tr');
                    for (var i = 0; i < rows.length; i++) {
                        var nameCell = rows[i].querySelector('td:nth-child(2)');
                        if (nameCell && nameCell.textContent.trim() === t.name) {
                            if (rows[i].parentNode) rows[i].parentNode.removeChild(rows[i]);
                            break;
                        }
                    }
                }
            });
            // 3) 重新渲染汇总 + 已完成列表
            try { renderSummaryPage(); renderCompletedSection(); } catch(e) {}
            // 4) 提示用户
            try { showToast('已自动转入已入库列表：' + toComplete.map(function(t) { return t.name; }).join('、'), 'success'); } catch(e) {}
            // 5) 更新内存中的 all_reports
            if (summaryData && Array.isArray(summaryData.all_reports)) {
                toComplete.forEach(function(t) {
                    summaryData.all_reports.forEach(function(r) {
                        if (r.product_code === p.product_code && r.store_id === t.sid && r.order_type === '缺货订购') {
                            r.replenish_status = '已完成';
                            r.status_remark = '自动判定（已配送' + t.transit + '≥需求' + t.demand + '）';
                            r.status_changed_at = new Date().toISOString();
                            r.status_changed_by = (user && (user.name || user.username)) || '管理员';
                        }
                    });
                });
            }
        }).catch(function(err) { console.warn('[mark_store_completed] 调用失败', err); });
    } // _doAutoTransfer 结束

    // v5.15.6: 两个分支 —— 缓存全命中 → 零网络请求；部分缺失 → 补查
    if (_emptyStores.length > 0) {
        console.log('[showShortageDetail] ' + _emptyStores.length + ' 家缓存未命中 → 补查 get_realtime_transit');
        refreshTransitData(p.product_code, sa).then(function(map) {
            _doAutoTransfer(map || null);
        });
    } else {
        console.log('[showShortageDetail] ✅ ' + sa.length + ' 家全缓存命中 → 零网络请求');
        _doAutoTransfer(null); // null 表示用 sa[i].transit 缓存值，不用 Edge Function
    }
};

// ========== 新品审批 ==========
// 管理员操作日志（静默，不阻塞主流程）
function logAdminAction(action, detail) {
    // 使用 callEdgeFunction 自动处理 token 续期，静默忽略错误
    callEdgeFunction('log_admin_action', { user: user.name || user.username, action: action, detail: detail }).catch(function() {});
}
async function loadApprovals() {
    try {
        var resp = await callEdgeFunction('get_approvals', {});
        if (resp.success && resp.data) {
            newProductApprovals = resp.data;
            renderNewProductsTable();
        }
    } catch(e) {}
}

window.approveNewProduct = async function(productCode) {
    if (!checkPermission('edit_status', '您没有审批权限')) return;
    var reason = prompt('审批通过？可输入备注（选填）：', '同意订购');
    if (reason === null) return;
    try {
        var resp = await callEdgeFunction('approve_report', { product_code: productCode, status: '已审批', reason: reason || '同意订购', operator: user.username || '管理员' });
        if (resp.success) { newProductApprovals[productCode] = { status: '已审批', reason: reason || '' }; renderNewProductsTable(); showToast('已审批！', 'success'); }
        else showAlert('审批失败：' + safeErrorMsg(resp.error));
    } catch(e) { showAlert('审批失败：' + safeErrorMsg(e)); }
};

window.rejectNewProduct = async function(productCode) {
    if (!checkPermission('edit_status', '您没有审批权限')) return;
    var reason = prompt('驳回原因（必填）：', '');
    if (!reason || !reason.trim()) { showAlert('驳回原因不能为空'); return; }
    try {
        var resp = await callEdgeFunction('approve_report', { product_code: productCode, status: '已驳回', reason: reason.trim(), operator: user.username || '管理员' });
        if (resp.success) { newProductApprovals[productCode] = { status: '已驳回', reason: reason.trim() }; renderNewProductsTable(); showToast('已驳回！', 'success'); }
        else showAlert('驳回失败：' + safeErrorMsg(resp.error));
    } catch(e) { showAlert('操作失败：' + safeErrorMsg(e)); }
};

// 安全提取错误信息，防止 [object Object]
function safeErrorMsg(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    return err.message || err.details || err.hint || String(err);
}

// ========== 删除新品订购汇总 ==========
window.deleteNewProduct = async function(productCode, productName) {
    if (!checkPermission('edit_status', '您没有删除权限')) return;
    var name = productName || productCode;
    if (!confirm('确定删除新品【' + name + '】的所有上报记录吗？\n\n此操作不可撤销！')) return;
    try {
        var resp = await callEdgeFunction('delete_new_product', { product_code: productCode, operator: user.username || user.name || '管理员' });
        if (resp.success) {
            showToast('已删除新品：' + name, 'success');
            loadSummary(true);
        } else {
            showAlert('删除失败：' + safeErrorMsg(resp.error));
        }
    } catch(e) { showAlert('删除异常：' + safeErrorMsg(e)); }
};

window.showNewDetail = function(idx) {
    if (!summaryData) return; var g = summaryData.new_products_grouped[idx]; if (!g) return;
    document.getElementById('detailTitle').textContent = safeText(g.product_name) + ' - 需求明细';
    var tbody = document.getElementById('detailTbody'); tbody.innerHTML = '';
    var sns = summaryData.overview.stores, pts = { '15305479520':'wszhyy02' };
    g.stores.forEach(function(s) { tbody.innerHTML += '<tr><td>'+safeText(sns[pts[s.store_id]||s.store_id]||s.store_id)+'</td><td>-</td><td>-</td><td>'+getUrgencyBadge('普通')+'</td><td>'+safeText(s.demand)+'</td><td>-</td><td>-</td></tr>'; });
    document.getElementById('detailModal').classList.add('show');
};

// ========== 员工管理 ==========
var storeOptions = STORE_CONFIG.map(function(s) { return { id: s.id, name: s.name }; });
document.getElementById('addEmployeeBtn').addEventListener('click', showAddEmployeeModal);
document.getElementById('refreshEmpBtn').addEventListener('click', loadEmployees);
document.getElementById('empCancelBtn').addEventListener('click', function() { document.getElementById('empModal').classList.remove('show'); });
document.getElementById('empSaveBtn').addEventListener('click', handleAddEmployee);

function showAddEmployeeModal() {
    var sel = document.getElementById('empStoreSelect'); sel.innerHTML = '<option value="">请选择门店</option>';
    storeOptions.forEach(function(s) { var o = document.createElement('option'); o.value = s.id; o.textContent = s.name; sel.appendChild(o); });
    document.getElementById('empPhoneInput').value = ''; document.getElementById('empNameInput').value = '';
    document.getElementById('empModal').classList.add('show');
}

async function handleAddEmployee() {
    if (!checkPermission('manage_employees', '您没有管理员工的权限')) return;
    var ph = document.getElementById('empPhoneInput').value.trim(), nm = document.getElementById('empNameInput').value.trim(), si = document.getElementById('empStoreSelect').value;
    if (!ph || ph.length !== 11) { showAlert('请输入正确的11位手机号'); return; }
    if (!si) { showAlert('请选择所属门店'); return; }
    var sn = storeOptions.find(function(s) { return s.id === si; }).name || si;
    var result = await callEdgeFunction('add_employee', { phone:ph, name:nm, store_id:si, store_name:sn, created_by:user.id, operator:(user&&(user.username||user.name))||'管理员' });
    if (result.success && result.data) { showToast('添加成功！' + ph + '可用手机号登录', 'success'); document.getElementById('empModal').classList.remove('show'); loadEmployees(); }
    else { showAlert('添加失败：' + (result.error || '未知错误')); }
}

async function loadEmployees() {
    try {
        var result = await callEdgeFunction('list_employees', {}), tbody = document.getElementById('employeeTbody'); tbody.innerHTML = '';
        if (!result.success || !result.data) { tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#999;">暂无员工数据</td></tr>'; return; }
        result.data.forEach(function(emp) {
            var bindings = emp.device_bindings || [];
            var ds = bindings.length > 0 ? '<span class="sync-success">已绑定('+bindings.length+'台)</span>' : '<span class="sync-fail">未绑定</span>';
            var sb = emp.is_active ? '<span class="replenish-badge replenish-ordered">正常</span>' : '<span class="replenish-badge replenish-text">停用</span>';
            var ts = emp.created_at ? new Date(emp.created_at).toLocaleString('zh-CN') : '-';
            var ah = '';
            if (emp.is_active) { ah += '<button class="btn-detail" onclick="toggleEmployee(\''+emp.id+'\', false)">停用</button> '; if (bindings.length > 0) ah += '<button class="btn-detail" style="color:red;" onclick="unbindDevice(\''+escapeHtml(bindings[0].device_id||'')+'\')">解绑</button>'; }
            else { ah = '<button class="btn-detail" onclick="toggleEmployee(\''+emp.id+'\', true)">启用</button>'; }
            tbody.innerHTML += '<tr><td>'+safeText(emp.phone)+'</td><td>'+safeText(emp.name||'-')+'</td><td>'+safeText(emp.store_name)+'</td><td>'+ds+'</td><td>'+sb+'</td><td style="font-size:12px;">'+safeText(ts)+'</td><td><button class="btn-primary" style="padding:4px 8px;font-size:12px;" onclick="showPasswordModal(\''+emp.id+'\',\''+escapeHtml(emp.phone)+'\')">修改密码</button></td><td>'+ah+'</td></tr>';
        });
    } catch(err) { logError('员工列表加载失败', err); }
}

window.toggleEmployee = async function(id, a) { if (!checkPermission('manage_employees')) return; if (!confirm(a?'确定启用？':'确定停用？停用后将无法登录')) return; await callEdgeFunction('toggle_employee', { id:id, is_active:a, operator:(user&&(user.username||user.name))||'管理员' }); loadEmployees(); };
window.unbindDevice = async function(did) { if (!checkPermission('manage_devices')) return; if (!confirm('确定解绑？')) return; try { var r = await callEdgeFunction('revoke_device', { device_id:did, target_type:'employee', target_id:'', operator:(user&&(user.username||user.name))||'管理员' }); if (r.success) { showToast('解绑成功', 'success'); loadEmployees(); } else { showAlert('解绑失败：'+(r.error||'未知错误')); } } catch(e) { showAlert('解绑异常：'+e.message); } };

// ========== 修改密码 ==========
var currentEditEmpId = '';
document.getElementById('pwdCancelBtn').addEventListener('click', function() { document.getElementById('passwordModal').classList.remove('show'); clearPasswordModal(); });
window.showPasswordModal = function(id, phone) { if (!checkPermission('manage_employees')) return; currentEditEmpId = id; document.getElementById('pwdEmpPhone').value = phone; document.getElementById('pwdNewPassword').value = ''; document.getElementById('pwdConfirmPassword').value = ''; document.getElementById('passwordModal').classList.add('show'); };
function clearPasswordModal() { currentEditEmpId = ''; document.getElementById('pwdEmpPhone').value = ''; document.getElementById('pwdNewPassword').value = ''; document.getElementById('pwdConfirmPassword').value = ''; }
document.getElementById('pwdSaveBtn').addEventListener('click', async function() {
    var np = document.getElementById('pwdNewPassword').value.trim(), cp = document.getElementById('pwdConfirmPassword').value.trim();
    if (!np) { showAlert('请输入新密码'); return; } if (np.length < 4) { showAlert('密码至少4位'); return; } if (np !== cp) { showAlert('两次密码不一致'); return; }
    if (!confirm('确定修改密码？')) return;
    try { var r = await callEdgeFunction('update_employee_password', { id:currentEditEmpId, new_password:np, operator:(user&&(user.username||user.name))||'管理员' }); if (r.success) { showToast('密码修改成功', 'success'); document.getElementById('passwordModal').classList.remove('show'); clearPasswordModal(); } else showAlert('修改失败：'+(r.error||'未知')); } catch(e) { showAlert('修改失败：'+e.message); }
});

// ========== 设备授权管理 ==========
document.getElementById('refreshDeviceBtn').addEventListener('click', loadPendingDevices);

async function loadPendingDevices() {
    try { var result = await callEdgeFunction('get_pending_devices', {}), tbody = document.getElementById('deviceTbody'); tbody.innerHTML = ''; if (!result.success) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;">暂无待授权设备</td></tr>'; return; } var devices = result.data.store_devices || []; if (devices.length === 0) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;">暂无待授权设备</td></tr>'; return; } var SND = {}; STORE_CONFIG.forEach(function(s) { SND[s.id] = s.name; }); SND['15305479520'] = '02第二药店'; devices.forEach(function(dev) { var dn = SND[dev.username] || dev.username, ch = ''; if (dev.conflict) { var bn = SND[dev.conflict.bound_to] || dev.conflict.bound_to; ch = ' <span style="color:#e74c3c;font-size:11px;">⚠ 被「'+safeText(bn)+'」绑定，授权后自动解除</span>'; } var ts = dev.last_login_at ? new Date(dev.last_login_at).toLocaleString('zh-CN') : '-'; tbody.innerHTML += '<tr><td>门店账号</td><td>'+safeText(dn)+'</td><td style="font-size:11px;word-break:break-all;">'+safeText(dev.device_id)+'</td><td>'+safeText(ts)+'</td><td><span class="replenish-badge replenish-text">待授权</span>'+ch+'</td><td><button class="btn-primary" onclick="authorizeDevice(\''+escapeHtml(dev.device_id)+'\',\'store\',\''+escapeHtml(dev.username)+'\',true)">授权</button> <button class="btn-detail" style="color:red;" onclick="authorizeDevice(\''+escapeHtml(dev.device_id)+'\',\'store\',\''+escapeHtml(dev.username)+'\',false)">拒绝</button></td></tr>'; }); } catch(err) { document.getElementById('deviceTbody').innerHTML = '<tr><td colspan="6" style="text-align:center;color:red;">加载失败</td></tr>'; } }

window.authorizeDevice = async function(did, tt, ti, auth) { if (!checkPermission('manage_devices')) return; if (!confirm(auth?'确定授权？授权后可正常登录':'确定拒绝？拒绝后需重新申请')) return; try { var r = await callEdgeFunction('authorize_device', { device_id:did, target_type:tt, target_id:ti, authorize:auth, operator:(user&&(user.username||user.name))||'管理员' }); if (r.success) { showToast(auth?'授权成功':'已拒绝', 'success'); loadPendingDevices(); loadAuthorizedDevices(); } else { showAlert('操作失败：'+(r.error||'未知错误')); } } catch(e) { showAlert('操作异常：'+e.message); } };

window.batchAuthorizeAll = async function() {
    if (!checkPermission('manage_devices')) return;
    try {
        var r = await callEdgeFunction('get_pending_devices', {}); if (!r.success || !r.data) { showAlert('获取列表失败'); return; }
        var devs = r.data.store_devices || []; if (devs.length === 0) { showAlert('没有待授权设备'); return; }
        if (!confirm('确定一键授权全部 '+devs.length+' 个设备？')) return;
        var dl = devs.map(function(d) { return { device_id:d.device_id, target_id:d.username, target_type:'store' }; });
        var br = await callEdgeFunction('batch_authorize', { device_list:dl, authorize:true, operator:(user&&(user.username||user.name))||'管理员' });
        if (br.success) { showToast('批量授权完成！成功 '+br.data.success_count+' 个'+(br.data.fail_count>0?'，失败 '+br.data.fail_count+' 个':''), 'success'); loadPendingDevices(); loadAuthorizedDevices(); }
        else showAlert('批量授权失败：'+(br.error||'未知'));
    } catch(e) { showAlert('批量授权异常：'+e.message); }
};

async function loadAuthorizedDevices() {
    try { var tbody = document.getElementById('authorizedDeviceTbody'); tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;">加载中...</td></tr>'; var r = await callEdgeFunction('debug_get_all_authorized', {}); if (!r.success || !r.data) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;">暂无已授权设备</td></tr>'; return; } var all = r.data; tbody.innerHTML = ''; if (all.length === 0) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;">暂无已授权设备</td></tr>'; return; } var seen = {}, ud = all.filter(function(d) { var k = d.username+'|'+d.device_id; if (seen[k]) return false; seen[k] = true; return true; }); var er = await callEdgeFunction('list_employees', {}), sr = await callEdgeFunction('list_stores', {}), em = {}; if (er.success && er.data) er.data.forEach(function(e) { em[e.phone] = e; }); var sm = {}; if (sr.success && sr.data) sr.data.forEach(function(s) { sm[s.username] = s; }); var snd = {}; STORE_CONFIG.forEach(function(s) { snd[s.id] = s.name; }); snd['15305479520'] = '02第二药店'; ud.forEach(function(d) { var ts = (d.authorized_at || d.last_login_at) ? new Date(d.authorized_at || d.last_login_at).toLocaleString('zh-CN') : '-'; var sb = d.is_authorized ? '<span class="replenish-badge replenish-ordered">已授权</span>' : '<span class="replenish-badge replenish-text">未授权</span>'; var tt = '门店', dn = snd[d.username] || d.username; if (em[d.username]) { tt = '员工'; dn = em[d.username].name || d.username; } tbody.innerHTML += '<tr><td>'+safeText(tt)+'</td><td>'+safeText(dn)+'</td><td>'+safeText(d.username)+'</td><td style="font-size:11px;word-break:break-all;">'+safeText(d.device_id)+'</td><td>'+sb+'</td><td><button class="btn-detail" style="color:red;" onclick="revokeDevice(\''+escapeHtml(d.device_id)+'\',\''+safeText(tt==='员工'?'employee':'store')+'\',\''+escapeHtml(d.username)+'\')">撤销</button></td></tr>'; }); } catch(err) { document.getElementById('authorizedDeviceTbody').innerHTML = '<tr><td colspan="5" style="text-align:center;color:red;">加载失败</td></tr>'; } }

window.revokeDevice = async function(did, tt, ti) { if (!checkPermission('manage_devices')) return; if (!confirm('确定撤销？撤销后需重新申请授权')) return; try { var r = await callEdgeFunction('revoke_device', { device_id:did, target_type:tt, target_id:ti, operator:(user&&(user.username||user.name))||'管理员' }); if (r.success) { showToast('已撤销', 'success'); loadAuthorizedDevices(); loadPendingDevices(); } else { showAlert('撤销失败：'+(r.error||'未知错误')); } } catch(e) { showAlert('撤销异常：'+e.message); } };
window.clearAllDeviceAuth = async function() { if (!checkPermission('manage_devices')) return; if (!confirm('警告：此操作将清除所有设备授权，所有门店必须重新申请授权！\n\n确定继续？')) return; try { var r = await callEdgeFunction('clear_all_device_auth', { operator:(user&&(user.username||user.name))||'管理员' }); if (r.success) showToast('已清除 '+ (r.data?.device_count||0) +' 个设备授权', 'success'); else showAlert('清除失败：'+(r.error||'未知错误')); loadAuthorizedDevices(); loadPendingDevices(); } catch(e) { showAlert('清除异常：'+e.message); } };

// ========== 门店管理 ==========
async function loadStores() { /* 使用STORE_CONFIG */ var tbody = document.getElementById('usersTbody'); tbody.innerHTML = ''; STORE_CONFIG.forEach(function(s) { tbody.innerHTML += '<tr><td>'+s.id+'</td><td style="white-space:nowrap;">'+s.name+'</td><td style="text-align:center;"><span class="replenish-badge replenish-done">正常</span></td></tr>'; }); }

// ========== 操作日志 ==========
var auditPage = 0, auditPageSize = 10, auditAllLogs = [];
document.getElementById('refreshAuditBtn').addEventListener('click', loadLogs);
async function loadLogs() { try { var r = await callEdgeFunction('get_audit_log', { limit:200 }); if (!r.success) throw new Error(r.error||'加载失败'); auditAllLogs = r.data || []; auditPage = 0; renderAuditPage(); } catch(err) { document.getElementById('auditTbody').innerHTML = '<tr><td colspan="4" style="text-align:center;color:red;">加载失败</td></tr>'; } }
function renderAuditPage() { var tb = document.getElementById('auditTbody'); if (auditAllLogs.length === 0) { tb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#999;">暂无日志</td></tr>'; return; } var s = auditPage * auditPageSize, pi = auditAllLogs.slice(s, s + auditPageSize), tp = Math.ceil(auditAllLogs.length / auditPageSize); tb.innerHTML = ''; pi.forEach(function(l) { tb.innerHTML += '<tr><td>'+safeText(l.time?new Date(l.time).toLocaleString('zh-CN'):'-')+'</td><td>'+safeText(l.user||'-')+'</td><td>'+safeText(l.action||'-')+'</td><td>'+safeText(l.detail||'-')+'</td></tr>'; }); var pd = document.getElementById('auditPagination') || document.createElement('div'); pd.id = 'auditPagination'; pd.style.cssText = 'display:flex;justify-content:center;align-items:center;gap:12px;padding:12px 0;'; pd.innerHTML = tp > 1 ? '<button onclick="auditPage=Math.max(0,auditPage-1);renderAuditPage()" '+(auditPage===0?'disabled style="opacity:0.4"':'')+' style="padding:6px 14px;border:1px solid var(--input-border);border-radius:6px;cursor:pointer;">上一页</button><span>第 '+(auditPage+1)+'/'+tp+' 页（共 '+auditAllLogs.length+' 条）</span><button onclick="auditPage=Math.min('+(tp-1)+',auditPage+1);renderAuditPage()" '+(auditPage>=tp-1?'disabled style="opacity:0.4"':'')+' style="padding:6px 14px;border:1px solid var(--input-border);border-radius:6px;cursor:pointer;">下一页</button>' : ''; if (!document.getElementById('auditPagination')) tb.parentElement.parentElement.appendChild(pd); }

// ========== 子账号管理 ==========
document.getElementById('addAdminBtn').addEventListener('click', showAddAdminModal);
document.getElementById('refreshAdminBtn').addEventListener('click', loadAdmins);
document.getElementById('adminCancelBtn').addEventListener('click', function() { document.getElementById('adminModal').classList.remove('show'); });
document.getElementById('adminSaveBtn').addEventListener('click', handleAddAdmin);
document.getElementById('adminRoleSelect').addEventListener('change', function() { var iv = this.value === 'viewer'; document.querySelectorAll('.perm-check').forEach(function(cb) { var p = cb.dataset.perm; if (iv) { cb.checked = (p === 'view_summary' || p === 'view_audit_log'); cb.disabled = true; } else { cb.checked = (p !== 'manage_admins'); cb.disabled = false; } }); });

function showAddAdminModal() { document.getElementById('adminModalTitle').textContent = '添加子账号'; document.getElementById('adminEditId').value = ''; document.getElementById('adminUsernameInput').value = ''; document.getElementById('adminPasswordInput').value = ''; document.getElementById('adminNameInput').value = ''; document.getElementById('adminRoleSelect').value = 'admin'; document.getElementById('adminUsernameInput').disabled = false; document.getElementById('adminPasswordInput').placeholder = '登录密码'; document.querySelectorAll('.perm-check').forEach(function(cb) { var p = cb.dataset.perm; cb.checked = (p !== 'manage_admins'); cb.disabled = false; }); document.getElementById('adminModal').classList.add('show'); }
function getAdminPermissionsFromUI() { var p = {}; document.querySelectorAll('.perm-check').forEach(function(cb) { p[cb.dataset.perm] = cb.checked; }); return p; }

async function handleAddAdmin() { var id = document.getElementById('adminEditId').value, un = document.getElementById('adminUsernameInput').value.trim(), pw = document.getElementById('adminPasswordInput').value, nm = document.getElementById('adminNameInput').value.trim(), rl = document.getElementById('adminRoleSelect').value, ps = getAdminPermissionsFromUI(); var _op = (user&&(user.username||user.name))||'管理员'; if (!id) { if (!un) { showAlert('请输入账号'); return; } if (!pw || pw.length < 6) { showAlert('密码至少6位'); return; } if (!nm) nm = un; var r = await callEdgeFunction('add_admin_user', { username:un, password:pw, name:nm, role:rl, permissions:ps, created_by:user.id, operator:_op }); if (r.success && r.data) { showToast('添加成功！'+un+'可登录', 'success'); document.getElementById('adminModal').classList.remove('show'); loadAdmins(); } else showAlert('添加失败：'+(r.error||'未知')); } else { var r2 = await callEdgeFunction('update_admin_user', { id:id, name:nm, role:rl, permissions:ps, operator:_op }); if (r2.success && r2.data) { showToast('修改成功', 'success'); document.getElementById('adminModal').classList.remove('show'); loadAdmins(); } else showAlert('修改失败：'+(r2.error||'未知')); } }

async function loadAdmins() { try { var r = await callEdgeFunction('list_admin_users', {}), tb = document.getElementById('adminTbody'); tb.innerHTML = ''; if (!r.success || !r.data) { tb.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;">暂无子账号</td></tr>'; return; } var rl = { super_admin:'超级管理员', admin:'普通管理员', viewer:'只读用户' }; r.data.forEach(function(a) { var pc = Object.keys(a.permissions||{}).filter(function(k) { return a.permissions[k] === true; }).length; var sb = a.is_active ? '<span class="replenish-badge replenish-ordered">正常</span>' : '<span class="replenish-badge replenish-text">停用</span>'; var ts = a.created_at ? new Date(a.created_at).toLocaleString('zh-CN') : '-'; var ah = a.role !== 'super_admin' ? '<button class="btn-detail" onclick="editAdmin(\''+a.id+'\')">编辑</button> <button class="btn-detail" onclick="toggleAdminStatus(\''+a.id+'\','+(!a.is_active)+')">'+(a.is_active?'停用':'启用')+'</button> <button class="btn-detail" style="color:red;" onclick="deleteAdmin(\''+a.id+'\')">删除</button>' : '<span style="color:#999;font-size:12px;">不可操作</span>'; tb.innerHTML += '<tr><td>'+safeText(a.username)+'</td><td>'+safeText(a.name||'-')+'</td><td>'+safeText(rl[a.role]||a.role)+'</td><td>'+pc+' 项</td><td>'+sb+'</td><td style="font-size:12px;">'+safeText(ts)+'</td><td>'+ah+'</td></tr>'; }); } catch(err) {} }

window.editAdmin = async function(id) { try { var r = await callEdgeFunction('list_admin_users', {}); if (!r.success || !r.data) return; var a = r.data.find(function(x) { return x.id === id; }); if (!a) return; document.getElementById('adminModalTitle').textContent = '编辑子账号'; document.getElementById('adminEditId').value = a.id; document.getElementById('adminUsernameInput').value = a.username; document.getElementById('adminUsernameInput').disabled = true; document.getElementById('adminPasswordInput').value = ''; document.getElementById('adminPasswordInput').placeholder = '不修改请留空'; document.getElementById('adminNameInput').value = a.name || ''; document.getElementById('adminRoleSelect').value = a.role; document.querySelectorAll('.perm-check').forEach(function(cb) { var p = cb.dataset.perm; cb.checked = (a.permissions||{})[p] === true; cb.disabled = false; }); document.getElementById('adminModal').classList.add('show'); } catch(e) {} };
window.toggleAdminStatus = async function(id, a) { if (!confirm(a?'确定启用？':'确定停用？')) return; var r = await callEdgeFunction('toggle_admin_user', { id:id, is_active:a, operator:(user&&(user.username||user.name))||'管理员' }); if (r.success) { showToast(a?'已启用':'已停用', 'success'); loadAdmins(); } else showAlert('失败'); };
window.deleteAdmin = async function(id) { if (!confirm('确定删除？删除后无法恢复')) return; var r = await callEdgeFunction('delete_admin_user', { id:id, operator:(user&&(user.username||user.name))||'管理员' }); if (r.success) { showToast('已删除', 'success'); loadAdmins(); } else showAlert('删除失败'); };

// Tab 增强
document.querySelectorAll('.tab-btn').forEach(function(b) { b.addEventListener('click', function() { if (this.dataset.tab === 'admins') loadAdmins(); }); });

// ========== 页面初始化 ==========
// ★ 2026-11-10 优化：删掉 pingWarmup（ping 只预热 JWT/Supabase，不预热 SQL Server 连接池；
// 而 get_summary 本身就是第一个真正用 SQL 的请求，冷启动时间已经包含在里面；
// 且 ping 是 setTimeout 100ms 后触发、完全不阻塞首屏，省了也不影响用户体验）
// v5.15.6: 监听主进程 autoUpdater 消息（仅 Electron 环境有 window.electron）
if (window.electron?.ipcRenderer) {
    try {
        window.electron.ipcRenderer.on('update-downloaded', function(info) {
            showToast('🆕 新版本 v' + (info?.version || '?') + ' 已下载，退出后自动安装', 'info');
        });
    } catch(_) {}
}
loadSummary();
initPermissionUI();

// ========== 管理员操作日志（记录关键操作）==========
var _originalUpdateReplenish = window.updateReplenishStatus;
window.updateReplenishStatus = async function(sel) {
    var pc = sel.getAttribute('data-product-code'), ns = sel.value, os = sel.getAttribute('data-status')||'';
    await _originalUpdateReplenish(sel);
    // 记录操作日志
    try { await callEdgeFunction('log_admin_action', { user:user.name||user.username, action:'修改补货状态', detail:pc+' '+os+'→'+ns }); } catch(e) {}
};

// ========== 供货商 Excel 样式筛选下拉 ==========
var _supplierSearchTimer = 0;
var _pendingSuppliers = []; // 暂存临时勾选

window.toggleExcelFilter = function(e) {
    e.stopPropagation();
    var panel = document.getElementById('supplierFilterPanel');
    if (panel.classList.contains('show')) { panel.classList.remove('show'); return; }
    _pendingSuppliers = selectedSuppliers.slice();
    updateSupplierCheckmarks();
    updateSupplierDropdownFilter(document.getElementById('supplierSearchInput').value.trim());
    panel.classList.add('show');
    setTimeout(function() { document.getElementById('supplierSearchInput').focus(); }, 50);
    setTimeout(function() {
        var closeFn = function(ev) {
            var wrap = document.getElementById('supplierFilterWrap');
            if (wrap && !wrap.contains(ev.target)) { panel.classList.remove('show'); document.removeEventListener('click', closeFn); }
        };
        document.addEventListener('click', closeFn);
    }, 100);
};

window.onSupplierKeywordChange = function() {
    clearTimeout(_supplierSearchTimer);
    _supplierSearchTimer = setTimeout(function() {
        var kw = document.getElementById('supplierSearchInput').value.trim();
        updateSupplierDropdownFilter(kw);
        if (kw) {
            // 有关键字：自动勾选匹配项
            var dropdown = document.getElementById('supplierDropdown');
            var opts = dropdown.querySelectorAll('.excel-filter-option:not(.all)');
            _pendingSuppliers = [];
            opts.forEach(function(o) {
                if (o.style.display !== 'none') {
                    var s = o.getAttribute('data-supplier');
                    if (s) _pendingSuppliers.push(s);
                }
            });
            updateSupplierCheckmarks();
        } else {
            // 清空搜索 → 重置为全选
            _pendingSuppliers = [];
            updateSupplierCheckmarks();
        }
    }, 200);
};

function updateSupplierDropdownFilter(kw) {
    var dropdown = document.getElementById('supplierDropdown');
    if (!dropdown) return;
    var opts = dropdown.querySelectorAll('.excel-filter-option:not(.all)');
    var kwLower = (kw||'').toLowerCase();
    opts.forEach(function(o) {
        var s = (o.getAttribute('data-supplier') || '').toLowerCase();
        o.style.display = (!kwLower || s.indexOf(kwLower) !== -1) ? '' : 'none';
    });
}

window.toggleSupplierAllCheckbox = function(e) {
    e.stopPropagation();
    var cb = document.getElementById('supplierCheckAll');
    var checked = cb ? cb.checked : false;
    var dropdown = document.getElementById('supplierDropdown');
    var kw = document.getElementById('supplierSearchInput').value.trim();
    var opts = dropdown.querySelectorAll('.excel-filter-option:not(.all)');
    var visibleOpts = kw ? Array.from(opts).filter(function(o) { return o.style.display !== 'none'; }) : Array.from(opts);
    if (checked) {
        // 全选 → 清空 _pendingSuppliers
        _pendingSuppliers = [];
    } else {
        // 全部勾选可见项
        visibleOpts.forEach(function(o) { var s = o.getAttribute('data-supplier'); if (s && _pendingSuppliers.indexOf(s) < 0) _pendingSuppliers.push(s); });
    }
    updateSupplierCheckmarks();
};

window.toggleSupplierItemCheckbox = function(cb) {
    var row = cb.closest('.excel-filter-option');
    var supplier = row ? row.getAttribute('data-supplier') : null;
    if (!supplier) return;
    var idx = _pendingSuppliers.indexOf(supplier);
    if (cb.checked) {
        if (idx < 0) _pendingSuppliers.push(supplier);
    } else {
        if (idx >= 0) _pendingSuppliers.splice(idx, 1);
    }
    updateSupplierCheckmarks();
};

window.applySupplierFilter = function() {
    selectedSuppliers = _pendingSuppliers.slice();
    updateSupplierDisplay();
    document.getElementById('supplierFilterPanel').classList.remove('show');
    applyStatusFilter();
};

window.cancelSupplierFilter = function() {
    _pendingSuppliers = selectedSuppliers.slice();
    document.getElementById('supplierFilterPanel').classList.remove('show');
};

function updateSupplierCheckmarks() {
    var dropdown = document.getElementById('supplierDropdown');
    var opts = dropdown.querySelectorAll('.excel-filter-option:not(.all)');
    opts.forEach(function(o) {
        var s = o.getAttribute('data-supplier') || '';
        var cb = o.querySelector('input[type=checkbox]');
        if (cb) cb.checked = _pendingSuppliers.indexOf(s) >= 0;
    });
    // 全选复选框：当没有任何选中项时勾选，否则不勾选
    var allCb = document.getElementById('supplierCheckAll');
    if (allCb) allCb.checked = _pendingSuppliers.length === 0;
    // 更新全选行计数文本（保留 checkbox 元素不变）
    var allOptDiv = dropdown.querySelector('.excel-filter-option.all');
    if (allOptDiv) {
        var label = allOptDiv.querySelector('label');
        if (label) {
            var txtNode = label.lastChild;
            if (txtNode && txtNode.nodeType === 3) {
                txtNode.textContent = ' (全选)' + (_pendingSuppliers.length > 0 ? '（已选' + _pendingSuppliers.length + '项）' : '');
            }
        }
    }
}

function updateSupplierDisplay() {
    var text = document.getElementById('supplierFilterText');
    if (!text) return;
    if (selectedSuppliers.length === 0) {
        text.textContent = '供货商筛选';
    } else if (selectedSuppliers.length <= 2) {
        text.textContent = selectedSuppliers.join(', ');
    } else {
        text.textContent = selectedSuppliers[0] + ', ' + selectedSuppliers[1] + '...共' + selectedSuppliers.length + '项';
    }
}


