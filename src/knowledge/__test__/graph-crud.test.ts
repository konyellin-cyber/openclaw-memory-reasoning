/**
 * graph.ts Phase 2 CRUD 单元测试
 * 运行: npx tsx src/knowledge/__test__/graph-crud.test.ts
 */

import {
  type SemanticGraph,
  type GraphNode,
  addNode,
  removeNode,
  addEdge,
  removeEdge,
  movePapers,
  getChildren,
  getNeighbors,
  getTopLevelNodes,
  getNode,
  addPaperToNode,
  hasPaper,
} from "../graph.js";

// ─── helpers ───

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function makeGraph(): SemanticGraph {
  return {
    version: 1,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    nodes: [
      {
        id: "root",
        description: "根节点",
        parent: null,
        papers: ["p1", "p2", "p3", "p4", "p5"],
        edges: [],
      },
    ],
  };
}

// ─── tests ───

console.log("\n=== addNode ===");
{
  const g = makeGraph();
  const newNode: GraphNode = {
    id: "multi-obj",
    description: "多目标优化",
    parent: "root",
    papers: [],
    edges: [],
  };
  assert(addNode(g, newNode) === true, "addNode returns true for new node");
  assertEqual(g.nodes.length, 2, "graph has 2 nodes");
  assert(addNode(g, newNode) === false, "addNode returns false for duplicate");
  assertEqual(g.nodes.length, 2, "graph still has 2 nodes after duplicate");
}

console.log("\n=== removeNode ===");
{
  const g = makeGraph();
  addNode(g, { id: "child1", description: "c1", parent: "root", papers: [], edges: [] });
  addNode(g, { id: "child2", description: "c2", parent: "root", papers: [], edges: [{ target: "child1", relation: "related" }] });
  assert(removeNode(g, "child1") === true, "removeNode returns true");
  assertEqual(g.nodes.length, 2, "graph has 2 nodes after removal");
  // child2 的指向 child1 的边应被清理
  const child2 = getNode(g, "child2")!;
  assertEqual(child2.edges.length, 0, "child2 edge to child1 cleaned up");
}

console.log("\n=== removeNode cleans up parent refs ===");
{
  const g = makeGraph();
  addNode(g, { id: "parent-node", description: "parent", parent: "root", papers: [], edges: [] });
  addNode(g, { id: "grandchild", description: "gc", parent: "parent-node", papers: [], edges: [] });
  removeNode(g, "parent-node");
  const gc = getNode(g, "grandchild")!;
  assertEqual(gc.parent, null, "grandchild parent reset to null");
}

console.log("\n=== addEdge / removeEdge ===");
{
  const g = makeGraph();
  addNode(g, { id: "a", description: "A", parent: "root", papers: [], edges: [] });
  addNode(g, { id: "b", description: "B", parent: "root", papers: [], edges: [] });

  assert(addEdge(g, "a", { target: "b", relation: "shared-math" }) === true, "addEdge returns true");
  assert(addEdge(g, "a", { target: "b", relation: "dup" }) === false, "addEdge returns false for duplicate");
  assertEqual(getNode(g, "a")!.edges.length, 1, "node a has 1 edge");

  assert(removeEdge(g, "a", "b") === true, "removeEdge returns true");
  assertEqual(getNode(g, "a")!.edges.length, 0, "node a has 0 edges after removal");
  assert(removeEdge(g, "a", "b") === false, "removeEdge returns false when no edge");
  assert(removeEdge(g, "nonexist", "b") === false, "removeEdge returns false for non-existent node");
}

console.log("\n=== movePapers ===");
{
  const g = makeGraph();
  addNode(g, { id: "target", description: "T", parent: "root", papers: [], edges: [] });

  const result = movePapers(g, ["p1", "p3", "p999"], "root", "target");
  assertEqual(result.moved, 2, "moved 2 papers");
  assertEqual(result.notFound, 1, "1 not found (p999)");
  assertEqual(getNode(g, "root")!.papers, ["p2", "p4", "p5"], "root lost p1, p3");
  assertEqual(getNode(g, "target")!.papers, ["p1", "p3"], "target gained p1, p3");
}

console.log("\n=== movePapers dedup ===");
{
  const g = makeGraph();
  addNode(g, { id: "target", description: "T", parent: "root", papers: ["p1"], edges: [] });
  // p1 已在 target 中，移动时不应重复
  const result = movePapers(g, ["p1"], "root", "target");
  assertEqual(result.moved, 1, "reports moved even if target has it");
  assertEqual(getNode(g, "target")!.papers, ["p1"], "target still has p1 once (no dup)");
  assert(!getNode(g, "root")!.papers.includes("p1"), "root no longer has p1");
}

console.log("\n=== movePapers bad nodes ===");
{
  const g = makeGraph();
  const result = movePapers(g, ["p1"], "root", "nonexist");
  assertEqual(result.moved, 0, "0 moved when target doesn't exist");
  assertEqual(result.notFound, 1, "all reported as notFound");
}

console.log("\n=== getChildren ===");
{
  const g = makeGraph();
  addNode(g, { id: "c1", description: "c1", parent: "root", papers: [], edges: [] });
  addNode(g, { id: "c2", description: "c2", parent: "root", papers: [], edges: [] });
  addNode(g, { id: "c3", description: "c3", parent: "c1", papers: [], edges: [] });

  const rootChildren = getChildren(g, "root");
  assertEqual(rootChildren.length, 2, "root has 2 children");
  assertEqual(rootChildren.map((n) => n.id).sort(), ["c1", "c2"], "root children are c1, c2");

  const c1Children = getChildren(g, "c1");
  assertEqual(c1Children.length, 1, "c1 has 1 child");
  assertEqual(c1Children[0].id, "c3", "c1 child is c3");
}

console.log("\n=== getNeighbors ===");
{
  const g = makeGraph();
  addNode(g, { id: "a", description: "A", parent: "root", papers: [], edges: [] });
  addNode(g, { id: "b", description: "B", parent: "root", papers: [], edges: [] });
  addEdge(g, "a", { target: "b", relation: "extends" });
  addEdge(g, "a", { target: "root", relation: "contains" });

  const neighbors = getNeighbors(g, "a");
  assertEqual(neighbors.length, 2, "a has 2 neighbors");
  assertEqual(neighbors.map((n) => n.node.id).sort(), ["b", "root"], "neighbors are b, root");
}

console.log("\n=== getTopLevelNodes ===");
{
  const g = makeGraph();
  addNode(g, { id: "top1", description: "T1", parent: "root", papers: [], edges: [] });
  addNode(g, { id: "top2", description: "T2", parent: null, papers: [], edges: [] });
  addNode(g, { id: "deep", description: "D", parent: "top1", papers: [], edges: [] });

  const tops = getTopLevelNodes(g);
  const topIds = tops.map((n) => n.id).sort();
  assertEqual(topIds, ["root", "top1", "top2"], "top level includes root, top1 (parent=root), top2 (parent=null)");
  assert(!topIds.includes("deep"), "deep is not top level");
}

console.log("\n=== hasPaper cross-node ===");
{
  const g = makeGraph();
  addNode(g, { id: "x", description: "X", parent: "root", papers: ["p99"], edges: [] });
  assert(hasPaper(g, "p1") === true, "p1 found in root");
  assert(hasPaper(g, "p99") === true, "p99 found in node x");
  assert(hasPaper(g, "pNone") === false, "pNone not found anywhere");
}

console.log("\n=== addPaperToNode idempotent ===");
{
  const g = makeGraph();
  assert(addPaperToNode(g, "root", "p1") === false, "duplicate paper returns false");
  assert(addPaperToNode(g, "root", "p100") === true, "new paper returns true");
  assertEqual(g.nodes[0].papers.length, 6, "root has 6 papers");
}

// ─── summary ───

console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed! 🎉\n");
}
