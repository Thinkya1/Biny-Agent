/** 手动启动独立 Runtime Host；Desktop/TUI 通常会在需要时自动拉起它。 */
import { runRuntimeHostProcess } from "../../runtime/hostProcess.js";

export async function runtimeHostCommand(): Promise<void> {
  // 命令名只认第一次出现；后续同值参数（如 --session-id runtime-host）不能截到这里。
  const commandIndex = process.argv.indexOf("runtime-host");
  await runRuntimeHostProcess(commandIndex < 0 ? [] : process.argv.slice(commandIndex + 1));
}
