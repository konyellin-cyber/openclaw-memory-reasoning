---
name: semantic-navigator
description: Semantic navigation for knowledge graphs. Supports both external papers and internal memory. Use when: (1) Browsing academic papers by topic, (2) Exploring internal memory by semantic topics, (3) Finding recent content in specific areas, (4) Discovering related knowledge through node connections.
---

# Semantic Navigator

## Overview

This skill provides semantic navigation through knowledge graphs, supporting both external papers and internal memory. It replaces the legacy `navigate_knowledge` plugin tool with a more flexible, source-aware navigation system.

## Core Capabilities

### 1. Dual Source Support

**External Papers** (`--source papers`):
- Navigates academic papers organized by semantic topics
- Data stored in: `~/.openclaw/personal-rec/knowledge/`
- Content type: Research papers, articles, summaries

**Internal Memory** (`--source memory`):
- Navigates personal memories organized by semantic topics
- Data stored in: `~/.openclaw/memory-index/`
- Content type: Decisions, insights, logs, people

### 2. Navigation Actions

**`--action overview`**:
- Returns top-level topic nodes
- Shows node statistics (total items, active nodes)
- Starting point for exploration

**`--action explore --nodeId <id>`**:
- Explores a specific node
- Shows sub-topics, neighbors, edge descriptions
- Reveals relationship context

**`--action read --nodeId <id>`**:
- Reads content cards under a node
- Supports pagination (`--limit`, `--offset`)
- Supports time filtering (`--since`)

### 3. Smart Query Support

When users ask to find content, analyze their intent:

| User Query Pattern | Mapped Action |
|-------------------|---------------|
| "Find papers about X" | `overview` → find relevant node → `read` |
| "What did I decide about X?" | `overview` (source=memory) → find decision node → `read` |
| "Recent papers in topic X" | `explore` node X → `read` with `--since` |
| "Explore knowledge about X" | `overview` → `explore` relevant node |

## Interaction Patterns

### Pattern A: General Browse
```
User: "帮我找关于推荐系统的论文"
→ Use: `--source papers --action overview`
→ Find "recommendation" related node
→ Call: `--source papers --action read --nodeId <rec-node-id>`
```

### Pattern B: Memory Retrieval
```
User: "我最近写了哪些决策？"
→ Use: `--source memory --action overview`
→ Find "decisions" node
→ Call: `--source memory --action read --nodeId <decision-node-id> --since 2026-03-01`
```

### Pattern C: Deep Exploration
```
User: "深入看看推荐 Scaling 这个方向"
→ Call: `--source papers --action explore --nodeId scaling-node-id`
→ Explore sub-nodes (e.g., "model scaling", "infrastructure scaling")
→ Read papers in specific sub-nodes
```

### Pattern D: Recent Content Filter
```
User: "最近一周有哪些新的论文？"
→ Use: `--source papers --action overview`
→ Call: `--action read --nodeId root --since 2026-03-01`
```

## Implementation Details

### Data Directory Resolution

```typescript
// source="papers" → ~/.openclaw/personal-rec/knowledge/
// source="memory" → ~/.openclaw/memory-index/

function getDataDir(source: SourceType): string {
  const home = homedir();
  if (source === "papers") {
    return join(home, ".openclaw", "personal-rec", "knowledge");
  } else {
    return join(home, ".openclaw", "memory-index");
  }
}
```

### Core Functions

1. **overview(source)**:
   - Load graph from data directory
   - Call `getTopLevelNodes()`
   - Calculate statistics (total items, node distribution)
   - Format as Markdown list

2. **explore(source, nodeId)**:
   - Load graph
   - Call `getNode(nodeId)`, `getChildren(nodeId)`, `getNeighbors(nodeId)`
   - Format node info + relationships

3. **read(source, nodeId, opts)**:
   - Load node cards via `loadNodeCards()`
   - Apply filters (limit, offset, since)
   - Sort by date (newest first)
   - Format as card list

## Error Handling

- **Invalid nodeId**: Return error with available nodes
- **Empty node**: Return "No content in this node" message
- **Invalid source**: Return "source must be 'papers' or 'memory'"
- **File not found**: Check if data directory exists, suggest initialization

## Migration from Plugin

The `navigate_knowledge` plugin tool is deprecated. This skill provides:

- ✅ All original functionality (overview, explore, read_papers)
- ✅ Source separation (papers vs memory)
- ✅ Cleaner CLI interface (`--source`, `--action`)

Migration guide:
- Old: `navigate_knowledge action="overview"`
- New: `semantic-navigator --source papers --action overview`

## Best Practices

1. **Always start with overview** when browsing a new area
2. **Use limit wisely** to avoid token overflow on large nodes
3. **Leverage edge descriptions** to understand semantic relationships
4. **Use --since for recent content** to avoid stale data
5. **Cross-reference sources**: Check both papers and memory for comprehensive view
