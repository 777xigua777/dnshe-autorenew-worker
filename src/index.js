// --------------- 常量配置 ---------------
const API_HOST = "https://api005.dnshe.com";
const RENEW_BEFORE_DAYS = 180; // 剩余天数 ≤ 该值才续期
const DAY_MS = 24 * 60 * 60 * 1000;
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000; // 北京时间 UTC+8 偏移
const LIST_SLEEP_MS = 300;     // 域名遍历间隔
const RENEW_SLEEP_MS = 800;    // 续期请求间隔
const FETCH_TIMEOUT = 10000;   // 接口超时时间
const ACCOUNT_SLEEP_MS = 1000; // 账号切换间隔（避免限流）
const MAX_ACCOUNT_NUM = 20;    // 支持最大账号数量

export default {
  /** 网页访问 & 手动执行 SSE 接口 */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      return this.createSSEStream(env);
    }
    return new Response(pageHtml(), {
      headers: { "Content-Type": "text/html;charset=utf-8" },
    });
  },

  /** Cloudflare Cron 定时自动续期 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAllAccounts(env, (...args) => console.log("[定时任务]", ...args)));
  },

  /** 创建 SSE 流式响应，实时推送日志 */
  async createSSEStream(env) {
    const stream = new ReadableStream({
      async start(controller) {
        const sendLog = (rawMsg) => {
          controller.enqueue(`data: ${JSON.stringify(rawMsg)}\n\n`);
        };

        try {
          await runAllAccounts(env, sendLog);
          sendLog("🎉 所有账号全部处理完成");
        } catch (globalErr) {
          sendLog(`❌ 全局执行异常：${globalErr.message || String(globalErr)}`);
        } finally {
          controller.close();
        }
      },
      cancel() {
        console.log("SSE 客户端主动断开连接");
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
};

// --------------- 多账号核心逻辑 ---------------
function parseAccounts(env) {
  const accounts = [];

  for (let i = 1; i <= MAX_ACCOUNT_NUM; i++) {
    const key = env[`API_KEY_${i}`];
    const secret = env[`API_SECRET_${i}`];
    
    if (key || secret) {
      console.log(`[调试] 序号${i}: key存在=${!!key}, secret存在=${!!secret}`);
    }
    
    if (key && secret) {
      accounts.push({
        name: env[`ACCOUNT_NAME_${i}`] || `账号${i}`,
        apiKey: key,
        apiSecret: secret,
      });
    }
  }

  if (accounts.length === 0 && env.API_KEY && env.API_SECRET) {
    console.log("[调试] 触发单账号兜底配置");
    accounts.push({
      name: "默认账号",
      apiKey: env.API_KEY,
      apiSecret: env.API_SECRET,
    });
  }

  console.log("[调试] 最终识别到的账号数量:", accounts.length);

  if (accounts.length === 0) {
    throw new Error("未找到任何有效账号配置，请设置环境变量");
  }

  return accounts;
}

async function runAllAccounts(env, log) {
  const accounts = parseAccounts(env);
  log(`📋 共加载 ${accounts.length} 个账号，开始逐个处理`);

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    log(`========== 开始处理【${account.name}】 ==========`);

    try {
      await processSingleAccount(account, log);
      log(`✅ 【${account.name}】处理完成`);
    } catch (accErr) {
      log(`❌ 【${account.name}】处理异常：${accErr.message || String(accErr)}`);
    }

    if (i < accounts.length - 1) {
      log("----------------------------------------");
      await sleep(ACCOUNT_SLEEP_MS);
    }
  }
}

async function processSingleAccount(account, log) {
  const { apiKey, apiSecret, name } = account;

  const domainList = await listDomains(apiKey, apiSecret, log);
  if (!Array.isArray(domainList) || domainList.length === 0) {
    log(`【${name}】无活跃子域名，跳过`);
    return;
  }

  log(`【${name}】找到 ${domainList.length} 个活跃域名，仅剩余 ≤${RENEW_BEFORE_DAYS} 天自动续期`);

  for (const domainItem of domainList) {
    const { id, full_domain, expires_at, never_expires } = domainItem;
    log(`【${name}】处理: ${full_domain} (ID: ${id})`);

    if (never_expires === 1 || never_expires === "1") {
      log(`✅ 【${name}】${full_domain} 为永久域名，无需续期`);
      await sleep(LIST_SLEEP_MS);
      continue;
    }

    const expireDate = new Date(expires_at);
    if (isNaN(expireDate.getTime())) {
      log(`⚠️ 【${name}】${full_domain} 过期时间格式错误，跳过`);
      await sleep(LIST_SLEEP_MS);
      continue;
    }
    const expireUtcTime = new Date(expireDate.getTime() - UTC8_OFFSET_MS);
    const nowUtc = new Date();
    const remainingDays = Math.floor((expireUtcTime - nowUtc) / DAY_MS);

    if (remainingDays > RENEW_BEFORE_DAYS) {
      log(`✅ 【${name}】${full_domain} 剩余 ${remainingDays} 天，无需续期`);
      await sleep(LIST_SLEEP_MS);
      continue;
    }

    const renewResult = await renewDomain(apiKey, apiSecret, id);
    if (renewResult.success) {
      log(`✅ 【${name}】续期成功: ${full_domain}`);
    } else {
      log(`❌ 【${name}】续期失败: ${full_domain}，原因: ${renewResult.message}`);
    }
    await sleep(RENEW_SLEEP_MS);
  }
}

// --------------- 接口封装 ---------------
async function listDomains(apiKey, apiSecret, log) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const res = await fetch(`${API_HOST}/index.php?m=domain_hub&endpoint=subdomains&action=list`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "X-API-Key": apiKey,
        "X-API-Secret": apiSecret,
        "User-Agent": "DNSHE-AutoRenew-Worker/2.0",
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      log(`域名列表接口 HTTP 异常，状态码: ${res.status}`);
      return [];
    }

    const data = await res.json();
    if (!data.success) {
      log(`拉取域名列表失败: ${data.message || "接口返回不成功"}`);
      return [];
    }

    log(`接口返回总域名数量: ${data.count}`);

    return Array.isArray(data.subdomains)
      ? data.subdomains.filter(item =>
          String(item.status || "").toLowerCase() === "registered"
        )
      : [];
  } catch (err) {
    if (err.name === "AbortError") log("拉取域名列表请求超时");
    else log(`listDomains 接口异常: ${String(err)}`);
    return [];
  }
}

async function renewDomain(apiKey, apiSecret, subdomainId) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const res = await fetch(`${API_HOST}/index.php?m=domain_hub&endpoint=subdomains&action=renew`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "X-API-Key": apiKey,
        "X-API-Secret": apiSecret,
        "Content-Type": "application/json",
        "User-Agent": "DNSHE-AutoRenew-Worker/2.0",
      },
      body: JSON.stringify({ subdomain_id: subdomainId }),
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { success: false, message: `HTTP 请求失败 状态码 ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") {
      return { success: false, message: "续期接口请求超时" };
    }
    return { success: false, message: String(err) };
  }
}

// --------------- 工具函数 ---------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 前端页面
function pageHtml() {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DNSHE 多账号自动续期工具</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:system-ui,-apple-system,Segoe UI}
body{background:#f0f2f5;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px}
.container{width:100%;max-width:760px;background:#fff;border-radius:16px;padding:30px;box-shadow:0 4px 20px rgba(0,0,0,0.06)}
h1{text-align:center;font-size:24px;color:#1e293b;margin-bottom:24px}
.btn-run{width:100%;padding:14px;font-size:16px;color:#fff;background:#2563eb;border:none;border-radius:10px;cursor:pointer;transition:background 0.2s}
.btn-run:hover{background:#1d4ed8}
.btn-run:disabled{background:#94a3b8;cursor:not-allowed}
.log-card{
  margin-top:20px;
  background:#f8fafc;
  border:1px solid #e2e8f0;
  border-radius:10px;
  padding:16px;
  min-height:280px;
  max-height:560px;
  overflow-y:auto;
  font-size:14px;
  line-height:1.8;
  white-space:pre-wrap;
}
.log-success{color:#059669;font-weight:500;display:block;}
.log-error{color:#dc2626;font-weight:500;display:block;}
.log-normal{color:#334155;display:block;}
.log-warning{color:#d97006;font-weight:500;display:block;}
</style>
</head>
<body>
<div class="container">
  <h1>DNSHE 多账号自动续期</h1>
  <button class="btn-run" id="runBtn">开始批量续期</button>
  <div id="logBox" class="log-card">等待点击按钮执行...</div>
</div>
<script>
const runBtn = document.getElementById('runBtn');
const logBox = document.getElementById('logBox');
let eventSource = null;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function appendLog(text) {
  const safeText = escapeHtml(text);
  let className = 'log-normal';
  if (text.includes('✅')) className = 'log-success';
  else if (text.includes('❌') || text.includes('失败') || text.includes('错误')) className = 'log-error';
  else if (text.includes('⚠️')) className = 'log-warning';
  logBox.innerHTML += \`<span class="\${className}">\${safeText}</span>\`;
  logBox.scrollTop = logBox.scrollHeight;
}

function closeStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  runBtn.disabled = false;
  runBtn.textContent = '开始批量续期';
}

runBtn.addEventListener('click', () => {
  if (eventSource) eventSource.close();
  runBtn.disabled = true;
  runBtn.textContent = '执行中，请勿刷新...';
  logBox.innerHTML = '';

  eventSource = new EventSource('/run');

  eventSource.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    appendLog(msg);
    if (msg.includes('所有账号全部处理完成') || msg.includes('未找到任何有效账号')) {
      closeStream();
    }
  };

  eventSource.onerror = () => {
    appendLog('⚠️ 连接断开或发生网络错误');
    closeStream();
  };
});
</script>
</body>
</html>
  `;
}
