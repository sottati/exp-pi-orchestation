import React, { useRef, useEffect, useState, useCallback } from "react";
import type { Frame } from "./dithie-frames";
import {
  FRAME_IDLE,
  FRAME_IDLE_BLINK,
  FRAME_THINKING_1,
  FRAME_THINKING_2,
  FRAME_THINKING_3,
  FRAME_THINKING_4,
  FRAME_DELEGATING,
  FRAME_ERROR,
} from "./dithie-frames";

export interface DithieSpriteProps {
  size: 16 | 32 | 64;
  state: "idle" | "thinking" | "walking" | "delegating" | "error";
}

const THINKING_FRAMES: Frame[] = [
  FRAME_THINKING_1,
  FRAME_THINKING_2,
  FRAME_THINKING_3,
  FRAME_THINKING_4,
];

const WALKING_FRAMES: Frame[] = [
  FRAME_THINKING_1,
  FRAME_THINKING_3,
];

// ─── Canvas renderer (size=64) ────────────────────────────────────────────────

function DithieCanvas({ frame }: { frame: Frame }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, 64, 64);
    ctx.fillStyle = "#ffffff";

    for (let row = 0; row < frame.length; row++) {
      const frameRow = frame[row];
      if (!frameRow) continue;
      for (let col = 0; col < frameRow.length; col++) {
        if (frameRow[col] === 1) {
          // Each pixel in the 16x16 frame maps to a 4x4 block on the 64x64 canvas
          ctx.fillRect(col * 4, row * 4, 4, 4);
        }
      }
    }
  }, [frame]);

  return <canvas ref={canvasRef} width={64} height={64} />;
}

// ─── CSS Grid renderer (size=16 or 32) ───────────────────────────────────────

function DithieGrid({ frame, size }: { frame: Frame; size: 16 | 32 }) {
  const cellSize = size / 16; // 1px for size=16, 2px for size=32
  const cols = frame[0]?.length ?? 16;

  return (
    <div
      className="dithie-sprite"
      style={{
        display: "inline-grid",
        gridTemplateColumns: `repeat(${cols}, ${cellSize}px)`,
        width: size,
        height: size,
      }}
    >
      {frame.flatMap((row, rowIdx) =>
        row.map((pixel, colIdx) => (
          <div
            key={`${rowIdx}-${colIdx}`}
            style={{
              width: cellSize,
              height: cellSize,
              background: pixel === 1 ? "#ffffff" : "transparent",
            }}
          />
        ))
      )}
    </div>
  );
}

// ─── DithieSprite ─────────────────────────────────────────────────────────────

export function DithieSprite({ size, state }: DithieSpriteProps) {
  const [currentFrame, setCurrentFrame] = useState<Frame>(() => {
    switch (state) {
      case "idle":        return FRAME_IDLE;
      case "thinking":    return FRAME_THINKING_1;
      case "walking":     return FRAME_THINKING_1;
      case "delegating":  return FRAME_DELEGATING;
      case "error":       return FRAME_ERROR;
    }
  });

  // Animation: depends on state prop
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    let blinkTimeout: ReturnType<typeof setTimeout> | null = null;
    let blinkRestoreTimeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (interval !== null) clearInterval(interval);
      if (blinkTimeout !== null) clearTimeout(blinkTimeout);
      if (blinkRestoreTimeout !== null) clearTimeout(blinkRestoreTimeout);
    };

    if (state === "idle") {
      setCurrentFrame(FRAME_IDLE);

      const scheduleBlink = () => {
        blinkTimeout = setTimeout(() => {
          setCurrentFrame(FRAME_IDLE_BLINK);
          blinkRestoreTimeout = setTimeout(() => {
            setCurrentFrame(FRAME_IDLE);
            // schedule next blink
            blinkTimeout = setTimeout(scheduleBlink, 3000);
          }, 150);
        }, 3000);
      };

      scheduleBlink();
    } else if (state === "thinking") {
      let frameIndex = 0;
      setCurrentFrame(FRAME_THINKING_1);

      interval = setInterval(() => {
        frameIndex = (frameIndex + 1) % THINKING_FRAMES.length;
        const nextFrame = THINKING_FRAMES[frameIndex];
        if (nextFrame) setCurrentFrame(nextFrame);
      }, 500);
    } else if (state === "walking") {
      let frameIndex = 0;
      setCurrentFrame(WALKING_FRAMES[frameIndex] ?? FRAME_THINKING_1);

      interval = setInterval(() => {
        frameIndex = (frameIndex + 1) % WALKING_FRAMES.length;
        const nextFrame = WALKING_FRAMES[frameIndex];
        if (nextFrame) setCurrentFrame(nextFrame);
      }, 220);
    } else if (state === "delegating") {
      setCurrentFrame(FRAME_DELEGATING);
    } else if (state === "error") {
      setCurrentFrame(FRAME_ERROR);
    }

    return cleanup;
  }, [state]);

  const isBreathing = state === "idle";
  const isWalking = state === "walking";

  const inner =
    size === 64 ? (
      <DithieCanvas frame={currentFrame} />
    ) : (
      <DithieGrid frame={currentFrame} size={size} />
    );

  return (
    <div
      className={`dithie-sprite${isBreathing ? " dithie-sprite--breathing" : ""}${isWalking ? " dithie-sprite--walking" : ""}`}
      style={{ display: "inline-block", lineHeight: 0 }}
    >
      {inner}
    </div>
  );
}
