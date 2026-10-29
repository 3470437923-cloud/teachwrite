/**
 * 作品名 / 路径段的合法性规则（纯函数，无 IO）。
 *
 * 为什么单独一个模块：这条规则有**两个使用者**，而且必须完全一致 ——
 *   ① 新建作品（`project.createProject`）：不合法的名字根本不该建出来；
 *   ② 删除 / 彻底删除（`store/recycle`）：不合法的名字不该被拼接成删除目标。
 * 写在任意一边都会让另一边慢慢漂移，所以提到这里做单一来源。
 *
 * 与 Rust 侧 `fs.rs::valid_child_name` **逐条对应**：TS 侧负责给用户一句人话，
 * Rust 侧是最后一道锁（受限删除命令只接受"父目录 + 一个路径段"）。
 * 见 D-032 / KL-ST-02 / KL-TL-04 / KL-DF-10。
 */

/** Windows 保留设备名（含带扩展名形态：`NUL.txt` 同样是设备） */
export function isReservedDeviceName(name: string): boolean {
  const stem = (name.split(".")[0] ?? "").replace(/ +$/, "").toUpperCase();
  if (["CON", "PRN", "AUX", "NUL"].includes(stem)) return true;
  return /^(COM|LPT)[1-9]$/.test(stem);
}

/**
 * 单个路径段/文件名的合法性判定，返回第一条不通过的人话；合法返回 null。
 * 拒绝：空 / `.` / `..` / 分隔符 / 冒号（NTFS 备用数据流 ADS）/ 通配符 /
 *       控制字符 / 尾随空格或点 / Windows 保留设备名。
 */
export function childNameProblem(name: string): string | null {
  if (name === "" || name === "." || name === "..") return "名称为空或指向父目录";
  if (/[\\/:*?"<>|]/.test(name)) return "名称含 \\ / : * ? \" < > | 中的字符";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return "名称含控制字符";
  if (/[ .]$/.test(name)) return "名称不能以空格或点结尾";
  if (isReservedDeviceName(name)) return "名称是 Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）";
  return null;
}