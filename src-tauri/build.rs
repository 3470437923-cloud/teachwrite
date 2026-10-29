fn main() {
    // 构建烙印(B19/D-053):把提交号与构建时间戳编译进产物的 app_info.build 字段。
    // 每次打包都会变,于是任何一份副本都能追溯到它是从哪个提交、什么时候建的 ——
    // 别人改名重发也甩不掉这条来源记录(与 PE 的 LegalCopyright 同为结构性锚定)。
    // git 不可用(浅克隆/无 git 环境)就留空,绝不让构建失败。
    let commit = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=TW_BUILD_COMMIT={}", commit);
    println!("cargo:rustc-env=TW_BUILD_TIME={}", chrono_free_stamp());
    // 提交号变了要重跑 build script,否则烙印会停在旧值
    println!("cargo:rerun-if-changed=../.git/HEAD");
    tauri_build::build()
}

/// 不引入 chrono:自己算 Unix 秒 → YYYY-MM-DDTHH:MM:SS(UTC)。
/// 只需要粗粒度的"什么时候建的",够用了。
fn chrono_free_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant 的 civil_from_days(公历 proleptic)。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}
