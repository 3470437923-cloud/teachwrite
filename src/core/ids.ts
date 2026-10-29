/**
 * 时间戳与 ID 生成。
 *
 * 保持既有格式（依据实测样本文件）：
 *   manifest 时间戳  "2026-09-27T22:00:35.918741"     （Dart DateTime.toIso8601String()，本地时间，微秒）
 *   manifest 条目 id "item_1790517635918741_g2mpat"   （item_ + 微秒纪元 + _ + 6 位小写字母数字）
 *   回收站 id        "20260704170528_1783155928889255"（本地 YYYYMMDDHHmmss + _ + 微秒纪元）
 */

/** id 随机后缀的字符集：小写字母 + 数字（与实测样本 id 口径一致，不含易混字符以外的符号） */
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/** 数字左侧补 0 到固定宽度（时间字段定宽，保证 id 可读且可按字典序排序） */
function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** 亚毫秒部分（0..999）：JS 只有毫秒精度，后 3 位用高精度时钟补足 */
let subMsSource: () => number = () =>
  typeof performance !== "undefined" ? Math.floor((performance.now() % 1) * 1000) % 1000 : 0;

/**
 * "2026-09-27T22:00:35.918741"（本地时间，6 位微秒）。
 * 注意：JS 时钟只有毫秒精度，末 3 位来自 subMsSource（形状与 Dart 输出一致，
 * 但不是真实微秒采样）；同毫秒内多次调用靠 subMsSource 的自然漂移区分。
 */
export function isoMicros(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}` +
    `T${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}` +
    `.${pad(d.getMilliseconds(), 3)}${pad(subMsSource(), 3)}`
  );
}

/** "20260704170528"（本地时间，秒级定宽；回收站 id 的时间段，肉眼可读可排序） */
export function compactStamp(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}` +
    `${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}`
  );
}

/**
 * 微秒纪元字符串，如 "1783155928889255"。
 * 实现为 毫秒×1000 + 随机亚毫秒位（0..999）：形状是微秒纪元，同一毫秒内的
 * 两次调用靠随机位错开（碰撞概率 1/1000；newItemId 另有 6 位随机后缀兜底）。
 */
export function microsEpoch(d: Date = new Date(), rand: () => number = Math.random): string {
  return (BigInt(d.getTime()) * 1000n + BigInt(Math.floor(rand() * 1000))).toString();
}

/**
 * "item_1790517635918741_g2mpat"（manifest 条目 id）。
 * 唯一性 = 微秒纪元 + 6 位 [a-z0-9] 随机后缀（36^6 ≈ 21.9 亿），正常写入频率下可视为不碰撞。
 */
export function newItemId(d: Date = new Date(), rand: () => number = Math.random): string {
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += ALNUM[Math.floor(rand() * ALNUM.length)];
  return `item_${microsEpoch(d, rand)}_${suffix}`;
}

/**
 * "20260704170528_1783155928889255"（回收站目录名）。
 * 前段本地时间给人读，后段微秒纪元保证同秒多次删除也不重名
 * （同毫秒碰撞概率 1/1000，回收站流程接线时建议建目录前再做存在性检查）。
 */
export function newRecycleId(d: Date = new Date(), rand: () => number = Math.random): string {
  return `${compactStamp(d)}_${microsEpoch(d, rand)}`;
}

/** 仅供测试：替换亚毫秒来源，使 isoMicros 输出可确定（生产代码不得调用） */
export function __setSubMsSource(fn: () => number): void {
  subMsSource = fn;
}
