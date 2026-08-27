/**
 * timestamp-converter — Biny 官方示例插件。
 *
 * 注册一个 `plugin_timestamp_convert` 工具：Unix 时间戳（秒/毫秒自动识别）
 * 与人类可读日期时间互转。纯计算、零依赖、无副作用（risk: "read"）。
 *
 * 插件契约：默认导出一个接收 BinyPluginContext 的函数；
 * schema 字段只需提供鸭子类型的 parse 方法，无需打包 zod。
 */

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function pad(value) {
  return String(value).padStart(2, "0");
}

function describeDate(date) {
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return {
    iso: date.toISOString(),
    local,
    weekday: `星期${WEEKDAYS[date.getDay()]}`,
    unixSeconds: Math.floor(date.getTime() / 1000),
    unixMilliseconds: date.getTime(),
    timezoneOffsetMinutes: -date.getTimezoneOffset()
  };
}

function convert(rawValue) {
  const value = String(rawValue).trim();
  if (!value) throw new Error("value 不能为空。");

  if (/^-?\d+$/.test(value)) {
    const numeric = Number(value);
    // 1e12 秒 ≈ 2001-09；超过这个量级按毫秒处理。
    const milliseconds = Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) throw new Error(`无法解析时间戳：${value}`);
    return { input: value, detected: Math.abs(numeric) < 1e12 ? "unix-seconds" : "unix-milliseconds", ...describeDate(date) };
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`无法识别的输入：${value}。支持 Unix 时间戳（秒/毫秒）或日期时间字符串。`);
  }
  return { input: value, detected: "datetime-string", ...describeDate(date) };
}

export default function register(context) {
  context.registerTool({
    name: "plugin_timestamp_convert",
    description: "在 Unix 时间戳（秒或毫秒）与人类可读日期时间之间互转。",
    promptSnippet: "时间戳与日期互转（秒/毫秒自动识别）",
    parameters: {
      type: "object",
      properties: {
        value: {
          type: "string",
          description: "Unix 时间戳（秒或毫秒），或日期时间字符串（如 2026-08-26 17:30:00 / ISO 8601）。"
        }
      },
      required: ["value"],
      additionalProperties: false
    },
    schema: {
      parse(input) {
        const args = input && typeof input === "object" ? input : {};
        if (typeof args.value !== "string" || !args.value.trim()) {
          throw new Error("缺少必填参数 value（字符串）。");
        }
        return { value: args.value };
      }
    },
    source: "plugin",
    risk: "read",
    resolveExecution(args) {
      return {
        approvalRule: "plugin_timestamp_convert",
        display: { kind: "generic", summary: `转换时间：${args.value}` },
        execute: async () => {
          try {
            return convert(args.value);
          } catch (error) {
            return { isError: true, errorMessage: error instanceof Error ? error.message : String(error) };
          }
        }
      };
    }
  });
}
