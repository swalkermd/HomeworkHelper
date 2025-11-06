import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import cors from 'cors';
import OpenAI from 'openai';
import pRetry, { AbortError } from 'p-retry';

const app = express();
const PORT = 5000;

app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));

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

app.post('/api/analyze-text', async (req, res) => {
  try {
    const { question } = req.body;
    console.log('Analyzing text question:', question);
    
    const result = await pRetry(
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
          console.error('OpenAI API error:', error);
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
    
    console.log('Analysis successful');
    res.json(result);
  } catch (error) {
    console.error('Error analyzing text:', error);
    res.status(500).json({ error: 'Failed to analyze question' });
  }
});

app.post('/api/analyze-image', async (req, res) => {
  try {
    const { imageUri, problemNumber } = req.body;
    console.log('Analyzing image, problem number:', problemNumber);
    
    const result = await pRetry(
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
          console.error('OpenAI API error:', error);
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
    
    console.log('Image analysis successful');
    res.json(result);
  } catch (error) {
    console.error('Error analyzing image:', error);
    res.status(500).json({ error: 'Failed to analyze image' });
  }
});

app.post('/api/ask-question', async (req, res) => {
  try {
    const { question, context } = req.body;
    console.log('Answering follow-up question');
    
    const result = await pRetry(
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
          console.error('OpenAI API error:', error);
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
    
    console.log('Follow-up question answered');
    res.json({ answer: result });
  } catch (error) {
    console.error('Error answering question:', error);
    res.status(500).json({ error: 'Failed to answer question' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'API server is running' });
});

app.use('/', createProxyMiddleware({
  target: 'http://localhost:8081',
  changeOrigin: false,
  ws: true,
  on: {
    proxyReq: (proxyReq: any, req: any) => {
      if (req.headers.origin) {
        proxyReq.setHeader('origin', req.headers.origin);
      }
    }
  }
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Proxy server with API running on port ${PORT}`);
  console.log(`   API endpoints available at /api/*`);
  console.log(`   Frontend proxied from port 8081`);
});
