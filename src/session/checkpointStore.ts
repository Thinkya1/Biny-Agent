/**
 * 工作区快照模块。
 *
 * agent 改坏了要能退回去。难点是"退回去"不能变成第二次破坏，所以这里有两条硬约束：
 *
 * - **建快照不碰用户的 git 状态**。用独立的临时索引文件加 `commit-tree`，快照挂在
 *   `refs/biny/checkpoints/*` 上。用户的暂存区、HEAD、分支历史、reflog 全都不受影响，
 *   `git log` 里也看不见这些提交。
 * - **恢复不删文件**。快照之后新建的文件会被移到 `.biny/undo-trash/<时间戳>/` 而不是
 *   删除。恢复本身也是可逆的 —— 一个"撤销"功能如果会让人丢东西，就没人敢用。
 *
 * 快照只覆盖 git 认得的范围（遵守 .gitignore）。`node_modules`、构建产物和被忽略的本地
 * 文件不在其中，恢复时也不会动它们。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { agentDir, ensureAgentDirs } from "./store.js";

const run = promisify(execFile);
const checkpointRefPrefix = "refs/biny/checkpoints";
/**
 * agent 自己的状态目录必须整个排除在快照之外。它进了快照，恢复就会覆盖会话日志、计划清单，
 * 乃至记录着"要恢复到哪个快照"的索引文件本身 —— 撤销会把自己的依据一起抹掉。
 */
const excludeAgentState = [":(exclude).biny", ":(exclude).agent"];
const maxCheckpoints = 50;

export interface Checkpoint {
  id: string;
  label: string;
  commit: string;
  createdAt: string;
}

export interface RestoreSummary {
  checkpoint: Checkpoint;
  restoredFiles: number;
  /** 快照之后新建、这次被移走的文件（工作区相对路径）。 */
  movedAside: string[];
  /** 移走的文件放在哪里；没有移动时为 undefined。 */
  trashDirectory?: string;
}

export class CheckpointStore {
  private constructor(private readonly workspaceRoot: string, private readonly gitDir: string) {}

  /** 不是 git 仓库时返回 undefined —— 快照能力就是不可用，不去伪造一个。 */
  static async open(workspaceRoot: string): Promise<CheckpointStore | undefined> {
    try {
      const { stdout } = await run("git", ["rev-parse", "--absolute-git-dir"], { cwd: workspaceRoot });
      return new CheckpointStore(path.resolve(workspaceRoot), stdout.trim());
    } catch {
      return undefined;
    }
  }

  async create(label: string): Promise<Checkpoint> {
    // pid+毫秒在并发下同毫秒会撞名，加随机成分保证临时索引互不污染。
    const temporaryIndex = path.join(os.tmpdir(), `biny-checkpoint-index-${process.pid}-${Date.now().toString(36)}-${randomUUID()}`);
    try {
      // 独立索引文件：用户暂存了什么、没暂存什么，全程不受影响。
      const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
      await this.git(["read-tree", "--empty"], env);
      await this.git(["add", "-A", "--", ".", ...excludeAgentState], env);
      const tree = (await this.git(["write-tree"], env)).trim();
      const commit = (await this.git([
        "commit-tree", tree,
        "-m", `biny checkpoint: ${label}`
      ], {
        ...env,
        GIT_AUTHOR_NAME: "Biny", GIT_AUTHOR_EMAIL: "checkpoint@biny.local",
        GIT_COMMITTER_NAME: "Biny", GIT_COMMITTER_EMAIL: "checkpoint@biny.local"
      })).trim();
      const checkpoint: Checkpoint = { id: shortId(commit), label, commit, createdAt: new Date().toISOString() };
      // ref 让快照提交不会被 gc 掉，同时留在 refs/biny 下不污染 refs/heads。
      await this.git(["update-ref", `${checkpointRefPrefix}/${checkpoint.id}`, commit]);
      await this.appendIndexEntry(checkpoint);
      return checkpoint;
    } finally {
      await fs.rm(temporaryIndex, { force: true });
    }
  }

  async list(): Promise<Checkpoint[]> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.indexPath(), "utf8"));
      const entries = (parsed as { checkpoints?: unknown }).checkpoints;
      return Array.isArray(entries) ? entries.filter(isCheckpoint) : [];
    } catch {
      return [];
    }
  }

  async restore(id: string): Promise<RestoreSummary> {
    const checkpoints = await this.list();
    const checkpoint = checkpoints.find((entry) => entry.id === id)
      ?? (id === "latest" ? checkpoints[checkpoints.length - 1] : undefined);
    if (!checkpoint) throw new Error(`No such checkpoint: ${id}`);

    const snapshotFiles = new Set(await this.filesInCommit(checkpoint.commit));
    const currentFiles = await this.trackedFilesNow();
    const addedSinceCheckpoint = [...currentFiles].filter((file) => !snapshotFiles.has(file)).sort();

    // 先把新增文件挪走，再落回快照内容。顺序反过来的话，新增文件会被后面的写入覆盖判断漏掉。
    let trashDirectory: string | undefined;
    if (addedSinceCheckpoint.length) {
      trashDirectory = path.join(".biny", "undo-trash", new Date().toISOString().replace(/[:.]/g, "-"));
      await ensureAgentDirs(this.workspaceRoot);
      for (const file of addedSinceCheckpoint) {
        const destination = path.join(this.workspaceRoot, trashDirectory, file);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.rename(path.join(this.workspaceRoot, file), destination).catch(() => undefined);
      }
    }

    // 用临时索引把快照内容写回工作区。`git checkout <commit> -- .` 会顺带改写用户的暂存区，
    // 而 `checkout-index` 只认给它的索引文件，用户暂存了什么完全不受影响。
    const restoreIndex = path.join(os.tmpdir(), `biny-restore-index-${process.pid}-${Date.now().toString(36)}-${randomUUID()}`);
    try {
      const env = { ...process.env, GIT_INDEX_FILE: restoreIndex };
      await this.git(["read-tree", checkpoint.commit], env);
      await this.git(["checkout-index", "-a", "-f"], env);
    } finally {
      await fs.rm(restoreIndex, { force: true });
    }

    return {
      checkpoint,
      restoredFiles: snapshotFiles.size,
      movedAside: addedSinceCheckpoint,
      ...(trashDirectory ? { trashDirectory } : {})
    };
  }

  private async filesInCommit(commit: string): Promise<string[]> {
    const { stdout } = await run("git", ["ls-tree", "-r", "--name-only", commit], { cwd: this.workspaceRoot, maxBuffer: 64 * 1024 * 1024 });
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  private async trackedFilesNow(): Promise<Set<string>> {
    // -c 已跟踪 + -o 未跟踪，--exclude-standard 让 .gitignore 生效，和建快照时的范围一致。
    const { stdout } = await run("git", ["ls-files", "-co", "--exclude-standard", "--", ".", ...excludeAgentState], { cwd: this.workspaceRoot, maxBuffer: 64 * 1024 * 1024 });
    return new Set(stdout.split("\n").map((line) => line.trim()).filter(Boolean));
  }

  private indexPath(): string {
    return path.join(agentDir(this.workspaceRoot), "checkpoints.json");
  }

  private async appendIndexEntry(checkpoint: Checkpoint): Promise<void> {
    const checkpoints = [...await this.list(), checkpoint];
    const dropped = checkpoints.slice(0, Math.max(0, checkpoints.length - maxCheckpoints));
    const retained = checkpoints.slice(-maxCheckpoints);
    await ensureAgentDirs(this.workspaceRoot);
    const target = this.indexPath();
    await fs.writeFile(`${target}.tmp`, `${JSON.stringify({ version: 1, checkpoints: retained })}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(`${target}.tmp`, target);
    // 过期的快照连 ref 一起删掉，否则那些提交会永远留在仓库里。
    for (const entry of dropped) {
      await this.git(["update-ref", "-d", `${checkpointRefPrefix}/${entry.id}`]).catch(() => undefined);
    }
  }

  private async git(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await run("git", args, {
      cwd: this.workspaceRoot,
      env: env ?? process.env,
      maxBuffer: 64 * 1024 * 1024
    });
    return stdout;
  }
}

function shortId(commit: string): string {
  return commit.slice(0, 12);
}

function isCheckpoint(value: unknown): value is Checkpoint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Checkpoint>;
  return typeof candidate.id === "string"
    && typeof candidate.label === "string"
    && typeof candidate.commit === "string"
    && typeof candidate.createdAt === "string";
}
