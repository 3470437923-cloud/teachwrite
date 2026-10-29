//! 文件系统能力层。
//!
//! 只做「纯原语」：读写/列举/改名/复制/删除/stat。
//! **路径分级授权不在这里**——业务层（TS 的 pathGuard）负责判定
//! projectRoot / skillsDir / booksRoot 三授权根，Rust 侧不重复实现策略。
//! 这样规则只有一份，测试也只测一份。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// 相对查询目录的路径（'\' 分隔）
    pub rel: String,
    /// 绝对路径
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: u64,
    /// 是否为链接 / junction（与 fs_stat 同口径看链接本身；前端据此给标记、不递归展开）
    pub is_link: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatInfo {
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: u64,
    /// 是否为链接 / junction（reparse point）。删除流程据此拒绝穿透（KL-DF-10）。
    pub is_link: bool,
}

/// 是否 reparse point（Windows：文件属性带 FILE_ATTRIBUTE_REPARSE_POINT）。
/// 用 `symlink_metadata` 的属性判断，而不是 `is_symlink()` —— 后者只覆盖符号链接，
/// 目录 junction（挂载点）在属性层面同样是 reparse point。
fn is_reparse(md: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        return md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    {
        md.file_type().is_symlink()
    }
}

/// Windows 保留设备名（含带扩展名形态：`NUL.txt` 同样是设备）。
/// 这些名字在 Windows 上无法作为真实文件/目录存在，出现即视为攻击面（KL-DF-10）。
fn is_reserved_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim_end_matches(' ');
    let up = stem.to_ascii_uppercase();
    if matches!(up.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    // COM1-9 / LPT1-9（COM0、LPT0 不是保留名；COM¹ 之类的上标形态这里不追）
    let bytes = up.as_bytes();
    if bytes.len() == 4 && (up.starts_with("COM") || up.starts_with("LPT")) {
        return (b'1'..=b'9').contains(&bytes[3]);
    }
    false
}

/// 单个路径段校验（按**本机**平台口径）。
///
/// 实现见 [`valid_child_name_on`]。之所以拆成两个函数：`cfg!(windows)` 是
/// 编译期内建宏，Windows 开发机上**无法翻转**，于是 macOS 分支永远不会被执行、
/// 也就永远无法被测试。把平台做成显式参数后，单元测试就能在 Windows 上
/// 把两种口径**都真跑一遍**（见本文件 `mod tests`），而不是只写一句没证据的断言。
pub fn valid_child_name(name: &str) -> Result<(), String> {
    valid_child_name_on(name, cfg!(windows))
}

/// 单个路径段校验：删除类命令只接受"父目录 + 一个名字"，从结构上排除路径穿越。
///
/// **两平台的非法字符集不同**，必须分开判，否则会出现
/// 「TS 层建得出来、Rust 层删不掉」的不对称：
///
/// | 字符 | Windows | macOS / POSIX |
/// |---|---|---|
/// | `/` | 非法 | **非法**（唯一的分隔符） |
/// | NUL 与控制字符 | 非法 | **非法** |
/// | `\` | 非法（分隔符） | 合法（普通字符） |
/// | `: * ? " < > \|` | 非法 | **合法** |
/// | `CON` / `NUL` / `COM1` 等 | 非法（保留设备名） | **合法**（就是普通文件名） |
///
/// `src/core/tools/pathGuard.ts` 的冒号（ADS）检查已经用 `IS_WINDOWS` 正确包住了，
/// 所以 macOS 上 `file_write` 允许写 `第1章:初稿.md` —— 若这里仍无条件拒绝，
/// 用户就会**建得出来、删不掉**。故本函数同步按平台门控。
///
/// 注意：POSIX 上"以点结尾"（`book.`）是**合法**的，但这里仍拒绝 ——
/// 那不是平台限制，而是本产品的命名约定（避免跨平台同步时出现同名不同实体的两份文件）。
pub fn valid_child_name_on(name: &str, windows: bool) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." {
        return Err(format!("非法名称：{name:?}"));
    }
    // `/` 与 NUL 在所有平台都非法
    if name.contains('/') {
        return Err(format!("名称含非法字符：{name}"));
    }
    if name.chars().any(|c| (c as u32) < 0x20) {
        return Err(format!("名称含控制字符：{name:?}"));
    }
    // 以下都是 Windows 专有约束
    if windows {
        if name.contains(['\\', ':', '*', '?', '"', '<', '>', '|']) {
            return Err(format!("名称含非法字符：{name}"));
        }
        if is_reserved_device_name(name) {
            return Err(format!("名称是 Windows 保留设备名：{name}"));
        }
    }
    // 跨平台命名约定（非平台限制）：不以空格或点结尾
    if name.ends_with(' ') || name.ends_with('.') {
        return Err(format!("名称不能以空格或点结尾：{name:?}"));
    }
    Ok(())
}

/// 清掉只读属性（Windows 上只读文件会让 remove_dir_all 直接 "Access is denied"）。
/// 目录一并处理：只读目录同样会挡住删除。失败不致命（真删不掉时后续会报错）。
fn clear_readonly(path: &Path) {
    if let Ok(md) = fs::symlink_metadata(path) {
        if is_reparse(&md) {
            return; // 不动链接目标的属性
        }
        let mut perm = md.permissions();
        if perm.readonly() {
            perm.set_readonly(false);
            let _ = fs::set_permissions(path, perm);
        }
        if md.is_dir() {
            if let Ok(rd) = fs::read_dir(path) {
                for ent in rd.flatten() {
                    clear_readonly(&ent.path());
                }
            }
        }
    }
}

/// 稳健删除：清只读 → 删除 → 失败重试（杀软/预览程序短暂占用是常态）。
/// reparse point 只删链接本身，绝不跟随目标；不存在视为已达成（幂等）。
fn remove_path_robust(path: &Path, recursive: bool) -> Result<(), String> {
    let md = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return Ok(()),
    };
    let display = path.display().to_string();
    if is_reparse(&md) {
        clear_readonly(path);
        return fs::remove_file(path)
            .or_else(|_| fs::remove_dir(path))
            .map_err(|e| format!("删除链接失败 {display}: {}", io_err(e)));
    }
    let is_dir = md.is_dir();
    let mut last = String::new();
    for attempt in 0..3 {
        clear_readonly(path);
        let r = if is_dir {
            if recursive {
                fs::remove_dir_all(path)
            } else {
                fs::remove_dir(path)
            }
        } else {
            fs::remove_file(path)
        };
        match r {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = io_err(e);
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(120));
                }
            }
        }
    }
    Err(format!("删除失败 {display}: {last}"))
}

fn io_err<E: std::fmt::Display>(e: E) -> String {
    format!("{e}")
}

fn mtime_ms(md: &fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 文本解码策略（与 TS 侧测试替身 nodeFs 逐条同口径）：
///   1. UTF-8 BOM → 剥离后按 UTF-8（BOM 不应作为正文首字符 U+FEFF 混进编辑器）；
///   2. UTF-16LE/BE BOM → 按对应解码（部分编辑器/旧版 Word 的导出形态）；
///   3. 严格 UTF-8；
///   4. 失败回退 GBK（encoding_rs 的 GBK 实现覆盖 GB18030 常用区）——
///      中文 Windows 用户的存量旧稿大量是 GBK，"打不开旧稿"是阻断级体验问题。
/// IO 错误（占用/权限/不存在）仍然报错；编码层面不再产生硬错误。
fn decode_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (s, _, _) = encoding_rs::GBK.decode(bytes);
            s.into_owned()
        }
    }
}

#[tauri::command]
pub fn fs_read_text(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读取失败 {path}: {}", io_err(e)))?;
    Ok(decode_text(&bytes))
}

#[tauri::command]
pub fn fs_write_text(path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("建目录失败 {}: {}", parent.display(), io_err(e)))?;
    }
    fs::write(&p, content).map_err(|e| format!("写入失败 {path}: {}", io_err(e)))
}

#[tauri::command]
pub fn fs_append_text(path: String, content: String) -> Result<(), String> {
    use std::io::Write;
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("建目录失败 {}: {}", parent.display(), io_err(e)))?;
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .map_err(|e| format!("打开失败 {path}: {}", io_err(e)))?;
    f.write_all(content.as_bytes())
        .map_err(|e| format!("追加失败 {path}: {}", io_err(e)))
}

/// 列出目录的直接子项；目录不存在时返回空表（与 TS 侧测试替身同行为）
#[tauri::command]
pub fn fs_list(dir: String) -> Result<Vec<DirEntry>, String> {
    let base = Path::new(&dir);
    let rd = match fs::read_dir(base) {
        Ok(rd) => rd,
        Err(_) => return Ok(vec![]),
    };
    let mut out = Vec::new();
    for ent in rd.flatten() {
        let path = ent.path();
        // symlink_metadata：看链接本身而不是目标（与 fs_stat 同口径）——
        // junction 不再被当成普通目录列出（前端不会递归进链接、删除门也能一眼认出），
        // 悬空链接也不再被静默跳过，而是带 is_link 标记列出来。
        let md = match fs::symlink_metadata(&path) {
            Ok(md) => md,
            Err(_) => continue,
        };
        let link = is_reparse(&md);
        let is_dir = md.is_dir() && !link;
        let name = ent.file_name().to_string_lossy().to_string();
        out.push(DirEntry {
            rel: name.clone(),
            path: path.to_string_lossy().to_string(),
            is_dir,
            size: if is_dir { 0 } else { md.len() },
            mtime_ms: mtime_ms(&md),
            is_link: link,
            name,
        });
    }
    // 稳定顺序：目录在前，再按名称（大小写不敏感）
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
pub fn fs_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).exists())
}

#[tauri::command]
pub fn fs_mkdir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| format!("建目录失败 {path}: {}", io_err(e)))
}

#[tauri::command]
pub fn fs_remove(path: String, recursive: bool) -> Result<(), String> {
    remove_path_robust(Path::new(&path), recursive)
}

/// 受限删除：只删 `<parent>\<name>`，且 `name` 必须是**单个路径段**。
/// 删除作品 / 清空回收站都走这里 —— 目标由"父目录 + 一个名字"拼出，
/// 路径穿越、ADS（`name:stream`）、保留设备名在结构上就不成立（KL-DF-10 的结构面）。
#[tauri::command]
pub fn fs_remove_child(parent: String, name: String, recursive: bool) -> Result<(), String> {
    valid_child_name(&name)?;
    let p = Path::new(&parent).join(&name);
    remove_path_robust(&p, recursive)
}

#[tauri::command]
pub fn fs_rename(from: String, to: String) -> Result<(), String> {
    let t = PathBuf::from(&to);
    if let Some(parent) = t.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("建目录失败 {}: {}", parent.display(), io_err(e)))?;
    }
    fs::rename(&from, &t).map_err(|e| format!("改名失败 {from} → {to}: {}", io_err(e)))
}

/// 取路径的"最深可 canonicalize 前缀"：目标可能尚不存在，
/// 逐级向上找第一个存在的祖先 canonicalize，再把剩余段拼回去。
/// 这样「目标是否位于源内部」的判定对 junction/符号链接同样成立。
fn canonicalize_deepest(p: &Path) -> PathBuf {
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut cur: &Path = p;
    loop {
        if let Ok(c) = fs::canonicalize(cur) {
            let mut out = c;
            for seg in missing.iter().rev() {
                out.push(seg);
            }
            return out;
        }
        match cur.file_name() {
            Some(name) => {
                missing.push(name.to_os_string());
                cur = cur.parent().unwrap_or(Path::new(""));
            }
            None => return p.to_path_buf(), // 已到根仍失败：退回原路径（词法判定兜底）
        }
    }
}

#[tauri::command]
pub fn fs_copy(from: String, to: String) -> Result<(), String> {
    let src = Path::new(&from);
    let dst = PathBuf::from(&to);
    // 防自复制：目标位于源内部（A → A\b）会目录套目录无限递归，
    // 直到路径超长才报错 —— 期间已在磁盘上真实创建深层垃圾目录。
    // 判定走 canonicalize（含 junction 解引用），词法相同也算自复制。
    if src.is_dir() {
        let src_c = canonicalize_deepest(src);
        let dst_c = canonicalize_deepest(&dst);
        if dst_c == src_c || dst_c.starts_with(&src_c) {
            return Err(format!("不能把目录复制到它自身内部：{from} → {to}"));
        }
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("建目录失败 {}: {}", parent.display(), io_err(e)))?;
    }
    if src.is_dir() {
        copy_dir(src, &dst).map_err(io_err)
    } else {
        fs::copy(src, &dst).map(|_| ()).map_err(|e| format!("复制失败 {from} → {to}: {}", io_err(e)))
    }
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for ent in fs::read_dir(src)? {
        let ent = ent?;
        let from = ent.path();
        let to = dst.join(ent.file_name());
        // reparse point（junction/符号链接）**跳过不跟随**：跟随可能指回祖先
        // （无限递归）或指到授权根外（把无关目录拷进作品）。与 fs_stat 的
        // 「看链接本身而不是目标」同一口径。
        let md = match fs::symlink_metadata(&from) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if is_reparse(&md) {
            continue;
        }
        if md.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn fs_stat(path: String) -> Result<Option<StatInfo>, String> {
    // symlink_metadata：看链接本身而不是目标 —— metadata 会跟随 junction，
    // 那样删除流程就看不到"这是个链接"，安全门形同虚设。
    match fs::symlink_metadata(&path) {
        Ok(md) => Ok(Some(StatInfo {
            is_dir: md.is_dir(),
            size: if md.is_dir() { 0 } else { md.len() },
            mtime_ms: mtime_ms(&md),
            is_link: is_reparse(&md),
        })),
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_names_and_recycle_ids() {
        for ok in ["星海拾梦", "book", "第1章.md", "a b", "20260704170528_1783155928889255"] {
            for win in [true, false] {
                assert!(valid_child_name_on(ok, win).is_ok(), "应接受（win={win}）：{ok}");
            }
        }
    }

    #[test]
    fn rejects_traversal_and_separators() {
        // `/`、空、`.`、`..` 在**所有平台**都非法
        for bad in ["", ".", "..", "a/b", "./x"] {
            for win in [true, false] {
                assert!(valid_child_name_on(bad, win).is_err(), "应拒绝（win={win}）：{bad:?}");
            }
        }
        // `\` 只在 Windows 上非法（POSIX 上是普通字符）
        for bad in ["a\\b", "第1章\\初稿"] {
            assert!(valid_child_name_on(bad, true).is_err(), "Windows 应拒绝：{bad:?}");
            assert!(valid_child_name_on(bad, false).is_ok(), "POSIX 应接受：{bad:?}");
        }
        // `..\..` 两平台都拒，但**理由不同**：Windows 因为含 `\`，
        // POSIX 因为"以点结尾"这条命名约定。写这条是为了钉住这个差别 ——
        // 它看起来像"POSIX 上该放行"，实际不放行。
        for win in [true, false] {
            assert!(valid_child_name_on("..\\..", win).is_err(), "应拒绝（win={win}）");
        }
    }

    #[test]
    fn rejects_ads_and_wildcards_on_windows_only() {
        // 冒号 = NTFS 备用数据流；通配符会在旧 API 下被展开 —— 都是 Windows 专有约束。
        // POSIX 上这些字符全都是合法的文件名字符，拒绝它们会造成
        // 「file_write 建得出来、fs_remove_child 删不掉」的不对称。
        for bad in ["book:secret", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b"] {
            assert!(valid_child_name_on(bad, true).is_err(), "Windows 应拒绝：{bad:?}");
            assert!(valid_child_name_on(bad, false).is_ok(), "POSIX 应接受：{bad:?}");
        }
        // 中文名 + 冒号（最可能真实出现的形态）
        assert!(valid_child_name_on("第1章:初稿.md", false).is_ok());
        assert!(valid_child_name_on("第1章:初稿.md", true).is_err());
    }

    #[test]
    fn rejects_reserved_device_names_on_windows_only() {
        // 保留设备名是 Windows 概念；POSIX 上 `NUL` / `aux` 就是普通文件名
        for bad in ["CON", "con", "NUL", "NUL.txt", "com1", "LPT9.md", "aux"] {
            assert!(valid_child_name_on(bad, true).is_err(), "Windows 应拒绝：{bad:?}");
            assert!(valid_child_name_on(bad, false).is_ok(), "POSIX 应接受：{bad:?}");
        }
        // 不是保留名的不许误伤（两平台都成立）
        for ok in ["COM0", "LPT0", "COM10", "console", "auxiliary", "nulll"] {
            for win in [true, false] {
                assert!(valid_child_name_on(ok, win).is_ok(), "应接受（win={win}）：{ok}");
            }
        }
    }

    #[test]
    fn rejects_control_chars_and_trailing_dots() {
        for bad in ["a\u{1}b", "book.", "book ", "a\nb"] {
            for win in [true, false] {
                assert!(valid_child_name_on(bad, win).is_err(), "应拒绝（win={win}）：{bad:?}");
            }
        }
        // 中文名以点结尾同样拒（命名约定，非平台限制）
        assert!(valid_child_name_on("第1章.", false).is_err());
    }

    /// 平台门控的**回归锁**：确认 `valid_child_name` 真的按本机平台分派。
    /// 没有这条，`cfg!(windows)` 万一写反（比如写成 `!cfg!(windows)`）也没人发现。
    #[test]
    fn valid_child_name_follows_the_host_platform() {
        // 这两个名字在 Windows 上非法、在 POSIX 上合法 —— 正好能区分平台
        for probe in ["book:secret", "NUL"] {
            let got = valid_child_name(probe).is_ok();
            let want = !cfg!(windows);
            assert_eq!(got, want, "{probe:?} 的平台判定不对（cfg!(windows)={}）", cfg!(windows));
        }
    }

    #[test]
    fn robust_remove_is_idempotent_and_clears_readonly() {
        let base = std::env::temp_dir().join(format!("deepcompose-fs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let deep = base.join("书").join("章节内容");
        fs::create_dir_all(&deep).unwrap();
        let f = deep.join("第1章.md");
        fs::write(&f, "正文").unwrap();
        // 只读文件在 Windows 上会挡住 remove_dir_all —— clear_readonly 必须先把它解开
        let mut perm = fs::metadata(&f).unwrap().permissions();
        perm.set_readonly(true);
        fs::set_permissions(&f, perm).unwrap();

        remove_path_robust(&base.join("书"), true).unwrap();
        assert!(!base.join("书").exists());
        // 幂等：再删一次仍然 Ok
        remove_path_robust(&base.join("书"), true).unwrap();
        let _ = fs::remove_dir_all(&base);
    }
}
