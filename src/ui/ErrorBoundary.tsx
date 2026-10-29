/**
 * 渲染错误边界(B19)。
 *
 * 为什么必须有:此前全项目没有任何 ErrorBoundary,而 React 的行为是
 * **渲染期一次抛错就卸载整棵树** —— 用户看到的「崩溃/白屏」正是这个形态
 * (KL-UI-11 那次的 session!.messages 白屏同一条路)。没有边界时,连错误原因
 * 都只在控制台里,发布版窗口标题不显示错误(见 main.tsx 的纪律)。
 *
 * 口径:降级成一块可读的面板,说清发生了什么 + 一条真正能用的出路
 * (重新载入窗口),不假装还能继续用已坏掉的那一栏。
 * 主工作台与设置屏各挂一座边界:一栏崩了不带走另一栏。
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** 出错时显示在面板标题里的区域名(中文,给用户看的) */
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 与控制台同一口径留档(发布版不弹窗、不改标题,但取证时能在 WebView2 日志里看到)
    console.error("RENDER ERROR in " + this.props.label + ":", error, info?.componentStack);
  }

  private reload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="err-boundary" role="alert">
        <div className="eb-h">{this.props.label}出了问题</div>
        <p className="eb-p">
          界面渲染时出错。你的作品文件与已生成的内容都在磁盘上,没有丢失;重新载入即可继续。
        </p>
        <pre className="eb-code">{String(error.message || error)}</pre>
        <button type="button" className="btn btn-accent" onClick={this.reload}>
          重新载入
        </button>
      </div>
    );
  }
}
