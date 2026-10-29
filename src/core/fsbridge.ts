/**
 * 文件系统桥。
 *
 * 业务层（src/core/**）不直接碰 Node/浏览器 API，只依赖本接口；
 * 生产环境走 Tauri IPC（Rust 侧 fs_* 命令），测试环境走 node:fs 替身。
 * 这是「路径分级授权」的落点：所有路径都要先过 pathGuard。
 */

/** 目录条目元数据（Rust fs_list 与测试替身 nodeFs 返回同一形态） */
export interface DirEntry {
  /** 文件名（不含路径） */
  name: string;
  /** 相对查询目录的路径，'\' 分隔，保持既有格式（直接子项即文件名本身） */
  rel: string;
  /** 绝对路径 */
  path: string;
  /** 链接/junction 恒为 false（链接不作目录展开，与 fs_stat 同口径） */
  isDir: boolean;
  /** 字节数；目录恒为 0（Rust 侧口径） */
  size: number;
  /** 毫秒时间戳 */
  mtimeMs: number;
  /** 是否链接 / junction（reparse point）：前端据此给标记、不递归展开 */
  isLink: boolean;
}

/** 文件/目录的状态信息（stat 的结果形态） */
export interface StatInfo {
  isDir: boolean;
  size: number;
  mtimeMs: number;
  /** 是否链接 / junction（reparse point）；删除流程据此拒绝穿透（KL-DF-10） */
  isLink: boolean;
}

/**
 * 文件系统原语接口。方法契约与 Rust 侧 fs_* 命令逐条对齐（测试替身 nodeFs 同口径）：
 *  - writeText / appendText：自动创建目标父目录（递归），目标不存在时创建；
 *  - list：目录不存在返回 []（不抛）；条目排序为目录在前、再按名称大小写不敏感；
 *  - remove：目标不存在静默成功；recursive=false 时删单文件或**空目录**（非空目录报错）；
 *  - removeChild：只删 `<parent>\<name>`，`name` 必须是单个路径段（Rust 侧会校验：
 *    拒绝分隔符 / `..` / 冒号(ADS) / 通配符 / 控制字符 / 保留设备名）；
 *  - rename / copy：自动创建目标父目录；copy 对目录递归复制；
 *  - stat：路径不存在返回 null（不抛）；
 *  - readText：UTF-8 BOM 剥离；UTF-16（BOM 探测）转 UTF-8；非 UTF-8 回退 GBK 解码
 *    （中文 Windows 存量旧稿多为 GBK）；IO 错误（占用/权限/不存在）才抛错。
 */
export interface FsBridge {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  appendText(path: string, content: string): Promise<void>;
  /** 列出目录的直接子项；目录不存在时返回 [] */
  list(dir: string): Promise<DirEntry[]>;
  exists(path: string): Promise<boolean>;
  /** 递归建目录（等价 mkdir -p，已存在不报错） */
  mkdir(path: string): Promise<void>;
  /** recursive=false 时删空目录或单文件 */
  remove(path: string, recursive: boolean): Promise<void>;
  /** 受限删除：只删 `<parent>\<name>`（name 为单个路径段，Rust 侧校验） */
  removeChild(parent: string, name: string, recursive: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  stat(path: string): Promise<StatInfo | null>;
}

/** Tauri IPC 调用签名（与 @tauri-apps/api 的 invoke 同形） */
export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** 生产实现：把每个动作映射到 Rust 的 fs_* 命令 */
export function createTauriFs(invoke: InvokeFn): FsBridge {
  return {
    readText: (path) => invoke<string>("fs_read_text", { path }),
    writeText: (path, content) => invoke<void>("fs_write_text", { path, content }),
    appendText: (path, content) => invoke<void>("fs_append_text", { path, content }),
    list: (dir) => invoke<DirEntry[]>("fs_list", { dir }),
    exists: (path) => invoke<boolean>("fs_exists", { path }),
    mkdir: (path) => invoke<void>("fs_mkdir", { path }),
    remove: (path, recursive) => invoke<void>("fs_remove", { path, recursive }),
    removeChild: (parent, name, recursive) => invoke<void>("fs_remove_child", { parent, name, recursive }),
    rename: (from, to) => invoke<void>("fs_rename", { from, to }),
    copy: (from, to) => invoke<void>("fs_copy", { from, to }),
    stat: (path) => invoke<StatInfo | null>("fs_stat", { path }),
  };
}

let current: FsBridge | null = null;

/** 注入当前进程使用的桥（应用启动时调用一次） */
export function setFs(fs: FsBridge): void {
  current = fs;
}

/** 取当前进程的桥；未装配即抛错（属于启动顺序编程错误，不做静默兜底） */
export function getFs(): FsBridge {
  if (!current) throw new Error("FsBridge 未初始化：启动时必须先 setFs()");
  return current;
}
