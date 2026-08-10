import type { GraphEdge, GraphEdgeKind, GraphNode, GraphNodeKind, SerializedGraph } from './types.js';

let edgeCounter = 0;
function nodeId(kind: GraphNodeKind, label: string): string {
  return `n${kind[0]}-${label.replace(/[^a-z0-9]/gi, '').slice(-40)}`;
}
function edgeId(): string {
  return `edge${edgeCounter++}`;
}

export class ContextGraph {
  nodes = new Map<string, GraphNode>();
  edges: GraphEdge[] = [];

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.length;
  }

  upsertNode(kind: GraphNodeKind, label: string, data: Record<string, unknown> = {}): string {
    const id = nodeId(kind, label);
    const existing = this.nodes.get(id);
    if (existing) {
      existing.ts = Date.now();
      existing.data = { ...existing.data, ...data };
      return id;
    }
    this.nodes.set(id, { id, kind, label, ts: Date.now(), data });
    return id;
  }

  addEdge(source: string, target: string, kind: GraphEdgeKind, weight = 1): void {
    const existing = this.edges.find(
      (e) => e.source === source && e.target === target && e.kind === kind
    );
    if (existing) {
      existing.ts = Date.now();
      existing.weight = Math.min(5, existing.weight + weight);
      return;
    }
    this.edges.push({ source, target, kind, ts: Date.now(), weight });
  }

  relate(sourceKind: GraphNodeKind, sourceLabel: string, targetKind: GraphNodeKind, targetLabel: string, kind: GraphEdgeKind): void {
    const a = this.upsertNode(sourceKind, sourceLabel);
    const b = this.upsertNode(targetKind, targetLabel);
    this.addEdge(a, b, kind);
  }

  private neighborsOf(id: string): GraphNode[] {
    const out: GraphNode[] = [];
    const seen = new Set<string>();
    for (const e of this.edges) {
      let other: string | null = null;
      if (e.source === id) other = e.target;
      else if (e.target === id) other = e.source;
      if (other && !seen.has(other)) {
        seen.add(other);
        const n = this.nodes.get(other);
        if (n) out.push(n);
      }
    }
    return out;
  }

  relatedTo(label: string): GraphNode[] {
    let target: GraphNode | null = null;
    for (const n of this.nodes.values()) {
      if (n.label === label) {
        target = n;
        break;
      }
    }
    if (!target) return [];
    return this.neighborsOf(target.id);
  }

  nodesOfKind(kind: GraphNodeKind): GraphNode[] {
    return [...this.nodes.values()].filter((n) => n.kind === kind);
  }

  edgesOfKind(kind: GraphEdgeKind): GraphEdge[] {
    return this.edges.filter((e) => e.kind === kind);
  }

  /** Decisoes que afetaram um modulo (via arestas affects/relates_to). */
  decisionsFor(moduleLabel: string): GraphNode[] {
    const related = this.relatedTo(moduleLabel);
    return related.filter((n) => n.kind === 'decision');
  }

  errorsFor(componentLabel: string): GraphNode[] {
    const related = this.relatedTo(componentLabel);
    return related.filter((n) => n.kind === 'error');
  }

  changesFor(fileLabel: string): GraphNode[] {
    const related = this.relatedTo(fileLabel);
    return related.filter((n) => n.kind === 'change');
  }

  /** Arquivos relacionados a um arquivo: imports + imported_by + mesma funcionalidade. */
  filesRelatedTo(fileLabel: string): string[] {
    const related = this.relatedTo(fileLabel);
    const out = new Set<string>();
    for (const n of related) {
      if (n.kind === 'file') out.add(n.label);
      if (n.data && typeof n.data.file === 'string') out.add(n.data.file as string);
    }
    return [...out];
  }

  serialize(): SerializedGraph {
    return { nodes: [...this.nodes.values()], edges: this.edges };
  }

  static deserialize(sg: SerializedGraph): ContextGraph {
    const g = new ContextGraph();
    g.nodes = new Map(sg.nodes.map((n) => [n.id, n]));
    g.edges = sg.edges;
    return g;
  }

  reset(): void {
    this.nodes.clear();
    this.edges = [];
  }
}
