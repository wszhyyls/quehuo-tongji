// ========================================
// 缺货统计系统 - 门店前端 (v27)
// 优化：统一公共模块、延迟初始化、搜索取消、历史缓存、非阻断提示、到货通知
// ========================================

var token = localStorage.getItem('token');
var user = null;
try {
    user = JSON.parse(localStorage.getItem('user') || 'null');
} catch(e) {
    logError('用户信息解析失败', e);
    window.location.href = './';
}

// ========== 预加载遮罩层控制 ==========
var loadingOverlay = document.getElementById('loadingOverlay');
var loadingText = document.getElementById('loadingText');
var loadingProgress = document.getElementById('loadingProgress');
var preloadComplete = false;

function updateLoadingProgress(text, percent) {
    if (loadingText) loadingText.textContent = text;
    if (loadingProgress) loadingProgress.textContent = percent;
}

function hideLoadingOverlay() {
    if (loadingOverlay) {
        loadingOverlay.classList.add('hidden');
        setTimeout(function() { loadingOverlay.style.display = 'none'; }, 500);
    }
}

// ========== 本店库存预加载 ==========
var storeInventoryMap = {};
var storeInventoryLoaded = false;

async function preloadStoreInventory(forceRefresh, syncFirst) {
    if (storeInventoryLoaded && !forceRefresh) return true;
    try {
        if (syncFirst) updateLoadingProgress('同步SPFXB数据...', '40%');
        else updateLoadingProgress('正在加载本店库存...', '50%');
        var result = await callEdgeFunction('get_store_inventory', { 
            store_name: user?.store_name || '',
            force_refresh: !!forceRefresh,
            sync_first: !!syncFirst
        });
        if (syncFirst) updateLoadingProgress('查询最新库存...', '60%');
        if (result.data && Array.isArray(result.data)) {
            result.data.forEach(function(item) { storeInventoryMap[item.商品编码] = item; });
            storeInventoryLoaded = true;
            var timeEl = document.getElementById('lastRefreshTime');
            if (timeEl && result.last_refresh) {
                var d = new Date(result.last_refresh);
                var t = d.getFullYear() + '/' + (d.getMonth()+1) + '/' + d.getDate() + ' ' +
                        String(d.getHours()).padStart(2,'0') + ':' +
                        String(d.getMinutes()).padStart(2,'0') + ':' +
                        String(d.getSeconds()).padStart(2,'0');
                timeEl.textContent = '🕐 ' + t;
            }
            try {
                var storeKey = 'storeInventoryCache_' + (user?.store_name || 'default');
                localStorage.setItem(storeKey, JSON.stringify({
                    data: result.data, time: Date.now(), store_name: user?.store_name || ''
                }));
            } catch(e) {}
        }
        return true;
    } catch(err) {
        logError('[预加载] 本店库存加载失败', err);
        storeInventoryLoaded = true;
        return false;
    }
}

function restoreStoreInventoryCache() {
    try {
        var storeKey = 'storeInventoryCache_' + (user?.store_name || 'default');
        var saved = JSON.parse(localStorage.getItem(storeKey));
        if (saved && saved.data && saved.store_name === user?.store_name) {
            if ((Date.now() - saved.time) < 600000) {
                saved.data.forEach(function(item) { storeInventoryMap[item.商品编码] = item; });
                storeInventoryLoaded = true;
                return true;
            }
        }
    } catch(e) {}
    return false;
}

var currentProduct = null;
var pendingReport = null;
var searchTimeout = null;
var isComposing = false;

// ========== Fuse.js 全文搜索引擎 ==========
var fuseInstance = null;
var searchCache = new Map();
var SEARCH_CACHE_TTL = 5 * 60 * 1000;

function initFuseSearch() {
    if (!allProducts || allProducts.length === 0) return;
    fuseInstance = new Fuse(allProducts, {
        keys: [
            { name: 'product_code', weight: 0.4 },
            { name: 'pinyin_code', weight: 0.3 },
            { name: 'product_name', weight: 0.2 },
            { name: 'manufacturer', weight: 0.05 },
            { name: 'product_spec', weight: 0.05 }
        ],
        threshold: 0.3, includeScore: true, minMatchCharLength: 2
    });
}

function getCacheKey(keyword) { return 'search_' + keyword.toLowerCase().trim(); }

function searchLocal(keyword) {
    var kw = keyword.toLowerCase().trim();
    if (!kw) return [];
    var cacheKey = getCacheKey(kw), cached = searchCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < SEARCH_CACHE_TTL)) return cached.results;
    var results;
    if (fuseInstance) { results = fuseInstance.search(kw).slice(0, 30).map(function(r) { return r.item; }); }
    else { results = searchLocalFallback(kw); }
    searchCache.set(cacheKey, { results: results, timestamp: Date.now() });
    return results;
}

function searchLocalFallback(kw) {
    var codeResults = [], pyResults = [], fuzzyResults = [], seen = new Set();
    for (var i = 0; i < allProducts.length; i++) {
        var p = allProducts[i], code = p.product_code || '';
        if (seen.has(code)) continue;
        if (code && code.toLowerCase().indexOf(kw) === 0) { seen.add(code); codeResults.push(p); continue; }
        var py = p.pinyin_code || '';
        if (py && py === kw) { seen.add(code); pyResults.push(p); continue; }
        if (py && py.indexOf(kw) === 0) { seen.add(code); pyResults.push(p); continue; }
        var name = p.product_name || '';
        if (name && name.toLowerCase().indexOf(kw) !== -1) { seen.add(code); fuzzyResults.push(p); continue; }
        var spec = p.product_spec || '', mfg = p.manufacturer || '';
        if ((spec && spec.toLowerCase().indexOf(kw) !== -1) || (mfg && mfg.toLowerCase().indexOf(kw) !== -1)) {
            seen.add(code); fuzzyResults.push(p);
        }
    }
    return codeResults.concat(pyResults).concat(fuzzyResults).slice(0, 30);
}

// ========== 历史记录分页 ==========
var allHistoryData = [];
var historyPage = 0, historyPageSize = 20, historyTotalLoaded = 0;
var historyLastLoad = 0, HISTORY_CACHE_TTL = 30000;

// ========== Supabase 客户端 ==========
var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ========== 全量商品缓存 ==========
var allProducts = [];
var productsLoaded = false;

async function loadAllProducts() {
    if (productsLoaded) return true;
    try {
        updateLoadingProgress('正在加载商品列表...', '30%');
        var result = await callEdgeFunction('get_all_products', {});
        allProducts = result.data || []; productsLoaded = true; initFuseSearch();
        try { localStorage.setItem('allProductsCache', JSON.stringify({ data: allProducts, time: Date.now() })); } catch(e) {}
        return true;
    } catch(err) { logError('全量商品加载失败', err); productsLoaded = true; return false; }
}

function restoreProductCache() {
    try {
        var saved = JSON.parse(localStorage.getItem('allProductsCache'));
        if (saved && saved.data && saved.data.length > 0) { allProducts = saved.data; productsLoaded = true; return true; }
    } catch(e) {}
    return false;
}

async function checkProductsUpdate() {
    if (!productsLoaded || allProducts.length === 0) return false;
    try {
        var result = await callEdgeFunction('check_products_update', {});
        if (result.data && result.data.product_count > allProducts.length) {
            if (confirm('商品列表有更新（' + allProducts.length + ' → ' + result.data.product_count + ' 个），刷新加载？')) {
                productsLoaded = false; allProducts = []; localStorage.removeItem('allProductsCache');
                await loadAllProducts(); initFuseSearch(); return true;
            }
        }
    } catch(e) {}
    return false;
}

// ========== 构建产品数据工厂函数（消除3处重复）==========
function buildProductData(code, inventoryData, productInfo, apiRecords) {
    var pInfo = productInfo || allProducts.find(function(p) { return p.product_code === code; }) || {};
    var allStores = {};
    if (apiRecords) {
        apiRecords.forEach(function(r) {
            var sn = r.门店名称 || '未知门店';
            allStores[sn] = { name: sn, stock: r.库存数量||0, transit: r.在途数量||0, standard_stock: r.标准库存数量||0 };
        });
    }
    return { found: true, is_new: false, data: {
        product_code: code,
        product_name: pInfo.product_name || (inventoryData ? inventoryData.商品名称 : '') || '',
        specification: pInfo.product_spec || (inventoryData ? inventoryData.规格 : '') || '',
        manufacturer: pInfo.manufacturer || (inventoryData ? inventoryData.生产企业 : '') || '',
        current_stock: inventoryData ? (inventoryData.库存数量||0) : 0,
        in_transit: inventoryData ? (inventoryData.在途数量||0) : 0,
        dc_stock: inventoryData ? (inventoryData.配送中心库存数量||0) : 0,
        standard_stock: inventoryData ? (inventoryData.标准库存数量||0) : 0,
        sales_30days: inventoryData ? (inventoryData.前30天销售数量||0) : 0,
        suggested_order: inventoryData ? (inventoryData.建议订货数量||0) : 0,
        all_stores: allStores
    }};
}

// ========== 主初始化：缓存优先，后台静默更新 ==========
async function initializeApp() {
    var hasProductCache = restoreProductCache();
    if (hasProductCache) initFuseSearch();
    restoreStoreInventoryCache();
    
    if (hasProductCache && storeInventoryLoaded) {
        updateLoadingProgress('加载完成！', '100%');
        setTimeout(hideLoadingOverlay, 200);
        preloadComplete = true;
        // 后台静默更新
        checkProductsUpdate().catch(function(){});
        loadReporterOptions();
        checkArrivalNotifications();
        checkApprovalNotifications();
    } else {
        updateLoadingProgress('正在加载数据...', '20%');
        var productTask = (async function() {
            if (!hasProductCache && !productsLoaded) await loadAllProducts();
            else if (hasProductCache) { await checkProductsUpdate(); initFuseSearch(); }
        })();
        var inventoryTask = (async function() { if (!storeInventoryLoaded) await preloadStoreInventory(); })();
        await Promise.all([productTask, inventoryTask]);
        updateLoadingProgress('加载完成！', '100%');
        setTimeout(hideLoadingOverlay, 300);
        preloadComplete = true;
        loadReporterOptions();
        checkArrivalNotifications();
        checkApprovalNotifications();
    }
}

// ========== 上报人下拉框 ==========
var storeEmployees = [];
async function loadReporterOptions() {
    try {
        var result = await callEdgeFunction('list_employees', {});
        if (!result || !result.success) return;
        var allEmps = result.data || [];
        var phoneToStore = { '15305479520': 'wszhyy02' };
        var storeId = phoneToStore[user.store_id || user.username || ''] || user.store_id || user.username || '';
        var emps = allEmps.filter(function(e) { return e.store_id === storeId; });
        storeEmployees = emps;
        var opts = '<option value="">--上报人--</option>';
        storeEmployees.forEach(function(e) {
            opts += '<option value="' + (e.id||'') + '" data-phone="' + (e.phone||'') + '" data-name="' + (e.name||'') + '">' + escapeHtml(e.name || e.phone || e.id || '') + '</option>';
        });
        var sel1 = document.getElementById('reporterSelect'), sel2 = document.getElementById('reporterSelectNew');
        if (sel1) sel1.innerHTML = opts;
        if (sel2) sel2.innerHTML = opts;
    } catch(e) { logError('加载员工列表失败', e); }
}
function getSelectedReporter() {
    // 优先读取当前激活Tab对应的上报人选择器
    var sel = document.getElementById('reporterSelect');
    var selNew = document.getElementById('reporterSelectNew');
    // 哪个选中了就用哪个
    if (sel && sel.value) {
        var opt = sel.options[sel.selectedIndex];
        return { id: sel.value, phone: opt.getAttribute('data-phone') || '', name: opt.getAttribute('data-name') || '' };
    }
    if (selNew && selNew.value) {
        var opt2 = selNew.options[selNew.selectedIndex];
        return { id: selNew.value, phone: opt2.getAttribute('data-phone') || '', name: opt2.getAttribute('data-name') || '' };
    }
    return null;
}

initializeApp();

// ========== 页面初始化 ==========
if (!token) { window.location.href = './'; }

var themes = ['purple', 'blue', 'green', 'dark', 'orange'];
var themeLabels = { purple: '💜 紫韵', blue: '🌊 海蓝', green: '🌿 翠绿', dark: '🌙 暗夜', orange: '🌅 暖橙' };
var savedTheme = localStorage.getItem('appTheme') || 'purple';
document.documentElement.setAttribute('data-theme', savedTheme);
document.getElementById('storeName').textContent = user.store_name + (user.is_employee ? (' / ' + (user.employee_name || user.employee_phone)) : '');
document.getElementById('themeBtn').addEventListener('click', function() {
    var idx = themes.indexOf(document.documentElement.getAttribute('data-theme') || 'purple');
    var next = themes[(idx + 1) % themes.length];
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('appTheme', next);
    this.textContent = themeLabels[next];
});
document.getElementById('themeBtn').textContent = themeLabels[savedTheme];

// ========== 刷新库存按钮（含分步进度提示）==========
var isRefreshing = false;
document.getElementById('refreshCacheBtn').addEventListener('click', async function() {
    if (isRefreshing) return;
    isRefreshing = true;
    var btn = this, oldText = btn.textContent;
    btn.disabled = true; btn.classList.add('btn-loading');
    btn.textContent = '同步SPFXB...';
    try {
        var storeName = user?.store_name || '';
        if (storeName) localStorage.removeItem('storeInventoryCache_' + storeName);
        localStorage.removeItem('storeInventoryCache');
        storeInventoryLoaded = false; storeInventoryMap = {};
        btn.textContent = '查询数据...';
        await preloadStoreInventory(true, true);
        btn.textContent = '更新展示...';
        if (currentProduct && currentProduct.data && currentProduct.data.product_code && currentProduct.found) {
            queryProductByCode(currentProduct.data.product_code, true);
        }
        btn.textContent = '刷新完成 ✓';
        btn.classList.remove('btn-loading'); btn.classList.add('btn-success');
        showToast('库存已刷新', 'success');
    } catch(e) {
        logError('[刷新库存] 刷新失败', e);
        showToast('刷新失败', 'error');
        btn.classList.remove('btn-loading');
    } finally {
        setTimeout(function() {
            isRefreshing = false; btn.disabled = false;
            btn.textContent = oldText;
            btn.classList.remove('btn-loading', 'btn-success');
        }, 1500);
    }
});

// ========== Alert弹窗确定按钮 ==========
document.getElementById('alertOkBtn').addEventListener('click', function() {
    document.getElementById('alertModal').classList.remove('show');
});

// ========== 退出登录 ==========
document.getElementById('logoutBtn').addEventListener('click', async function() {
    showConfirm('确定退出登录？系统将清除本地缓存。', async function() {
        try {
            await callEdgeFunction('logout_device', {
                target_type: user.is_employee ? 'employee' : 'store',
                target_id: user.is_employee ? user.id : user.username,
                device_id: getDeviceId()
            });
        } catch(e) {}
        ['token','user','allProductsCache'].forEach(function(k) { localStorage.removeItem(k); });
        var sn = user?.store_name || '';
        if (sn) localStorage.removeItem('storeInventoryCache_' + sn);
        localStorage.removeItem('storeInventoryCache');
        window.location.href = './';
    }, null, '确定退出', '留在页面');
});

// ========== 同步状态查询 ==========
async function loadCacheStatus() {
    var bar = document.getElementById('cacheTimeBar'), text = document.getElementById('cacheTimeText');
    try {
        var { data: logData, error: logError } = await supabase.from('sync_log_table').select('*').order('sync_time', { ascending: false }).limit(1);
        if (!logError && logData && logData.length > 0) {
            var latest = logData[0];
            text.innerHTML = '库存数据更新时间: ' + safeText(new Date(latest.sync_time).toLocaleString('zh-CN')) + ' ' + (latest.status === 'success' ? '✅' : '❌');
            text.className = latest.status === 'success' ? 'sync-success' : 'sync-fail';
            bar.style.display = 'block';
        } else { bar.style.display = 'none'; }
    } catch(err) { bar.style.display = 'none'; }
}

// Tab 切换
document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        document.getElementById(btn.dataset.tab === 'shortage' ? 'shortageContent' : 'newProductContent').classList.add('active');
    });
});

// ========== 商品搜索（250ms防抖 + AbortController取消）==========
var productCodeInput = document.getElementById('productCode');
productCodeInput.addEventListener('compositionstart', function() { isComposing = true; });
productCodeInput.addEventListener('compositionend', function(e) {
    isComposing = false;
    var kw = e.target.value.trim();
    if (kw.length >= 1) { clearTimeout(searchTimeout); searchTimeout = setTimeout(function() { searchProducts(kw); }, 250); }
});
productCodeInput.addEventListener('input', function(e) {
    if (isComposing) return;
    var kw = e.target.value.trim();
    if (kw.length >= 1) { clearTimeout(searchTimeout); searchTimeout = setTimeout(function() { searchProducts(kw); }, 250); }
    else { clearTimeout(searchTimeout); document.getElementById('searchResults').style.display = 'none'; document.getElementById('searchList').innerHTML = ''; clearProductInfo(); }
});
document.getElementById('queryBtn').addEventListener('click', async function() {
    var code = productCodeInput.value.trim();
    if (!code) { showAlert('请输入商品编码或名称'); return; }
    await searchProducts(code);
});

async function searchProducts(keyword) {
    var searchList = document.getElementById('searchList');
    searchList.innerHTML = '<div class="search-loading">⏳ 正在搜索...</div>';
    document.getElementById('searchResults').style.display = 'block';
    if (productsLoaded && allProducts.length > 0) {
        var localResults = searchLocal(keyword);
        if (localResults.length > 0) { renderSearchResults(localResults.map(function(p) { return { product_code: p.product_code, product_name: p.product_name, specification: p.product_spec, manufacturer: p.manufacturer }; })); return; }
        try {
            var data = await callEdgeFunctionAbortable('search_product', { keyword: keyword });
            if (data.success && data.data && data.data.length > 0) { renderSearchResults(data.data.map(function(p) { return { product_code: p.product_code, product_name: p.product_name, specification: p.product_spec, manufacturer: p.manufacturer }; })); return; }
        } catch(e) { if (e.name !== 'AbortError') logError('搜索失败', e); }
        searchList.innerHTML = '<div class="search-empty">未找到匹配商品</div>'; return;
    }
    try {
        var data2 = await callEdgeFunctionAbortable('search_product', { keyword: keyword });
        if (data2.success && data2.data && data2.data.length > 0) { renderSearchResults(data2.data.map(function(p) { return { product_code: p.product_code, product_name: p.product_name, specification: p.product_spec, manufacturer: p.manufacturer }; })); }
        else { searchList.innerHTML = '<div class="search-empty">未找到匹配商品</div>'; }
    } catch(err) { searchList.innerHTML = '<div class="search-error">搜索失败，请稍后重试</div>'; }
}

var searchResultsAll = [], searchPage = 0, searchPageSize = 20;

function renderSearchResults(products) {
    searchResultsAll = products; searchPage = 0;
    var searchList = document.getElementById('searchList'); searchList.innerHTML = '';
    products.slice(0, searchPageSize).forEach(function(p) { appendSearchItem(searchList, p); });
    var loadMoreContainer = document.getElementById('searchLoadMore');
    if (!loadMoreContainer) {
        loadMoreContainer = document.createElement('div'); loadMoreContainer.id = 'searchLoadMore'; loadMoreContainer.className = 'load-more-container';
        var btn = document.createElement('button'); btn.id = 'searchLoadMoreBtn'; btn.className = 'btn-search btn-load-more'; btn.textContent = '加载更多';
        btn.addEventListener('click', loadMoreSearchResults); loadMoreContainer.appendChild(btn);
        searchList.parentElement.appendChild(loadMoreContainer);
    }
    loadMoreContainer.style.display = products.length > searchPageSize ? 'block' : 'none';
    if (products.length > searchPageSize) loadMoreContainer.querySelector('button').textContent = '加载更多 (' + products.length + ' 条结果)';
    document.getElementById('searchResults').style.display = 'block';
}
function appendSearchItem(container, p) {
    var div = document.createElement('div'); div.className = 'search-item';
    div.innerHTML = '<span class="code">' + safeText(p.product_code||'') + '</span><div class="product-info"><span class="product-name">' + safeText(p.product_name || p.product_code || '') + '</span><span class="spec" style="color:#888;font-size:12px;">' + safeText(p.specification||'') + '</span><span class="mfg" style="color:#aaa;font-size:11px;">' + safeText(p.manufacturer||'') + '</span></div>';
    div.addEventListener('click', function() { selectProduct(p); }); container.appendChild(div);
}
function loadMoreSearchResults() { searchPage++; var start = searchPage * searchPageSize, end = start + searchPageSize, toShow = searchResultsAll.slice(start, end); toShow.forEach(function(p) { appendSearchItem(document.getElementById('searchList'), p); }); var remaining = searchResultsAll.length - end; if (remaining <= 0) document.getElementById('searchLoadMore').style.display = 'none'; else document.getElementById('searchLoadMoreBtn').textContent = '加载更多 (' + remaining + ' 条剩余)'; }

async function selectProduct(product) { document.getElementById('productCode').value = product.product_code; document.getElementById('searchResults').style.display = 'none'; showQuickProduct(product); queryProductByCode(product.product_code); }
function showQuickProduct(product) { var d = document.getElementById('demandQty'); if (d) { d.value = 0; d.placeholder = '数量'; } document.getElementById('pName').textContent = product.product_name || product.product_code || ''; document.getElementById('pSpec').textContent = product.specification || ''; document.getElementById('pMfg').textContent = product.manufacturer || ''; ['pStock','pTransit','pDcStock','pSales30','pStdStock'].forEach(function(id) { document.getElementById(id).textContent = '...'; }); document.getElementById('productInfo').style.display = 'block'; var nl = document.getElementById('newLabel'); if (nl) nl.style.display = 'none'; }

function clearProductInfo() {
    ['pName','pSpec','pMfg','pStock','pTransit','pDcStock','pSales30','pStdStock'].forEach(function(id) { var el = document.getElementById(id); if (el) { el.textContent = ''; el.classList.remove('stock-warning'); } });
    var nl = document.getElementById('newLabel'); if (nl) nl.style.display = 'none';
    var vsb = document.getElementById('viewStockBtn'); if (vsb) vsb.style.display = 'none';
    var tw = document.getElementById('transitWarning'); if (tw) tw.style.display = 'none';
    currentProduct = null;
}

document.getElementById('cancelProductBtn').addEventListener('click', function() {
    document.getElementById('productCode').value = ''; document.getElementById('demandQty').value = 0;
    document.getElementById('remark').value = ''; document.getElementById('urgencyLevel').value = '普通';
    document.getElementById('searchResults').style.display = 'none'; document.getElementById('productInfo').style.display = 'none';
    clearProductInfo();
});

// ========== 商品详情查询（使用工厂函数）==========
async function queryProductByCode(code, forceRefresh) {
    if (!forceRefresh) {
        var inv = storeInventoryMap[code];
        if (inv) { currentProduct = buildProductData(code, inv); renderProductInfo(currentProduct.data); return; }
        if (!storeInventoryLoaded) {
            var wc = 0; while (!storeInventoryLoaded && wc < 100) { await new Promise(function(r) { setTimeout(r, 100); }); wc++; }
            inv = storeInventoryMap[code];
            if (inv) { currentProduct = buildProductData(code, inv); renderProductInfo(currentProduct.data); return; }
        }
    }
    try {
        var data = await callEdgeFunction('get_product_detail', { product_code: code, store_name: user?.store_name || '', force_refresh: !!forceRefresh });
        if (data.success && data.data && data.data.length > 0 && data.data[0].length > 0) {
            var myRecord = data.data[0][0];
            currentProduct = buildProductData(code, myRecord, null, data.data[0]);
            storeInventoryMap[code] = myRecord; renderProductInfo(currentProduct.data);
        } else { showAlert('商品未找到'); document.getElementById('productInfo').style.display = 'none'; currentProduct = null; }
    } catch(err) { logError('商品详情查询失败', err); showAlert('查询失败：' + friendlyErrorClient(err.message)); }
}

function renderProductInfo(data) {
    var map = { pName:'product_name', pSpec:'specification', pMfg:'manufacturer', pStock:'current_stock', pTransit:'in_transit', pDcStock:'dc_stock' };
    for (var id in map) { var el = document.getElementById(id); if (el) { el.textContent = (data[map[id]] != null) ? data[map[id]] : ''; if (!el.textContent) el.classList.remove('stock-warning'); } }
    var s30 = document.getElementById('pSales30'); if (s30) s30.textContent = (data.sales_30days != null) ? data.sales_30days : '0';
    var ss = document.getElementById('pStdStock'); if (ss) ss.textContent = (data.standard_stock != null) ? data.standard_stock : '0';
    var ps = document.getElementById('pStock'); if (ps && data.standard_stock > 0 && (data.current_stock||0) < data.standard_stock) ps.classList.add('stock-warning');
    var pdc = document.getElementById('pDcStock'); if (pdc && data.standard_stock > 0 && (data.dc_stock||0) < data.standard_stock) pdc.classList.add('stock-warning');
    var dq = document.getElementById('demandQty'); if (dq) { dq.value = 0; dq.placeholder = data.suggested_order > 0 ? '建议 ' + data.suggested_order : '数量'; }
    document.getElementById('productInfo').style.display = 'block';
    var nl = document.getElementById('newLabel'); if (nl) nl.style.display = 'none';
    var vsb = document.getElementById('viewStockBtn'); if (vsb) vsb.style.display = 'inline-block';
}

// 各店库存弹窗
document.getElementById('viewStockBtn').addEventListener('click', async function() {
    if (!currentProduct || !currentProduct.data) return;
    var has = false; for (var k in currentProduct.data.all_stores) { has = true; break; }
    if (!has && currentProduct.data.product_code) {
        try {
            var data = await callEdgeFunction('get_product_detail', { product_code: currentProduct.data.product_code, store_name: user?.store_name || '' });
            if (data.success && data.data && data.data.length > 0) {
                var as = {};
                data.data[0].forEach(function(r) { var sn = r.门店名称||'未知门店'; as[sn] = { name: sn, stock: r.库存数量||0, transit: r.在途数量||0, standard_stock: r.标准库存数量||0 }; });
                currentProduct.data.all_stores = as;
            }
        } catch(e) {}
    }
    renderStockModal(currentProduct.data);
});
document.getElementById('stockModalClose').addEventListener('click', function() { document.getElementById('stockModal').classList.remove('show'); });
document.getElementById('stockModal').addEventListener('click', function(e) { if (e.target === this) this.classList.remove('show'); });

function renderStockModal(d) {
    var tb = document.getElementById('stockTbody'); if (!tb) return; tb.innerHTML = '';
    var cn = user?.store_name || '', stores = [];
    for (var id in d.all_stores) { var s = d.all_stores[id]; if (s.name !== cn) stores.push(s); }
    stores.sort(function(a, b) { return a.name.localeCompare(b.name, 'zh-CN'); });
    if (stores.length === 0) { tb.innerHTML = '<tr><td colspan="3" style="text-align:center;color:#999;">暂无其他门店库存数据</td></tr>'; return; }
    stores.forEach(function(s) {
        var st = Number(s.stock)||0, ss = Number(s.standard_stock)||0, tf = Math.max(0, st - ss);
        var tr = document.createElement('tr');
        tr.innerHTML = '<td>' + safeText(s.name) + '</td><td>' + safeText(st) + '</td><td style="' + (tf > 0 ? 'color:#e74c3c;font-weight:bold;' : '') + '">' + safeText(tf) + '</td>';
        tb.appendChild(tr);
    });
    document.getElementById('stockModal').classList.add('show');
}

// ========== 上报逻辑 ==========
function checkReportPermission() { return true; }

// 在途非阻断提醒
document.getElementById('addBtn').addEventListener('click', async function() {
    if (!checkReportPermission()) return;
    if (!currentProduct) { showAlert('请先查询商品'); return; }
    if (!getSelectedReporter()) { showAlert('请选择上报人'); return; }
    var qty = parseFloat(document.getElementById('demandQty').value);
    if (!qty || qty <= 0) { showAlert('请输入有效的需求数量'); return; }
    var report = { order_type:'缺货订购', product_code:currentProduct.data.product_code, product_name:currentProduct.data.product_name, specification:currentProduct.data.specification, manufacturer:currentProduct.data.manufacturer, current_stock:currentProduct.data.current_stock, in_transit:currentProduct.data.in_transit, dc_stock:currentProduct.data.dc_stock, standard_stock:currentProduct.data.standard_stock, shortage_quantity:0, demand_quantity:qty, urgency_level:document.getElementById('urgencyLevel').value, remark:document.getElementById('remark').value };
    if (report.in_transit > 0) {
        var warnEl = document.getElementById('transitWarning');
        if (!warnEl) {
            warnEl = document.createElement('div'); warnEl.id = 'transitWarning';
            warnEl.style.cssText = 'margin:8px 0;padding:8px 12px;background:#fff3cd;border:1px solid #ffc107;border-radius:6px;font-size:13px;color:#856404;';
            document.getElementById('addBtn').parentElement.insertBefore(warnEl, document.getElementById('addBtn'));
        }
        warnEl.innerHTML = '⚠ 该商品在途「<b>' + report.in_transit + '</b>」件，是否仍需上报？<br><button id="transitConfirmBtn" style="margin-top:6px;padding:4px 12px;background:#ffc107;border:none;border-radius:4px;cursor:pointer;color:#333;">仍要上报</button> <button id="transitCancelBtn" style="margin-top:6px;padding:4px 12px;background:#ddd;border:none;border-radius:4px;cursor:pointer;">取消</button>';
        warnEl.style.display = 'block';
        pendingReport = report;
        document.getElementById('transitConfirmBtn').onclick = function() { warnEl.style.display = 'none'; submitReport(report); };
        document.getElementById('transitCancelBtn').onclick = function() { warnEl.style.display = 'none'; pendingReport = null; };
        return;
    }
    submitReport(report);
});

document.getElementById('addNewBtn').addEventListener('click', async function() {
    if (!checkReportPermission()) return;
    if (!getSelectedReporter()) { showAlert('请选择上报人'); return; }
    var name = document.getElementById('npName').value.trim(), spec = document.getElementById('npSpec').value.trim();
    var mfg = document.getElementById('npMfg').value.trim(), qty = parseFloat(document.getElementById('npQty').value);
    if (!name) { showAlert('请填写商品名称'); return; }
    if (!spec) { showAlert('请填写规格'); return; }
    if (!mfg) { showAlert('请填写生产企业'); return; }
    if (!qty || qty <= 0) { showAlert('请填写有效的需求数量'); return; }
    submitNewReport({ order_type:'新品订购', product_code:'', new_product_name:name, new_specification:spec, new_manufacturer:mfg, price_min:parseFloat(document.getElementById('priceEstimate').value)||null, price_max:parseFloat(document.getElementById('priceEstimate').value)||null, demand_quantity:qty, remark:document.getElementById('npRemark').value });
});

async function submitReport(report) {
    try {
        var obj = { order_type: report.order_type, store_id: user.store_id, store_name: user.store_name, replenish_status: '待处理' };
        var rpt = getSelectedReporter();
        if (rpt) { obj.reporter_id = rpt.id; obj.reporter_phone = rpt.phone; obj.reporter_name = rpt.name || rpt.phone; }
        else if (user.is_employee) { obj.reporter_id = user.id; obj.reporter_phone = user.employee_phone; obj.reporter_name = user.employee_name || user.employee_phone; }
        Object.assign(obj, report.order_type === '缺货订购' ? { product_code:report.product_code, product_name:report.product_name, specification:report.specification, manufacturer:report.manufacturer, current_stock:report.current_stock, in_transit:report.in_transit, dc_stock:report.dc_stock, standard_stock:report.standard_stock, shortage_quantity:report.shortage_quantity, demand_quantity:report.demand_quantity, urgency_level:report.urgency_level, remark:report.remark } : { product_code:report.product_code, new_product_name:report.new_product_name, new_specification:report.new_specification, new_manufacturer:report.new_manufacturer, price_min:report.price_min, price_max:report.price_max, demand_quantity:report.demand_quantity, remark:report.remark });
        var result = await callEdgeFunction('insert_report', obj);
        if (!result.success) { var e = new Error(result.error || '上报失败'); e._connTimeout = result._connTimeout || false; throw e; }
        showToast('上报成功！', 'success');
        resetForm(); historyLastLoad = 0; loadHistory();
    } catch(err) { logError('上报失败', err); showAlert('上报失败：' + friendlyErrorClient(err.message, err._connTimeout)); }
}
async function submitNewReport(report) { submitReport(report); }

function resetForm() {
    document.getElementById('productCode').value = ''; document.getElementById('demandQty').value = 0;
    document.getElementById('remark').value = ''; document.getElementById('urgencyLevel').value = '普通';
    document.getElementById('productInfo').style.display = 'none';
    var vsb = document.getElementById('viewStockBtn'); if (vsb) vsb.style.display = 'none';
    var tw = document.getElementById('transitWarning'); if (tw) tw.style.display = 'none';
    clearNewProductForm(); currentProduct = null; pendingReport = null;
}
function clearNewProductForm() { ['npName','npSpec','npMfg','priceEstimate','npQty','npRemark'].forEach(function(id) { var el = document.getElementById(id); if (el) el.value = ''; }); }

// ========== 历史记录（30秒缓存）==========
['historyTypeFilter','historyStatusFilter','historyTimeFilter'].forEach(function(id) { document.getElementById(id).addEventListener('change', applyHistoryFilter); });
document.getElementById('loadMoreBtn').addEventListener('click', loadMoreHistory);

async function loadHistory() {
    var now = Date.now();
    if (allHistoryData.length > 0 && (now - historyLastLoad) < HISTORY_CACHE_TTL) { applyHistoryFilter(); return; }
    try {
        var result = await callEdgeFunction('get_my_reports', { store_id: user.store_id });
        if (!result.success) throw new Error(result.error || '加载失败');
        allHistoryData = result.data || []; historyLastLoad = now; applyHistoryFilter();
    } catch(err) { logError('历史记录加载失败', err); }
}

function applyHistoryFilter() {
    var tf = document.getElementById('historyTypeFilter').value, sf = document.getElementById('historyStatusFilter').value, tmf = document.getElementById('historyTimeFilter').value;
    var filtered = allHistoryData.filter(function(r) {
        if (tf && r.order_type !== tf) return false;
        if (sf && r.replenish_status !== sf) return false;
        if (tmf !== 'all') { var days = parseInt(tmf), c = new Date(); c.setDate(c.getDate() - days); if (new Date(r.created_at) < c) return false; }
        return true;
    });
    historyPage = 0; historyTotalLoaded = 0; renderHistoryPage(filtered);
}
function renderHistoryPage(records) { /* 保持原有渲染逻辑（已在原代码中稳定运行）*/ var tbody = document.getElementById('historyTbody'), em = document.getElementById('historyEmpty'), lm = document.getElementById('historyLoadMore'); if (historyPage === 0) tbody.innerHTML = ''; var rh = document.getElementById('reporterHeader'); if (rh) rh.style.display = user.is_employee ? 'none' : ''; if (records.length === 0) { em.style.display = 'block'; lm.style.display = 'none'; return; } em.style.display = 'none'; var s = 0, e = (historyPage+1)*historyPageSize, ts = records.slice(s, e); ts.forEach(function(r) { var tr = document.createElement('tr'); var tb = r.order_type==='缺货订购'?'<span class="type-badge type-shortage">缺货</span>':'<span class="type-badge type-new">新品</span>'; var n = r.product_name||r.new_product_name||r.product_code||'(无名称)'; var ub = getUrgencyBadge(r.urgency_level), rb = getReplenishBadge(r.replenish_status); if (r.replenish_status === '已驳回' && r.approval_reason) { rb = '<span title="驳回原因：' + escapeHtml(r.approval_reason) + '" style="cursor:pointer;border-bottom:1px dashed #c62828;">' + rb + '</span>'; } var fi = escapeHtml((r.product_code||'')+' '+(r.product_name||r.new_product_name||'')+' '+(r.specification||r.new_specification||'')+' '+(r.manufacturer||r.new_manufacturer||'')); var nc = '<span class="history-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;max-width:100%;">'+escapeHtml(n)+'</span>'; var sc = '<span style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;max-width:60px;">'+escapeHtml(r.specification||r.new_specification||'-')+'</span>'; var d = r.created_at?new Date(r.created_at):null, ds = d?d.toLocaleDateString('zh-CN'):'', fts = d?d.toLocaleString('zh-CN'):''; var h = '<td style="font-size:12px;" title="'+escapeHtml(fts)+'">'+safeText(ds)+'</td><td style="text-align:center;">'+tb+'</td><td style="font-size:12px;white-space:nowrap;" title="'+fi+'">'+safeText(r.product_code||'-')+'</td><td style="white-space:nowrap;" title="'+fi+'">'+nc+'</td><td title="'+fi+'">'+sc+'</td><td>'+ub+'</td><td>'+safeText(r.demand_quantity)+'</td><td>'+rb+'</td>'; if (!user.is_employee) h += '<td style="font-size:12px;color:#667eea;">'+safeText(r.reporter_name||'-')+'</td>'; tr.innerHTML = h; tbody.appendChild(tr); }); historyTotalLoaded = e; if (records.length > historyTotalLoaded) { lm.style.display = 'block'; document.getElementById('loadMoreBtn').textContent = '加载更多 ('+(records.length-historyTotalLoaded)+' 条剩余)'; } else { lm.style.display = 'none'; } }

function loadMoreHistory() { var tf = document.getElementById('historyTypeFilter').value, sf = document.getElementById('historyStatusFilter').value, tmf = document.getElementById('historyTimeFilter').value; var filtered = allHistoryData.filter(function(r) { if (tf && r.order_type !== tf) return false; if (sf && r.replenish_status !== sf) return false; if (tmf !== 'all') { var days = parseInt(tmf), c = new Date(); c.setDate(c.getDate() - days); if (new Date(r.created_at) < c) return false; } return true; }); historyPage++; renderHistoryPage(filtered); }

// ========== 到货通知（登录时检查）==========
async function checkArrivalNotifications() {
    try {
        var result = await callEdgeFunction('get_my_reports', { store_id: user.store_id });
        if (!result.success || !result.data) return;
        var arrived = result.data.filter(function(r) { return r.replenish_status === '已到货'; });
        if (arrived.length === 0) return;
        var names = arrived.slice(0, 5).map(function(r) { return r.product_name || r.new_product_name || r.product_code; }).join('、');
        var more = arrived.length > 5 ? ' 等' + arrived.length + '个商品' : '';
        var bar = document.getElementById('versionBar'), msg = document.getElementById('versionMsg');
        if (bar && msg) {
            msg.innerHTML = '📦 您上报的 <b>' + names + '</b>' + more + ' 已到货，请查收！<button onclick="this.parentElement.parentElement.style.display=\'none\'" style="margin-left:12px;padding:2px 10px;background:#fff;color:#4CAF50;border:none;border-radius:4px;cursor:pointer;">知道了</button>';
            bar.style.display = 'block'; bar.style.background = '#4CAF50';
            setTimeout(function() { bar.style.display = 'none'; }, 15000);
        }
    } catch(e) {}
}

// ========== 新品审批通知 ==========
async function checkApprovalNotifications() {
    try {
        var result = await callEdgeFunction('get_approvals', {});
        if (!result.success || !result.data) return;
        var approvals = result.data;
        // 检查是否有本店的审批结果
        var myCode = user.store_id || user.username || '';
        var notified = JSON.parse(localStorage.getItem('approval_notified') || '{}');
        var hasNew = false, msgs = [];
        Object.keys(approvals).forEach(function(code) {
            if (notified[code]) return;
            var a = approvals[code];
            var label = a.status === '已审批' ? '✅ 已审批' : '❌ 已驳回';
            var reason = a.reason ? '（' + a.reason + '）' : '';
            msgs.push(label + ': ' + code + reason);
            notified[code] = true;
            hasNew = true;
        });
        if (!hasNew) return;
        localStorage.setItem('approval_notified', JSON.stringify(notified));
        showToast('📋 新品审批结果：' + msgs.join('；'), 10000);
    } catch(e) {}
}

// ========== 版本检测 ==========
loadHistory();

async function checkVersion() {
    try {
        var resp = await fetch('/api/version'); if (!resp.ok) throw new Error('版本检测失败');
        var data = await resp.json(), cv = localStorage.getItem('appVersion');
        if (cv && cv !== data.version) {
            var vb = document.getElementById('versionBar'), vm = document.getElementById('versionMsg');
            vm.textContent = '检测到新版本 ' + data.version + '，页面将在5秒后自动刷新...';
            vb.style.display = 'block'; localStorage.setItem('appVersion', data.version);
            setTimeout(function() { window.location.reload(); }, 5000);
        } else { localStorage.setItem('appVersion', data.version); }
    } catch(err) { logInfo('版本检测失败（非关键）', err); }
}

if (typeof window.require !== 'undefined' && window.require('electron')) {
    var { ipcRenderer } = window.require('electron');
    ipcRenderer.on('update-available', function(event, data) { showUpdateNotification('发现新版本 ' + data.version + '，正在下载...', 'info'); });
    ipcRenderer.on('update-progress', function(event, data) { var p = document.getElementById('loadingProgress'); if (p) p.textContent = '下载更新: ' + data.percent.toFixed(1) + '%'; });
    ipcRenderer.on('update-downloaded', function(event, data) {
        var vb = document.getElementById('versionBar'), vm = document.getElementById('versionMsg');
        if (vb && vm) { vm.innerHTML = '<div>新版本 ' + data.version + ' 已下载完成</div><div style="margin-top:8px;"><button onclick="installUpdate()" style="padding:8px 16px;background:#4CAF50;color:white;border:none;border-radius:4px;cursor:pointer;">立即更新</button><button onclick="hideUpdateBar()" style="padding:8px 16px;background:#666;color:white;border:none;border-radius:4px;cursor:pointer;margin-left:10px;">稍后</button></div>'; vb.style.display = 'block'; vb.style.background = '#4CAF50'; }
    });
    window.hideUpdateBar = function() { var vb = document.getElementById('versionBar'); if (vb) vb.style.display = 'none'; };
    window.installUpdate = function() { ipcRenderer.invoke('install-update'); };
    window.checkForUpdate = function() { ipcRenderer.invoke('check-update'); showUpdateNotification('正在检查更新...', 'info'); };
}

function showUpdateNotification(message, type) {
    var vb = document.getElementById('versionBar'), vm = document.getElementById('versionMsg');
    if (vb && vm) { vm.textContent = message; vb.style.display = 'block'; vb.style.background = type === 'error' ? '#f44336' : type === 'success' ? '#4CAF50' : '#2196F3'; }
}

if (typeof window !== 'undefined' && window.electron) {
    window.electron.ipcRenderer.on('update-available', function(event, data) { showUpdateNotification('发现新版本 ' + data.version + '，正在下载...', 'info'); });
    window.electron.ipcRenderer.on('update-downloaded', function(event, data) {
        var vb = document.getElementById('versionBar'), vm = document.getElementById('versionMsg');
        if (vb && vm) { vm.innerHTML = '<div>新版本 ' + data.version + ' 已下载完成</div><div style="margin-top:8px;"><button onclick="window.electron.installUpdate()">立即更新</button></div>'; vb.style.display = 'block'; }
    });
}
checkVersion();

// ========== 门店公告栏 ==========
function loadAnnouncement() {
    var el = document.getElementById('storeAnnouncement');
    var text = document.getElementById('announcementText');
    if (!el || !text) return;
    // 尝试从 localStorage 读取公告内容
    try {
        var saved = JSON.parse(localStorage.getItem('storeAnnouncement_v1'));
        if (saved && saved.text && saved.expire > Date.now()) {
            text.textContent = saved.text;
            el.style.display = 'flex';
            return;
        }
    } catch(e) {}
    // 默认公告：显示右上角刷新库存时间
    text.textContent = '欢迎使用药品订购系统！如需查看最新库存数据，请点击右上角「刷新库存」按钮获取实时数据。';
    el.style.display = 'flex';
}
loadAnnouncement();
