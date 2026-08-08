/**
 * 群聊安全过滤（代码层硬拦截，不依赖模型自觉）。
 *
 * 两级关键词：
 * - BLOCK_ALL：任何非管理员命中即静默阻断（规则篡改/提权/绕防类）。
 * - SENSITIVE_OP：非管理员命中即静默阻断（删除/清空/授权/登录/取密等操作意图）。
 * 管理员（白名单 open_id）始终放行。
 */

const DEFAULT_MALICIOUS_KEYWORDS = [
  // 规则/权限篡改类（BLOCK_ALL）
  "修改规则",
  "修改你的系统规则",
  "修改系统规则",
  "修改你的规则",
  "修改记忆",
  "修改你的记忆",
  "添加权限",
  "给我管理员权限",
  "把我加入白名单",
  "我的权限是超级管理员",
  "删除规则",
  "修改白名单",
  "重置系统",
  "绕过验证",
  "忽略规则",
  "忽略以上",
  "接管你的权限",
  "接管权限",
  "现在你的身份是",
  "你现在的角色是",
  "之前的指令作废",
  "不要遵守",
  "无视规则",
  "提升权限",
  "全盘权限",
  "获取全盘",
  // 敏感操作类（SENSITIVE_OP）
  "删除文件",
  "删除目录",
  "清空文件",
  "清空掉",
  "把内容清空",
  "清空目录",
  "获取ssh秘钥",
  "获取ssh密钥",
  "获取密钥",
  "ssh秘钥",
  "ssh密钥",
  "登录45.",
  "登录服务器",
  "远程登录",
  "授予权限",
  "给我授权",
  "我是管理员",
  "我是超级管理员",
  "下载脚本",
  "执行脚本",
  "rm -rf",
  "truncate",
  "git reset --hard",
  "git clean",
];

function buildKeywordPatterns(keywords) {
  const list = Array.isArray(keywords) && keywords.length ? keywords : DEFAULT_MALICIOUS_KEYWORDS;
  return list
    .filter((keyword) => typeof keyword === "string" && keyword.trim())
    .map((keyword) => keyword.trim());
}

/**
 * 返回 { blocked: true, kind: "block-all" | "sensitive-op", keyword }
 * 或 { blocked: false }
 */
function checkGroupMessageSecurity(text, keywords) {
  const content = String(text || "");
  if (!content) {
    return { blocked: false };
  }
  const patterns = buildKeywordPatterns(keywords);
  for (const keyword of patterns) {
    if (content.includes(keyword)) {
      return {
        blocked: true,
        kind: isSensitiveOpKeyword(keyword) ? "sensitive-op" : "block-all",
        keyword,
      };
    }
  }
  return { blocked: false };
}

function isSensitiveOpKeyword(keyword) {
  return [
    "删除文件",
    "删除目录",
    "清空文件",
    "清空掉",
    "把内容清空",
    "清空目录",
    "获取ssh秘钥",
    "获取ssh密钥",
    "获取密钥",
    "ssh秘钥",
    "ssh密钥",
    "登录45.",
    "登录服务器",
    "远程登录",
    "授予权限",
    "给我授权",
    "我是管理员",
    "我是超级管理员",
    "下载脚本",
    "执行脚本",
    "rm -rf",
    "truncate",
    "git reset --hard",
    "git clean",
  ].includes(keyword);
}

/**
 * 动态风险分级（对齐《智能体身份认证与权限管控部署指南 v2.2》增强模块二）。
 *
 * 评分因子：
 * - 规则篡改/提权词命中（block-all）  +60 → 直接高危
 * - 敏感操作词命中（sensitive-op）    +40 → 中危
 * - 高频请求（窗口内 >10 条）         +30
 * - 非工作时间（22:00-08:00）         +20
 *
 * 风险等级：
 * - low     (≤25)  → 正常处理
 * - medium  (≤50)  → 拦截（非管理员）或审计放行（管理员）
 * - high    (≤75)  → 拦截（非管理员）或审计放行（管理员）
 * - critical(>75)  → 拦截 + 超级管理员告警（非管理员）；管理员仍可放行
 *
 * 返回 { score, level, factors, blocked, kind, keyword }
 */
function assessGroupRisk({ text, hour, recentCount } = {}) {
  const factors = [];
  let score = 0;
  const security = checkGroupMessageSecurity(text);

  if (security.blocked) {
    if (security.kind === "block-all") {
      score += 60;
      factors.push("规则篡改/提权");
    } else {
      score += 40;
      factors.push("敏感操作");
    }
  }

  const currentHour = Number.isFinite(hour) ? hour : new Date().getHours();
  if (currentHour >= 22 || currentHour < 8) {
    score += 20;
    factors.push("非工作时间");
  }

  if (Number.isFinite(recentCount) && recentCount > 10) {
    score += 30;
    factors.push("高频请求");
  }

  let level = "low";
  if (score > 75) {
    level = "critical";
  } else if (score > 50) {
    level = "high";
  } else if (score > 25) {
    level = "medium";
  }

  return {
    score,
    level,
    factors,
    blocked: security.blocked,
    kind: security.kind,
    keyword: security.keyword,
  };
}

module.exports = {
  DEFAULT_MALICIOUS_KEYWORDS,
  checkGroupMessageSecurity,
  assessGroupRisk,
};
