/**
 * gemini-live-lab - Lab версия голосового режима с поддержкой HTML+SVG
 * 
 * Отличия от gemini-live:
 * 1. responseModalities: ["AUDIO", "TEXT"] - модель возвращает и аудио и текст
 * 2. Текстовые части (HTML/SVG) отправляются клиенту как { type: "visual", html: "..." }
 * 3. Использует lab-специфичный системный промпт (lab_prompt_header + main prompt)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { GoogleGenAI } from "npm:@google/genai@1.34.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VOICE_NAME = "Alnilam";
const ADMIN_EMAIL = "yorik.spb65@gmail.com";

interface FunctionCall {
  id: string;
  name: string;
  args?: Record<string, string>;
}

const tools = [
  { googleSearch: {} },
  {
    functionDeclarations: [
      {
        name: "send_email",
        description:
          "Отправляет заявку/лид на почту администратора. Используй когда пользователь хочет что бы с ним связались, позвонили, или хочет пообщаться со специалистом.",
        parameters: {
          type: "OBJECT" as const,
          properties: {
            subject: { type: "STRING" as const, description: "Тема письма" },
            message: { type: "STRING" as const, description: "Полные данные клиента и саммари диалога" },
          },
          required: ["subject", "message"],
        },
      },
      {
        name: "fetch_url_content",
        description: "Загружает и анализирует содержимое веб-страницы. Используй когда пользователь просит посмотреть/проверить/проанализировать сайт. ВАЖНО: СНАЧАЛА скажи пользователю 'Сейчас посмотрю сайт [URL]' и ТОЛЬКО ПОТОМ вызывай функцию.",
        parameters: {
          type: "OBJECT" as const,
          properties: {
            url: { type: "STRING" as const, description: "URL страницы (можно без https://, он будет добавлен автоматически). Например: example.com или https://example.com" },
          },
          required: ["url"],
        },
      },
      {
        name: "list_cases",
        description: "Возвращает список кейсов Pioneer AI.",
        parameters: { type: "OBJECT" as const, properties: {} },
      },
      {
        name: "get_case_details",
        description: "Возвращает детали кейса.",
        parameters: {
          type: "OBJECT" as const,
          properties: {
            slug: { type: "STRING" as const, description: "slug кейса" },
          },
          required: ["slug"],
        },
      },
      {
        name: "generate_visual",
        description: "Генерирует визуальный контент (HTML/SVG карточки, списки, диаграммы) для отображения пользователю. Используй когда нужно показать информацию визуально: карточки кейсов, списки, сравнительные таблицы, простые диаграммы. ВАЖНО: Сначала скажи пользователю голосом что покажешь, потом вызови функцию.",
        parameters: {
          type: "OBJECT" as const,
          properties: {
            prompt: { 
              type: "STRING" as const, 
              description: "Подробное описание что нужно сгенерировать. Включи всю необходимую информацию и данные." 
            },
            context: { 
              type: "STRING" as const, 
              description: "Дополнительный контекст или данные для визуализации (опционально)" 
            },
          },
          required: ["prompt"],
        },
      },
    ],
  },
];

// Функция для удаления рассуждений ИИ из ответа
function removeThinkingTags(text: string): string {
  if (!text) return text;
  
  let cleaned = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "");
  cleaned = cleaned.replace(/\[thinking\][\s\S]*?\[\/thinking\]/gi, "");
  cleaned = cleaned.replace(/\[think\][\s\S]*?\[\/think\]/gi, "");
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  
  return cleaned;
}

/**
 * Получает системный промпт с lab_prompt_header
 */
async function getSystemPrompt(): Promise<string> {
  try {
    // Получаем lab промпт через специальный параметр
    const response = await fetch("https://bnxpiwqgdrycqrchzqlt.supabase.co/functions/v1/get_system_prompt?lab=true");

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const jsonData = await response.json();

    if (jsonData.prompt && typeof jsonData.prompt === "string") {
      const trimmedPrompt = jsonData.prompt.trim();
      console.log("✅ Lab system prompt successfully loaded");
      console.log(`Prompt length: ${trimmedPrompt.length} characters`);
      return trimmedPrompt;
    } else {
      throw new Error("Invalid or missing 'prompt' field in JSON response");
    }
  } catch (error) {
    console.error("❌ Failed to load system prompt:", error);
    return `## Ты полезный АИ ассистент Pioneer AI Lab, но у тебя сейчас нет доступа к базе знаний`;
  }
}

/**
 * Извлекает контекст устройства из истории сообщений
 */
function extractDeviceContext(history: Array<{ role: string; content: string }>) {
  let deviceContext: string | null = null;
  const cleanedHistory = [];

  for (const msg of history) {
    if (msg.content && msg.content.includes('[КОНТЕКСТ УСТРОЙСТВА]')) {
      deviceContext = msg.content.replace('[КОНТЕКСТ УСТРОЙСТВА]', '').trim();
      console.log(`📱 Device context extracted: ${deviceContext.substring(0, 80)}...`);
    } else if (msg.content?.trim()) {
      cleanedHistory.push(msg);
    }
  }

  return { deviceContext, cleanedHistory };
}

let lastKnownHandle: string | undefined = undefined;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const upgradeHeader = req.headers.get("upgrade") || "";
  if (upgradeHeader.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 400, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const clientSessionId = url.searchParams.get("sessionId");
  const clientHandle = url.searchParams.get("handle");
  const skipGreeting = url.searchParams.get("skipGreeting") === "true";

  if (!clientSessionId) {
    console.error("❌ Missing sessionId parameter");
    return new Response("Missing sessionId", { status: 400, headers: corsHeaders });
  }

  console.log(`👤 [LAB] Client session: ${clientSessionId.substring(0, 20)}...`);
  if (clientHandle) {
    console.log(`🔄 [LAB] Client provided handle for resumption`);
  }
  if (skipGreeting) {
    console.log(`⏭️ [LAB] Skip greeting requested (has text history)`);
  }

  let textHistory: Array<{ role: string; content: string }> = [];
  let deviceContextInfo: string | null = null;

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");

  if (!apiKey || !resendApiKey) {
    return new Response("Missing API keys", { status: 500, headers: corsHeaders });
  }

  const systemPrompt = await getSystemPrompt();
  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: "v1alpha" },
  });

  let geminiSession: any = null;
  let pendingMessages: any[] = [];
  let sessionHasSentEmail = false;
  let currentTurnAiTranscript = "";
  // Visual контент приходит ТОЛЬКО от generate_visual tool
  let conversationHistory: string[] = [];

  const sendToClient = (type: string, data: Record<string, unknown> | string) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      try {
        if (type === "text") {
          clientSocket.send(JSON.stringify({ type: "text", data }));
        } else if (typeof data === "object") {
          clientSocket.send(JSON.stringify({ type, ...data }));
        } else {
          clientSocket.send(JSON.stringify({ type, data }));
        }
      } catch (e) {
        console.error("Error sending to client:", e);
      }
    }
  };

  const handleFunctionCall = async (call: FunctionCall) => {
    console.log(`>> [LAB] Executing: ${call.name}`);

    if (call.name === "send_email") {
      sessionHasSentEmail = true;
      const args = call.args || {};

      console.log(`>> Email args - subject: "${args.subject}", message: "${args.message}"`);

      try {
        const resend = new Resend(resendApiKey);

        const subject = args.subject || args.topic || "Новый лид от Pioneer AI Lab";
        const message = args.message || args.text || args.content || "Не указано";

        console.log(`>> Sending email with subject: "${subject}"`);

        const emailResponse = await resend.emails.send({
          from: "Pioneer AI <onboarding@resend.dev>",
          to: [ADMIN_EMAIL],
          subject: subject,
          html: `<p>Голосовой чат (Lab): ${message.replace(/\n/g, "<br>")}</p>`,
        });

        if (emailResponse.error) {
          console.error("❌ Resend API Error:", emailResponse.error);
          throw new Error(`Resend API Error: ${emailResponse.error.message || JSON.stringify(emailResponse.error)}`);
        }

        console.log("✅ Email sent successfully", emailResponse);
        sendToClient("text", `✅ Заявка отправлена`);
        return { id: call.id, name: call.name, response: { result: { success: true } } };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        console.error("❌ Email failed:", errorMessage, err);
        sendToClient("text", `❌ Ошибка: ${errorMessage}`);
        return { id: call.id, name: call.name, response: { result: { success: false, error: errorMessage } } };
      }
    } else if (call.name === "list_cases") {
      sendToClient("text", `📋 Загружаю кейсы...`);
      try {
        const r = await fetch("https://pioneer-ai.ru/cases-summary.json");
        const json = await r.json();
        return { id: call.id, name: call.name, response: { result: { success: true, data: json } } };
      } catch (_e) {
        return { id: call.id, name: call.name, response: { result: { success: false } } };
      }
    } else if (call.name === "get_case_details") {
      const slug = call.args?.slug;
      sendToClient("text", `📖 Кейс: ${slug}`);
      try {
        const r = await fetch(`https://pioneer-ai.ru/cases/${slug}.json`);
        const json = await r.json();
        return { id: call.id, name: call.name, response: { result: { success: true, data: json } } };
      } catch (_e) {
        return { id: call.id, name: call.name, response: { result: { success: false } } };
      }
    } else if (call.name === "fetch_url_content") {
      let fetchUrl = call.args?.url || "";

      if (fetchUrl && !fetchUrl.match(/^https?:\/\//i)) {
        fetchUrl = `https://${fetchUrl}`;
        console.log(`🔗 Автоматически добавлен протокол: ${fetchUrl}`);
      }

      sendToClient("text", `🔍 Просматриваю сайт ${fetchUrl}...`);

      try {
        const r = await fetch(fetchUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; PioneerAI-Bot/1.0)",
          },
        });

        if (!r.ok) {
          return { id: call.id, name: call.name, response: { result: { success: false, error: `HTTP ${r.status}` } } };
        }

        const html = await r.text();
        console.log(`📄 HTML загружен: ${html.length} символов`);

        let textContent = html
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
          .replace(/<!--[\s\S]*?-->/g, "")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/p>/gi, "\n\n")
          .replace(/<\/div>/gi, "\n")
          .replace(/<\/h[1-6]>/gi, "\n\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/\n\s*\n\s*\n/g, "\n\n")
          .replace(/  +/g, " ")
          .trim();

        console.log(`📝 Текст извлечен: ${textContent.length} символов`);

        const MAX_LENGTH = 5000;
        const truncated = textContent.length > MAX_LENGTH;
        if (truncated) {
          textContent = textContent.substring(0, MAX_LENGTH);
        }

        return {
          id: call.id,
          name: call.name,
          response: {
            result: {
              success: true,
              content: textContent,
              truncated: truncated,
              url: fetchUrl
            }
          }
        };
      } catch (e: any) {
        console.error(`❌ Ошибка загрузки ${fetchUrl}:`, e.message);
        return { id: call.id, name: call.name, response: { result: { success: false, error: e.message } } };
      }
    } else if (call.name === "generate_visual") {
      const prompt = call.args?.prompt || "";
      const context = call.args?.context || "";
      
      console.log(`🎨 [LAB] generate_visual called with prompt: ${prompt.substring(0, 100)}...`);
      sendToClient("text", `🎨 Генерирую визуализацию...`);
      
      try {
        // Вызываем gemini-chat-lab для генерации HTML
        const response = await fetch(
          "https://bnxpiwqgdrycqrchzqlt.supabase.co/functions/v1/gemini-chat-lab",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [
                {
                  role: "user",
                  content: `Сгенерируй HTML/SVG визуализацию. 
              
ТРЕБОВАНИЯ:
- Используй CSS переменные: hsl(var(--foreground)), hsl(var(--background)), hsl(var(--primary)), hsl(var(--muted)), hsl(var(--accent))
- Для интерактивных элементов добавляй data-chat-action="текст действия"  
- Отвечай ТОЛЬКО чистым HTML/SVG кодом, БЕЗ markdown обёрток (без \`\`\`html)
- Делай компактный, но красивый дизайн

ЗАДАЧА: ${prompt}
${context ? `\nДАННЫЕ: ${context}` : ""}`
                }
              ],
              stream: false
            }),
          }
        );
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
        
        const data = await response.json();
        console.log(`📦 [LAB] gemini-chat-lab response keys:`, Object.keys(data));
        
        // gemini-chat-lab возвращает { content: "..." } для non-streaming
        const html = data.content || data.response || data.text || "";
        
        if (html.trim()) {
          const cleanedHtml = removeThinkingTags(html);
          // Отправляем HTML клиенту как visual
          sendToClient("visual", { html: cleanedHtml });
          console.log(`✅ [LAB] Visual content generated and sent: ${cleanedHtml.substring(0, 100)}...`);
          
          return { 
            id: call.id, 
            name: call.name, 
            response: { result: { success: true, rendered: true, length: cleanedHtml.length } } 
          };
        } else {
          console.warn(`⚠️ [LAB] Empty HTML response from gemini-chat-lab`);
          return { 
            id: call.id, 
            name: call.name, 
            response: { result: { success: false, error: "Empty response" } } 
          };
        }
      } catch (err: any) {
        console.error("❌ [LAB] generate_visual failed:", err.message);
        sendToClient("text", `❌ Не удалось сгенерировать визуализацию`);
        return { 
          id: call.id, 
          name: call.name, 
          response: { result: { success: false, error: err.message } } 
        };
      }
    }

    return null;
  };

  // Функция для обработки входящих сообщений
  const processMessage = async (msg: any) => {
    if (msg.type === "history" && Array.isArray(msg.data)) {
      console.log(`📜 [LAB] Processing text history: ${msg.data.length} messages`);

      const { deviceContext, cleanedHistory } = extractDeviceContext(msg.data);

      if (deviceContext) {
        deviceContextInfo = deviceContext;
        console.log(`📱 [LAB] Device context will be added to system instruction`);
      }
      textHistory = cleanedHistory;

      const historyTurns = cleanedHistory
        .filter((m: any) => m.content?.trim())
        .map((m: any) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));

      if (historyTurns.length > 0) {
        historyTurns.push({
          role: "user",
          parts: [{
            text: "Продолжаем."
          }]
        });

        console.log(`➡️ [LAB] Injecting ${historyTurns.length} turns as context`);

        await geminiSession.sendClientContent({
          turns: historyTurns,
          turnComplete: true,
        });

        console.log(`✅ [LAB] Text context with continuation prompt injected`);
        sendToClient("history_ack", { count: historyTurns.length });
      }
      return;
    }

    // Официальный формат Google Gemini Live API
    if (msg.realtimeInput) {
      geminiSession.sendRealtimeInput(msg.realtimeInput);
    } else if (msg.clientContent) {
      geminiSession.sendClientContent(msg.clientContent);
      console.log("📤 [LAB] Client content forwarded to Gemini");
    }
    // Legacy support
    else if (msg.type === "audio") {
      geminiSession.sendRealtimeInput({
        audio: {
          data: msg.data,
          mimeType: "audio/pcm;rate=16000",
        },
      });
    } else if (msg.type === "text") {
      geminiSession.sendClientContent({
        turns: [{ role: "user", parts: [{ text: msg.data }] }],
        turnComplete: true,
      });
      console.log("📤 [LAB] Text forwarded to Gemini");
    }
  };

  clientSocket.onopen = async () => {
    console.log("📱 [LAB] Client connected");

    if (clientHandle) {
      console.log(`🔄 [LAB] Resuming session for: ${clientSessionId.substring(0, 20)}...`);
    } else {
      console.log(`🆕 [LAB] Starting new session for: ${clientSessionId.substring(0, 20)}...`);
    }

    try {
      let finalSystemPrompt = systemPrompt;

      if (deviceContextInfo) {
        finalSystemPrompt = `${finalSystemPrompt}\n\n## Информация о пользователе\n${deviceContextInfo}`;
        console.log(`📱 [LAB] Device context added to system prompt`);
      }

      // LAB: Добавляем инструкции для использования generate_visual tool
      finalSystemPrompt = `${finalSystemPrompt}

## LAB MODE: Visual Output через generate_visual tool

У тебя есть инструмент generate_visual для создания визуального контента (HTML/SVG карточки, списки, диаграммы).

КОГДА ИСПОЛЬЗОВАТЬ:
- Пользователь просит "покажи", "визуализируй", "нарисуй", "выведи на экран"
- Нужно показать список кейсов, карточки, таблицы
- Информацию удобнее воспринимать визуально чем на слух

АЛГОРИТМ:
1. Сначала скажи голосом что сейчас покажешь (например: "Сейчас покажу наши кейсы...")
2. Вызови generate_visual с подробным prompt, включив ВСЕ данные которые нужно отобразить
3. После получения результата продолжи объяснение голосом

ВАЖНО: 
- НЕ пытайся генерировать HTML сам - используй ТОЛЬКО generate_visual tool
- В prompt для generate_visual включи всю информацию: названия, описания, данные
- Если нужны данные кейсов - сначала вызови list_cases, потом generate_visual с полученными данными
`;

      geminiSession = await ai.live.connect({
        // IMPORTANT (Google Live API limitation): responseModalities supports ONE modality per session.
        // We keep AUDIO here (same as production gemini-live). Visual/HTML must be implemented via a separate text channel.
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: VOICE_NAME },
            },
          },
          thinkingConfig: {
            thinkingBudget: 1024,
            includeThoughts: false,
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: { parts: [{ text: finalSystemPrompt }] },
          tools: tools,
          enableAffectiveDialog: true,
          proactivity: { proactiveAudio: true },
          sessionResumption: {
            handle: clientHandle || undefined,
          },
          contextWindowCompression: {
            slidingWindow: {},
          },
        } as any,
        callbacks: {
          onopen: () => {
            console.log("✅ [LAB] Gemini session opened");
            const wasResumed = !!clientHandle;

            sendToClient("setup_complete", { resumed: wasResumed });

            if (wasResumed) {
              console.log("🔄 [LAB] Session successfully resumed with full context!");
            }
          },
          onmessage: async (message: any) => {
            const msgTypes: string[] = [];
            if (message.sessionResumptionUpdate) msgTypes.push("sessionResumptionUpdate");
            if (message.toolCall?.functionCalls) msgTypes.push("toolCall");
            if (message.serverContent?.interrupted) msgTypes.push("interrupted");
            if (message.serverContent?.outputTranscription?.text) msgTypes.push("outputTranscription");
            if (message.serverContent?.inputTranscription?.text) msgTypes.push("inputTranscription");
            if (message.serverContent?.turnComplete) msgTypes.push("turnComplete");
            if (message.serverContent?.modelTurn?.parts?.some((p: any) => p.text)) msgTypes.push("textContent");

            if (msgTypes.length > 0) {
              console.log(`📨 [LAB] [${new Date().toISOString()}] Message types: ${msgTypes.join(", ")}`);
            }

            if (message.sessionResumptionUpdate) {
              const update = message.sessionResumptionUpdate;
              console.log("🔑 [LAB] sessionResumptionUpdate:", JSON.stringify(update));

              if (update?.newHandle) {
                lastKnownHandle = update.newHandle;
                sendToClient("session_handle", { handle: update.newHandle });
                console.log(`📤 [LAB] Session handle sent to client: ${String(update.newHandle).slice(0, 18)}...`);
              }
            }

            if (message.toolCall?.functionCalls) {
              console.log("🔧 [LAB] Tool calls detected:", message.toolCall.functionCalls.length);
              const functionResponses = [];

              for (const call of message.toolCall.functionCalls) {
                console.log("🔧 [LAB] Executing function:", call.name);

                sendToClient("tool_call", {
                  functionName: call.name,
                  functionArgs: call.args || {},
                });

                const result = await handleFunctionCall(call);
                if (result) {
                  functionResponses.push(result);

                  sendToClient("tool_call", {
                    functionName: call.name,
                    functionArgs: call.args || {},
                    functionResult: result.response?.result,
                  });
                }
              }

              if (functionResponses.length > 0 && geminiSession) {
                console.log("📤 [LAB] Sending function responses:", functionResponses.length);
                await geminiSession.sendToolResponse({
                  functionResponses,
                });
              }
            }

            // Обработка modelTurn.parts - только аудио
            // Visual контент приходит ТОЛЬКО от generate_visual tool
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                // Аудио - отправляем клиенту
                if (part.inlineData?.mimeType?.includes("audio")) {
                  sendToClient("audio", {
                    data: part.inlineData.data,
                    mimeType: part.inlineData.mimeType,
                  });
                }
                // Текстовые части (thinking) игнорируем - это не HTML
                // HTML генерируется только через generate_visual tool
              }
            }

            if (message.serverContent?.interrupted) {
              console.log("⚠️ [LAB] Interrupted");
              sendToClient("interrupted", {});
            }

            if (message.serverContent?.outputTranscription?.text) {
              const text = message.serverContent.outputTranscription.text;
              sendToClient("ai_transcript", { data: text });
              currentTurnAiTranscript += text;
            }

            if (message.serverContent?.inputTranscription?.text) {
              console.log("🎤 [LAB] User transcript:", message.serverContent.inputTranscription.text.substring(0, 50));
              sendToClient("user_transcript", { data: message.serverContent.inputTranscription.text });
              conversationHistory.push(`[USER]: ${message.serverContent.inputTranscription.text}`);
            }

            if (message.serverContent?.turnComplete) {
              console.log("✅ [LAB] Turn complete");

              if (currentTurnAiTranscript.trim()) {
                conversationHistory.push(`[AI]: ${currentTurnAiTranscript.trim()}`);
              }

              const lowerTranscript = currentTurnAiTranscript.toLowerCase();
              const mentionsSending = lowerTranscript.includes("отправл") || lowerTranscript.includes("заявка отправ");

              if (mentionsSending && !sessionHasSentEmail) {
                try {
                  const resend = new Resend(resendApiKey);
                  await resend.emails.send({
                    from: "Pioneer AI <onboarding@resend.dev>",
                    to: [ADMIN_EMAIL],
                    subject: "PUSH (Lab) - принудительная отправка",
                    html: `<h2>⚠️ AI упомянул отправку, но send_email не был вызван</h2><p>История диалога:</p><pre>${conversationHistory.join("\n")}</pre>`,
                  });
                  sessionHasSentEmail = true;
                  console.log("📨 [LAB] PUSH email sent successfully");
                } catch (pushErr) {
                  console.error("❌ [LAB] PUSH email failed:", pushErr);
                }
              }

              currentTurnAiTranscript = "";
              
              sendToClient("turn_complete", {});
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error("❌ [LAB] Gemini error:", e.message);
            sendToClient("error", { message: e.message });
          },
          onclose: () => {
            console.log("🔌 [LAB] Gemini session closed");
            if (clientSocket.readyState === WebSocket.OPEN) {
              sendToClient("session_closed", {
                handle: lastKnownHandle,
                message: "Gemini session closed unexpectedly"
              });
              console.log("📤 [LAB] session_closed notification sent to client with handle:",
                          lastKnownHandle ? lastKnownHandle.slice(0, 18) + "..." : "undefined");
            }
          },
        },
      });

      // Обработка буферизированных сообщений
      if (pendingMessages.length > 0) {
        console.log(`📦 [LAB] Processing ${pendingMessages.length} buffered messages`);
        for (const msg of pendingMessages) {
          await processMessage(msg);
        }
        pendingMessages = [];
      }

      // Приветствие только если НЕТ истории и НЕТ handle
      if (!clientHandle && textHistory.length === 0 && !skipGreeting) {
        console.log("🚀 [LAB] Инициирую первое сообщение от ИИ...");

        await geminiSession.sendClientContent({
          turns: [
            {
              role: "user",
              parts: [
                {
                  text: "Системное уведомление: Пользователь начал новую сессию в Lab режиме. Поздоровайся с ним первым прямо сейчас. Представься (как указано в твоем системном промпте) и кратко объясни что Lab режим позволяет тебе показывать визуальный контент (HTML, SVG) параллельно с голосом.",
                },
              ],
            },
          ],
          turnComplete: true,
        });
      } else if (clientHandle) {
        console.log("🔄 [LAB] Session resumed with handle - context restored automatically");
      } else if (skipGreeting || textHistory.length > 0) {
        console.log("📜 [LAB] History injected or skipGreeting - waiting for user voice input");
      } else {
        console.log("ℹ️ [LAB] Приветствие пропущено (либо сессия восстановлена, либо есть история).");
      }
    } catch (error) {
      console.error("❌ [LAB] Failed to connect:", error);
      sendToClient("error", { message: "Не удалось подключиться к AI" });
    }
  };

  clientSocket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (!geminiSession) {
        console.log(`📦 [LAB] Buffering message (geminiSession not ready): ${msg.type}`);
        pendingMessages.push(msg);
        return;
      }

      await processMessage(msg);
    } catch (e) {
      console.error("[LAB] Client msg error:", e);
    }
  };

  clientSocket.onerror = (err) => {
    console.error("❌ [LAB] Client error:", err);
  };

  clientSocket.onclose = () => {
    console.log("📱 [LAB] Client disconnected");
    if (geminiSession) {
      geminiSession.close();
    }
  };

  return response;
});
