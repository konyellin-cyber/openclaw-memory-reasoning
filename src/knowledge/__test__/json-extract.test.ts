/**
 * extractTopLevelJson 测试
 * 运行: npx tsx src/knowledge/__test__/json-extract.test.ts
 */

function extractTopLevelJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

let passed = 0;
let failed = 0;
function assert(ok: boolean, msg: string) {
  if (ok) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

console.log("\n=== extractTopLevelJson ===");

// 1: 嵌套 JSON（模拟 LLM 真实输出）
const t1 = `some text {"shouldSplit": true, "newNodes": [{"id": "a", "papers": ["p1"]}], "newEdges": []} end`;
const r1 = extractTopLevelJson(t1);
const p1 = JSON.parse(r1!);
assert(p1.shouldSplit === true && p1.newNodes.length === 1, "nested JSON extracted correctly");

// 2: 字符串内花括号
const t2 = `{"reason": "因为{很多}论文", "shouldSplit": false}`;
const p2 = JSON.parse(extractTopLevelJson(t2)!);
assert(p2.shouldSplit === false && p2.reason.includes("{很多}"), "braces inside string handled");

// 3: 深层嵌套
const t3 = JSON.stringify({
  shouldSplit: true,
  newNodes: [
    { id: "multi-obj", description: "多目标", papers: ["p1", "p2", "p3"] },
    { id: "cold-start", description: "冷启动", papers: ["p4", "p5"] },
  ],
  newEdges: [{ from: "multi-obj", to: "cold-start", relation: "共享数学框架" }],
  remainingPapers: ["p6"],
});
const p3 = JSON.parse(extractTopLevelJson(t3)!);
assert(p3.newNodes.length === 2 && p3.newEdges.length === 1, "deep nested with arrays");

// 4: markdown fence 前缀 → stripCodeFences 后仍有前导文字
const t4 = `好的，分析结果如下：\n${t3}`;
const p4 = JSON.parse(extractTopLevelJson(t4)!);
assert(p4.newNodes.length === 2, "leading text before JSON");

// 5: 不完整 JSON
assert(extractTopLevelJson("{incomplete...") === null, "incomplete JSON returns null");

// 6: 无 JSON
assert(extractTopLevelJson("no json here") === null, "no JSON returns null");

// 7: 转义引号
const t7 = `{"key": "value with \\"quotes\\"", "shouldSplit": true}`;
const p7 = JSON.parse(extractTopLevelJson(t7)!);
assert(p7.shouldSplit === true, "escaped quotes handled");

// 8: 588 篇论文级别的大 JSON
const bigNodes = Array.from({ length: 6 }, (_, i) => ({
  id: `node-${i}`,
  description: `description ${i}`,
  papers: Array.from({ length: 100 }, (_, j) => `260${i}.${10000 + j}`),
}));
const bigJson = JSON.stringify({
  shouldSplit: true,
  reason: "test",
  newNodes: bigNodes,
  newEdges: [],
  remainingPapers: ["remain1"],
});
const pBig = JSON.parse(extractTopLevelJson(bigJson)!);
assert(pBig.newNodes.length === 6, `large JSON (${bigJson.length} bytes) parsed correctly`);

console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log("All tests passed! 🎉\n");
