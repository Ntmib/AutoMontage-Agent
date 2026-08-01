const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  for (const [html, out] of [['iphone-mock','iphone'],['screenshot-mock','screenshot']]) {
    const p = await b.newPage({ viewport: { width: 1024, height: 1536 }, deviceScaleFactor: 1.5 });
    await p.goto(`file://${process.cwd()}/scripts/${html}.html`);
    await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(400);
    await p.screenshot({ path: `public/broll/${out}.png`, clip: { x:0,y:0,width:1024,height:1536 } });
    await p.close();
  }
  await b.close(); console.log('мокапы готовы');
})();
