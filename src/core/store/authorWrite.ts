/** 保存完成时以实际写入的文本更新基线，不能吞掉等待期间的作者输入。 */
export function settleSavedTab<T extends {content:string;baseContent:string;dirty:boolean}>(current:T, written:string):T {
  return {...current,baseContent:written,dirty:current.content!==written};
}
/** 切书/关窗前，保存过程中新增或变化的脏标签仍须保留。 */
export function hasNewUnsavedEdits(saved:readonly {rel:string;content:string}[],current:readonly {rel:string;content:string;dirty:boolean}[]):boolean {
  const captured = new Map(saved.map(tab => [tab.rel,tab.content]));
  return current.some(tab => tab.dirty && captured.get(tab.rel) !== tab.content);
}
/** 采用写成时，只有原标签未变化才替换正文；并发作者输入必须保留。 */
export function settleAdoptedTab<T extends {content:string;baseContent:string;dirty:boolean}>(current:T,written:string,previous:string|null):T {
  if (!current.dirty && current.content === previous) return {...current,content:written,baseContent:written,dirty:false};
  return settleSavedTab(current,written);
}
