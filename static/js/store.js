// ========================================
// 缺货统计系统 - 门店前端 (v26)
// 优化：登录时同步预加载 + 本店库存预加载 + Fuse.js全文搜索
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
var preloadComplete = false;  // 标记预加载是否完成

function updateLoadingProgress(text, percent) {
    if (loadingText) loadingText.textContent = text;
    if (loadingProgress) loadingProgress.textContent = percent;
}

function hideLoadingOverlay() {
    if (loadingOverlay) {
        loadingOverlay.classList.add('hidden');
        setTimeout(function() {
            loadingOverlay.style.display = 'none';
        }, 500);
    }
}

// ========== 本店库存预加载（预加载后选择商品无需网络请求）==========
var storeInventoryMap = {};  // 商品编码 -> 库存数据
var storeInventoryLoaded = false;
var STORE_INVENTORY_CACHE_TTL = 10 * 60 * 1000; // 10分钟缓存有效期

// 预加载本店库存数据
async function preloadStoreInventory(forceRefresh, syncFirst) {
    if (storeInventoryLoaded && !forceRefresh) return true;
    try {
        updateLoadingProgress('正在加载本店库存...', '50%');
        logInfo('[预加载] 正在加载本店库存数据...', null);
        var result = await callEdgeFunction('get_store_inventory', { 
            store_name: user?.store_name || '',
            force_refresh: !!forceRefresh,
            sync_first: !!syncFirst  // 先同步SPFXB_Result再查询，确保数据最新
        });
        if (result.data && Array.isArray(result.data)) {
            // 构建 Map 加速查询
            result.data.forEach(function(item) {
                storeInventoryMap[item.商品编码] = item;
            });
            storeInventoryLoaded = true;
            logInfo('[预加载] 本店库存加载完成，共 ' + result.data.length + ' 条', null);
            
            // 显示上次数据刷新时间
            var timeEl = document.getElementById('lastRefreshTime');
            if (timeEl && result.last_refresh) {
                var d = new Date(result.last_refresh);
                timeEl.textContent = '🕐 ' + d.toLocaleString('zh-CN');
            }
            
            // 保存到 localStorage（按门店名称存储，避免混淆）
            try {
                var storeKey = 'storeInventoryCache_' + (user?.store_name || 'default');
                localStorage.setItem(storeKey, JSON.stringify({
                    data: result.data,
                    time: Date.now(),
                    store_name: user?.store_name || ''
                }));
            } catch(e) {}
        }
        return true;
    } catch(err) {
        logError('[预加载] 本店库存加载失败', err);
        storeInventoryLoaded = true;  // 即使失败也标记为完成，避免无限等待
        return false;
    }
}

// 尝试从 localStorage 恢复本店库存缓存（按门店名称）
function restoreStoreInventoryCache() {
    try {
        // 先尝试找对应门店的缓存
        var storeKey = 'storeInventoryCache_' + (user?.store_name || 'default');
        var saved = JSON.parse(localStorage.getItem(storeKey));
        
        // 检查缓存是否匹配当前门店
        if (saved && saved.data && saved.store_name === user?.store_name) {
            // 缓存10分钟有效
            if ((Date.now() - saved.time) < 600000) {
                saved.data.forEach(function(item) {
                    storeInventoryMap[item.商品编码] = item;
                });
                storeInventoryLoaded = true;
                console.log('[缓存] 从本地恢复本店库存，共 ' + saved.data.length + ' 条');
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

// ========== Fuse.js 全文搜索引擎（v3.12新增）==========
var fuseInstance = null;  // Fuse.js 实例
var searchCache = new Map();  // 搜索结果缓存（5分钟有效）
var SEARCH_CACHE_TTL = 5 * 60 * 1000;  // 缓存5分钟

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
        threshold: 0.3,  // 模糊匹配强度（0=精确，1=任意匹配）
        includeScore: true,
        minMatchCharLength: 2  // 最少2个字符开始匹配
    });
    console.log('[Fuse.js] 搜索索引已初始化，共 ' + allProducts.length + ' 条商品');
}

function getCacheKey(keyword) {
    return 'search_' + keyword.toLowerCase().trim();
}

function searchLocal(keyword) {
    var kw = keyword.toLowerCase().trim();
    if (!kw) return [];
    
    // 检查缓存
    var cacheKey = getCacheKey(kw);
    var cached = searchCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < SEARCH_CACHE_TTL)) {
        return cached.results;
    }
    
    // 使用 Fuse.js 搜索
    var results;
    if (fuseInstance) {
        var fuseResults = fuseInstance.search(kw);
        results = fuseResults.slice(0, 30).map(function(r) { return r.item; });
    } else {
        // 后备：原始循环搜索
        results = searchLocalFallback(kw);
    }
    
    // 存入缓存
    searchCache.set(cacheKey, { results: results, timestamp: Date.now() });
    return results;
}

// ========== 内存搜索函数（性能优化版，后备方案）==========
// product_code 已存储 USERCODE（商品条码），与原业务系统编码一致
// 优化：拼音码改精确匹配（前缀），减少匹配字段数量
function searchLocalFallback(kw) {
    var codeResults = [];
    var pyResults = [];
    var fuzzyResults = [];
    var seen = new Set();
    
    for (var i = 0; i < allProducts.length; i++) {
        var p = allProducts[i];
        var code = p.product_code || '';
        
        if (seen.has(code)) continue;
        
        // 1. 商品编码前缀匹配（最优先）
        if (code && code.toLowerCase().indexOf(kw) === 0) {
            seen.add(code);
            codeResults.push(p);
            continue;
        }
        
        // 2. 拼音码精确匹配
        var py = p.pinyin_code || '';
        if (py && py === kw) {
            seen.add(code);
            pyResults.push(p);
            continue;
        }
        
        // 3. 拼音码前缀匹配
        if (py && py.indexOf(kw) === 0) {
            seen.add(code);
            pyResults.push(p);
            continue;
        }
        
        // 4. 商品名称模糊匹配
        var name = p.product_name || '';
        if (name && name.toLowerCase().indexOf(kw) !== -1) {
            seen.add(code);
            fuzzyResults.push(p);
            continue;
        }
        
        // 5. 规格/厂家匹配
        var spec = p.product_spec || '';
        var mfg = p.manufacturer || '';
        if ((spec && spec.toLowerCase().indexOf(kw) !== -1) || 
            (mfg && mfg.toLowerCase().indexOf(kw) !== -1)) {
            seen.add(code);
            fuzzyResults.push(p);
        }
    }
    
    var allResults = codeResults.concat(pyResults).concat(fuzzyResults);
    return allResults.slice(0, 30);
}

// ========== 历史记录分页相关 ==========
var allHistoryData = [];      // 全量历史数据
var historyPage = 0;           // 当前页
var historyPageSize = 20;      // 每页显示条数
var historyTotalLoaded = 0;     // 已加载条数
var isLoadingMore = false;    // 是否正在加载更多

// ========== Supabase 客户端初始化 ==========
// SUPABASE_URL / SUPABASE_ANON_KEY / EDGE_FUNCTION_URL 已在 utils.js 统一定义
var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ========== 全量商品内存缓存（方案2）==========
var allProducts = [];          // 全量商品数据
var productsLoaded = false;    // 是否已加载完成

async function loadAllProducts() {
    if (productsLoaded) return true;
    try {
        updateLoadingProgress('正在加载商品列表...', '30%');
        logInfo('正在加载全量商品数据...', null);
        // 通过 Edge Function 获取全量商品（避免浏览器 Permissions Policy 限制）
        var result = await callEdgeFunction('get_all_products', {});
        var data = result.data || [];
        
        allProducts = data;
        productsLoaded = true;
        logInfo('全量商品加载完成，共 ' + allProducts.length + ' 条', null);
        
        // 初始化 Fuse.js 搜索引擎（v3.12）
        initFuseSearch();

        // 保存到 localStorage（下次打开直接使用）
        try {
            localStorage.setItem('allProductsCache', JSON.stringify({
                data: allProducts,
                time: Date.now()
            }));
        } catch(e) {}
        
        return true;
    } catch(err) {
        logError('全量商品加载失败，将回退到在线搜索', err);
        productsLoaded = true;  // 即使失败也标记完成
        return false;
    }
}

// 尝试从 localStorage 恢复商品列表缓存（永久有效，商品基本信息基本不变）
function restoreProductCache() {
    try {
        var saved = JSON.parse(localStorage.getItem('allProductsCache'));
        // 商品列表永久缓存，只要存在就使用
        if (saved && saved.data && saved.data.length > 0) {
            allProducts = saved.data;
            productsLoaded = true;
            console.log('[缓存] 从本地恢复商品列表，共 ' + allProducts.length + ' 条');
            return true;
        }
    } catch(e) {}
    return false;
}

// ========== 检查商品列表是否有更新 ==========
async function checkProductsUpdate() {
    if (!productsLoaded || allProducts.length === 0) return false;
    
    try {
        var result = await callEdgeFunction('check_products_update', {});
        if (result.data && result.data.product_count) {
            var currentCount = allProducts.length;
            var serverCount = result.data.product_count;
            
            if (serverCount > currentCount) {
                console.log('[更新检查] 发现新品增加: 本地 ' + currentCount + ' -> 服务器 ' + serverCount);
                // 有新品，询问用户是否更新
                if (confirm('发现商品列表有更新（' + currentCount + ' → ' + serverCount + ' 个），是否刷新商品列表？')) {
                    productsLoaded = false;
                    allProducts = [];
                    localStorage.removeItem('allProductsCache');
                    await loadAllProducts();
                    initFuseSearch();
                    return true;
                }
            } else {
                console.log('[更新检查] 商品列表已是最新，共 ' + currentCount + ' 个');
            }
        }
    } catch(e) {
        console.log('[更新检查] 检查失败，使用本地缓存', e);
    }
    return false;
}

// ========== 主初始化函数：并行预加载商品+库存，减少等待时间 ==========
async function initializeApp() {
    updateLoadingProgress('正在加载数据...', '20%');
    
    // 1~2. 商品加载与库存加载并行执行
    var productTask = (async function() {
        var cacheRestored = restoreProductCache();
        if (cacheRestored) {
            await checkProductsUpdate();
            initFuseSearch();
        }
        if (!productsLoaded) {
            await loadAllProducts();
        }
    })();
    
    // 3~4. 库存加载
    var inventoryTask = (async function() {
        var invCacheRestored = restoreStoreInventoryCache();
        if (invCacheRestored) {
            storeInventoryLoaded = false;  // 强制从服务器覆盖
        }
        if (!storeInventoryLoaded) {
            await preloadStoreInventory();
        }
    })();
    
    // 并行等待两个任务完成
    await Promise.all([productTask, inventoryTask]);
    
    // 5. 预加载完成，显示主界面
    updateLoadingProgress('加载完成！', '100%');
    setTimeout(hideLoadingOverlay, 300);
    preloadComplete = true;
    logInfo('[预加载] 所有数据加载完成，页面已准备好', null);
}

// 启动初始化
initializeApp();

// ========== 页面初始化检查 ==========
if (!token) { window.location.href = './'; }

var themes = ['purple', 'blue', 'green', 'dark', 'orange'];
var themeLabels = { purple: '💜 紫韵', blue: '🌊 海蓝', green: '🌿 翠绿', dark: '🌙 暗夜', orange: '🌅 暖橙' };

var savedTheme = localStorage.getItem('appTheme') || 'purple';
document.documentElement.setAttribute('data-theme', savedTheme);
document.getElementById('storeName').textContent = user.store_name + 
    (user.is_employee ? (' / ' + (user.employee_name || user.employee_phone)) : '');

document.getElementById('themeBtn').addEventListener('click', function() {
    var current = document.documentElement.getAttribute('data-theme') || 'purple';
    var idx = themes.indexOf(current);
    var next = themes[(idx + 1) % themes.length];
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('appTheme', next);
    this.textContent = themeLabels[next];
});
document.getElementById('themeBtn').textContent = themeLabels[savedTheme];

// 刷新库存按钮（含500ms防抖，防止重复点击）
var isRefreshing = false;
document.getElementById('refreshCacheBtn').addEventListener('click', async function() {
    if (isRefreshing) return;
    isRefreshing = true;
    var btn = this;
    var oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '刷新中...';
    
    try {
        // 清除本店库存缓存（强制重新从服务器获取）
        var storeName = user?.store_name || '';
        if (storeName) {
            localStorage.removeItem('storeInventoryCache_' + storeName);
        }
        localStorage.removeItem('storeInventoryCache');
        
        // 重置加载状态，强制重新获取
        storeInventoryLoaded = false;
        storeInventoryMap = {};
        
        // 重新从服务器加载本店库存（强制从 SQL Server 获取最新数据，并先同步SPFXB_Result）
        await preloadStoreInventory(true, true);
        
        // 如果当前有选中商品，重新显示商品详情（强制从 SQL Server 获取）
        if (currentProduct && currentProduct.data && currentProduct.data.product_code && currentProduct.found) {
            queryProductByCode(currentProduct.data.product_code, true);
        }
        
        showToast('库存已刷新', 'success');
    } catch(e) {
        logError('[刷新库存] 刷新失败', e);
        showToast('刷新失败', 'error');
    } finally {
        isRefreshing = false;
        btn.disabled = false;
        btn.textContent = oldText;
    }
});

// ========== 退出登录 ==========
document.getElementById('logoutBtn').addEventListener('click', async function() {
    if (!confirm('确定退出登录？')) return;
    
    // 调用退出登录接口
    try {
        var targetType = user.is_employee ? 'employee' : 'store';
        var targetId = user.is_employee ? user.id : user.username;
        await callEdgeFunction('logout_device', {
            target_type: targetType,
            target_id: targetId,
            device_id: getDeviceId()
        });
    } catch(e) {}
    
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('allProductsCache');
    // 清除本店库存缓存
    var storeName = user?.store_name || '';
    if (storeName) {
        localStorage.removeItem('storeInventoryCache_' + storeName);
    }
    localStorage.removeItem('storeInventoryCache');
    window.location.href = './';
});

// ========== Edge Function 调用（仅用于需要权限的操作，异常统一处理）==========
async function callEdgeFunction(action, params) {
    try {
        var response = await fetch(EDGE_FUNCTION_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ action: action, params: params })
        });
        if (!response.ok) {
            var errBody = '';
            try { errBody = await response.text(); } catch(e) {}
            var errMsg = '请求失败: ' + response.status;
            if (errBody) {
                try {
                    var parsed = JSON.parse(errBody);
                    if (parsed.error) errMsg = parsed.error;
                } catch(e) { errMsg += ' - ' + errBody.substring(0, 200); }
            }
            throw new Error(errMsg);
        }
        return await response.json();
    } catch (err) {
        logError('Edge Function调用失败', err);
        return { success: false, error: err.message };
    }
}

// ========== 同步状态查询（优化3：改查Supabase日志表）==========
async function loadCacheStatus() {
    var bar = document.getElementById('cacheTimeBar');
    var text = document.getElementById('cacheTimeText');
    try {
        // 优先查 Supabase 日志表（快）
        var { data: logData, error: logError } = await supabase
            .from('sync_log_table')
            .select('*')
            .order('sync_time', { ascending: false })
            .limit(1);
        
        if (!logError && logData && logData.length > 0) {
            var latest = logData[0];
            var timeStr = latest.sync_time ? new Date(latest.sync_time).toLocaleString('zh-CN') : '';
            var statusClass = latest.status === 'success' ? 'sync-success' : 'sync-fail';
            var statusText = latest.status === 'success' ? '✅' : '❌';
            text.innerHTML = '库存数据更新时间: ' + safeText(timeStr) + ' ' + statusText;
            text.className = statusClass;
            bar.style.display = 'block';
        } else {
            // 回退到 Edge Function 查 SQL Server（兼容旧数据）
            var data = await callEdgeFunction('get_sync_log', {});
            if (data.success && data.data && data.data.length > 0) {
                var latest = data.data[0][0];
                var timeStr = (latest.同步时间 || '').replace('T', ' ').substring(0, 19);
                var statusClass = latest.状态 === '成功' ? 'sync-success' : 'sync-fail';
                var statusText = latest.状态 === '成功' ? '✅' : '❌';
                text.innerHTML = '库存数据更新时间: ' + safeText(timeStr) + ' ' + statusText;
                text.className = statusClass;
                bar.style.display = 'block';
            } else {
                bar.style.display = 'none';
            }
        }
    } catch(err) {
        logError('同步状态查询失败', err);
        bar.style.display = 'none';
    }
}

// Tab切换
document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        if (btn.dataset.tab === 'shortage') {
            document.getElementById('shortageContent').classList.add('active');
        } else {
            document.getElementById('newProductContent').classList.add('active');
        }
    });
});

// ========== 商品搜索（性能优化版）==========
var productCodeInput = document.getElementById('productCode');
productCodeInput.addEventListener('compositionstart', function() { isComposing = true; });
productCodeInput.addEventListener('compositionend', function(e) {
    isComposing = false;
    var keyword = e.target.value.trim();
    if (keyword.length >= 1) {
        clearTimeout(searchTimeout);
        // 统一150ms防抖（Fuse.js搜索性能足够，无需区分状态）
        searchTimeout = setTimeout(function() { searchProducts(keyword); }, 150);
    }
});
productCodeInput.addEventListener('input', function(e) {
    if (isComposing) return;
    var keyword = e.target.value.trim();
    if (keyword.length >= 1) {
        clearTimeout(searchTimeout);
        // 统一150ms防抖（Fuse.js搜索性能足够）
        searchTimeout = setTimeout(function() { searchProducts(keyword); }, 150);
    } else {
        clearTimeout(searchTimeout);
        document.getElementById('searchResults').style.display = 'none';
        document.getElementById('searchList').innerHTML = '';
        clearProductInfo();
    }
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

    // 内存搜索
    if (productsLoaded && allProducts.length > 0) {
        var localResults = searchLocal(keyword);
        if (localResults.length > 0) {
            renderSearchResults(localResults.map(function(p) {
                return {
                    product_code: p.product_code,
                    product_name: p.product_name,
                    specification: p.product_spec,
                    manufacturer: p.manufacturer
                };
            }));
            return;
        }

        // 内存搜不到 → 走 Edge Function（商品编码/名称模糊匹配）
        try {
            var data = await callEdgeFunction('search_product', { keyword: keyword });
            if (data.success && data.data && data.data.length > 0) {
                renderSearchResults(data.data.map(function(p) {
                    return {
                        product_code: p.product_code,
                        product_name: p.product_name,
                        specification: p.product_spec,
                        manufacturer: p.manufacturer
                    };
                }));
                return;
            }
        } catch(e) { logError('Edge Function 搜索失败', e); }

        searchList.innerHTML = '<div class="search-empty">未找到匹配商品</div>';
        document.getElementById('searchResults').style.display = 'block';
        return;
    }

    // 回退：全量未加载完时走 Edge Function（兼容首次访问）
    try {
        var data = await callEdgeFunction('search_product', { keyword: keyword });
        if (data.success && data.data && data.data.length > 0) {
            var products = data.data.map(function(p) {
                return {
                    product_code: p.product_code,
                    product_name: p.product_name,
                    specification: p.product_spec,
                    manufacturer: p.manufacturer
                };
            });
            renderSearchResults(products);
        } else {
            searchList.innerHTML = '<div class="search-empty">未找到匹配商品</div>';
            document.getElementById('searchResults').style.display = 'block';
        }
    } catch (err) {
        logError('搜索失败', err);
        searchList.innerHTML = '<div class="search-error">搜索失败，请稍后重试</div>';
        document.getElementById('searchResults').style.display = 'block';
    }
}

// ========== 搜索结果分页相关 ==========
var searchResultsAll = [];     // 全量搜索结果
var searchPage = 0;            // 当前搜索页
var searchPageSize = 20;      // 每页显示条数

function renderSearchResults(products) {
    searchResultsAll = products;
    searchPage = 0;
    
    var searchList = document.getElementById('searchList');
    searchList.innerHTML = '';
    
    // 显示第一页
    var toShow = products.slice(0, searchPageSize);
    toShow.forEach(function(p) {
        appendSearchItem(searchList, p);
    });
    
    // 显示加载更多按钮
    var loadMoreContainer = document.getElementById('searchLoadMore');
    if (!loadMoreContainer) {
        loadMoreContainer = document.createElement('div');
        loadMoreContainer.id = 'searchLoadMore';
        loadMoreContainer.className = 'load-more-container';
        loadMoreContainer.style.display = 'none';
        var loadMoreBtn = document.createElement('button');
        loadMoreBtn.id = 'searchLoadMoreBtn';
        loadMoreBtn.className = 'btn-search btn-load-more';
        loadMoreBtn.textContent = '加载更多';
        loadMoreBtn.addEventListener('click', loadMoreSearchResults);
        loadMoreContainer.appendChild(loadMoreBtn);
        searchList.parentElement.appendChild(loadMoreContainer);
    }
    
    if (products.length > searchPageSize) {
        loadMoreContainer.style.display = 'block';
        loadMoreContainer.querySelector('button').textContent = '加载更多 (' + products.length + ' 条结果)';
    } else {
        loadMoreContainer.style.display = 'none';
    }
    
    document.getElementById('searchResults').style.display = 'block';
}

function appendSearchItem(container, p) {
    var div = document.createElement('div');
    div.className = 'search-item';
    div.innerHTML = '<span class="code">' + safeText(p.product_code || '') + '</span>' +
        '<div class="product-info">' +
        '<span class="product-name">' + safeText(p.product_name || '') + '</span>' +
        '<span class="spec" style="color:#888;font-size:12px;">' + safeText(p.specification || '') + '</span>' +
        '<span class="mfg" style="color:#aaa;font-size:11px;">' + safeText(p.manufacturer || '') + '</span>' +
        '</div>';
    div.addEventListener('click', function() { selectProduct(p); });
    container.appendChild(div);
}

function loadMoreSearchResults() {
    searchPage++;
    var start = searchPage * searchPageSize;
    var end = start + searchPageSize;
    var toShow = searchResultsAll.slice(start, end);
    
    var searchList = document.getElementById('searchList');
    toShow.forEach(function(p) {
        appendSearchItem(searchList, p);
    });
    
    var loadMoreBtn = document.getElementById('searchLoadMoreBtn');
    var remaining = searchResultsAll.length - end;
    if (remaining <= 0) {
        document.getElementById('searchLoadMore').style.display = 'none';
    } else {
        loadMoreBtn.textContent = '加载更多 (' + remaining + ' 条剩余)';
    }
}

async function selectProduct(product) {
    document.getElementById('productCode').value = product.product_code;
    document.getElementById('searchResults').style.display = 'none';
    
    // 优化：先用搜索结果中的基本信息快速显示，再异步加载详细数据
    // 这样用户会感觉"秒响应"
    showQuickProduct(product);
    
    // 后台异步加载详细数据（库存、各店库存等）
    queryProductByCode(product.product_code);
}

// 快速显示搜索结果中的基本信息（无需等待后端）
function showQuickProduct(product) {
    var demandQtyEl = document.getElementById('demandQty');
    if (demandQtyEl) {
        demandQtyEl.value = 0;  // 默认0
        demandQtyEl.placeholder = '数量';
    }
    
    // 快速填充基本信息（来自搜索结果，无需网络请求）
    document.getElementById('pName').textContent = product.product_name || '';
    document.getElementById('pSpec').textContent = product.specification || '';
    document.getElementById('pMfg').textContent = product.manufacturer || '';
    
    // 显示加载中的库存数据
    document.getElementById('pStock').textContent = '...';
    document.getElementById('pTransit').textContent = '...';
    document.getElementById('pDcStock').textContent = '...';
    document.getElementById('pSales30').textContent = '...';
    document.getElementById('pStdStock').textContent = '...';
    
    document.getElementById('productInfo').style.display = 'block';
    
    // 标记为新品（如果搜索结果没有此商品详情）
    var newLabel = document.getElementById('newLabel');
    if (newLabel) newLabel.style.display = 'none';
}

// ========== 商品详情查询（仍需Edge Function查SQL Server实时数据）==========
function clearProductInfo() {
    var fields = ['pName', 'pSpec', 'pMfg', 'pStock', 'pTransit', 'pDcStock', 'pSales30', 'pStdStock'];
    fields.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) {
            el.textContent = '';
            el.classList.remove('stock-warning');
        }
    });
    var newLabelEl = document.getElementById('newLabel');
    if (newLabelEl) newLabelEl.style.display = 'none';
    var viewStockBtn = document.getElementById('viewStockBtn');
    if (viewStockBtn) viewStockBtn.style.display = 'none';
    currentProduct = null;
}

document.getElementById('cancelProductBtn').addEventListener('click', function() {
     document.getElementById('productCode').value = '';
     document.getElementById('demandQty').value = 0;
     document.getElementById('remark').value = '';
     document.getElementById('urgencyLevel').value = '普通';
     document.getElementById('searchResults').style.display = 'none';
     document.getElementById('productInfo').style.display = 'none';
     clearProductInfo();
});

async function queryProductByCode(code, forceRefresh) {
    // 强制刷新时跳过内存缓存
    if (!forceRefresh) {
        // 优先从预加载的内存数据中读取（秒响应）
        var inventoryData = storeInventoryMap[code];
        if (inventoryData) {
            console.log('[预加载] 从内存读取商品详情: ' + code);
            // 从商品列表缓存补充商品名称/规格/厂家（库存缓存可能没有这些字段）
            var productInfo = allProducts.find(function(p) { return p.product_code === code; }) || {};
            currentProduct = {
                found: true,
                is_new: false,
                data: {
                    product_code: code,
                    product_name: productInfo.product_name || inventoryData.商品名称 || '',
                    specification: productInfo.product_spec || inventoryData.规格 || '',
                    manufacturer: productInfo.manufacturer || inventoryData.生产企业 || '',
                    current_stock: inventoryData.库存数量 || 0,
                    in_transit: inventoryData.在途数量 || 0,
                    dc_stock: inventoryData.配送中心库存数量 || 0,
                    standard_stock: inventoryData.标准库存数量 || 0,
                    sales_30days: inventoryData.前30天销售数量 || 0,
                    suggested_order: inventoryData.建议订货数量 || 0,
                    all_stores: {}
                }
            };
            renderProductInfo(currentProduct.data);
            return;
        }
        
        // 内存中没有数据，检查预加载是否还在进行中
        if (!storeInventoryLoaded) {
            console.log('[预加载] 等待预加载完成...');
            // 等待预加载完成（最多等10秒）
            var waitCount = 0;
            while (!storeInventoryLoaded && waitCount < 100) {
                await new Promise(function(r) { setTimeout(r, 100); });
                waitCount++;
            }
            
            // 预加载完成后，再次检查内存
            inventoryData = storeInventoryMap[code];
            if (inventoryData) {
                console.log('[预加载] 预加载完成后从内存读取: ' + code);
                var productInfo2 = allProducts.find(function(p) { return p.product_code === code; }) || {};
                currentProduct = {
                    found: true,
                    is_new: false,
                    data: {
                        product_code: code,
                        product_name: productInfo2.product_name || inventoryData.商品名称 || '',
                        specification: productInfo2.product_spec || inventoryData.规格 || '',
                        manufacturer: productInfo2.manufacturer || inventoryData.生产企业 || '',
                        current_stock: inventoryData.库存数量 || 0,
                        in_transit: inventoryData.在途数量 || 0,
                        dc_stock: inventoryData.配送中心库存数量 || 0,
                        standard_stock: inventoryData.标准库存数量 || 0,
                        sales_30days: inventoryData.前30天销售数量 || 0,
                        suggested_order: inventoryData.建议订货数量 || 0,
                        all_stores: {}
                    }
                };
                renderProductInfo(currentProduct.data);
                return;
            }
            
            console.log('[预加载] 预加载完成但仍未找到商品: ' + code);
        }
    }
    
    // 预加载已完成但仍未命中，或强制刷新，调用后端API
    console.log('[预加载] 调用后端API查询' + (forceRefresh ? '(强制刷新)' : '') + ': ' + code);
    try {
        var data = await callEdgeFunction('get_product_detail', { 
            product_code: code,
            store_name: user?.store_name || '',
            force_refresh: !!forceRefresh
        });
        if (data.success && data.data && data.data.length > 0) {
            var records = data.data[0];
            if (records.length > 0) {
                var myRecord = records[0];
                
                // 构建各门店库存数据（用于弹窗显示）
                var allStores = {};
                records.forEach(function(r) {
                    var storeName = r.门店名称 || '未知门店';
                    allStores[storeName] = {
                        name: storeName,
                        stock: r.库存数量 || 0,
                        transit: r.在途数量 || 0,
                        standard_stock: r.标准库存数量 || 0  // 用于计算可调拨
                    };
                });
                
                currentProduct = {
                    found: true,
                    is_new: false,
                    data: {
                        product_code: myRecord.商品编码,
                        product_name: myRecord.商品名称,
                        specification: myRecord.规格,
                        manufacturer: myRecord.生产企业,
                        current_stock: myRecord.库存数量 || 0,
                        in_transit: myRecord.在途数量 || 0,
                        dc_stock: myRecord.配送中心库存数量 || 0,
                        standard_stock: myRecord.标准库存数量 || 0,
                        sales_30days: myRecord.前30天销售数量 || 0,
                        suggested_order: myRecord.建议订货数量 || 0,
                        all_stores: allStores
                    }
                };
                
                // 存入内存Map，下次直接命中
                storeInventoryMap[code] = myRecord;
                
                renderProductInfo(currentProduct.data);
            } else {
                showAlert('商品未找到');
                document.getElementById('productInfo').style.display = 'none';
                currentProduct = null;
            }
        } else {
            showAlert('商品未找到');
            document.getElementById('productInfo').style.display = 'none';
            currentProduct = null;
        }
    } catch (err) {
        logError('商品详情查询失败', err);
        showAlert('查询失败：' + err.message);
    }
}

function renderProductInfo(data) {
    var map = { pName:'product_name', pSpec:'specification', pMfg:'manufacturer',
               pStock:'current_stock', pTransit:'in_transit', pDcStock:'dc_stock' };
    for (var id in map) {
        var el = document.getElementById(id);
        if (el) {
            var val = data[map[id]];
            el.textContent = (val !== undefined && val !== null) ? val : '';
            if (el.textContent === '') el.classList.remove('stock-warning');
        }
    }
    
    // 前30天销量和标准库存（显示0而不是空白）
    var pSales30El = document.getElementById('pSales30');
    if (pSales30El) {
        pSales30El.textContent = (data.sales_30days !== undefined && data.sales_30days !== null) ? data.sales_30days : '0';
    }
    var pStdStockEl = document.getElementById('pStdStock');
    if (pStdStockEl) {
        pStdStockEl.textContent = (data.standard_stock !== undefined && data.standard_stock !== null) ? data.standard_stock : '0';
    }

    var pStockEl = document.getElementById('pStock');
    if (pStockEl && data.standard_stock > 0 && (data.current_stock||0) < data.standard_stock) {
        pStockEl.classList.add('stock-warning');
    }
    var pDcStockEl = document.getElementById('pDcStock');
    if (pDcStockEl && data.standard_stock > 0 && (data.dc_stock||0) < data.standard_stock) {
        pDcStockEl.classList.add('stock-warning');
    }

    // 需求数量默认0，用户手动输入
    var demandQtyEl = document.getElementById('demandQty');
    if (demandQtyEl) {
        demandQtyEl.value = 0;  // 默认0
        if (data.suggested_order && data.suggested_order > 0) {
            demandQtyEl.placeholder = '建议 ' + data.suggested_order;
        } else {
            demandQtyEl.placeholder = '数量';
        }
    }

    document.getElementById('productInfo').style.display = 'block';
    var newLabelEl = document.getElementById('newLabel');
    if (newLabelEl) newLabelEl.style.display = 'none';
    var viewStockBtn = document.getElementById('viewStockBtn');
    if (viewStockBtn) viewStockBtn.style.display = 'inline-block';
}

// 各店库存弹窗
document.getElementById('viewStockBtn').addEventListener('click', async function() {
    if (!currentProduct || !currentProduct.data) return;
    
    // 如果 all_stores 为空（内存命中时未获取各门店数据），先调用 API 获取
    var hasStores = false;
    for (var k in currentProduct.data.all_stores) { hasStores = true; break; }
    
    if (!hasStores && currentProduct.data.product_code) {
        try {
            var data = await callEdgeFunction('get_product_detail', {
                product_code: currentProduct.data.product_code,
                store_name: user?.store_name || ''
            });
            if (data.success && data.data && data.data.length > 0) {
                var records = data.data[0];
                var allStores = {};
                records.forEach(function(r) {
                    var storeName = r.门店名称 || '未知门店';
                    allStores[storeName] = {
                        name: storeName,
                        stock: r.库存数量 || 0,
                        transit: r.在途数量 || 0,
                        standard_stock: r.标准库存数量 || 0  // 用于计算可调拨
                    };
                });
                currentProduct.data.all_stores = allStores;
            }
        } catch(e) {
            console.error('[各门店库存] 获取失败:', e);
        }
    }
    
    renderStockModal(currentProduct.data);
});
document.getElementById('stockModalClose').addEventListener('click', function() {
    document.getElementById('stockModal').classList.remove('show');
});
document.getElementById('stockModal').addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('show');
});

function renderStockModal(productData) {
    var stockTbody = document.getElementById('stockTbody');
    if (!stockTbody) return;
    stockTbody.innerHTML = '';
    
    var currentStoreName = user?.store_name || '';
    
    var stores = [];
    for (var id in productData.all_stores) {
        var s = productData.all_stores[id];
        // 排除本店（无需显示自己的库存）
        if (s.name === currentStoreName) continue;
        stores.push(s);
    }
    stores.sort(function(a, b) { return a.name.localeCompare(b.name, 'zh-CN'); });
    
    if (stores.length === 0) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="3" style="text-align:center;color:#999;">暂无其他门店库存数据</td>';
        stockTbody.appendChild(tr);
    } else {
        stores.forEach(function(s) {
            var stock = Number(s.stock) || 0;
            var standardStock = Number(s.standard_stock) || 0;
            // 可调拨数量 = 库存 - 标准库存，只取正数（优先满足本店标准需求）
            var transferable = Math.max(0, stock - standardStock);
            
            var tr = document.createElement('tr');
            // 可调拨>0 红色高亮
            var transferStyle = transferable > 0 ? 'color:#e74c3c;font-weight:bold;' : '';
            tr.innerHTML = '<td>' + safeText(s.name) + '</td>' +
                '<td>' + safeText(stock) + '</td>' +
                '<td style="' + transferStyle + '">' + safeText(transferable) + '</td>';
            stockTbody.appendChild(tr);
        });
    }
    document.getElementById('stockModal').classList.add('show');
}

// ========== 上报逻辑（员工/主账号区分）==========

// 员工权限检查：只有员工账号能上报
function checkReportPermission() {
    // 主账号也可以上报，但标记为"管理员代报"
    // 如果将来要限制只有员工可报，取消下面注释：
    /*
    if (!user.is_employee) {
        showAlert('此功能仅供门店员工使用，请联系员工进行上报');
        return false;
    }
    */
    return true;
}

// 缺货订购上报
document.getElementById('addBtn').addEventListener('click', async function() {
    if (!checkReportPermission()) return;
    if (!currentProduct) { showAlert('请先查询商品'); return; }
    var qty = parseFloat(document.getElementById('demandQty').value);
    if (!qty || qty <= 0) { showAlert('请输入有效的需求数量'); return; }
    var urgencyLevel = document.getElementById('urgencyLevel').value;
    var report = {
        order_type: '缺货订购',
        product_code: currentProduct.data.product_code,
        product_name: currentProduct.data.product_name,
        specification: currentProduct.data.specification,
        manufacturer: currentProduct.data.manufacturer,
        current_stock: currentProduct.data.current_stock,
        in_transit: currentProduct.data.in_transit,
        dc_stock: currentProduct.data.dc_stock,
        standard_stock: currentProduct.data.standard_stock,
        shortage_quantity: 0,
        demand_quantity: qty,
        urgency_level: urgencyLevel,
        remark: document.getElementById('remark').value
    };

    // 在途品种提示
    if (report.in_transit > 0) {
        pendingReport = report;
        showConfirm(
            '该商品当前有在途数量「' + report.in_transit + '」，是否继续上报？',
            function() { submitReport(report); },
            function() { pendingReport = null; }
        );
        return;
    }
    submitReport(report);
});

// 新品订购上报
document.getElementById('addNewBtn').addEventListener('click', async function() {
    if (!checkReportPermission()) return;
    var name = document.getElementById('npName').value.trim();
    var spec = document.getElementById('npSpec').value.trim();
    var mfg = document.getElementById('npMfg').value.trim();
    var qty = parseFloat(document.getElementById('npQty').value);
    if (!name) { showAlert('请填写商品名称'); return; }
    if (!spec) { showAlert('请填写规格'); return; }
    if (!mfg) { showAlert('请填写生产企业'); return; }
    if (!qty || qty <= 0) { showAlert('请填写有效的需求数量'); return; }

    var report = {
        order_type: '新品订购',
        product_code: '',
        new_product_name: name,
        new_specification: spec,
        new_manufacturer: mfg,
        price_min: parseFloat(document.getElementById('priceEstimate').value) || null,
        price_max: parseFloat(document.getElementById('priceEstimate').value) || null,
        demand_quantity: qty,
        remark: document.getElementById('npRemark').value
    };
    submitNewReport(report);
});

// 统一提交上报（带上报人信息）
async function submitReport(report) {
    try {
        var insertObj = {
            order_type: report.order_type,
            store_id: user.store_id,
            store_name: user.store_name,
            replenish_status: '待处理'
        };

        // 上报人信息（员工登录时有，主账号为空）
        if (user.is_employee) {
            insertObj.reporter_id = user.id;
            insertObj.reporter_phone = user.employee_phone;
            insertObj.reporter_name = user.employee_name || user.employee_phone;
        }

        if (report.order_type === '缺货订购') {
            Object.assign(insertObj, {
                product_code: report.product_code,
                product_name: report.product_name,
                specification: report.specification,
                manufacturer: report.manufacturer,
                current_stock: report.current_stock,
                in_transit: report.in_transit,
                dc_stock: report.dc_stock,
                standard_stock: report.standard_stock,
                shortage_quantity: report.shortage_quantity,
                demand_quantity: report.demand_quantity,
                urgency_level: report.urgency_level,
                remark: report.remark
            });
        } else {
            Object.assign(insertObj, {
                product_code: report.product_code,
                new_product_name: report.new_product_name,
                new_specification: report.new_specification,
                new_manufacturer: report.new_manufacturer,
                price_min: report.price_min,
                price_max: report.price_max,
                demand_quantity: report.demand_quantity,
                remark: report.remark
            });
        }

        // 通过 Edge Function 上报（避免浏览器 Permissions Policy 限制）
        var result = await callEdgeFunction('insert_report', insertObj);
        if (!result.success) throw new Error(result.error || '上报失败');

        showAlert('上报成功！');
        resetForm();
        loadHistory();
    } catch (err) {
        logError('上报失败', err);
        showAlert('上报失败：' + err.message);
    }
}

async function submitNewReport(report) {
    submitReport(report);
}

function resetForm() {
    document.getElementById('productCode').value = '';
    document.getElementById('demandQty').value = 0;
    document.getElementById('remark').value = '';
    document.getElementById('urgencyLevel').value = '普通';
    document.getElementById('productInfo').style.display = 'none';
    var viewStockBtn = document.getElementById('viewStockBtn');
    if (viewStockBtn) viewStockBtn.style.display = 'none';
    clearNewProductForm();
    currentProduct = null;
    pendingReport = null;
}

function clearNewProductForm() {
    ['npName', 'npSpec', 'npMfg', 'priceEstimate', 'npQty', 'npRemark'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
}

// ========== 历史记录（带筛选和分页）==========
var historyFilterTimeout = null;

// 筛选器事件绑定
document.getElementById('historyTypeFilter').addEventListener('change', function() {
    applyHistoryFilter();
});
document.getElementById('historyStatusFilter').addEventListener('change', function() {
    applyHistoryFilter();
});
document.getElementById('historyTimeFilter').addEventListener('change', function() {
    applyHistoryFilter();
});

// 加载更多按钮
document.getElementById('loadMoreBtn').addEventListener('click', loadMoreHistory);

// 加载全部历史数据并筛选
async function loadHistory() {
    try {
        // 通过 Edge Function 获取历史记录（避免浏览器 Permissions Policy 限制）
        var result = await callEdgeFunction('get_my_reports', { store_id: user.store_id });
        
        if (!result.success) throw new Error(result.error || '加载失败');

        allHistoryData = result.data || [];
        applyHistoryFilter();
    } catch (err) {
        logError('历史记录加载失败', err);
    }
}

// 应用筛选
function applyHistoryFilter() {
    var typeFilter = document.getElementById('historyTypeFilter').value;
    var statusFilter = document.getElementById('historyStatusFilter').value;
    var timeFilter = document.getElementById('historyTimeFilter').value;
    
    // 筛选数据
    var filtered = allHistoryData.filter(function(r) {
        // 类型筛选
        if (typeFilter && r.order_type !== typeFilter) return false;
        // 状态筛选
        if (statusFilter && r.replenish_status !== statusFilter) return false;
        // 时间筛选
        if (timeFilter !== 'all') {
            var days = parseInt(timeFilter);
            var cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - days);
            if (new Date(r.created_at) < cutoff) return false;
        }
        return true;
    });
    
    // 重置分页并渲染
    historyPage = 0;
    historyTotalLoaded = 0;
    renderHistoryPage(filtered);
}

// 渲染一页历史记录
function renderHistoryPage(records) {
    var tbody = document.getElementById('historyTbody');
    var emptyMsg = document.getElementById('historyEmpty');
    var loadMoreContainer = document.getElementById('historyLoadMore');
    
    if (historyPage === 0) {
        tbody.innerHTML = '';
    }
    
    // 控制上报人列显示/隐藏（员工隐藏，主账号显示）
    var reporterHeader = document.getElementById('reporterHeader');
    if (reporterHeader) {
        reporterHeader.style.display = user.is_employee ? 'none' : '';
    }
    
    if (records.length === 0) {
        emptyMsg.style.display = 'block';
        loadMoreContainer.style.display = 'none';
        return;
    }
    
    emptyMsg.style.display = 'none';
    
    // 分页渲染
    var start = 0;
    var end = (historyPage + 1) * historyPageSize;
    var toShow = records.slice(start, end);
    
    toShow.forEach(function(r) {
        var tr = document.createElement('tr');
        var typeBadge = r.order_type === '缺货订购'
            ? '<span class="type-badge type-shortage">缺货</span>'
            : '<span class="type-badge type-new">新品</span>';
        var name = r.order_type === '缺货订购' ? r.product_name : r.new_product_name;
        var urgencyBadge = getUrgencyBadge(r.urgency_level);
        var replenishBadge = getReplenishBadge(r.replenish_status);
        var nameCell = '<span class="history-name" title="' + 
            escapeHtml((r.product_code||'') + ' ' + (r.product_name||r.new_product_name||'') + ' ' + 
            (r.specification||r.new_specification||'') + ' ' + (r.manufacturer||r.new_manufacturer||'')) + '">' + 
            escapeHtml(name) + '</span>';
        var createdAt = r.created_at ? new Date(r.created_at).toLocaleString('zh-CN') : '';

        var html = '<td>' + safeText(createdAt) + '</td><td>' + typeBadge + '</td><td>' + 
                   nameCell + '</td><td>' + urgencyBadge + '</td><td>' + 
                   safeText(r.demand_quantity) + '</td><td>' + replenishBadge + '</td>';

        // 主账号可见上报人列
        if (!user.is_employee) {
            html += '<td style="font-size:12px;color:#667eea;">' + safeText(r.reporter_name || '-') + '</td>';
        }

        tr.innerHTML = html;
        tbody.appendChild(tr);
    });
    
    historyTotalLoaded = end;
    
    // 显示加载更多按钮
    if (records.length > historyTotalLoaded) {
        loadMoreContainer.style.display = 'block';
        var loadMoreBtn = document.getElementById('loadMoreBtn');
        loadMoreBtn.textContent = '加载更多 (' + (records.length - historyTotalLoaded) + ' 条剩余)';
    } else {
        loadMoreContainer.style.display = 'none';
    }
}

// 加载更多历史记录
function loadMoreHistory() {
    var typeFilter = document.getElementById('historyTypeFilter').value;
    var statusFilter = document.getElementById('historyStatusFilter').value;
    var timeFilter = document.getElementById('historyTimeFilter').value;
    
    var filtered = allHistoryData.filter(function(r) {
        if (typeFilter && r.order_type !== typeFilter) return false;
        if (statusFilter && r.replenish_status !== statusFilter) return false;
        if (timeFilter !== 'all') {
            var days = parseInt(timeFilter);
            var cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - days);
            if (new Date(r.created_at) < cutoff) return false;
        }
        return true;
    });
    
    historyPage++;
    renderHistoryPage(filtered);
}
function getUrgencyBadge(level) {
    var cls = 'urgency-badge ';
    if (level === '紧急') cls += 'urgency-urgent';
    else if (level === '加急') cls += 'urgency-expedite';
    else cls += 'urgency-normal';
    return '<span class="' + cls + '">' + (level || '普通') + '</span>';
}

function getReplenishBadge(status) {
    var cls = 'replenish-badge ';
    var label = status || '待处理';
    if (label === '已订购') cls += 'replenish-ordered';
    else if (label === '已到货') cls += 'replenish-arrived';
    else if (label === '待处理') cls += 'replenish-pending';
    else cls += 'replenish-text';
    return '<span class="' + cls + '">' + label + '</span>';
}

// ========== 弹窗组件 ==========
function showAlert(msg) {
    document.getElementById('alertMsg').textContent = msg;
    document.getElementById('alertModal').classList.add('show');
}
document.getElementById('alertOkBtn').addEventListener('click', function() {
    document.getElementById('alertModal').classList.remove('show');
});

function showConfirm(msg, onYes, onNo) {
    document.getElementById('confirmMsg').textContent = msg;
    document.getElementById('confirmModal').classList.add('show');
    document.getElementById('confirmYesBtn').onclick = function() {
        document.getElementById('confirmModal').classList.remove('show');
        if (onYes) onYes();
    };
    document.getElementById('confirmNoBtn').onclick = function() {
        document.getElementById('confirmModal').classList.remove('show');
        if (onNo) onNo();
    };
}

// ========== 版本检测 ==========
loadHistory();

async function checkVersion() {
    try {
        var resp = await fetch('/api/version');
        if (!resp.ok) {
            throw new Error('版本检测请求失败');
        }
        var data = await resp.json();
        var currentVersion = localStorage.getItem('appVersion');
        if (currentVersion && currentVersion !== data.version) {
            var versionBar = document.getElementById('versionBar');
            var versionMsg = document.getElementById('versionMsg');
            versionMsg.textContent = '检测到新版本 ' + data.version + '，页面将在5秒后自动刷新...';
            versionBar.style.display = 'block';
            localStorage.setItem('appVersion', data.version);
            setTimeout(function() { window.location.reload(); }, 5000);
        } else {
            localStorage.setItem('appVersion', data.version);
        }
    } catch (err) {
        logInfo('版本检测失败（非关键）', err);
    }
}
// ========== Electron 自动更新检测 ==========
// 仅在 Electron 环境中运行
if (typeof window.require !== 'undefined' && window.require('electron')) {
    const { ipcRenderer } = window.require('electron');
    
    // 显示更新进度
    ipcRenderer.on('update-available', (event, data) => {
        showUpdateNotification(`发现新版本 ${data.version}，正在下载...`, 'info');
    });
    
    ipcRenderer.on('update-progress', (event, data) => {
        var progress = document.getElementById('loadingProgress');
        if (progress) {
            progress.textContent = `下载更新: ${data.percent.toFixed(1)}%`;
        }
    });
    
    ipcRenderer.on('update-downloaded', (event, data) => {
        var versionBar = document.getElementById('versionBar');
        var versionMsg = document.getElementById('versionMsg');
        if (versionBar && versionMsg) {
            versionMsg.innerHTML = `
                <div>新版本 ${data.version} 已下载完成</div>
                <div style="margin-top: 8px;">
                    <button onclick="installUpdate()" style="padding: 8px 16px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer;">
                        立即更新
                    </button>
                    <button onclick="hideUpdateBar()" style="padding: 8px 16px; background: #666; color: white; border: none; border-radius: 4px; cursor: pointer; margin-left: 10px;">
                        稍后
                    </button>
                </div>
            `;
            versionBar.style.display = 'block';
            versionBar.style.background = '#4CAF50';
        }
    });
    
    // 隐藏更新提示栏
    window.hideUpdateBar = function() {
        var versionBar = document.getElementById('versionBar');
        if (versionBar) {
            versionBar.style.display = 'none';
        }
    };
    
    // 安装更新
    window.installUpdate = function() {
        ipcRenderer.invoke('install-update');
    };
    
    // 手动检查更新
    window.checkForUpdate = function() {
        ipcRenderer.invoke('check-update');
        showUpdateNotification('正在检查更新...', 'info');
    };
}

// 显示更新通知
function showUpdateNotification(message, type) {
    var versionBar = document.getElementById('versionBar');
    var versionMsg = document.getElementById('versionMsg');
    if (versionBar && versionMsg) {
        versionMsg.textContent = message;
        versionBar.style.display = 'block';
        if (type === 'error') {
            versionBar.style.background = '#f44336';
        } else if (type === 'success') {
            versionBar.style.background = '#4CAF50';
        } else {
            versionBar.style.background = '#2196F3';
        }
    }
}

// ========== Electron 自动更新检测 ==========
// 仅在 Electron 环境中运行
if (typeof window !== 'undefined' && window.electron) {
    window.electron.ipcRenderer.on('update-available', (event, data) => {
        showUpdateNotification(`发现新版本 ${data.version}，正在下载...`, 'info');
    });
    
    window.electron.ipcRenderer.on('update-downloaded', (event, data) => {
        var versionBar = document.getElementById('versionBar');
        var versionMsg = document.getElementById('versionMsg');
        if (versionBar && versionMsg) {
            versionMsg.innerHTML = `
                <div>新版本 ${data.version} 已下载完成</div>
                <div style="margin-top: 8px;">
                    <button onclick="window.electron.installUpdate()">立即更新</button>
                </div>
            `;
            versionBar.style.display = 'block';
        }
    });
}

checkVersion();
