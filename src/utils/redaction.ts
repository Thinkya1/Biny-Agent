/**
 * 纯文本敏感信息打码。
 *
 * 单独放在无 Node 依赖的模块里，Renderer 也会用它处理活动摘要，避免把路径和凭据文件
 * 判断逻辑一起打进浏览器包。
 */
export function redactSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|AIza|AKIA)[-_A-Za-z0-9]{8,}\b/g, "[redacted]")
    // 值排除集同时含半角与全角分隔符：activity 摘要用「；」拼接字段，若只排除半角
    // 「,;」，token=… 的贪婪匹配会一路吞掉后续中文字段（见 activity/redaction.ts）。
    .replace(/\bBearer\s+[^\s,;；，、]+/gi, "Bearer [redacted]")
    .replace(/((?:aws_secret_access_key|_authToken)\s*[:=]\s*)([^\s,;；，、]+)/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[:=]\s*)([^\s,;；，、]+)/gi, "$1[redacted]")
    .replace(/(["'](?:apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|token|secret|password)["']\s*:\s*["'])([^"']*)(["'])/gi, "$1[redacted]$3");
}
