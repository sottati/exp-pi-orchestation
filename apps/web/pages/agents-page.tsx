import { useRuntime } from "../runtime-context";

export function AgentsPage() {
  const { state } = useRuntime();

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Agents</div>
          <div className="page-subtitle">Catalogo del runtime compartido por la UI.</div>
        </div>
        <span className="resource-pill">{state.agents.length} total</span>
      </div>

      <div className="table-view">
        <div className="resource-list">
        {state.agents.map((agent) => (
          <article key={agent.id} className="resource-card">
            <div className="resource-card-header">
              <div>
                <div className="resource-card-title">{agent.name}</div>
                <div className="resource-card-subtitle">{agent.id}</div>
              </div>
              <span className="resource-pill">{agent.maxConcurrency} slots</span>
            </div>
            <div className="resource-grid">
              <div className="resource-field">
                <span className="resource-field-label">Role</span>
                <span className="resource-field-value">{agent.role}</span>
              </div>
              <div className="resource-field">
                <span className="resource-field-label">Capabilities</span>
                <span className="resource-field-value">{agent.capabilities.length}</span>
              </div>
            </div>
            <div className="resource-card-meta">
              {agent.capabilities.map((capability) => (
                <span key={capability} className="resource-pill">
                  {capability}
                </span>
              ))}
            </div>
          </article>
        ))}
        {state.agents.length === 0 && <div className="empty-block">no agents available</div>}
        </div>
      </div>
    </section>
  );
}
