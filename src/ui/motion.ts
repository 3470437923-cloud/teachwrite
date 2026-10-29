/**
 * 手写动效原语（零依赖）。
 *
 * 为什么需要它：CSS transition 能覆盖绝大多数交互（按压、面板开合、分节
 * 转场、气泡进入），而且天然可打断（重定向时从当前计算值继续，不会回跳）。
 * 但有三种动效 CSS 做不了，必须自己驱动：
 *
 *   1. 流式跟随滚动 —— 每一帧内容都在变长，目标位置连续移动，且必须
 *      「用户一动滚轮就立刻让位」。scrollIntoView 是瞬时跳，读起来像
 *      闪屏；scrollTo({behavior:'smooth'}) 是不可打断的浏览器内置动画。
 *   2. 需要速度延续的落位 —— 松手时把手指速度交给动画。
 *   3. 需要读当前屏幕值再重定向的动效 —— 直接操作 transform 的那类。
 *
 * 本模块提供这三类所需要的弹簧求解器。所有动效都遵守：
 *   · 目标值可随时改写，动画从当前位置与当前速度继续（可打断）
 *   · prefers-reduced-motion 时退化为瞬时到位，不做位移
 *   · 用 rAF 驱动、transform/scrollTop 这类不触发重排的属性
 */

/** 用户是否要求减少动态效果（每次读取都重新查询，尊重系统设置的即时变更） */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface SpringConfig {
  /** 劲度系数：越大越快到位 */
  stiffness: number;
  /** 阻尼：越大越不容易过冲 */
  damping: number;
  /** 质量：越大越"重"、起步越慢 */
  mass: number;
}

/** 跟随滚动用的临界阻尼弹簧：快、且不过冲（过冲在滚动里像"弹回去"） */
export const FOLLOW_SPRING: SpringConfig = { stiffness: 220, damping: 30, mass: 1 };
/** 带一点惯性的落位弹簧（有速度输入时用，保留一点过冲） */
export const SETTLE_SPRING: SpringConfig = { stiffness: 180, damping: 22, mass: 1 };

/** 单自由度弹簧求解器：给定初始值/速度/目标，逐帧推进。 */
export class Spring {
  value: number;
  velocity: number;
  target: number;
  private cfg: SpringConfig;
  private raf = 0;
  private last = 0;
  private onUpdate: (v: number) => void;
  private onSettle?: () => void;

  constructor(value: number, cfg: SpringConfig, onUpdate: (v: number) => void) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.cfg = cfg;
    this.onUpdate = onUpdate;
  }

  /** 改写目标。动画从当前值与当前速度继续 —— 这就是"可打断"。 */
  to(target: number, velocity?: number, onSettle?: () => void): this {
    this.target = target;
    if (velocity !== undefined) this.velocity = velocity;
    this.onSettle = onSettle;
    this.start();
    return this;
  }

  /** 立刻停到某值（用于用户接管、或 reduced-motion） */
  jump(value: number): void {
    this.stop();
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.onUpdate(value);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
  }

  private start(): void {
    if (this.raf) return; // 已在跑，改写目标即可
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    // 帧间隔夹在 [1, 40] ms：切到后台再回来时不会因为一个巨大的 dt 炸掉
    const dt = Math.min(Math.max((now - this.last) / 1000, 0.001), 0.04);
    this.last = now;

    const { stiffness, damping, mass } = this.cfg;
    // 半隐式欧拉：先按当前位移算加速度，再更新速度与位置
    const accel = (-stiffness * (this.value - this.target) - damping * this.velocity) / mass;
    this.velocity += accel * dt;
    this.value += this.velocity * dt;

    const settled =
      Math.abs(this.value - this.target) < 0.5 && Math.abs(this.velocity) < 1;
    if (settled) {
      this.value = this.target;
      this.velocity = 0;
      this.onUpdate(this.value);
      this.raf = 0;
      this.onSettle?.();
      return;
    }
    this.onUpdate(this.value);
    this.raf = requestAnimationFrame(this.tick);
  };
}

/** 每个滚动容器挂一个跟随弹簧（用 WeakMap 存，元素回收后自然释放） */
const followers = new WeakMap<HTMLElement, Spring>();

/** 判定容器是否「贴在底部」——用户往上翻时就不该再自动跟随 */
export function isNearBottom(el: HTMLElement, slack = 48): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

/**
 * 弹簧跟随滚动到底部。
 * 与 scrollIntoView 的区别：
 *   · 目标每帧都在动（内容在增长），弹簧会连续追赶而不是一跳一跳
 *   · 用户滚动时调用 springScrollCancel 即让位（可打断）
 *
 * beforeWrite(v)：弹簧每次写 scrollTop 之前调用，参数是即将写入的值
 * （reduced-motion 的瞬时写也会调）。用途是「程序写入守卫」—— 写 scrollTop
 * 会触发 scroll 事件，而调用方通常把 scroll 事件当作「用户滚了」来取消跟随；
 * 不区分的话弹簧自己写的每一帧都会把跟随取消掉、并把"是否贴底"的状态算乱
 * （流式输出时视图被来回拽、用户反而滚不动 —— 就是少了这道守卫的症状）。
 * 调用方记下 v，在 scroll 处理器里把「scrollTop 与最后写入值一致」的事件
 * 判为程序写入跳过。为什么用值匹配而不是布尔旗：浏览器会把连续的 scroll
 * 事件合并派发，布尔旗在合并时会张冠李戴 —— 用户上滚与弹簧写入合并成一条
 * 事件时，用户滚动被误判为程序写入而忽略，弹簧继续把视图拽回底部。
 */
export function springScrollToBottom(
  el: HTMLElement,
  config = FOLLOW_SPRING,
  beforeWrite?: (v: number) => void,
): void {
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 0) return;
  if (prefersReducedMotion()) {
    beforeWrite?.(max);
    el.scrollTop = max;
    return;
  }
  let spring = followers.get(el);
  if (!spring) {
    spring = new Spring(el.scrollTop, config, (v) => {
      beforeWrite?.(v);
      el.scrollTop = v;
    });
    followers.set(el, spring);
  }
  spring.to(max);
}

/** 让位：用户自己的滚动优先，动画立刻停在当前屏幕值上 */
export function springScrollCancel(el: HTMLElement): void {
  followers.get(el)?.stop();
}