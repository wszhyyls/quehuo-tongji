# 药店缺货管理系统 - SQL Server 到 Supabase 同步脚本
# 运行环境：Python 3.8+
# 依赖：pip install pyodbc sqlalchemy supabase
# 
# v3.13 优化：
# - 支持增量同步（基于时间戳）
# - 提高同步频率（每15分钟执行一次）
# - 支持全量同步和增量同步模式

import pyodbc
from supabase import create_client, Client
import json
from datetime import datetime, timedelta
import sys
import argparse
import uuid

# ============================================
# 配置区域 - 请根据实际情况修改
# ============================================

# SQL Server 连接配置
SQL_SERVER = {
    'server': '121.229.175.49,1290',
    'database': 'RQZT',  # 账套名
    'username': 'zhyy02',
    'password': '123456zX'
}

# Supabase 配置（从 Supabase Dashboard 获取）
SUPABASE_URL = 'https://qswpgnnedqvuegwfbprd.supabase.co'
SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODcyNzQ2MSwiZXhwIjoyMDk0MzAzNDYxfQ.gkgIKEqBXtUMz9op1Q9nUnvIZVA4KOsdycQoAAigE4U'

# 同步配置
SYNC_MODE = 'incremental'  # 'full'=全量同步, 'incremental'=增量同步
SYNC_INTERVAL_MINUTES = 15  # 建议15分钟执行一次（可根据需要调整为5-30分钟）

# 同步开关
SYNC_PRODUCTS = True      # 同步商品基础数据
SYNC_STORE_STOCK = True   # 同步门店库存（P0优化重点）
SYNC_PURCHASE_PLAN = True # 同步采购计划

# ============================================

def test_sqlserver_connection():
    """测试 SQL Server 连接"""
    print("=" * 50)
    print("测试 SQL Server 连接...")
    print("=" * 50)
    
    try:
        conn_str = (
            f"DRIVER={{SQL Server}};"
            f"SERVER={SQL_SERVER['server']};"
            f"DATABASE={SQL_SERVER['database']};"
            f"UID={SQL_SERVER['username']};"
            f"PWD={SQL_SERVER['password']};"
        )
        conn = pyodbc.connect(conn_str, timeout=10)
        print("✅ SQL Server 连接成功！")
        
        # 获取数据库列表
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sys.databases WHERE state_desc = 'ONLINE'")
        dbs = [row[0] for row in cursor.fetchall()]
        print(f"\n可用数据库: {dbs}")
        cursor.close()
        conn.close()
        return True, dbs
        
    except Exception as e:
        print(f"❌ 连接失败: {e}")
        return False, []

def get_table_columns(conn, table_name):
    """获取表的列名"""
    cursor = conn.cursor()
    cursor.execute(f"""
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = '{table_name}'
        ORDER BY ORDINAL_POSITION
    """)
    columns = [row[0] for row in cursor.fetchall()]
    cursor.close()
    return columns

def sync_products_to_supabase(conn, supabase: Client):
    """同步商品基础数据"""
    print("\n" + "=" * 50)
    print("同步商品基础数据...")
    print("=" * 50)
    
    try:
        cursor = conn.cursor()
        
        # 检查表是否存在
        cursor.execute("SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'Shortage_StoreStockCache'")
        if cursor.fetchone()[0] == 0:
            print("❌ 表 Shortage_StoreStockCache 不存在")
            cursor.close()
            return 0
        
        # 获取列名
        columns = get_table_columns(conn, 'Shortage_StoreStockCache')
        print(f"表列名: {columns}")
        
        # 查询数据（子查询去重避免ORDER BY冲突）
        query = """
            SELECT product_code, product_name, product_spec, manufacturer
            FROM (
                SELECT DISTINCT
                    LTRIM(RTRIM(ISNULL(商品编码, ''))) as product_code,
                    LTRIM(RTRIM(ISNULL(商品名称, ''))) as product_name,
                    LTRIM(RTRIM(ISNULL(规格, ''))) as product_spec,
                    LTRIM(RTRIM(ISNULL(生产企业, ''))) as manufacturer
                FROM Shortage_StoreStockCache WITH (NOLOCK)
                WHERE 商品编码 IS NOT NULL AND LTRIM(RTRIM(商品编码)) <> ''
            ) t
            ORDER BY product_code
        """
        
        cursor.execute(query)
        rows = cursor.fetchall()
        print(f"✅ 查询到 {len(rows)} 条商品记录")
        
        # 准备数据（生成 uuid 主键）
        products = []
        for row in rows:
            products.append({
                'id': str(uuid.uuid4()),
                'product_code': row[0] if row[0] else '',
                'product_name': row[1] if row[1] else '',
                'product_spec': row[2] if row[2] else '',
                'manufacturer': row[3] if row[3] else '',
                'updated_at': datetime.now().isoformat()
            })
        
        # 批量插入 Supabase
        if products:
            # 清空旧数据（uuid 类型不能用数字比较）
            supabase.table('product_cache').delete().neq('product_code', '').execute()
            
            # 批量插入
            data = supabase.table('product_cache').insert(products).execute()
            print(f"✅ 已同步 {len(products)} 条商品到 Supabase")
        
        cursor.close()
        return len(products)
        
    except Exception as e:
        print(f"❌ 同步商品失败: {e}")
        return 0

def sync_store_stock_to_supabase(conn, supabase: Client, sync_mode='full', last_sync=None):
    """同步门店库存数据 - 支持全量和增量同步"""
    print("\n" + "=" * 50)
    print(f"同步门店库存数据 ({'增量' if sync_mode == 'incremental' else '全量'})...")
    print("=" * 50)
    
    try:
        cursor = conn.cursor()
        
        # 增量同步模式：只同步有变化的库存数据（有库存或在途的记录）
        if sync_mode == 'incremental' and last_sync:
            print(f"📅 增量同步模式，只同步有库存/在途变化的记录")
            query = """
                SELECT 
                    LTRIM(RTRIM(ISNULL(商品编码, ''))) as product_code,
                    LTRIM(RTRIM(ISNULL(门店名称, ''))) as store_name,
                    ISNULL(库存数量, 0) as store_stock,
                    ISNULL(在途数量, 0) as in_transit,
                    ISNULL(门店库存汇总, 0) as store_total,
                    ISNULL(配送中心库存数量, 0) as dc_stock,
                    ISNULL(前30天销售数量, 0) as sales_30days,
                    ISNULL(前90天销售数量, 0) as sales_90days,
                    ISNULL(月均销售数量, 0) as monthly_sales,
                    ISNULL(标准库存数量, 0) as standard_stock,
                    ISNULL(门店计划, 0) as store_plan,
                    LTRIM(RTRIM(ISNULL(标记, ''))) as flag
                FROM dbo.Shortage_StoreStockCache WITH (NOLOCK)
                WHERE 商品编码 IS NOT NULL AND LTRIM(RTRIM(商品编码)) <> ''
                  AND (库存数量 > 0 OR 在途数量 > 0 OR 门店库存汇总 > 0)
            """
        else:
            # 全量同步模式
            query = """
                SELECT 
                    LTRIM(RTRIM(ISNULL(商品编码, ''))) as product_code,
                    LTRIM(RTRIM(ISNULL(门店名称, ''))) as store_name,
                    ISNULL(库存数量, 0) as store_stock,
                    ISNULL(在途数量, 0) as in_transit,
                    ISNULL(门店库存汇总, 0) as store_total,
                    ISNULL(配送中心库存数量, 0) as dc_stock,
                    ISNULL(前30天销售数量, 0) as sales_30days,
                    ISNULL(前90天销售数量, 0) as sales_90days,
                    ISNULL(月均销售数量, 0) as monthly_sales,
                    ISNULL(标准库存数量, 0) as standard_stock,
                    ISNULL(门店计划, 0) as store_plan,
                    LTRIM(RTRIM(ISNULL(标记, ''))) as flag
                FROM dbo.Shortage_StoreStockCache WITH (NOLOCK)
                WHERE 商品编码 IS NOT NULL AND LTRIM(RTRIM(商品编码)) <> ''
            """
        
        cursor.execute(query)
        rows = cursor.fetchall()
        print(f"✅ 查询到 {len(rows)} 条门店库存记录")
        
        if len(rows) == 0:
            cursor.close()
            return 0
        
        # 准备数据（Decimal 转 int，store_id 用 store_name 避免重复）
        stock_data = []
        for row in rows:
            def to_int(val):
                return int(val) if val is not None else 0
            store_name = str(row[1]) if row[1] else ''
            stock_data.append({
                'product_code': str(row[0]) if row[0] else '',
                'store_id': store_name,
                'store_name': store_name,
                'store_stock': to_int(row[2]),
                'in_transit': to_int(row[3]),
                'store_total': to_int(row[4]),
                'dc_stock': to_int(row[5]),
                'sales_30days': to_int(row[6]),
                'sales_90days': to_int(row[7]),
                'monthly_sales': to_int(row[8]),
                'standard_stock': to_int(row[9]),
                'store_plan': to_int(row[10]),
                'flag': str(row[11]) if row[11] else '',
                'category': '',
                'last_updated': datetime.now().isoformat()
            })
        
        # 批量upsert（增量模式）或 清空+插入（全量模式）
        if sync_mode == 'full':
            # 全量模式：清空旧数据
            print("🗑️ 清空旧缓存数据...")
            supabase.table('shortage_storestock_cache').delete().neq('product_code', '').execute()
        
        # 按 product_code + store_id 去重，避免 upsert 冲突
        seen = set()
        deduped = []
        for item in stock_data:
            key = (item['product_code'], item['store_id'])
            if key not in seen:
                seen.add(key)
                deduped.append(item)
        
        # 分批插入
        batch_size = 200
        total_inserted = 0
        for i in range(0, len(deduped), batch_size):
            batch = deduped[i:i+batch_size]
            data = supabase.table('shortage_storestock_cache').upsert(
                batch,
                on_conflict='product_code,store_id'
            ).execute()
            total_inserted += len(batch)
            print(f"  📤 已同步 {total_inserted}/{len(deduped)} 条")
        
        print(f"✅ 已同步 {total_inserted} 条门店库存到 Supabase（去重前 {len(stock_data)} 条）")
        cursor.close()
        return total_inserted
        
    except Exception as e:
        print(f"❌ 同步门店库存失败: {e}")
        return 0

def sync_purchase_plan_to_supabase(conn, supabase: Client):
    """同步采购计划数据"""
    print("\n" + "=" * 50)
    print("同步采购计划数据...")
    print("=" * 50)
    
    try:
        cursor = conn.cursor()
        
        query = """
            SELECT 
                LTRIM(RTRIM(ISNULL(商品编码, ''))) as product_code,
                LTRIM(RTRIM(ISNULL(商品名称, ''))) as product_name,
                LTRIM(RTRIM(ISNULL(规格, ''))) as product_spec,
                LTRIM(RTRIM(ISNULL(生产企业, ''))) as manufacturer,
                ISNULL(仓库库存数量, 0) as warehouse_stock,
                ISNULL(标准库存汇总, 0) as standard_total,
                ISNULL(门店库存汇总, 0) as store_total,
                ISNULL(在途汇总, 0) as in_transit_total,
                ISNULL(可调拨数量, 0) as available,
                ISNULL(建议订货数量, 0) as suggested_order
            FROM Shortage_PurchasePlanCache WITH (NOLOCK)
        """
        
        cursor.execute(query)
        rows = cursor.fetchall()
        print(f"✅ 查询到 {len(rows)} 条采购计划记录")
        
        # 准备数据（Decimal 转 int 避免 JSON 序列化错误）
        plan_data = []
        for row in rows:
            def to_int(val):
                return int(val) if val is not None else 0
            plan_data.append({
                'product_code': str(row[0]) if row[0] else '',
                'product_name': str(row[1]) if row[1] else '',
                'product_spec': str(row[2]) if row[2] else '',
                'manufacturer': str(row[3]) if row[3] else '',
                'warehouse_stock': to_int(row[4]),
                'standard_total': to_int(row[5]),
                'store_total': to_int(row[6]),
                'in_transit_total': to_int(row[7]),
                'available': to_int(row[8]),
                'suggested_order': to_int(row[9]),
                'last_updated': datetime.now().isoformat()
            })
        
        # 批量插入
        if plan_data:
            # 清空旧数据
            supabase.table('shortage_purchaseplancache').delete().neq('id', 0).execute()
            
            data = supabase.table('shortage_purchaseplancache').insert(plan_data).execute()
            print(f"✅ 已同步 {len(plan_data)} 条采购计划到 Supabase")
        
        cursor.close()
        return len(plan_data)
        
    except Exception as e:
        print(f"❌ 同步采购计划失败: {e}")
        return 0

def main():
    """主函数 - 支持全量和增量同步"""
    parser = argparse.ArgumentParser(description='药店缺货管理系统同步工具')
    parser.add_argument('--mode', choices=['full', 'incremental'], default=SYNC_MODE,
                        help='同步模式: full=全量同步, incremental=增量同步')
    parser.add_argument('--interval', type=int, default=SYNC_INTERVAL_MINUTES,
                        help=f'同步间隔分钟数 (默认: {SYNC_INTERVAL_MINUTES})')
    parser.add_argument('--products', action='store_true', default=SYNC_PRODUCTS,
                        help='同步商品数据')
    parser.add_argument('--stock', action='store_true', default=SYNC_STORE_STOCK,
                        help='同步门店库存数据 (P0优化重点)')
    parser.add_argument('--plan', action='store_true', default=SYNC_PURCHASE_PLAN,
                        help='同步采购计划')
    parser.add_argument('--daemon', action='store_true',
                        help='守护进程模式，持续定时同步')
    args = parser.parse_args()
    
    sync_mode = args.mode
    sync_interval = args.interval
    
    print("\n" + "=" * 60)
    print("药店缺货管理系统 - SQL Server → Supabase 同步工具")
    print(f"同步模式: {'全量同步' if sync_mode == 'full' else '增量同步'}")
    print(f"同步间隔: {sync_interval} 分钟")
    print("=" * 60)
    
    # 守护进程模式：持续定时同步
    if args.daemon:
        print("\n🔄 守护进程模式启动，每 {} 分钟执行一次同步...".format(sync_interval))
        print("按 Ctrl+C 停止\n")
        
        while True:
            try:
                execute_sync(supabase_url=SUPABASE_URL, supabase_key=SUPABASE_KEY, 
                           sync_mode=sync_mode,
                           sync_products=args.products or SYNC_PRODUCTS,
                           sync_stock=args.stock or SYNC_STORE_STOCK,
                           sync_plan=args.plan or SYNC_PURCHASE_PLAN)
                
                print(f"\n⏰ 下次同步将在 {sync_interval} 分钟后执行...")
                import time
                time.sleep(sync_interval * 60)
                
            except KeyboardInterrupt:
                print("\n\n👋 同步服务已停止")
                sys.exit(0)
            except Exception as e:
                print(f"\n❌ 同步出错: {e}")
                print("30秒后重试...")
                import time
                time.sleep(30)
    else:
        # 单次同步
        execute_sync(supabase_url=SUPABASE_URL, supabase_key=SUPABASE_KEY,
                    sync_mode=sync_mode,
                    sync_products=args.products or SYNC_PRODUCTS,
                    sync_stock=args.stock or SYNC_STORE_STOCK,
                    sync_plan=args.plan or SYNC_PURCHASE_PLAN)


def execute_sync(supabase_url, supabase_key, sync_mode='incremental', 
                sync_products=True, sync_stock=True, sync_plan=True):
    """执行同步的核心逻辑"""
    print(f"\n{'='*50}")
    print(f"{'增量同步' if sync_mode == 'incremental' else '全量同步'}")
    print(f"{'='*50}")
    
    # 步骤 1: 测试 SQL Server 连接
    success, databases = test_sqlserver_connection()
    if not success:
        print("\n请检查 SQL Server 连接配置！")
        return False
    
    # 如果有多个数据库，让用户选择
    if len(databases) > 1:
        print(f"\n发现 {len(databases)} 个数据库:")
        for i, db in enumerate(databases, 1):
            print(f"  {i}. {db}")
        choice = input("\n请选择数据库编号: ").strip()
        try:
            SQL_SERVER['database'] = databases[int(choice) - 1]
        except:
            print("无效选择，退出")
            return False
    
    # 步骤 2: 连接 SQL Server
    print(f"\n正在连接数据库: {SQL_SERVER['database']}...")
    conn_str = (
        f"DRIVER={{SQL Server}};"
        f"SERVER={SQL_SERVER['server']};"
        f"DATABASE={SQL_SERVER['database']};"
        f"UID={SQL_SERVER['username']};"
        f"PWD={SQL_SERVER['password']};"
    )
    conn = pyodbc.connect(conn_str, timeout=30)
    print("✅ SQL Server 连接成功！")
    
    # 步骤 3: 初始化 Supabase 客户端
    print("\n正在初始化 Supabase 客户端...")
    try:
        supabase: Client = create_client(supabase_url, supabase_key)
        # 测试连接
        supabase.table('sync_metadata').select('id').limit(1).execute()
        print("✅ Supabase 连接成功！")
    except Exception as e:
        print(f"❌ Supabase 连接失败: {e}")
        print("请检查 SUPABASE_URL 和 SUPABASE_KEY 配置！")
        conn.close()
        return False
    
    # 步骤 4: 获取上次同步时间（用于增量同步）
    last_sync = None
    if sync_mode == 'incremental':
        try:
            meta = supabase.table('sync_metadata').select('*').eq('sync_type', 'inventory_incremental').single().execute()
            if meta.data:
                last_sync = meta.data.get('last_sync')
                print(f"📅 上次同步时间: {last_sync or '首次同步'}")
        except:
            print("📅 首次同步（将执行全量同步）")
    
    # 步骤 5: 执行同步
    total_synced = 0
    sync_start = datetime.now()
    
    if sync_products:
        count = sync_products_to_supabase(conn, supabase)
        total_synced += count
    
    if sync_stock:
        # P0优化：门店库存同步优先，支持增量模式
        count = sync_store_stock_to_supabase(conn, supabase, sync_mode, last_sync)
        total_synced += count
    
    if sync_plan:
        count = sync_purchase_plan_to_supabase(conn, supabase)
        total_synced += count
    
    # 步骤 6: 更新同步元数据
    sync_end = datetime.now()
    try:
        supabase.table('sync_metadata').upsert({
            'sync_type': 'inventory_incremental',
            'last_sync': sync_end.isoformat(),
            'records_synced': total_synced,
            'since': last_sync or 'full',
            'status': 'success',
            'duration_seconds': (sync_end - sync_start).total_seconds()
        }, on_conflict='sync_type').execute()
    except Exception as e:
        print(f"⚠️ 更新同步元数据失败: {e}")
    
    # 步骤 7: 记录同步日志
    try:
        supabase.table('sync_log').insert({
            'sync_type': f'full_sync' if sync_mode == 'full' else 'incremental_sync',
            'status': 'completed',
            'message': f'从 SQL Server 同步了 {total_synced} 条记录',
            'record_count': total_synced,
            'sync_start': sync_start.isoformat(),
            'sync_end': sync_end.isoformat(),
            'duration_seconds': (sync_end - sync_start).total_seconds()
        }).execute()
    except:
        pass
    
    # 步骤 8: 完成
    conn.close()
    
    print("\n" + "=" * 60)
    print(f"✅ 同步完成！共同步 {total_synced} 条记录")
    print(f"⏱️ 耗时: {(sync_end - sync_start).total_seconds():.1f} 秒")
    print("=" * 60)
    
    return True

if __name__ == "__main__":
    main()
