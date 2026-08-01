const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1536, height: 1024 }, deviceScaleFactor: 1.5 });
  await p.goto(`file://${process.cwd()}/scripts/screenshot-mock.html`);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(400);
  await p.screenshot({ path: 'public/broll/screenshot.png', clip: { x:0,y:0,width:1536,height:1024 } });
  await b.close(); console.log('screenshot.png ready');
})();
