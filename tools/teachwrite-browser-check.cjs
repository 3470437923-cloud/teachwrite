/* Browser-only virtual filesystem acceptance; never connects to a real model API. */
const {chromium} = require(process.env.TEACHWRITE_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async()=>{
  const browser = await chromium.launch({headless:true, ...(process.env.TEACHWRITE_CHROMIUM ? {executablePath:process.env.TEACHWRITE_CHROMIUM}: {})});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  const checks=[];
  const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);};
  async function diskState(){return await page.evaluate(async()=>{
    const {getFs}=await import('/src/core/fsbridge.ts');
    const {join}=await import('/src/core/dirs.ts'); const {loadGuide}=await import('/src/core/teaching/guide.ts');
    const {loadReviewBatches}=await import('/src/core/teaching/review.ts'); const {parsePrefs}=await import('/src/core/prefs.ts'); const raw=await window.__TAURI_INTERNALS__.invoke('prefs_load'); const root=parsePrefs(raw).currentNovelProject;
    const fs=getFs();const files=await fs.list(join(root,'章节内容'));
    const entry=files.find(e=>e.name==='第6章.md');const rel=join('章节内容','第6章.md');
    return {root,guide:await loadGuide(fs,root,6),body:entry?await fs.readText(entry.path):null,batches:await loadReviewBatches(fs,root,rel),hasNext:files.some(e=>e.name==='第7章.md')};
  });}
  try {
    await page.goto((process.env.TEACHWRITE_PREVIEW_URL || 'http://127.0.0.1:5188/preview.html')+'?archived=1');await page.waitForLoadState('networkidle');
    const action=page.locator('.tw-actions button').first();await action.waitFor();await page.waitForFunction(()=>!document.querySelector('.tw-actions button').disabled);
    await action.click();await page.getByRole('region',{name:'当前场景写作导览'}).waitFor();
    const panel=page.locator('.tw-guide'),editor=page.locator('textarea.editor-area');
    check('AI guide creates an empty author manuscript',await editor.inputValue()==='');
    check('only one current scene is shown',await panel.locator('h2').count()===1);
    check('future scene title stays locked',!(await panel.innerText()).includes('展开冲突并检验信息依据'));
    let disk=await diskState();check('complete three-step guide is persisted separately',disk.guide.steps.length===3&&disk.body==='');
    await panel.getByRole('checkbox').click();await page.waitForFunction(()=>document.querySelector('.tw-guide h2')?.textContent==='展开冲突并检验信息依据');
    disk=await diskState();check('manual checkbox persists one completed step',disk.guide.completed.length===1);
    await panel.getByRole('button',{name:'返回上一步并取消完成'}).click();await page.waitForFunction(()=>document.querySelector('.tw-guide h2')?.textContent==='明确本章的场景目标');
    check('manual reopening restores the prior task',(await diskState()).guide.completed.length===0);
    const source='作者手写验收正文。\n他检查了门前的脚印。\n每一步都由作者自行完成。';await editor.fill(source);
    const before=await panel.boundingBox();await editor.evaluate(el=>{el.scrollTop=el.scrollHeight;});const after=await panel.boundingBox();
    check('guide remains above the independently scrolling editor',before.y===after.y && (await editor.boundingBox()).y>=after.y+after.height-1);
    await page.getByRole('button',{name:'审读本章',exact:true}).click();await page.locator('.tw-review article').waitFor();
    check('review does not change author text',await editor.inputValue()===source);
    await page.locator('.tw-quote').first().click();check('exact quote selects author source',await editor.evaluate(el=>el.selectionEnd>el.selectionStart));
    await page.locator('.tw-review article select').first().selectOption('accepted');await page.waitForFunction(()=>document.querySelector('.tw-review article select')?.value==='accepted');
    disk=await diskState();check('accepted issue is persisted without rewriting',disk.batches[0].issues[0].status==='accepted'&&await editor.inputValue()===source);
    await page.getByRole('button',{name:'审读本章',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('[aria-label="审读历史批次"] option').length===2);
    check('rerun retains both review batches',(await diskState()).batches.length===2);
    await editor.fill(source+'\n作者再次手动修改。');check('stale source disables quote location',await page.locator('.tw-quote').first().isDisabled());
    check('next chapter stays locked until archive',await action.isDisabled());
    await page.getByRole('button',{name:'资料回流与归档',exact:true}).click();
    await page.getByText('确认归档完成',{exact:true}).click();await page.getByRole('button',{name:'提交',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.tw-actions button').disabled);
    check('author archive confirmation unlocks next chapter',!(await action.isDisabled()));
    check('archive action never generates next chapter automatically',!(await diskState()).hasNext);
    await editor.fill(source+'\n归档后的新修改。');await page.waitForFunction(()=>document.querySelector('.tw-actions button').disabled);
    check('post-archive author changes invalidate the gate',await action.isDisabled());
    await page.setViewportSize({width:1100,height:740});
    check('teaching panel and editor remain within viewport',await page.evaluate(()=>{const e=document.querySelector('textarea.editor-area').getBoundingClientRect();const g=document.querySelector('.tw-guide').getBoundingClientRect();return e.height>80&&g.height>35&&e.bottom<=window.innerHeight&&g.top>=0;}));
    check('no browser runtime exceptions',errors.length===0);
    fs.mkdirSync('.evidence/teachwrite',{recursive:true});await page.screenshot({path:'.evidence/teachwrite/workbench.png',fullPage:true});
    fs.writeFileSync('.evidence/teachwrite/browser-report.json',JSON.stringify({mode:'virtual-filesystem simulated AI; no real API',checks,errors},null,2));
    console.log(JSON.stringify({passed:checks.length,checks,errors},null,2));
  } catch(e) {console.error('FAILED:',e);console.error((await page.locator('body').innerText()).slice(-9000));process.exitCode=1;}
  finally {await browser.close();}
})();
