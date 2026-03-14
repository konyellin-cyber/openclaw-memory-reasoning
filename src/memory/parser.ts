/**
 * 内部记忆实体拆分器
 *
 * 从 memory/*.md 文件中提取独立的记忆实体:
 * - 按 section (##, ###) 拆分
 * - 提取元数据 (标题、内容、源文件、日期、人物)
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface MemoryEntity {
  id: string;                    // 唯一ID: {文件名}-{section行号}
  title: string;                 // section标题或"无标题"
  content: string;                // 完整内容
  sourceFile: string;             // 源文件路径 (相对 memory/)
  sourceLine: number;             // 在源文件中的起始行号
  date?: string;                  // 日期 (从文件名提取, YYYY-MM-DD 格式)
  level: number;                  // 标题级别 (1=##, 2=###, 3=####)
  people: string[];               // 相关人物 (从人物词典匹配提取)
}

/**
 * 解析单个 memory 文件,返回实体列表
 */
export function parseMemoryFile(
  filePath: string,
  relativePath: string,
  peopleDictionary?: PersonEntry[],
): MemoryEntity[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const entities: MemoryEntity[] = [];

  let currentEntity: {
    title: string;
    content: string[];
    startLine: number;
    level: number;
  } | null = null;

  // 尝试从文件名提取日期
  const dateMatch = relativePath.match(/(\d{4}-\d{2}-\d{2})/);
  const fileDate = dateMatch ? dateMatch[1] : undefined;

  // 上级标题日期栈: parentDates[level] = 该级别标题的日期
  // 子标题可从最近的有日期的父标题继承日期
  // 例如: ## 2026-03-05：xxx → parentDates[2] = "2026-03-05"
  //       ### 理由 (无日期) → 继承 parentDates[2]
  const parentDates: Record<number, string | undefined> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 检测标题 (##, ###, ####)
    const headerMatch = line.match(/^(#{2,4})\s+(.+)$/);

    if (headerMatch) {
      // 如果之前有未完成的实体,先保存
      if (currentEntity) {
        const inheritedDate = resolveInheritedDate(currentEntity.level + 1, parentDates);
        const effectiveDate = inheritedDate ?? fileDate;
        const entity = finalizeEntity(currentEntity, lines, i, relativePath, effectiveDate, peopleDictionary);
        if (entity) {
          entities.push(entity);
        }
      }

      // 开始新实体
      const level = headerMatch[1].length; // ## = 2, ### = 3, #### = 4
      const title = headerMatch[2].trim();

      // 更新上级标题日期栈
      const titleDate = parseDateFromTitle(title);
      if (titleDate) {
        parentDates[level] = titleDate;
      }
      // 清除所有更低级别的日期缓存 (当遇到新的同级/更高级标题时)
      for (const k of Object.keys(parentDates)) {
        if (Number(k) > level) {
          delete parentDates[Number(k)];
        }
      }

      currentEntity = {
        title,
        content: [],
        startLine: i + 1, // 行号从1开始
        level: level - 1, // ## = 1, ### = 2
      };
    } else if (currentEntity) {
      // 添加到当前实体的内容
      currentEntity.content.push(line);
    }
  }

  // 保存最后一个实体
  if (currentEntity) {
    const inheritedDate = resolveInheritedDate(currentEntity.level + 1, parentDates);
    const effectiveDate = inheritedDate ?? fileDate;
    const entity = finalizeEntity(currentEntity, lines, lines.length, relativePath, effectiveDate);
    if (entity) {
      entities.push(entity);
    }
  }

  return entities;
}

/**
 * 从上级标题日期栈中解析继承的日期
 *
 * 查找当前标题级别及所有更高级别标题中最近的日期
 * 例如 ### (level=3) 会先看自己标题日期，再看 ## (level=2) 的日期
 */
function resolveInheritedDate(
  currentLevel: number,
  parentDates: Record<number, string | undefined>,
): string | undefined {
  // 从当前级别往上查找最近的有日期的标题
  for (let lvl = currentLevel; lvl >= 2; lvl--) {
    if (parentDates[lvl]) {
      return parentDates[lvl];
    }
  }
  return undefined;
}

/**
 * 从标题文本中提取日期 (YYYY-MM-DD)
 *
 * 支持的标题格式:
 * - "## 2026-03-05：贴图流量重心"
 * - "## 2026-02-18 | 从法国大革命到组织扁平化"
 * - "### 技术价值 ≠ 商业价值（2026-02-23）"
 * - "### 明确设定的规则（2026-02-18）"
 * - "### 2026-02-26" (纯日期标题)
 * - "## 文档结构（2026-03-01 拆分）"
 * - "## 2026-03-05~06 | 犀牛鸟精英人才计划"
 */
function parseDateFromTitle(title: string): string | undefined {
  const m = title.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : undefined;
}

/**
 * 完成实体构建
 *
 * 日期提取优先级:
 * 1. Section 标题中的日期
 * 2. 文件名中的日期
 * 3. 留空 (由 index-builder fallback 到运行时间)
 */
function finalizeEntity(
  partial: {
    title: string;
    content: string[];
    startLine: number;
    level: number;
  },
  allLines: string[],
  endLine: number,
  sourceFile: string,
  date?: string,
  peopleDictionary?: PersonEntry[],
): MemoryEntity | null {
  // 过滤内容,移除空行
  const contentLines = partial.content.filter((l) => l.trim().length > 0);

  // 跳过内容过少的实体 (< 50 字符)
  const fullContent = contentLines.join("\n");
  if (fullContent.length < 50) {
    return null;
  }

  // 跳过纯列表 (少于3个非列表行)
  const nonListLines = contentLines.filter((l) => !l.trim().startsWith("-") && !l.trim().startsWith("*"));
  if (nonListLines.length < 3) {
    return null;
  }

  // 日期: 由调用方已解析好 (标题日期 > 继承日期 > 文件名日期)
  const resolvedDate = date;

  // 生成唯一ID
  const fileId = sourceFile.replace(/[^a-zA-Z0-9]/g, "_");
  const id = `${fileId}-${partial.startLine}`;

  // 提取人物关联属性
  const people = peopleDictionary ? extractPeople(partial.title, fullContent, peopleDictionary) : [];

  return {
    id,
    title: partial.title,
    content: fullContent,
    sourceFile,
    sourceLine: partial.startLine,
    date: resolvedDate,
    level: partial.level,
    people,
  };
}

// ─── 实体关联属性提取 ───

/**
 * 人物词典条目
 */
export interface PersonEntry {
  id: string;       // 企微 ID (如 "dreamtian")
  name: string;     // 中文姓名 (如 "田帅")
}

/**
 * 从 facts/work.md 的身份速查表加载人物词典
 *
 * 解析表格格式:
 * | 企微 ID | 姓名 | 角色 | 与我的关系 |
 * |---------|------|------|-----------|
 * | plancklin | 林康熠 | ... | ... |
 */
export function loadPeopleDictionary(memoryDir: string): PersonEntry[] {
  const workMdPath = join(memoryDir, "facts", "work.md");
  if (!existsSync(workMdPath)) {
    return [];
  }

  const content = readFileSync(workMdPath, "utf-8");
  const lines = content.split("\n");
  const people: PersonEntry[] = [];

  let inTable = false;
  let headerSeen = false;

  for (const line of lines) {
    if (line.includes("企微 ID") && line.includes("姓名")) {
      inTable = true;
      headerSeen = false;
      continue;
    }

    if (inTable) {
      if (line.match(/^\|[\s-|]+\|$/)) {
        headerSeen = true;
        continue;
      }

      if (headerSeen && line.startsWith("|")) {
        const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
        if (cells.length >= 2) {
          const id = cells[0].replace(/\*\*/g, "").trim();
          const name = cells[1].replace(/\*\*/g, "").trim();
          if (id && name && id !== "企微 ID") {
            people.push({ id, name });
          }
        }
      }

      if (line.trim() === "" || (line.startsWith("#") && headerSeen)) {
        inTable = false;
      }
    }
  }

  return people;
}

/**
 * 从内容中提取相关人物
 *
 * 匹配策略: 扫描 section 标题 + 内容，匹配人物词典中的企微 ID 或中文姓名
 */
function extractPeople(title: string, content: string, peopleDictionary: PersonEntry[]): string[] {
  if (peopleDictionary.length === 0) return [];

  const text = title + "\n" + content;
  const matched: string[] = [];

  for (const person of peopleDictionary) {
    // 匹配企微 ID（需要词边界，避免 "and" 匹配到 "andrewang" 等问题）
    const idRegex = new RegExp(`(?<![a-zA-Z0-9])${escapeRegExp(person.id)}(?![a-zA-Z0-9])`, "i");
    if (idRegex.test(text)) {
      if (!matched.includes(person.id)) {
        matched.push(person.id);
      }
      continue;
    }

    // 匹配中文姓名（精确匹配，中文无需词边界）
    if (person.name && text.includes(person.name)) {
      if (!matched.includes(person.id)) {
        matched.push(person.id);
      }
    }
  }

  return matched;
}

/**
 * 正则转义辅助函数
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 批量解析 memory 目录
 *
 * 自动加载人物词典，传递给每个文件的 parser
 */
export function parseMemoryDirectory(memoryDir: string): MemoryEntity[] {
  const entities: MemoryEntity[] = [];

  // 加载人物词典
  const peopleDictionary = loadPeopleDictionary(memoryDir);

  function traverse(dir: string, relativePath: string) {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = join(relativePath, entry.name);

      if (entry.isDirectory()) {
        traverse(fullPath, relPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const fileEntities = parseMemoryFile(fullPath, relPath, peopleDictionary);
        entities.push(...fileEntities);
      }
    }
  }

  traverse(memoryDir, "");

  return entities;
}
