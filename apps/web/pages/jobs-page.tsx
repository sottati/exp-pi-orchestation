import type { ScheduledJob } from "../../../packages/core/contracts";
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
    <section className="page stack-page">
      <div className="page-header">
        <div>
          <div className="page-title">scheduled jobs</div>
          <div className="page-subtitle">Estado del scheduler con refresco en vivo desde el runtime.</div>
        </div>
        <span className="resource-pill">{state.jobs.length} jobs</span>
      </div>

      <div className="page-body">
        {state.jobs.length === 0 ? (
          <div className="empty-block">No hay jobs programados en esta sesión.</div>
        ) : (
          <div className="table-view">
            <div className="resource-list">
              {state.jobs.map((job) => (
                <article key={job.jobId} className="resource-card">
                  <div className="resource-card-header">
                    <div>
                      <div className="resource-card-title">{job.jobId}</div>
                      <div className="resource-card-subtitle">{job.task}</div>
                    </div>
                    <span className="resource-pill" data-status={job.status}>{job.status}</span>
                  </div>

                  <div className="resource-grid">
                    <div className="resource-field">
                      <span className="resource-field-label">target</span>
                      <span className="resource-field-value">{job.targetAgentId}</span>
                    </div>
                    <div className="resource-field">
                      <span className="resource-field-label">schedule</span>
                      <span className="resource-field-value">{describeSchedule(job)}</span>
                    </div>
                    <div className="resource-field">
                      <span className="resource-field-label">next run</span>
                      <span className="resource-field-value">{formatDate(job.nextRunAt)}</span>
                    </div>
                    <div className="resource-field">
                      <span className="resource-field-label">last run</span>
                      <span className="resource-field-value">{formatDate(job.lastRunAt)}</span>
                    </div>
                  </div>

                  {job.error && <pre className="resource-pre">{job.error}</pre>}
                </article>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
