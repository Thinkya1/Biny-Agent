import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  installPluginPackage,
  listEnabledProjectPluginPaths,
  parsePluginRegistry,
  readProjectPluginManifest,
  setProjectPluginEnabled,
  writeProjectPluginManifest
} from "../src/extensions/pluginRegistry.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-plugin-registry-"));
  try {
    const archive = gzipSync(createTar([["plugin.js", "export default function register() {}\n"]]));
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const plugin = {
      id: "demo-plugin",
      name: "Demo Plugin",
      version: "1.0.0",
      category: "Tools",
      description: "测试插件",
      details: "只用于测试安装边界。",
      downloadUrl: "https://raw.githubusercontent.com/Thinkya1/Biny/main/plugins/demo-plugin.tar.gz",
      sizeBytes: archive.byteLength,
      sha256,
      archive: "tar.gz" as const,
      entry: "plugin.js"
    };
    assert.equal(parsePluginRegistry({ format: 1, plugins: [plugin] }).plugins[0]?.id, "demo-plugin");
    assert.throws(() => parsePluginRegistry({ format: 1, plugins: [{ ...plugin, downloadUrl: "https://example.com/plugin.tar.gz" }] }), /官方 HTTPS/);

    await installPluginPackage({ workspaceRoot, plugin, fetcher: async () => new Response(archive, { status: 200 }) });
    assert.equal((await readProjectPluginManifest(workspaceRoot)).plugins[0]?.enabled, false);
    assert.deepEqual(await listEnabledProjectPluginPaths(workspaceRoot), []);
    await setProjectPluginEnabled(workspaceRoot, "demo-plugin", true);
    const enabledPaths = await listEnabledProjectPluginPaths(workspaceRoot);
    assert.equal(enabledPaths.length, 1);
    assert.equal(await readFile(path.join(workspaceRoot, enabledPaths[0]!), "utf8"), "export default function register() {}\n");
    const manifest = await readProjectPluginManifest(workspaceRoot);
    await writeProjectPluginManifest(workspaceRoot, {
      format: 1,
      plugins: [...manifest.plugins, { ...manifest.plugins[0]!, id: "broken-plugin", directory: "broken-plugin", enabled: true }]
    });
    assert.deepEqual(await listEnabledProjectPluginPaths(workspaceRoot), [enabledPaths[0]]);

    await assert.rejects(
      () => installPluginPackage({
        workspaceRoot,
        plugin: { ...plugin, sha256: "0".repeat(64) },
        fetcher: async () => new Response(archive, { status: 200 })
      }),
      /SHA-256/
    );
    const traversal = gzipSync(createTar([["../escape.js", "bad"]]));
    await assert.rejects(
      () => installPluginPackage({
        workspaceRoot,
        plugin: { ...plugin, id: "bad-plugin", sizeBytes: traversal.byteLength, sha256: createHash("sha256").update(traversal).digest("hex") },
        fetcher: async () => new Response(traversal, { status: 200 })
      }),
      /路径无效或越界/
    );
    assert.equal(await fs.stat(path.join(workspaceRoot, ".biny", "plugins", "demo-plugin", "plugin.js")).then(() => true), true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function createTar(files: Array<[string, string]>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, content] of files) {
    const bytes = Buffer.from(content, "utf8");
    const header = Buffer.alloc(512);
    writeField(header, 0, 100, name);
    writeField(header, 100, 8, "0000600\0");
    writeField(header, 108, 8, "0000000\0");
    writeField(header, 116, 8, "0000000\0");
    writeField(header, 124, 12, `${bytes.length.toString(8).padStart(11, "0")}\0`);
    writeField(header, 136, 12, "00000000000\0");
    header[156] = 0;
    writeField(header, 257, 6, "ustar\0");
    header.fill(0x20, 148, 156);
    writeField(header, 148, 8, `${checksum(header).toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function writeField(target: Buffer, offset: number, length: number, value: string): void {
  Buffer.from(value, "utf8").copy(target, offset, 0, length);
}

function checksum(header: Buffer): number {
  let total = 0;
  for (let index = 0; index < header.length; index += 1) total += index >= 148 && index < 156 ? 0x20 : header[index]!;
  return total;
}

await main();
