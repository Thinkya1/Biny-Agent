/**
 * 连续执行步骤的聚合组（1:1 对齐 Alma 聊天，见 alma-reference/REFERENCE.md）。
 *
 * 头部行：相位头像堆叠（24px 圆形、-7px 叠放、ring 分隔，点头像看单相位）+ 汇总文案
 * （点了整体开合）+ 时间线视图切换（list-tree）+ chevron。早期相位折叠成「+N」pill，
 * 展开时自动收掉。展开体是左导轨（border-l）：思考相位带「思考 了 N 秒」标题 + 正文，
 * 工具相位直接渲染 ToolActivity 行。运行中：当前相位头像光环 + 标签 shimmer + 点阵呼吸灯。
 *
 * 自动策略沿用：待授权/失败自动展开；手动开合覆盖到状态翻转为止。
 */
import { memo, useMemo, useState } from "react";
import type { PermissionResult } from "../../../../../permission/PermissionManager.js";
import { classifyTool, VARIANT_ICON_NAMES } from "../../chatModel.js";
import { reasoningDetailText } from "../../reasoningPresentation.js";
import type { TimelineReasoningStep, TimelineTool, TimelineToolStep } from "../../sessionTimeline.js";
import { Icon } from "../Icon.js";
import { ToolActivity } from "../ToolActivity.js";
import { Collapse } from "./Collapse.js";
import { editToolPath, isMergeableEdit, MergedFileEdits } from "./MergedFileEdits.js";

/** 可进聚合组的步骤：工具调用，或思考相位。 */
export type ExecutionGroupStep = TimelineToolStep | TimelineReasoningStep;

/** 头部最多露出的相位头像数；更早的折叠成「+N」。 */
const MAX_AVATARS = 6;

export const ExecutionGroup = memo(function ExecutionGroup({
  steps,
  running,
  projectId,
  onPreviewFile,
  onOpenExternal,
  onResolvePermission,
}: {
  /** 连续的工具 + 思考步骤（≥2 个；单步骤不套聚合壳）。 */
  steps: ExecutionGroupStep[];
  /** 轮次是否在运行（驱动活体态：头像光环、shimmer 标签、点阵呼吸灯）。 */
  running: boolean;
  projectId: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
}): React.JSX.Element {
  const phases = steps;
  const lastPhaseIndex = phases.length - 1;

  const tools = useMemo(
    () => phases.filter((step): step is TimelineToolStep => step.kind === "tool").map((step) => step.tool),
    [phases]
  );
  const toolRunning = tools.some((tool) => tool.status === "running" || tool.status === "waiting");
  const thinkingActive = running && phases.some((step) => step.kind === "reasoning" && !step.completed);
  const isLive = toolRunning || thinkingActive;
  const failed = tools.some((tool) => tool.status === "failed" || tool.status === "denied" || tool.status === "unknown");
  const permissionPending = tools.some((tool) => Boolean(tool.permission && !tool.permission.resolved));

  // 自动策略：待授权或出错时展开时间线；手动开合覆盖到状态翻转为止。
  const auto = permissionPending || failed;
  const autoKey = `${String(isLive)}:${String(auto)}`;
  const [manual, setManual] = useState<{ key: string; timeline: boolean }>();
  const timelineMode = manual?.key === autoKey ? manual.timeline : auto;
  const [selectedPhase, setSelectedPhase] = useState<number | null>(null);

  const openPhaseIndex = selectedPhase !== null && selectedPhase < phases.length ? selectedPhase : null;
  const openPhase = openPhaseIndex !== null ? phases[openPhaseIndex] : undefined;
  // 活体内默认收起（流式期间保持安静）；待授权必须能露出来。
  const timelineOpen = (timelineMode && !isLive) || permissionPending;
  const railOpen = timelineOpen || openPhase !== undefined;

  const openTimeline = (next: boolean): void => {
    setManual({ key: autoKey, timeline: next });
    setSelectedPhase(null);
  };
  const togglePhase = (index: number): void => {
    setManual({ key: autoKey, timeline: false });
    setSelectedPhase((prev) => (prev === index ? null : index));
  };

  const allThinking = tools.length === 0;
  const overflowCount = Math.max(0, phases.length - MAX_AVATARS);
  const visiblePhases = overflowCount > 0 ? phases.slice(overflowCount) : phases;
  // 时间线展开体：相邻同路径的 edit 合并成一行（相位头像仍一一对应，不参与合并）。
  const railUnits = useMemo(() => buildRailUnits(phases), [phases]);

  return (
    <section className={`chat-activity${railOpen ? " is-open" : ""}`} data-running={isLive || undefined}>
      {isLive ? <span className="chat-visually-hidden">正在执行</span> : null}
      <div className="chat-activity-header">
        <div className="chat-activity-avatars">
          {overflowCount > 0 ? (
            <button
              aria-label={`${overflowCount} 个更早的相位`}
              className={`chat-activity-overflow${railOpen ? " is-hidden" : ""}`}
              onClick={() => openTimeline(true)}
              title={`${overflowCount} 个更早的相位`}
              type="button"
            >
              +{overflowCount}
            </button>
          ) : null}
          {visiblePhases.map((phase, vi) => {
            const index = overflowCount + vi;
            return (
              <PhaseAvatar
                active={isLive && index === lastPhaseIndex}
                key={phase.id}
                onClick={() => togglePhase(index)}
                phase={phase}
                selected={openPhaseIndex === index}
              />
            );
          })}
        </div>
        <button className="chat-activity-summary" onClick={() => openTimeline(!railOpen)} type="button">
          {isLive ? (
            <span className="chat-activity-live">
              <span className="chat-shimmer-text">{thinkingActive && !toolRunning ? "正在思考" : "正在执行"}</span>
              <WorkingDotGrid />
            </span>
          ) : (
            <span className="chat-activity-summary-text">
              {failed ? <span aria-label="有失败" className="chat-activity-failed-dot" /> : null}
              {allThinking ? thinkingSummaryLabel(phases) : `用了 ${tools.length} 个工具`}
            </span>
          )}
        </button>
        {!allThinking && phases.length > 1 ? (
          <button
            aria-label="时间线视图"
            aria-pressed={timelineOpen}
            className={`chat-activity-icon-btn${timelineOpen ? " is-active" : ""}`}
            onClick={() => openTimeline(!timelineOpen)}
            title="时间线视图"
            type="button"
          >
            <Icon name="list-tree" size={14} />
          </button>
        ) : null}
        <button
          aria-expanded={railOpen}
          aria-label={railOpen ? "收起" : "展开"}
          className="chat-activity-icon-btn chat-activity-chevron"
          onClick={() => openTimeline(!railOpen)}
          title={railOpen ? "收起" : "展开"}
          type="button"
        >
          <Icon name="chevron" size={16} />
        </button>
      </div>
      <Collapse open={railOpen}>
        <div className="chat-activity-rail">
          {openPhase ? (
            <PhaseBody
              key={openPhase.id}
              onOpenExternal={onOpenExternal}
              onPreviewFile={onPreviewFile}
              onResolvePermission={onResolvePermission}
              phase={openPhase}
              projectId={projectId}
              running={running}
              showTitle={!isLive}
            />
          ) : railUnits.map((unit) => unit.kind === "merged" ? (
            <MergedFileEdits
              key={unit.key}
              onPreviewFile={onPreviewFile}
              projectId={projectId}
              tools={unit.tools}
            />
          ) : (
            <PhaseBody
              key={unit.phase.id}
              onOpenExternal={onOpenExternal}
              onPreviewFile={onPreviewFile}
              onResolvePermission={onResolvePermission}
              phase={unit.phase}
              projectId={projectId}
              running={running}
              showTitle={!isLive}
            />
          ))}
        </div>
      </Collapse>
    </section>
  );
});

/** 时间线展开单元：单相位，或同文件连续编辑的合并行。 */
type RailUnit =
  | { kind: "single"; phase: ExecutionGroupStep }
  | { kind: "merged"; key: string; tools: TimelineTool[] };

/**
 * 相邻 + 同路径 + 可合并（edit 带 diff、无权限卡）的工具相位收成合并行；
 * 其余相位原样保留顺序。单个编辑不合并（仍是普通工具行）。
 */
function buildRailUnits(phases: ExecutionGroupStep[]): RailUnit[] {
  const units: RailUnit[] = [];
  let bucket: { phase: TimelineToolStep; path: string }[] = [];
  const flush = (): void => {
    if (bucket.length >= 2) {
      units.push({ kind: "merged", key: bucket[0]!.phase.id, tools: bucket.map((entry) => entry.phase.tool) });
    } else {
      for (const entry of bucket) units.push({ kind: "single", phase: entry.phase });
    }
    bucket = [];
  };
  for (const phase of phases) {
    const path = phase.kind === "tool" && isMergeableEdit(phase.tool) ? editToolPath(phase.tool) : undefined;
    if (phase.kind === "tool" && path !== undefined) {
      if (bucket.length > 0 && bucket[0]!.path !== path) flush();
      bucket.push({ phase, path });
    } else {
      flush();
      units.push({ kind: "single", phase });
    }
  }
  flush();
  return units;
}

/** 相位头像：24px 圆形按钮，叠放分隔；选中/活体有对应态。 */
function PhaseAvatar({ phase, selected, active, onClick }: {
  phase: ExecutionGroupStep;
  selected: boolean;
  /** 是否当前活跃相位（活体光环）。 */
  active: boolean;
  onClick(): void;
}): React.JSX.Element {
  const status = phase.kind === "tool" ? phase.tool.status : undefined;
  const iconName = phase.kind === "tool" ? VARIANT_ICON_NAMES[classifyTool(phase.tool.tool)] : "brain";
  const label = phase.kind === "tool" ? phase.tool.tool : "思考";
  return (
    <button
      aria-label={label}
      aria-pressed={selected}
      className={`chat-activity-avatar${selected ? " is-selected" : ""}${active ? " is-alive" : ""}`}
      data-status={status}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon name={iconName} size={12} />
    </button>
  );
}

/** 展开体内的单个相位：思考带标题 + 正文；工具直接渲染工具行。 */
function PhaseBody({ phase, running, showTitle, projectId, onPreviewFile, onOpenExternal, onResolvePermission }: {
  phase: ExecutionGroupStep;
  running: boolean;
  showTitle: boolean;
  projectId: string;
  onPreviewFile(path: string): void;
  onOpenExternal(url: string): void;
  onResolvePermission(requestId: string, result: PermissionResult): Promise<void>;
}): React.JSX.Element {
  if (phase.kind === "tool") {
    return (
      <ToolActivity
        onOpenExternal={onOpenExternal}
        onPreviewFile={onPreviewFile}
        onResolvePermission={onResolvePermission}
        projectId={projectId}
        tool={phase.tool}
      />
    );
  }
  const seconds = phase.durationMs !== undefined ? Math.max(1, Math.round(phase.durationMs / 1000)) : undefined;
  const streaming = running && !phase.completed;
  return (
    <div className="chat-activity-phase">
      {showTitle ? (
        <div className="chat-activity-phase-title">
          <span className="chat-activity-phase-verb">{streaming ? "正在思考" : "思考"}</span>
          {!streaming && seconds !== undefined ? <span className="chat-activity-phase-rest"> 了 {seconds} 秒</span> : null}
        </div>
      ) : null}
      <div className="chat-activity-thinking-text">{reasoningDetailText(phase)}</div>
    </div>
  );
}

/** 活体状态徽章：2 列 × 4 行点阵，按列优先错峰呼吸（对齐 Alma 的 WorkingDotGrid）。 */
function WorkingDotGrid(): React.JSX.Element {
  return (
    <span aria-hidden="true" className="chat-working-dots">
      {Array.from({ length: 8 }, (_, i) => {
        const row = Math.floor(i / 2);
        const col = i % 2;
        return <span key={i} style={{ animationDelay: `${((col * 4 + row) * 0.25).toFixed(2)}s` }} />;
      })}
    </span>
  );
}

/** 纯思考组的汇总文案：思考 了 N 秒（取累计耗时）。 */
function thinkingSummaryLabel(phases: ExecutionGroupStep[]): string {
  const totalMs = phases.reduce((sum, phase) => sum + (phase.kind === "reasoning" ? phase.durationMs ?? 0 : 0), 0);
  const seconds = Math.max(1, Math.round(totalMs / 1000));
  return `思考 了 ${seconds} 秒`;
}
