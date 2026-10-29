import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createNodeFs } from "../support/nodeFs";
import { executeTool, type ToolContext } from "../../src/core/tools/exec";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root,{recursive:true,force:true}))); });
async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"tw-guide-lock-"));roots.push(root);
  await fs.mkdir(path.join(root,"小说资料","写作导览"),{recursive:true});
  await fs.writeFile(path.join(root,"小说资料","写作导览","第1章-导览.md"),"尚未解锁的未来场景");
  await fs.writeFile(path.join(root,"小说资料","普通资料.md"),"场景依据");
  const ctx:ToolContext={fs:createNodeFs(),roots:{projectRoot:root,booksRoot:root,skillsDir:root},booksRoot:root,snapshotsDir:path.join(root,"snapshots"),sessionId:"test"};
  return ctx;
}
describe("导览未来内容不能由通用AI文件工具提前披露",()=>{
  it("直接读取整章导览被拒绝",async()=>{
    const ctx=await fixture();const result=JSON.parse(await executeTool(ctx,"file_read",{operation:"read",path:"小说资料/写作导览/第1章-导览.md"}));
    expect(result.error).toContain("导览");expect(result.content).toBeUndefined();
  });
  it("根目录搜索跳过导览子树，普通资料照常命中",async()=>{
    const ctx=await fixture();const result=JSON.parse(await executeTool(ctx,"file_manage",{operation:"search",path:".",directory:".",search_text:"场景"}));
    expect(result.results).toHaveLength(1);expect(result.results[0].file).toContain("普通资料");
  });
  it("直接搜索导览目录也不能绕过",async()=>{
    const ctx=await fixture();const result=JSON.parse(await executeTool(ctx,"file_manage",{operation:"search",path:".",directory:"小说资料/写作导览",search_text:"场景"}));
    expect(result.error).toContain("导览");
  });
});
