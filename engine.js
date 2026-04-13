// Allowed origins — only the Figma app may call protected endpoints
const ALLOWED_ORIGINS = ['https://www.figma.com', 'https://figma.com'];

// SSRF guard — blocks internal/private network URLs
function isBlockedUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const h = u.hostname.toLowerCase();
    const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254', 'metadata.google.internal'];
    if (blockedHosts.includes(h)) return true;
    // Block private CIDR ranges
    if (/^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^192\.168\./.test(h)) return true;
    return false;
  } catch {
    return true; // invalid URL → block
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const isAllowedOrigin = ALLOWED_ORIGINS.includes(origin);

    // Figma plugins run in a sandboxed iframe so Origin is null/empty.
    // Allow those plus explicit figma.com origins with *.
    // Any other real browser origin gets figma.com back, which the browser blocks.
    const corsHeaders = {
      "Access-Control-Allow-Origin": (isAllowedOrigin || !origin || origin === 'null') ? '*' : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Prefer, Authorization, apikey",
      "Vary": "Origin",
    };

    // CORS PREFLIGHT
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ==========================================
    // ROUTE 1: THE GITHUB ACTION AUDIT TRIGGER
    // ==========================================
    if (url.pathname === "/api/audit") {
      try {
        const body = await request.json();

        // Fix URL if missing https://
        let targetUrl = body.url || "";
        if (targetUrl && !targetUrl.startsWith("http")) {
          targetUrl = `https://${targetUrl}`;
        }

        // SSRF guard — reject internal/private network URLs
        if (!targetUrl || isBlockedUrl(targetUrl)) {
          return new Response(
            JSON.stringify({ success: false, error: "Invalid or blocked URL. Internal network addresses are not allowed." }),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        const sessionId = body.sessionId || "scan-" + Date.now();

        // --- PRE-FLIGHT URL CHECK ---
        // Purpose: catch typos, dead domains, and genuinely broken servers.
        // Bot-protected sites (403) and auth-gated sites (401) are NOT blocked here —
        // Playwright's headless Chrome in engine.js can often load them fine.
        const HARD_FAIL_CODES = new Set([404, 405, 410, 421, 500, 501, 502, 503, 504]);
        try {
          const urlCheck = await fetch(targetUrl, {
            method: "HEAD",
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9"
            },
            cf: { cacheEverything: false }
          });

          if (HARD_FAIL_CODES.has(urlCheck.status)) {
            return new Response(
              JSON.stringify({
                success: false,
                error: `Website unreachable❌: HTTP ${urlCheck.status}. Please check the URL and try again.`
              }),
              { headers: { "Content-Type": "application/json", ...corsHeaders } }
            );
          }
          // Soft-fail codes (401, 403, 429, etc.) are intentionally allowed through.
          // Playwright will attempt the real navigation with a full browser engine.
        } catch (pingError) {
          return new Response(
            JSON.stringify({
              success: false,
              error: `Failed to reach ${targetUrl}. The URL might be invalid or the server is down.`
            }),
            { headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        // Upload FULL tokens to Supabase Storage (bypasses 65KB GitHub limit)
        let tokensUrl = "";
        let compactTokens = [];
        try {
          const rawTokens = typeof body.designTokens === "string" ? JSON.parse(body.designTokens) : body.designTokens;
          compactTokens = Array.isArray(rawTokens) ? rawTokens : [];
          
          // Upload full tokens JSON to Supabase Storage
          const tokensFilename = `${sessionId}-tokens.json`;
          const tokensJson = JSON.stringify(compactTokens);
          const storageUrl = `https://${env.SUPABASE_PROJECT_ID}.supabase.co`;
          const storageKey = env.SUPABASE_SERVICE_ROLE_KEY;
          if (!storageKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");

          const uploadRes = await fetch(
            `${storageUrl}/storage/v1/object/audit-results/${tokensFilename}`,
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${storageKey}`,
                "Content-Type": "application/json",
                "x-upsert": "true",
              },
              body: tokensJson,
            }
          );
          
          if (uploadRes.ok) {
            tokensUrl = `${storageUrl}/storage/v1/object/public/audit-results/${tokensFilename}`;
            console.log(`Tokens uploaded: ${compactTokens.length} items, ${tokensJson.length} bytes`);
          } else {
            console.error("Token upload failed:", await uploadRes.text());
          }
        } catch (e) {
          compactTokens = [];
          console.error("Token processing error:", e.message);
        }

        // Upload Figma frame PNG to Supabase Storage for visual comparison
        let figmaImageUrl = "";
        try {
          const figmaPngBase64 = body.figmaPng || "";
          if (figmaPngBase64.length > 0) {
            const storageUrl = `https://${env.SUPABASE_PROJECT_ID}.supabase.co`;
            const storageKey = env.SUPABASE_SERVICE_ROLE_KEY;
            if (!storageKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
            const figmaFilename = `${sessionId}-figma.png`;
            
            // Decode base64 to binary
            const binaryStr = atob(figmaPngBase64);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
              bytes[i] = binaryStr.charCodeAt(i);
            }
            
            const figmaUploadRes = await fetch(
              `${storageUrl}/storage/v1/object/audit-results/${figmaFilename}`,
              {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${storageKey}`,
                  "Content-Type": "image/png",
                  "x-upsert": "true",
                },
                body: bytes,
              }
            );
            
            if (figmaUploadRes.ok) {
              figmaImageUrl = `${storageUrl}/storage/v1/object/public/audit-results/${figmaFilename}`;
              console.log(`Figma PNG uploaded: ${figmaFilename}`);
            } else {
              console.error("Figma PNG upload failed:", await figmaUploadRes.text());
            }
          }
        } catch (e) {
          console.error("Figma PNG processing error:", e.message);
        }

        // Store minimal scan record and trigger GitHub with small payload
        const supabaseUrl = `https://${env.SUPABASE_PROJECT_ID}.supabase.co`;
        const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseKey) {
          return new Response(
            JSON.stringify({ success: false, error: "Server misconfiguration: SUPABASE_SERVICE_ROLE_KEY is not set." }),
            { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        const scanRecord = {
          website_url: targetUrl,
          figma_frame_name: body.frameName || "Selected Frame",
          figma_file_url: body.fileUrl || null,
          design_tokens: compactTokens,
          audit_status: "processing",
          figma_id: body.figma_id || null,
          user_name: body.user_name || null,
          email: body.email || null,
          session_id: sessionId
        };

        // Upsert profile first to satisfy FK
        if (scanRecord.figma_id) {
          try {
            await fetch(`${supabaseUrl}/rest/v1/profiles`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "apikey": supabaseKey,
                "Authorization": `Bearer ${supabaseKey}`,
                "Prefer": "resolution=merge-duplicates,return=minimal",
              },
              body: JSON.stringify({
                figma_id: scanRecord.figma_id,
                email: scanRecord.email || null,
                full_name: scanRecord.user_name || null
              }),
            });
          } catch (e) {
            // ignore upsert errors for now
          }
        }

        const insertResponse = await fetch(`${supabaseUrl}/rest/v1/scan_history`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`,
            "Prefer": "return=representation",
          },
          body: JSON.stringify(scanRecord),
        });

        if (!insertResponse.ok) {
          const errorText = await insertResponse.text();
          return new Response(
            JSON.stringify({ success: false, error: "Supabase Error: " + errorText }),
            {
              status: insertResponse.status,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            }
          );
        }

        const insertedData = await insertResponse.json();
        const scanId = insertedData[0]?.id;

        // Trigger GitHub Action with only minimal inputs
        const githubBody = {
          ref: "main",
          inputs: {
            scan_id: scanId ? String(scanId) : "",
            url: String(targetUrl),
            session_id: String(sessionId),
            tokens_url: tokensUrl || "",
            figma_image_url: figmaImageUrl || "",
            frame_name: body.frameName || "Selected Frame",
          },
        };

        const response = await fetch(
          `https://api.github.com/repos/soumyaux/ui-match-engine/actions/workflows/audit.yml/dispatches`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.GITHUB_PAT}`,
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "Cloudflare-Worker",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify(githubBody),
          }
        );

        if (response.ok || response.status === 204) {
          return new Response(
            JSON.stringify({ success: true, scan_id: scanId }),
            {
              headers: { "Content-Type": "application/json", ...corsHeaders },
            }
          );
        } else {
          const errorText = await response.text();
          return new Response(
            JSON.stringify({ success: false, error: "GitHub Error: " + errorText }),
            {
              status: response.status,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            }
          );
        }
      } catch (e) {
        return new Response(
          JSON.stringify({ success: false, error: "Worker error: " + e.message }),
          {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
        );
      }
    }

    // ==========================================
    // ROUTE 3: LOGO PROXY
    // ==========================================
    if (url.pathname === "/logo.png") {
      const logoRes = await fetch("https://raw.githubusercontent.com/soumyaux/ui-match-engine/main/UI%20Match%20LOGO.png");
      const headers = new Headers(logoRes.headers);
      headers.set("Access-Control-Allow-Origin", "*"); // logo is public, keep open
      return new Response(logoRes.body, {
        status: logoRes.status,
        headers: headers
      });
    }

    // ==========================================
    // ROUTE 2: EMAIL REPORT SENDER
    // ==========================================
    if (url.pathname === "/api/email-report") {
      try {
        const formData = await request.formData();
        const email = formData.get("email");
        const userName = formData.get("user_name") || "Designer";
        const frameName = formData.get("frame_name") || "your selected Figma frame";
        const reportFile = formData.get("report"); // Blob

        if (!email || !reportFile) {
          return new Response(JSON.stringify({ error: "Missing email or report" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        // Convert Blob to base64 for email attachment
        const arrayBuffer = await reportFile.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        let binary = "";
        for (let i = 0; i < uint8Array.byteLength; i++) {
          binary += String.fromCharCode(uint8Array[i]);
        }
        const base64Report = btoa(binary);

        const senderEmail = env.SENDER_EMAIL || "reports@ui-match.com";
        const resendKey = env.RESEND_API_KEY;
        const brevoKey = env.BREVO_API_KEY;
        
        const htmlContent = `<div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; background: #f8faff; padding: 32px; border-radius: 16px;">
  <img src="https://raw.githubusercontent.com/soumyaux/ui-match-engine/main/UI%20Match%20LOGO.png" alt="UI Match" style="width:48px; margin-bottom: 16px;" />
  <h2 style="color: #0f1b35; font-size: 22px; margin: 0 0 8px;">Your audit report is attached! 🎉</h2>
  <p style="color: #64748b; font-size: 15px;">Hi ${userName},</p>
  <p style="color: #64748b; font-size: 15px;">The UI Match audit report for <strong>${frameName}</strong> is attached to this email as a PDF. The file contains a visual overlay highlighting every design discrepancy found between your Figma design and the live website.</p>
  <div style="background: #eff6ff; border-radius: 12px; padding: 16px; margin: 16px 0;">
    <p style="color: #1e40af; font-size: 13px; font-weight: 600; margin: 0;">📌 We've attached the PDF directly because download links expire after 24 hours.</p>
  </div>
  <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">Sent by <strong>UI Match</strong> · We don't store or sell your email.</p>
</div>`;

        let success = false;
        let lastError = "";

        // Attempt 1: RESEND
        if (resendKey) {
          try {
            const resendBody = {
              from: `UI Match <${senderEmail}>`,
              to: [email],
              subject: "Your UI Match Audit Report 📊",
              html: htmlContent,
              attachments: [
                {
                  filename: "ui-match-audit.pdf",
                  content: base64Report,
                },
              ],
            };

            const resendRes = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${resendKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(resendBody),
            });

            if (resendRes.ok) {
              success = true;
              console.log("Email sent via Resend");
            } else {
              lastError = `Resend Error: ${await resendRes.text()}`;
              console.warn(lastError);
            }
          } catch (e) {
            lastError = `Resend Exception: ${e.message}`;
            console.warn(lastError);
          }
        }

        // Attempt 2: BREVO (Fallback)
        if (!success && brevoKey) {
          try {
            const brevoBody = {
              sender: { name: "UI Match", email: senderEmail },
              to: [{ email: email }],
              subject: "Your UI Match Audit Report 📊",
              htmlContent: htmlContent,
              attachment: [
                {
                  name: "ui-match-audit.pdf",
                  content: base64Report,
                },
              ],
            };

            const brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
              method: "POST",
              headers: {
                "api-key": brevoKey,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(brevoBody),
            });

            if (brevoRes.ok) {
              success = true;
              console.log("Email sent via Brevo");
            } else {
              lastError += ` | Brevo Error: ${await brevoRes.text()}`;
              console.warn(lastError);
            }
          } catch (e) {
            lastError += ` | Brevo Exception: ${e.message}`;
            console.warn(lastError);
          }
        }

        if (success) {
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        } else {
          const finalError = lastError || "No email API keys configured (RESEND_API_KEY or BREVO_API_KEY missing)";
          console.error("All email providers failed or were not configured:", finalError);
          return new Response(JSON.stringify({ success: false, error: finalError }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // ==========================================
    // ROUTE 4: GEMINI 3.1 FLASH-LITE VISION BRIDGE
    // ==========================================
    if (url.pathname === "/api/vision") {
      try {
        const body = await request.json();
        const { image, prompt } = body; // image is base64 string
        
        if (!image || !prompt) {
           return new Response(JSON.stringify({ error: "Missing image or prompt" }), { status: 400, headers: corsHeaders });
        }

        const apiKey = env.GEMINI_API_KEY;
        if (!apiKey) {
           return new Response(JSON.stringify({ error: "Gemini API Key not configured in Worker" }), { status: 500, headers: corsHeaders });
        }

        // Gemini 2.5 Flash (best free vision model)
        // Key passed via header (not URL) to keep it out of access logs
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`;
        const geminiBody = {
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: "image/png", data: image } }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 100
          }
        };

        const res = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify(geminiBody)
        });

        const data = await res.json();
        // Handle Gemini 2.5 thinking model: answer is in last non-thought part
        const visionParts = data.candidates?.[0]?.content?.parts || [];
        let analysis = "";
        for (let i = visionParts.length - 1; i >= 0; i--) {
          if (visionParts[i].text && visionParts[i].text.trim().length > 0 && !visionParts[i].thought) {
            analysis = visionParts[i].text;
            break;
          }
        }
        if (!analysis) {
          for (let i = visionParts.length - 1; i >= 0; i--) {
            if (visionParts[i].text && visionParts[i].text.trim().length > 0) {
              analysis = visionParts[i].text;
              break;
            }
          }
        }

        return new Response(JSON.stringify({ analysis: analysis.trim() }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // SUPABASE PROXY (DEFAULT)
    // ==========================================
    try {
      const SUPABASE_HOST = `${env.SUPABASE_PROJECT_ID}.supabase.co`;
      const proxyRequest = new Request(
        `https://${SUPABASE_HOST}${url.pathname}${url.search}`,
        request
      );
      proxyRequest.headers.set("Host", SUPABASE_HOST);
      
      // Inject Supabase authentication headers for proxied REST requests
      const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
      if (supabaseKey) {
        proxyRequest.headers.set("apikey", supabaseKey);
        proxyRequest.headers.set("Authorization", `Bearer ${supabaseKey}`);
      }

      const supabaseResponse = await fetch(proxyRequest);
      // Clone response and inject CORS headers so Figma plugin iframe can read it
      const responseHeaders = new Headers(supabaseResponse.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
      responseHeaders.set("Access-Control-Allow-Headers", "Content-Type, Prefer, Authorization, apikey");
      return new Response(supabaseResponse.body, {
        status: supabaseResponse.status,
        statusText: supabaseResponse.statusText,
        headers: responseHeaders,
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: "Proxy Error: " + e.message }),
        {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }
  },
};
