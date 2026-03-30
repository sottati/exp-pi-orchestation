export interface SaveParams {
  type: "decision" | "preference" | "pattern" | "bug" | "architecture" | "conversation_summary";
  title: string;
  content: string;
}

export interface MemoryResult {
  id: number;
  title: string;
  content: string;
  type: string;
}

export class MemoryClient {
  private baseUrl: string;
  private sessionId: string;

  constructor(baseUrl?: string, sessionId?: string) {
    this.baseUrl = baseUrl ?? process.env.ENGRAM_URL ?? "http://localhost:7437";
    this.sessionId = sessionId ?? process.env.ENGRAM_SESSION_ID ?? "pi-agent";
  }

  async save(params: SaveParams): Promise<number | undefined> {
    try {
      const res = await fetch(`${this.baseUrl}/observations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: this.sessionId,
          type: params.type,
          title: params.title,
          content: params.content,
          scope: "project",
        }),
      });
      if (!res.ok) {
        return undefined;
      }
      const data = (await res.json()) as { id: number };
      return data.id;
    } catch {
      return undefined;
    }
  }

  async search(query: string, limit = 5): Promise<MemoryResult[]> {
    try {
      const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
      const res = await fetch(url);
      if (!res.ok) {
        return [];
      }
      const data = (await res.json()) as MemoryResult[];
      return data;
    } catch {
      return [];
    }
  }
}
