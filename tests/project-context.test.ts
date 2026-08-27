import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectProjectContext } from "../src/project/ProjectContext.js";

async function main(): Promise<void> {
  await testBrokenPackageJsonDegrades();
  await testJsoncTsconfigParses();
  await testBrokenTsconfigDegrades();
  await testUnreadableSrcDirectoryDegrades();
}

async function testBrokenPackageJsonDegrades(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-project-context-package-"));
  try {
    // package.json 损坏不能让整个 turn 的上下文收集失败,按缺失降级。
    await writeFile(path.join(workspaceRoot, "package.json"), "{ not json", "utf8");
    const context = await collectProjectContext(workspaceRoot, []);
    assert.equal(context.packageJson, undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testJsoncTsconfigParses(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-project-context-jsonc-"));
  try {
    // tsconfig.json 官方是 JSONC:行注释、块注释和尾逗号都要能解析。
    await writeFile(path.join(workspaceRoot, "tsconfig.json"), `{
  // 编译选项
  "compilerOptions": {
    "strict": true, /* 块注释 */
    "jsx": "react-jsx",
  },
  "include": ["src"],
}
`, "utf8");
    const context = await collectProjectContext(workspaceRoot, []);
    assert.equal(context.tsconfig?.compilerOptions.strict, true);
    assert.equal(context.tsconfig?.compilerOptions.jsx, "react-jsx");
    assert.deepEqual(context.tsconfig?.include, ["src"]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testBrokenTsconfigDegrades(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-project-context-tsconfig-"));
  try {
    await writeFile(path.join(workspaceRoot, "tsconfig.json"), "{ broken", "utf8");
    const context = await collectProjectContext(workspaceRoot, []);
    assert.equal(context.tsconfig, undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testUnreadableSrcDirectoryDegrades(): Promise<void> {
  // root 不受权限位约束,无法复现 EACCES,跳过。
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-project-context-eacces-"));
  const locked = path.join(workspaceRoot, "src", "locked");
  try {
    await mkdir(locked, { recursive: true });
    await writeFile(path.join(workspaceRoot, "src", "ok.ts"), "export {};\n", "utf8");
    await writeFile(path.join(locked, "hidden.ts"), "export {};\n", "utf8");
    await chmod(locked, 0o000);
    const context = await collectProjectContext(workspaceRoot, []);
    // 不可读目录按子树跳过,其余目录继续出现在轮廓里。
    assert.ok(context.srcTree.some((entry) => entry.includes("src/ok.ts")));
  } finally {
    await chmod(locked, 0o700).catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

await main();
