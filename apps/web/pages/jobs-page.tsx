import type { ScheduledJob } from "../../../packages/core/contracts";
import { statusBadgeClassName } from "../lib/agent-colors";
import { useRuntime } from "../runtime-context";

function formatDate(timestamp?: number) {
  if (!timestamp) return "n/a";
  return new Date(timestamp).toLocaleString();
}

function describeSchedule(job: ScheduledJob): string {
  if (job.schedule.type === "cron") {
    return `cron: ${job.schedule.cron ?? "?"}`;
  }
  if (job.schedule.type === "once") {
    return `once: ${formatDate(job.schedule.runAt)}`;
  }
  return `delay: ${job.schedule.delayMs ?? 0}ms`;
}

export function JobsPage() {
  const { state } = useRuntime();

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-1 border-b border-theme-border bg-theme-surface px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-theme-text">scheduled jobs</div>
            <div className="text-[11px] text-theme-border-subdued">Estado del scheduler con refresco en vivo desde el runtime.</div>
          </div>
          <span className="inline-flex items-center border border-theme-border-subdued px-2 py-[2px] text-[10px] uppercase tracking-[0.06em] text-theme-text">
            {state.jobs.length} jobs
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {state.jobs.length === 0 ? (
          <div className="px-5 py-[18px] text-[12px] text-theme-border-subdued">No hay jobs programados en esta sesión.</div>
        ) : (
          <div className="flex flex-col gap-2.5 px-5 py-4">
            <div className="flex flex-col gap-2.5">
              {state.jobs.map((job) => (
                <article
                  key={job.jobId}
                  className="flex flex-col gap-2.5 border border-theme-border bg-theme-input px-[14px] py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.08em] text-theme-text">{job.jobId}</div>
                      <div className="break-words text-[11px] text-theme-border-subdued">{job.task}</div>
                    </div>
                    <span className={statusBadgeClassName(job.status)} data-status={job.status}>
                      {job.status}
                    </span>
                  </div>

                  <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-x-3 gap-y-2">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-[0.06em] text-theme-border-subdued">target</span>
                      <span className="break-words text-[12px] text-theme-text">{job.targetAgentId}</span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-[0.06em] text-theme-border-subdued">schedule</span>
                      <span className="break-words text-[12px] text-theme-text">{describeSchedule(job)}</span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-[0.06em] text-theme-border-subdued">next run</span>
                      <span className="break-words text-[12px] text-theme-text">{formatDate(job.nextRunAt)}</span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-[0.06em] text-theme-border-subdued">last run</span>
                      <span className="break-words text-[12px] text-theme-text">{formatDate(job.lastRunAt)}</span>
                    </div>
                  </div>

                  {job.error && (
                    <pre className="border-t border-dashed border-theme-border pt-2.5 text-[12px] break-words whitespace-pre-wrap text-theme-button-foreground">
                      {job.error}
                    </pre>
                  )}
                </article>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
