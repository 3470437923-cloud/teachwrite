/**
 * 工具 schema（描述串沿用既有原文，保持逐字一致）。
 *
 * 纪律：
 *  - 描述与参数文案**逐字**沿用既有原文；
 *  - 描述串仅剥掉尾随的 `r`（全库 179 例）；
 *  - 参数名以**实测会话**为准（如 file_read 的参数是 `operation`，
 *    实测样本：真实工具调用 `{"operation": "list", "path": "."}`）；
 *  - 只有名字、没有逐字描述串的参数保守地不写 description，
 *    不自行编造。
 */

import type { ToolSchema } from "../ai/protocol";

/** file_read：读文件 / 列目录 */
export const FILE_READ: ToolSchema = {
  name: "file_read",
  description:
    "Read a file or list a directory. Supports both relative paths (relative to the current project root) and absolute paths. Files inside the current project or an installed skill directory are read directly; other external paths require user confirmation. For large files, use offset (1-based line) and limit to page through content; output is capped to keep responses small.",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["read", "list"],
        description: '"read" to read file content, "list" to list directory contents',
      },
      path: {
        type: "string",
        description:
          "File or directory path. Relative paths resolve against the current project root; absolute paths are also accepted.",
      },
      offset: {
        type: "integer",
        description:
          "Pagination start. read: 1-based line number (default 1). list: entry index (default 0).",
      },
      limit: {
        type: "integer",
        description:
          "Max items to return. read: lines (default 2000, max 2000). list: entries (default 200, max 500).",
      },
    },
    required: ["operation", "path"],
  },
};

/** file_write：写入 / 追加 / 替换 / 插入 / 删行（既有编辑操作都在此工具上） */
export const FILE_WRITE: ToolSchema = {
  name: "file_write",
  description:
    'TeachWrite: maintain reference material files ONLY under the current project 小说资料 directory, excluding 写作导览 and 审核/审读. NEVER create, rewrite, continue, or edit novel prose, dialogue, examples, or chapter drafts. Every material mutation requires author confirmation in the execution layer. Operations: "write" (overwrite/create), "append" (add to end), "replace" (find and replace text, set replace_all=true to replace ALL occurrences, default replaces first only), "insert" (insert at position), "delete_lines" (remove lines).',
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["write", "append", "replace", "insert", "delete_lines"],
      },
      path: {
        type: "string",
        description:
          "File or directory path. Relative paths resolve against the current project root; absolute paths are also accepted.",
      },
      content: { type: "string", description: "Content to write, append, or insert" },
      old_text: { type: "string", description: 'Text to find and replace (for "replace" operation)' },
      new_text: { type: "string", description: "New text for replace or insert operations" },
      replace_all: {
        type: "boolean",
        description:
          'For "replace" operation: if true, replace ALL occurrences; if false (default), replace first occurrence only',
      },
      position: {
        type: "string",
        enum: ["start", "end", "after_line"],
        description: 'Where to insert: "start", "end", or "after_line"',
      },
      after_line: {
        type: "integer",
        description: 'Line number after which to insert (for "insert" with position "after_line")',
      },
      start_line: { type: "integer", description: "Start line number for delete (1-based)" },
      end_line: {
        type: "integer",
        description: "End line number for delete (1-based, inclusive)",
      },
    },
    required: ["operation", "path"],
  },
};

/** file_manage：搜索 / 删除 / 改名 / 复制 */
export const FILE_MANAGE: ToolSchema = {
  name: "file_manage",
  description:
    "Search reference materials and author prose. Mutations are restricted to current project 小说资料 and require author confirmation; NEVER delete, rename, copy to, or indirectly alter chapter prose, candidate drafts, writing guides, review status, or archive credentials. This tool CANNOT list directories or read files - use file_read for that.",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["search", "delete", "rename", "copy"],
        description:
          'Operation type: "search" to find text in files, "delete" to remove file, "rename" to rename file, "copy" to duplicate file',
      },
      path: {
        type: "string",
        description:
          "File or directory path. Relative paths resolve against the current project root; absolute paths are also accepted.",
      },
      search_text: { type: "string" },
      new_path: { type: "string" },
      directory: {
        type: "string",
        description: 'Directory to search in (for "search" operation, default is entire project)',
      },
    },
    required: ["operation", "path"],
  },
};

/** create_project：创建小说项目 */
export const CREATE_PROJECT: ToolSchema = {
  name: "create_project",
  description:
    "Create a new novel project with the given name. IMPORTANT: Before using this tool, check Available Skills above and call skill_lookup with the matching skill name. If no skill matches, proceed directly.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The name of the new novel project (book title)" },
    },
    required: ["name"],
  },
};

/** question：向用户提问（2–4 个互斥选项） */
export const QUESTION: ToolSchema = {
  name: "question",
  description:
    "Ask the user questions during execution: gather preferences, clarify instructions, or offer choices. Each question has 2-4 options and supports single or multiple selection.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "Questions to ask the user",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The complete question to ask the user" },
            options: {
              type: "array",
              description:
                "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label"],
              },
            },
            multi_select: {
              type: "boolean",
              description:
                "Set to true to allow the user to select multiple options instead of just one.",
            },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
};

/** skill_lookup：按需加载技能正文 */
export const SKILL_LOOKUP: ToolSchema = {
  name: "skill_lookup",
  description:
    'Load a specialized skill on demand. Returns the skill\'s SKILL.md instructions, the skill\'s base directory path, and a sampled list of files in that directory (scripts/ for executable helpers, references/ for documentation, assets/ for output resources). Bundled files are NOT inlined — use file_read with the returned base directory to inspect them as needed. Call this when a user request matches a skill description listed under "Available Skills" in the system prompt.',
  parameters: {
    type: "object",
    properties: {
      skill_name: {
        type: "string",
        description: "The skill name exactly as shown in Available Skills, or the skill ID",
      },
    },
    required: ["skill_name"],
  },
};

/** 已实现的工具集合（顺序即注入顺序；与 exec.ts executeTool 的分发分支一一对应） */
export const IMPLEMENTED_TOOLS: ToolSchema[] = [
  FILE_READ,
  FILE_WRITE,
  FILE_MANAGE,
  CREATE_PROJECT,
  QUESTION,
  SKILL_LOOKUP,
];

/** 按名字取工具 schema 子集：未实现/拼错的名字静默跳过，返回顺序随入参 names */
export function toolsByName(names: string[]): ToolSchema[] {
  const all = IMPLEMENTED_TOOLS;
  return names
    .map((n) => all.find((t) => t.name === n))
    .filter((t): t is ToolSchema => Boolean(t));
}
