const { chromium } = require('playwright');

async function runAudit() {
  const targetUrl = process.env.TARGET_URL;
  const tokens = JSON.parse(process.env.TOKENS);

  console.log(`🌸 Starting Soothing Audit for: ${targetUrl}`);

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle' });

    // THE AUDIT LOGIC:
    // We look for an element on the live site that matches your Figma Frame name
    const report = await page.evaluate((design) => {
      // Simple logic: Find a button or text that matches the Figma name
      const element = document.querySelector(`[data-testid="${design.name}"]`) || document.querySelector('button, h1, a');
      
      if (!element) return { match: false, reason: "Element not found on live site" };

      const liveStyle = window.getComputedStyle(element);
      
      // Check if colors match (Simplified)
      const liveColor = liveStyle.backgroundColor; 
      const designColor = `rgb(${design.color.r}, ${design.color.g}, ${design.color.b})`;

      return {
        match: liveColor === designColor,
        liveColor,
        designColor,
        score: liveColor === designColor ? 100 : 40
      };
    }, tokens);

    console.log("📊 Audit Results:", report);
    
    // TODO: Send this report to Supabase so Figma can see it!
    
  } catch (error) {
    console.error("❌ Audit failed:", error);
  } finally {
    await browser.close();
  }
}

runAudit();
