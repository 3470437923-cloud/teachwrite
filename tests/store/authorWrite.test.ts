import {describe,it,expect} from "vitest";
import {settleSavedTab,settleAdoptedTab,hasNewUnsavedEdits} from "../../src/core/store/authorWrite";
const tab=(content:string,dirty=false)=>({id:"author",content,baseContent:"旧稿",dirty});
describe("异步作者保存与采用不丢掉等待期间的新输入",()=>{
  it("关窗保存中又输入的脏正文必须阻止关窗",()=>{expect(hasNewUnsavedEdits([{rel:"章",content:"已送去保存"}],[{rel:"章",content:"新输入",dirty:true}])).toBe(true);});
  it("保存中新增的脏标签必须阻止切书",()=>{expect(hasNewUnsavedEdits([],[{rel:"新章",content:"手写",dirty:true}])).toBe(true);});
  it("已写内容与当前相同不误阻止切书",()=>{expect(hasNewUnsavedEdits([{rel:"章",content:"相同"}],[{rel:"章",content:"相同",dirty:true}])).toBe(false);});
  it("保存尚未完成时继续输入：磁盘基线是实际写入稿，新输入仍为dirty",async()=>{
    let current=tab("送去保存",true);const captured=current.content;
    let finish!:()=>void;const io=new Promise<void>(resolve=>{finish=resolve;});
    const saved=io.then(()=>{current=settleSavedTab(current,captured);});
    current={...current,content:"保存期间又输入的新文字"};finish();await saved;
    expect(current.content).toBe("保存期间又输入的新文字");expect(current.baseContent).toBe(captured);expect(current.dirty).toBe(true);
  });
  it("实际写入稿与当前相同时才清dirty",()=>{expect(settleSavedTab(tab("送去保存",true),"送去保存")).toEqual({...tab("送去保存"),baseContent:"送去保存"});});
  it("采用期间编辑目标：保留新输入，以已经采用的磁盘文本为基线",()=>{
    const latest=tab("采用期间新输入",true);const next=settleAdoptedTab(latest,"已确认采用稿","旧稿");
    expect(next.content).toBe(latest.content);expect(next.baseContent).toBe("已确认采用稿");expect(next.dirty).toBe(true);
  });
  it("采用时目标没有变化：立刻同步落盘稿，后续索引失败也不会保留旧干净标签",()=>{
    const next=settleAdoptedTab(tab("旧稿"),"已确认采用稿","旧稿");expect(next.content).toBe("已确认采用稿");expect(next.baseContent).toBe(next.content);expect(next.dirty).toBe(false);
  });
  it("并发输入恰好等于采用稿时无需伪造dirty",()=>{expect(settleAdoptedTab(tab("采用稿",true),"采用稿","旧稿").dirty).toBe(false);});
  it("并发输入后又恢复旧稿也保留作者的dirty意图",()=>{const next=settleAdoptedTab(tab("旧稿",true),"采用稿","旧稿");expect(next.content).toBe("旧稿");expect(next.dirty).toBe(true);});
});
