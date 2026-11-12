// 版本号单一来源（Edge Functions 侧）
// 运行时以 Cloudflare Pages 上部署的 releases/latest.yml 为唯一真值；
// 这里只保留一个兜底常量，任何改动只需改这一处。
export const LATEST_YML_URL = "https://wszhyy.pages.dev/releases/latest.yml";
export const FALLBACK_VERSION = "5.15.15";

export async function getLatestVersion(): Promise<string> {
  try {
    const resp = await fetch(LATEST_YML_URL, { headers: { "User-Agent": "wszh-version-resolver" } });
    if (!resp.ok) return FALLBACK_VERSION;
    const text = await resp.text();
    const m = text.match(/^version:\s*['"]?(\S+?)['"]?\s*$/m);
    if (m && m[1]) return m[1];
  } catch {}
  return FALLBACK_VERSION;
}
