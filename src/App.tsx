import { useEffect, useState } from "react";
import MainWorkbench from "./ui/MainWorkbench";
import SettingsScreen from "./screens/SettingsScreen";
import ErrorBoundary from "./ui/ErrorBoundary";
import { pushEsc } from "./ui/escStack";

type View = "main" | "settings";

/**
 * 应用外壳。
 *
 * 这里现在只剩两件事：换屏，和换屏的方向。旧版本在外壳上叠了三样装饰 ——
 * 环境光壁纸（.ambient 漂移光斑）、颗粒层（.grain）、以及跟随指针游移的
 * 镜面反光（.glint）——它们都属于"液态玻璃"那套叙事：面板必须是半透明的，
 * 才需要底下有风景可透、才需要表面有高光可动。实色体系下这三样全部失去
 * 前提，因此整块删除，而不是留着调低透明度。
 *
 * 顺带省掉的成本：一张 58vmax 的模糊光斑层 + 每帧 q 一次 getBoundingClientRect
 * 的指针监听 + 一条 74–104s 的不停歇 CSS 动画。这个界面要连续开几个小时。
 */
export default function App() {
  const [view, setView] = useState<View>("main");

  /**
   * 视图切换。除了换屏，还要在 <html> 上记下导航方向：
   * 前进（进设置）→ 新屏从右侧推入；返回 → 从左侧推入。
   * 位移方向与"用户往哪走"一致，回来时才不会像又往前走了一次。
   */
  const go = (next: View) => {
    document.documentElement.dataset.nav = next === "settings" ? "forward" : "back";
    setView(next);
  };

  // 「Esc 返回主界面」是 escStack 的栈底：任何模态开着时它不是栈顶，
  // 一次 Esc 只关最上层模态（等价于旧的 .qmodal 探测，但不再依赖类名约定）；
  // 悬浮层（useDismiss/ModelSelect）在 document 层 stopPropagation，同样到不了这里。
  useEffect(() => {
    return pushEsc(() => {
      document.documentElement.dataset.nav = "back";
      setView("main");
    });
  }, []);

  return (
    <div className="app-shell">
      {view === "settings" ? (
        <ErrorBoundary label="设置">
          <SettingsScreen onBack={() => go("main")} />
        </ErrorBoundary>
      ) : null}
      {/* N-05：主工作台**常驻挂载**——进设置只隐藏不卸载。旧实现条件渲染切屏，
          MainWorkbench 整棵卸载，未落盘的编辑稿、进行中的生成/回流、会话级思考档位
          全部丢失，返回后是全新挂载。display:contents 让包装 div 对布局透明
          （.win 仍是 .app-shell 的 flex 子项），设置屏在侧时整体 display:none。
          代价与对策：全局按键监听挂 suspended 闸；存储路径变更由 onBootReplaced
          通知主工作台重新装配（见 MainWorkbench 的 assembleTick）。 */}
      <div style={{ display: view === "settings" ? "none" : "contents" }}>
        <ErrorBoundary label="主界面">
          <MainWorkbench suspended={view === "settings"} onOpenSettings={() => go("settings")} />
        </ErrorBoundary>
      </div>
    </div>
  );
}