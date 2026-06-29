import requests
import json

# 调用 Edge Function 从 Supabase 获取数据
url = "https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data"
headers = {"Content-Type": "application/json"}
data = {"action": "rebuild_feedback_from_supabase"}

print("正在恢复数据...")
try:
    resp = requests.post(url, headers=headers, json=data, timeout=30)
    result = resp.json()
    print("结果:", json.dumps(result, indent=2, ensure_ascii=False))
except Exception as e:
    print("错误:", e)

input("按回车键退出...")
