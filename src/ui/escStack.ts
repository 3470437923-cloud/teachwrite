/**
 * 模态 Esc 栈（N-17）：叠层模态一次 Esc 只关**最上层**。
 *
 * 旧实现每个模态各自在 window 上挂 keydown 监听，两层叠开（回收站 → 手打
 * 确认）时同一次 Esc 把两层全部关掉。这里把「谁开谁关」收敛成一个模块级栈：
 * 模态打开时 `pushEsc(closer)` 入栈，Esc 事件由本模块统一监听、只分发给栈顶。
 *
 * 与各处悬浮层（useDismiss / ModelSelect）的关系：它们在 document 层监听并
 * stopPropagation，事件到不了 window 的本监听器 —— 悬浮层仍然只关自己，
 * 语义与旧实现一致（它们本来就不是模态）。
 *
 * App 外壳的「Esc 返回主界面」是栈底：只要它仍是栈顶（没有模态）才生效，
 * 等价于旧的 `.qmodal` 探测，但不再依赖 DOM 类名约定。
 */

type Closer = () => void;
const stack: Closer[] = [];

function onEsc(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  // 输入法组词中的 Esc 是取消组词，不是关模态
  if (e.isComposing) return;
  const top = stack[stack.length - 1];
  if (top) top();
}

if (typeof window !== "undefined") {
  window.addEventListener("keydown", onEsc);
}

/**
 * 模态打开时注册关闭动作；返回退订函数（组件卸载/关闭时调用）。
 * 同一模态重复 push 各占一层，退订按引用精确移除自己那一层。
 */
export function pushEsc(closer: Closer): () => void {
  stack.push(closer);
  return () => {
    const i = stack.lastIndexOf(closer);
    if (i >= 0) stack.splice(i, 1);
  };
}
