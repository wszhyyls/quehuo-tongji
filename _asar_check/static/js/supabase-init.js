
// Supabase 初始化
const SUPABASE_URL = "https://qswpgnnedqvuegwfbprd.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI";
const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/query-shortage-data`;

let supabase;

if (typeof supabase !== "undefined") {
  supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// 登录函数
async function login(username, password) {
  // 先用门店/管理员密码验证，然后用 Supabase Auth 登录
  try {
    // 先查询用户信息
    const { data: users, error } = await supabase
      .from("users")
      .select("*")
      .eq("username", username)
      .eq("enabled", true);

    if (error) throw error;

    if (!users || users.length === 0) {
      return { success: false, error: "账号或密码错误" };
    }

    // 在真实场景中，我们会用 Supabase Auth
    // 这里简化处理
    localStorage.setItem("currentUser", JSON.stringify(users[0]));
    return { success: true, user: users[0] };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

// 调用 Edge Function
async function callEdgeFunction(action, params = {}) {
  const user = JSON.parse(localStorage.getItem("currentUser") || "null");
  if (!user) {
    return { success: false, error: "请先登录" };
  }

  try {
    const response = await fetch(EDGE_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${user.id}`, // 这里需要真实的 JWT
      },
      body: JSON.stringify({ action, params }),
    });

    return await response.json();
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

