const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 720, height: 1280 }, deviceScaleFactor: 2 });
  await p.goto(`file://${process.cwd()}/scripts/broll-growth.html`);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(400);
  await p.screenshot({ path: 'public/broll/growth.png', clip: { x:0,y:0,width:720,height:1280 } });
  await b.close(); console.log('growth.png ready');
})();
