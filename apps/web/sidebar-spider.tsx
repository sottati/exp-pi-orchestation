import React from "react";
import type { Frame } from "./dithie-frames";
import {
  FRAME_DELEGATING,
  FRAME_ERROR,
  FRAME_IDLE,
  FRAME_IDLE_BLINK,
  FRAME_THINKING_1,
  FRAME_THINKING_3,
} from "./dithie-frames";

interface SidebarSpiderIconProps {
  agentId: string;
  size?: number;
}

type Pixel = [number, number];

function cloneFrame(frame: Frame): Frame {
  return frame.map((row) => [...row]);
}

function mutateFrame(base: Frame, on: Pixel[] = [], off: Pixel[] = []): Frame {
  const next = cloneFrame(base);
  for (const [r, c] of on) {
    if (next[r] && typeof next[r][c] === "number") next[r][c] = 1;
  }
  for (const [r, c] of off) {
    if (next[r] && typeof next[r][c] === "number") next[r][c] = 0;
  }
  return next;
}

const FRAME_CODE = mutateFrame(
  FRAME_THINKING_1,
  [
    [10, 6], [10, 9],
    [11, 6], [11, 9],
    [12, 6], [12, 9],
    [13, 7], [13, 8],
  ],
  [
    [1, 2], [1, 14], [14, 0], [14, 15],
    [13, 1], [13, 14],
  ],
);

const FRAME_MATH = mutateFrame(
  FRAME_THINKING_3,
  [
    [11, 7], [11, 8],
    [12, 7], [12, 8],
    [13, 7], [13, 8],
  ],
  [
    [1, 0], [1, 15],
  ],
);

const FRAME_EXPLORER = mutateFrame(
  FRAME_DELEGATING,
  [
    [2, 2], [2, 13],
    [3, 1], [3, 14],
  ],
  [
    [12, 6], [12, 9],
  ],
);

const FRAME_WRITER = mutateFrame(
  FRAME_IDLE_BLINK,
  [
    [12, 7], [12, 8],
    [13, 6], [13, 7], [13, 8], [13, 9],
    [14, 7], [14, 8],
  ],
  [
    [1, 2], [1, 13],
  ],
);

const FRAME_DEBUGGER = mutateFrame(
  FRAME_ERROR,
  [
    [3, 7], [3, 8],
    [4, 6], [4, 9],
    [10, 5], [10, 10],
  ],
  [
    [14, 7], [14, 8],
  ],
);

const FRAME_SECRETARY = mutateFrame(
  FRAME_IDLE,
  [
    [3, 7], [3, 8],
    [4, 7], [4, 8],
    [8, 7], [8, 8],
  ],
  [
    [1, 2], [1, 13],
    [14, 0], [14, 15],
  ],
);

const SPECIALIST_FRAMES: Record<string, Frame> = {
  code: FRAME_CODE,
  math: FRAME_MATH,
  explorer: FRAME_EXPLORER,
  writer: FRAME_WRITER,
  debugger: FRAME_DEBUGGER,
  secretary: FRAME_SECRETARY,
};

export function SidebarSpiderIcon({ agentId, size = 22 }: SidebarSpiderIconProps) {
  const frame = SPECIALIST_FRAMES[agentId] ?? FRAME_IDLE;
  const pixels = frame.flatMap((row, y) =>
    row.flatMap((pixel, x) => (pixel === 1 ? [[x, y] as const] : [])),
  );

  return (
    <svg
      className={`sidebar-spider sidebar-spider--${agentId}`}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      {pixels.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />
      ))}
    </svg>
  );
}
