import OpenAI from "openai";
import { Buffer } from "buffer";
import pLimit from "p-limit";
import pRetry, { AbortError } from "p-retry";

const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY
});

function isRateLimitError(error: any): boolean {
  const errorMsg = error?.message || String(error);
  return (
    errorMsg.includes("429") ||
    errorMsg.includes("RATELIMIT_EXCEEDED") ||
    errorMsg.toLowerCase().includes("quota") ||
    errorMsg.toLowerCase().includes("rate limit")
  );
}

export async function analyzeTextQuestion(question: string): Promise<any> {
  return await pRetry(
    async () => {
      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: `You are an expert educational AI tutor. Analyze the homework question and provide a step-by-step solution with proper formatting.

RESPONSE FORMAT (JSON):
{
  "problem": "Restate the problem clearly",
  "subject": "Math|Chemistry|Physics|Bible Studies|Language Arts|Geography|General",
  "difficulty": "K-5|6-8|9-12|College+",
  "steps": [
    {
      "id": "1",
      "title": "Clear action heading",
      "content": "Solution step with proper formatting (use {num/den} for fractions, _subscript_, ^superscript^, [red:text] for colors, -> for arrows)"
    }
  ],
  "finalAnswer": "Plain text final answer"
}

FORMATTING RULES:
- Math: Use {num/den} for fractions, highlight operations in [red:term], show steps with ->
- Chemistry: Use _subscript_ (H_2_O), ^superscript^ (Ca^2+^)
- Physics: Include units, use +italic+_subscript_ for variables (v_0_)
- For geometry/physics: Add [IMAGE NEEDED: description] in first step
- Grade-appropriate language based on difficulty level`
            },
            {
              role: "user",
              content: question
            }
          ],
          response_format: { type: "json_object" },
          max_tokens: 8192,
        });
        
        const content = response.choices[0]?.message?.content || "{}";
        return JSON.parse(content);
      } catch (error: any) {
        if (isRateLimitError(error)) {
          throw error;
        }
        throw new AbortError(error);
      }
    },
    {
      retries: 7,
      minTimeout: 2000,
      maxTimeout: 128000,
      factor: 2,
    }
  );
}

export async function analyzeImageQuestion(imageUri: string, problemNumber?: string): Promise<any> {
  return await pRetry(
    async () => {
      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: `You are an expert educational AI tutor. Analyze the homework image and provide a step-by-step solution.

${problemNumber ? `Focus on problem #${problemNumber} in the image.` : 'If multiple problems exist, solve the most prominent one.'}

RESPONSE FORMAT (JSON):
{
  "problem": "Extracted problem text",
  "subject": "Math|Chemistry|Physics|Bible Studies|Language Arts|Geography|General",
  "difficulty": "K-5|6-8|9-12|College+",
  "steps": [
    {
      "id": "1",
      "title": "Clear action heading",
      "content": "Solution step with proper formatting"
    }
  ],
  "finalAnswer": "Plain text final answer"
}

FORMATTING RULES:
- Math: Use {num/den} for fractions, [red:term] for highlighting, -> for arrows
- Chemistry: _subscript_ (H_2_O), ^superscript^ (Ca^2+^)
- Physics: Include units, +italic+_subscript_ (v_0_)
- Add [IMAGE NEEDED: description] for diagrams needed`
            },
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: {
                    url: imageUri
                  }
                }
              ]
            }
          ],
          response_format: { type: "json_object" },
          max_tokens: 8192,
        });
        
        const content = response.choices[0]?.message?.content || "{}";
        return JSON.parse(content);
      } catch (error: any) {
        if (isRateLimitError(error)) {
          throw error;
        }
        throw new AbortError(error);
      }
    },
    {
      retries: 7,
      minTimeout: 2000,
      maxTimeout: 128000,
      factor: 2,
    }
  );
}

export async function askFollowUpQuestion(
  question: string,
  context: { problem: string; solution: string }
): Promise<string> {
  return await pRetry(
    async () => {
      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: `You are a helpful tutor answering follow-up questions. Be concise (2-4 sentences), use plain language, but preserve mathematical notation using the same formatting: {num/den} for fractions, _subscript_, ^superscript^, [color:text] for highlighting.

Context:
Problem: ${context.problem}
Solution: ${context.solution}`
            },
            {
              role: "user",
              content: question
            }
          ],
          max_tokens: 500,
        });
        
        return response.choices[0]?.message?.content || "I'm sorry, I couldn't answer that question.";
      } catch (error: any) {
        if (isRateLimitError(error)) {
          throw error;
        }
        throw new AbortError(error);
      }
    },
    {
      retries: 7,
      minTimeout: 2000,
      maxTimeout: 128000,
      factor: 2,
    }
  );
}

export async function generateDiagram(description: string): Promise<string> {
  try {
    const response = await openai.images.generate({
      model: "gpt-image-1",
      prompt: `Educational diagram: ${description}. Clean, clear, labeled, suitable for students. High quality illustration with proper proportions and accurate dimensions.`,
      size: "1024x1024",
    });
    
    const base64 = response.data?.[0]?.b64_json ?? "";
    return `data:image/png;base64,${base64}`;
  } catch (error) {
    console.error('Error generating diagram:', error);
    return '';
  }
}
