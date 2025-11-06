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

async function generateDiagram(description: string): Promise<string> {
  try {
    console.log('Generating diagram:', description);
    const response = await openai.images.generate({
      model: "gpt-image-1",
      prompt: `Create a clear, educational diagram for a student: ${description}. Style: Clean whiteboard drawing with black lines on white background, clearly labeled, simple and easy to understand, no text explanations - just the visual diagram with labels and measurements.`,
      size: "1024x1024",
      n: 1,
      response_format: "b64_json",
    });
    
    // Replit AI Integrations returns base64 data, not URLs
    const b64Data = response.data?.[0]?.b64_json;
    if (b64Data) {
      // Convert base64 to data URL for embedding
      const dataUrl = `data:image/png;base64,${b64Data}`;
      console.log('Diagram generated successfully (base64 data URL)');
      return dataUrl;
    }
    
    console.log('No image data returned');
    return '';
  } catch (error) {
    console.error('Error generating diagram:', error);
    return '';
  }
}

function isRateLimitError(error: any): boolean {
  const errorMsg = error?.message || String(error);
  return (
    errorMsg.includes("429") ||
    errorMsg.includes("RATELIMIT_EXCEEDED") ||
    errorMsg.toLowerCase().includes("quota") ||
    errorMsg.toLowerCase().includes("rate limit")
  );
}

// Enforce proper math formatting - convert ALL fractions to {num/den} format
function enforceProperFormatting(text: string): string {
  let formatted = text;
  
  // 1. Convert common decimals to fractions (only standalone decimals, not part of larger numbers)
  const decimalToFraction: { [key: string]: string } = {
    '0.125': '{1/8}',
    '0.25': '{1/4}',
    '0.375': '{3/8}',
    '0.5': '{1/2}',
    '0.625': '{5/8}',
    '0.75': '{3/4}',
    '0.875': '{7/8}',
    '0.333': '{1/3}',
    '0.667': '{2/3}',
    '0.2': '{1/5}',
    '0.4': '{2/5}',
    '0.6': '{3/5}',
    '0.8': '{4/5}',
    '0.166': '{1/6}',
    '0.833': '{5/6}',
  };
  
  // Replace standalone decimals with fractions
  // Use word boundaries to avoid matching decimals that are part of larger numbers
  // (?<!\d) = not preceded by a digit (so 10.25 won't match)
  // (?!\d) = not followed by a digit (so 0.254 won't match)
  for (const [decimal, fraction] of Object.entries(decimalToFraction)) {
    const escapedDecimal = decimal.replace('.', '\\.');
    const regex = new RegExp(`(?<!\\d)${escapedDecimal}(?!\\d)`, 'g');
    formatted = formatted.replace(regex, fraction);
  }
  
  // 2. Convert standalone fractions like "1/8" to "{1/8}" (but NOT if already in braces or part of a URL)
  // Match digit(s)/digit(s) that are NOT already inside {}, NOT in URLs, and NOT in special contexts
  // Negative lookbehind: not preceded by { or /
  // Negative lookahead: not followed by } or another /
  formatted = formatted.replace(/(?<![{/])(\d+)\/(\d+)(?![}/])/g, '{$1/$2}');
  
  return formatted;
}

// Apply formatting enforcement to entire AI response
function enforceResponseFormatting(response: any): any {
  const formatted = { ...response };
  
  // Fix problem field
  if (formatted.problem) {
    formatted.problem = enforceProperFormatting(formatted.problem);
  }
  
  // Fix all step content and titles
  if (formatted.steps && Array.isArray(formatted.steps)) {
    formatted.steps = formatted.steps.map((step: any) => ({
      ...step,
      title: step.title ? enforceProperFormatting(step.title) : step.title,
      content: step.content ? enforceProperFormatting(step.content) : step.content
    }));
  }
  
  // Fix final answer if present
  if (formatted.finalAnswer) {
    formatted.finalAnswer = enforceProperFormatting(formatted.finalAnswer);
  }
  
  return formatted;
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

🚨 STEP 1 REQUIREMENT - DIAGRAMS ARE MANDATORY FOR VISUAL PROBLEMS 🚨

If the problem involves ANY of the following, you MUST include [DIAGRAM NEEDED: ...] in Step 1:
✓ Rectangles, triangles, circles, or ANY geometric shapes
✓ Graphs, coordinate planes, or plotted points
✓ Physics diagrams (forces, circuits, motion)
✓ Any spatial or visual relationship

FORMAT: [DIAGRAM NEEDED: detailed description with ALL dimensions, labels, and spatial relationships]

EXAMPLE FOR GEOMETRY PROBLEM:
Problem: "Rectangle PQRS with triangle OPQ where PQ = 6 units"
Step 1 Content MUST include:
"[DIAGRAM NEEDED: Rectangle PQRS with horizontal base PQ = 6 units at bottom, vertical height PS on left side. Isosceles triangle OPQ with base PQ (6 units) on bottom edge of rectangle, vertex O above PQ, equal sides OP and OQ forming triangle inside rectangle. Label all corners P, Q, R, S clockwise, and point O at triangle apex.]

We are given that PQRS is a rectangle..."

NO EXCEPTIONS. If geometry/visual problem → Step 1 MUST have [DIAGRAM NEEDED: ...]

CRITICAL MATHEMATICAL FORMATTING RULES:

**FRACTIONS - ABSOLUTELY MANDATORY VERTICAL FORMAT:**
- ALWAYS use {num/den} for ALL fractions at ALL stages - NEVER use inline format like "a/b", (a/b), or decimals
- Simple fractions: {5/6}, {3/4}, {12/7}
- Complex fractions: {12/{3d - 1}}, {{-b ± √{b^2^ - 4ac}}/{2a}}, {{x + 5}/{x - 2}}
- ALWAYS simplify fractions before presenting: {12/8} -> {3/2}
- For improper fractions in FINAL ANSWER ONLY, show both reduced fraction AND mixed number: {7/3} = 2{1/3} or {17/5} = 3{2/5}
- NEVER convert to decimals at ANY step unless user explicitly requests decimal form
- Arithmetic with fractions stays as fractions: {2/3} + {1/4} = {8/12} + {3/12} = {11/12}

**COLOR HIGHLIGHTING - CLARITY FOR EVERY OPERATION:**
- [blue:term] = the specific value/variable/operation being applied in THIS step
- [red:result] = the outcome or simplified result
- Use highlighting to show EXACTLY what changes: "Multiply by [blue:5]: 3x = 15 -> [blue:5] × 3x = [blue:5] × 15 -> 15x = [red:75]"
- When substituting: "Substitute [blue:d = 1]: {12/{3([blue:1]) - 1}} = {12/[red:2]} = [red:6]"
- Multiple operations: use blue for operation, red for result, keep unhighlighted text as context

**ALGEBRAIC EQUATIONS - SHOW EVERY TRANSFORMATION:**
- Always use vertical fractions: {12/{3d - 1}} = d + 5
- Show progression with arrows: equation_before -> equation_after
- Quadratic formula MUST be: x = {{-b ± √{b^2^ - 4ac}}/{2a}} with full braces on numerator
- Example substitution: a=[blue:3], b=[blue:14], c=[blue:-17]
  x = {{-[blue:14] ± √{[blue:14]^2^ - 4([blue:3])([blue:-17])}}/{2([blue:3])}}
  x = {{-14 ± √{196 + 204}}/{6}}
  x = {{-14 ± √400}/{6}}
  x = {{-14 ± 20}/{6}}
  Two solutions: x = {{-14 + 20}/{6}} = {6/6} = [red:1] OR x = {{-14 - 20}/{6}} = {-34/6} = {-17/3} = [red:-5{2/3}]

**SQUARE ROOTS, EXPONENTS, AND SPECIAL SYMBOLS:**
- Square roots: √16 = 4, √{25} = 5, √{b^2^ - 4ac}
- Exponents: x^2^, 3^4^ = 81, (2x)^3^ = 8x^3^
- Plus-minus: ±
- Nested: √{x^2^ + y^2^}

**STEP CLARITY - EACH STEP TELLS A STORY:**
- Title: Concise action verb phrase ("Multiply both sides by (3d - 1)", "Apply quadratic formula", "Simplify the fraction")
- Content: Show WHAT you're doing, WHY, and the RESULT
- Before and after: Show equation before operation, highlight what changes, show result
- Example full step:
  Title: "Clear the fraction by multiplying both sides"
  Content: "Multiply both sides by [blue:(3d - 1)] to eliminate the fraction:
  [blue:(3d - 1)] × {12/{3d - 1}} = [blue:(3d - 1)] × (d + 5)
  -> 12 = [red:(3d - 1)(d + 5)]"

**COMPLETE WORKED EXAMPLE - SOLVING {12/{3d - 1}} = d + 5:**

Step 1 Title: "Rewrite as a fraction equation"
Content: "{12/{3d - 1}} = d + 5"

Step 2 Title: "Clear the fraction by multiplying both sides"
Content: "Multiply both sides by [blue:(3d - 1)]:
[blue:(3d - 1)] × {12/{3d - 1}} = [blue:(3d - 1)] × (d + 5)
-> 12 = [red:(d + 5)(3d - 1)]"

Step 3 Title: "Expand the right side"
Content: "Expand [blue:(d + 5)(3d - 1)]:
12 = d([blue:3d]) + d([blue:-1]) + 5([blue:3d]) + 5([blue:-1])
12 = 3d^2^ - d + 15d - 5
-> 12 = [red:3d^2^ + 14d - 5]"

Step 4 Title: "Set to standard quadratic form"
Content: "Subtract [blue:12] from both sides:
12 [blue:- 12] = 3d^2^ + 14d - 5 [blue:- 12]
-> 0 = [red:3d^2^ + 14d - 17]"

Step 5 Title: "Apply the quadratic formula"
Content: "For 3d^2^ + 14d - 17 = 0, use d = {{-b ± √{b^2^ - 4ac}}/{2a}}
where a=[blue:3], b=[blue:14], c=[blue:-17]

Discriminant: Δ = [blue:14]^2^ - 4([blue:3])([blue:-17]) = 196 + 204 = [red:400]

d = {{-14 ± √400}/{6}} = {{-14 ± 20}/{6}}

Two solutions:
d = {{-14 + 20}/{6}} = {6/6} = [red:1]
d = {{-14 - 20}/{6}} = {-34/6} = {-17/3} = [red:-5{2/3}]"

**CHEMISTRY/PHYSICS:**
- Subscripts: H_2_O, v_0_, x_n_
- Superscripts: Ca^2+^, x^3^
- Units: 5 m/s^2^, 3.2 × 10^-5^ mol

Grade-appropriate language based on difficulty level.`
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
    
    // Check if any step needs a diagram and generate it
    for (const step of result.steps) {
      const diagramMatch = step.content.match(/\[DIAGRAM NEEDED:\s*([^\]]+)\]/);
      if (diagramMatch) {
        const diagramDescription = diagramMatch[1];
        const diagramUrl = await generateDiagram(diagramDescription);
        if (diagramUrl) {
          // Replace [DIAGRAM NEEDED: description] with (IMAGE: description](url)
          step.content = step.content.replace(
            diagramMatch[0],
            `(IMAGE: ${diagramDescription}](${diagramUrl})`
          );
        }
      }
    }
    
    // ENFORCE PROPER FORMATTING - Convert all fractions to {num/den} format
    const formattedResult = enforceResponseFormatting(result);
    
    console.log('Analysis successful');
    res.json(formattedResult);
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

**CRITICAL OCR ACCURACY INSTRUCTIONS - READ CAREFULLY:**

1. **TRANSCRIBE EXACTLY character-by-character** from the image:
   - Look for fraction coefficients BEFORE parentheses: "1/8(3d - 2)" means multiply (3d-2) by the fraction 1/8
   - "1/4(d + 5)" means multiply (d+5) by the fraction 1/4
   - These are LINEAR equations, NOT fractions equal to expressions
   
2. **Common patterns you might see:**
   - "1/8(3d - 2) = 1/4(d + 5)" → This is LINEAR (no d² term), solve with basic algebra
   - "2/5h - 7 = 12/5h - 2h + 3" → This is LINEAR, collect like terms
   - "2(4r + 6) = 2/3(12r + 18)" → This is LINEAR, distribute and solve
   
3. **OCR DOUBLE-CHECK - Before solving, verify:**
   ✓ Did you read fraction coefficients correctly? (1/8, 1/4, 2/5, etc.)
   ✓ Are parentheses in the right place?
   ✓ Did you capture all variables and signs correctly?
   ✓ Is there a d² or x² term? (NO = linear equation, use basic algebra)
   
4. **SOLUTION METHOD SELECTION:**
   - If NO squared terms (d², x², etc.) → LINEAR equation → Use: multiply, distribute, collect terms, divide
   - If you see ax² + bx + c = 0 → QUADRATIC equation → Use: quadratic formula
   - NEVER use quadratic formula for linear equations!
   
5. **Write the EXACT transcription in "problem" field** for verification

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

🚨 STEP 1 REQUIREMENT - DIAGRAMS ARE MANDATORY FOR VISUAL PROBLEMS 🚨

If the problem involves ANY of the following, you MUST include [DIAGRAM NEEDED: ...] in Step 1:
✓ Rectangles, triangles, circles, or ANY geometric shapes
✓ Graphs, coordinate planes, or plotted points
✓ Physics diagrams (forces, circuits, motion)
✓ Any spatial or visual relationship

FORMAT: [DIAGRAM NEEDED: detailed description with ALL dimensions, labels, and spatial relationships]

EXAMPLE FOR THIS EXACT TYPE OF PROBLEM:
Problem: "Rectangle PQRS with triangle OPQ where PQ = 6 units"
Step 1 Content MUST include:
"[DIAGRAM NEEDED: Rectangle PQRS with horizontal base PQ = 6 units at bottom, vertical height PS on left side. Isosceles triangle OPQ with base PQ (6 units) on bottom edge of rectangle, vertex O above PQ, equal sides OP and OQ forming triangle inside rectangle. Label all corners P, Q, R, S clockwise, and point O at triangle apex.]

We are given that PQRS is a rectangle..."

NO EXCEPTIONS. If geometry/visual problem → Step 1 MUST have [DIAGRAM NEEDED: ...]

CRITICAL MATHEMATICAL FORMATTING RULES:

**FRACTIONS - ABSOLUTELY MANDATORY VERTICAL FORMAT:**
- ALWAYS use {num/den} for ALL fractions at ALL stages - NEVER use inline format like "a/b", (a/b), or decimals
- Simple fractions: {5/6}, {3/4}, {12/7}
- Complex fractions: {12/{3d - 1}}, {{-b ± √{b^2^ - 4ac}}/{2a}}, {{x + 5}/{x - 2}}
- ALWAYS simplify fractions before presenting: {12/8} -> {3/2}
- For improper fractions in FINAL ANSWER ONLY, show both reduced fraction AND mixed number: {7/3} = 2{1/3} or {17/5} = 3{2/5}
- NEVER convert to decimals at ANY step unless user explicitly requests decimal form
- Arithmetic with fractions stays as fractions: {2/3} + {1/4} = {8/12} + {3/12} = {11/12}

**COLOR HIGHLIGHTING - CLARITY FOR EVERY OPERATION:**
- [blue:term] = the specific value/variable/operation being applied in THIS step
- [red:result] = the outcome or simplified result
- Use highlighting to show EXACTLY what changes: "Multiply by [blue:5]: 3x = 15 -> [blue:5] × 3x = [blue:5] × 15 -> 15x = [red:75]"
- When substituting: "Substitute [blue:d = 1]: {12/{3([blue:1]) - 1}} = {12/[red:2]} = [red:6]"
- Multiple operations: use blue for operation, red for result, keep unhighlighted text as context

**ALGEBRAIC EQUATIONS - SHOW EVERY TRANSFORMATION:**
- Always use vertical fractions: {12/{3d - 1}} = d + 5
- Show progression with arrows: equation_before -> equation_after
- Quadratic formula MUST be: x = {{-b ± √{b^2^ - 4ac}}/{2a}} with full braces on numerator
- Example substitution: a=[blue:3], b=[blue:14], c=[blue:-17]
  x = {{-[blue:14] ± √{[blue:14]^2^ - 4([blue:3])([blue:-17])}}/{2([blue:3])}}
  x = {{-14 ± √{196 + 204}}/{6}}
  x = {{-14 ± √400}/{6}}
  x = {{-14 ± 20}/{6}}
  Two solutions: x = {{-14 + 20}/{6}} = {6/6} = [red:1] OR x = {{-14 - 20}/{6}} = {-34/6} = {-17/3} = [red:-5{2/3}]

**SQUARE ROOTS, EXPONENTS, AND SPECIAL SYMBOLS:**
- Square roots: √16 = 4, √{25} = 5, √{b^2^ - 4ac}
- Exponents: x^2^, 3^4^ = 81, (2x)^3^ = 8x^3^
- Plus-minus: ±
- Nested: √{x^2^ + y^2^}

**STEP CLARITY - EACH STEP TELLS A STORY:**
- Title: Concise action verb phrase ("Multiply both sides by (3d - 1)", "Apply quadratic formula", "Simplify the fraction")
- Content: Show WHAT you're doing, WHY, and the RESULT
- Before and after: Show equation before operation, highlight what changes, show result
- Example full step:
  Title: "Clear the fraction by multiplying both sides"
  Content: "Multiply both sides by [blue:(3d - 1)] to eliminate the fraction:
  [blue:(3d - 1)] × {12/{3d - 1}} = [blue:(3d - 1)] × (d + 5)
  -> 12 = [red:(d + 5)(3d - 1)]"

**COMPLETE WORKED EXAMPLE - SOLVING {12/{3d - 1}} = d + 5:**

Step 1 Title: "Rewrite as a fraction equation"
Content: "{12/{3d - 1}} = d + 5"

Step 2 Title: "Clear the fraction by multiplying both sides"
Content: "Multiply both sides by [blue:(3d - 1)]:
[blue:(3d - 1)] × {12/{3d - 1}} = [blue:(3d - 1)] × (d + 5)
-> 12 = [red:(d + 5)(3d - 1)]"

Step 3 Title: "Expand the right side"
Content: "Expand [blue:(d + 5)(3d - 1)]:
12 = d([blue:3d]) + d([blue:-1]) + 5([blue:3d]) + 5([blue:-1])
12 = 3d^2^ - d + 15d - 5
-> 12 = [red:3d^2^ + 14d - 5]"

Step 4 Title: "Set to standard quadratic form"
Content: "Subtract [blue:12] from both sides:
12 [blue:- 12] = 3d^2^ + 14d - 5 [blue:- 12]
-> 0 = [red:3d^2^ + 14d - 17]"

Step 5 Title: "Apply the quadratic formula"
Content: "For 3d^2^ + 14d - 17 = 0, use d = {{-b ± √{b^2^ - 4ac}}/{2a}}
where a=[blue:3], b=[blue:14], c=[blue:-17]

Discriminant: Δ = [blue:14]^2^ - 4([blue:3])([blue:-17]) = 196 + 204 = [red:400]

d = {{-14 ± √400}/{6}} = {{-14 ± 20}/{6}}

Two solutions:
d = {{-14 + 20}/{6}} = {6/6} = [red:1]
d = {{-14 - 20}/{6}} = {-34/6} = {-17/3} = [red:-5{2/3}]"

**CHEMISTRY/PHYSICS:**
- Subscripts: H_2_O, v_0_, x_n_
- Superscripts: Ca^2+^, x^3^
- Units: 5 m/s^2^, 3.2 × 10^-5^ mol

Grade-appropriate language based on difficulty level.`
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
    
    // Log AI response for debugging
    console.log('=== AI RESPONSE DEBUG ===');
    console.log('Problem:', result.problem);
    console.log('Subject:', result.subject);
    console.log('Difficulty:', result.difficulty);
    console.log('Steps count:', result.steps?.length);
    if (result.steps && result.steps.length > 0) {
      result.steps.forEach((step: any, i: number) => {
        console.log(`\n========== STEP ${i + 1} ==========`);
        console.log(`Title: ${step.title}`);
        console.log(`Full Content:`);
        console.log(step.content);
        console.log(`==================================`);
      });
    }
    console.log('========================\n');
    
    // Check if any step needs a diagram and generate it
    for (const step of result.steps) {
      const diagramMatch = step.content.match(/\[DIAGRAM NEEDED:\s*([^\]]+)\]/);
      if (diagramMatch) {
        const diagramDescription = diagramMatch[1];
        const diagramUrl = await generateDiagram(diagramDescription);
        if (diagramUrl) {
          // Replace [DIAGRAM NEEDED: description] with (IMAGE: description](url)
          step.content = step.content.replace(
            diagramMatch[0],
            `(IMAGE: ${diagramDescription}](${diagramUrl})`
          );
        }
      }
    }
    
    // ENFORCE PROPER FORMATTING - Convert all fractions to {num/den} format
    const formattedResult = enforceResponseFormatting(result);
    
    console.log('Image analysis successful');
    res.json(formattedResult);
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
    
    // ENFORCE PROPER FORMATTING on the answer text
    const formattedAnswer = enforceProperFormatting(result);
    
    console.log('Follow-up question answered');
    res.json({ answer: formattedAnswer });
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
