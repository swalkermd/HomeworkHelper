import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import cors from 'cors';
import OpenAI from 'openai';
import pRetry, { AbortError } from 'p-retry';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const app = express();
const PORT = 5000;

app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));

// Serve diagram images from public/diagrams
app.use('/diagrams', express.static(path.join(process.cwd(), 'public', 'diagrams')));

const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY
});

async function generateDiagram(description: string): Promise<string> {
  try {
    // Extract visual type from description if provided
    const typeMatch = description.match(/type=(\w+)/);
    const visualType = typeMatch ? typeMatch[1] : 'diagram';
    
    // Remove type tag from description for cleaner prompt
    const cleanDescription = description.replace(/type=\w+\s*-\s*/, '');
    
    console.log(`Generating ${visualType} for:`, cleanDescription.substring(0, 100) + '...');
    
    // Customize prompt based on visual type
    const styleGuides: { [key: string]: string } = {
      geometry: 'Clean geometric diagram with clear angles, labeled vertices, precise measurements, and dimension annotations. Use a ruler-and-compass style with clean black lines on white background.',
      graph: 'Coordinate plane with clearly marked axes, grid lines, labeled points, and plotted function/equation. Include axis labels (x, y) and key coordinates. Mathematical graph style.',
      chart: 'Clean data visualization chart with clear labels, legend if needed, and easy-to-read values. Professional infographic style with simple colors.',
      physics: 'Physics diagram with labeled components, force arrows with magnitude indicators, clear directional vectors, and relevant measurements. Technical diagram style.',
      illustration: 'Step-by-step visual illustration showing process or transformation clearly with arrows indicating sequence and labeled stages. Educational illustration style.',
    };
    
    const styleGuide = styleGuides[visualType] || 'Clean educational diagram with clear labels and simple presentation';
    
    const response = await openai.images.generate({
      model: "gpt-image-1",
      prompt: `Create a clear, educational ${visualType} for a student: ${cleanDescription}. 

Style requirements: ${styleGuide}

Key principles:
- White background, black/dark lines for maximum clarity
- All components clearly labeled with text
- Include all measurements, dimensions, and values mentioned
- Simple, uncluttered design focused on understanding
- No decorative elements - purely educational
- Large enough text to be readable`,
      size: "1024x1024",
      n: 1,
    });
    
    // Replit AI Integrations returns base64 data by default
    const b64Data = response.data?.[0]?.b64_json;
    if (b64Data) {
      // Save to file instead of returning data URL (data URLs crash React Native Web)
      const diagramsDir = path.join(process.cwd(), 'public', 'diagrams');
      if (!fs.existsSync(diagramsDir)) {
        fs.mkdirSync(diagramsDir, { recursive: true });
      }
      
      // Generate unique filename with type prefix
      const hash = crypto.createHash('md5').update(description).digest('hex').substring(0, 8);
      const filename = `${visualType}-${hash}.png`;
      const filepath = path.join(diagramsDir, filename);
      
      // Convert base64 to buffer and save
      const buffer = Buffer.from(b64Data, 'base64');
      fs.writeFileSync(filepath, buffer);
      
      // Return absolute URL (relative paths resolve to Expo dev server, not our API server)
      const domain = process.env.REPLIT_DEV_DOMAIN || `${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
      const url = `https://${domain}/diagrams/${filename}`;
      console.log(`✓ ${visualType} saved:`, url);
      return url;
    }
    
    console.log('✗ No image data returned');
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
function enforceProperFormatting(text: string | null | undefined): string {
  // Return empty string if text is null or undefined
  if (!text || typeof text !== 'string') {
    return '';
  }
  
  // Extract and preserve IMAGE tags to avoid processing their data URLs
  const imageTags: string[] = [];
  let formatted = text.replace(/\(IMAGE:[^\)]+\]\([^\)]+\)/g, (match) => {
    imageTags.push(match);
    return `__IMAGE_PLACEHOLDER_${imageTags.length - 1}__`;
  });
  
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
  for (const [decimal, fraction] of Object.entries(decimalToFraction)) {
    const escapedDecimal = decimal.replace('.', '\\.');
    const regex = new RegExp(`(?<!\\d)${escapedDecimal}(?!\\d)`, 'g');
    formatted = formatted.replace(regex, fraction);
  }
  
  // 2. Convert standalone fractions like "1/8" to "{1/8}"
  formatted = formatted.replace(/(?<![{/])(\d+)\/(\d+)(?![}/])/g, '{$1/$2}');
  
  // Restore IMAGE tags
  formatted = formatted.replace(/__IMAGE_PLACEHOLDER_(\d+)__/g, (match, index) => {
    return imageTags[parseInt(index)];
  });
  
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

// ============================================================================
// QUALITY CONTROL & VALIDATION SYSTEM
// ============================================================================

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  confidence: number;
}

// Structural validation - check required fields and format
function validateStructure(solution: any): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Check required fields
  if (!solution.problem || typeof solution.problem !== 'string') {
    errors.push('Missing or invalid problem statement');
  }
  
  if (!solution.subject || typeof solution.subject !== 'string') {
    errors.push('Missing or invalid subject');
  }
  
  if (!solution.difficulty || typeof solution.difficulty !== 'string') {
    errors.push('Missing or invalid difficulty level');
  }
  
  if (!Array.isArray(solution.steps) || solution.steps.length === 0) {
    errors.push('Missing or empty steps array');
  } else {
    solution.steps.forEach((step: any, index: number) => {
      if (!step.id || !step.title || !step.content) {
        errors.push(`Step ${index + 1} missing required fields (id, title, or content)`);
      }
    });
  }
  
  // Final answer is optional for multi-part questions where answers are in steps
  // Only flag as error if there are no steps either
  if (!solution.finalAnswer && (!solution.steps || solution.steps.length === 0)) {
    errors.push('Missing final answer and no solution steps provided');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

// Cross-model verification - use a second AI to verify the solution
async function crossModelVerification(
  originalQuestion: string, 
  proposedSolution: any
): Promise<ValidationResult> {
  try {
    console.log('🔍 Running cross-model verification...');
    
    // Extract key information from the solution
    const stepsText = proposedSolution.steps
      .map((s: any) => `${s.title}: ${s.content}`)
      .join('\n');
    
    const verificationPrompt = `You are a quality control expert verifying educational content for accuracy.

ORIGINAL PROBLEM:
${originalQuestion}

PROPOSED SOLUTION:
Subject: ${proposedSolution.subject}
Grade Level: ${proposedSolution.difficulty}

Steps:
${stepsText}

Final Answer: ${proposedSolution.finalAnswer}

YOUR TASK:
1. Verify the mathematical/scientific accuracy of this solution
2. Check that calculations are correct at each step
3. Verify the final answer is accurate
4. Identify any errors in logic, arithmetic, or problem-solving approach
5. Confirm the solution actually addresses the question asked

Respond in JSON format:
{
  "isCorrect": true/false,
  "confidence": 0-100 (how confident you are in this assessment),
  "errors": ["list of specific errors found, if any"],
  "warnings": ["list of minor issues or improvements, if any"],
  "reasoning": "brief explanation of your assessment"
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are an expert quality control validator for educational content. Your job is to verify accuracy and identify errors."
        },
        {
          role: "user",
          content: verificationPrompt
        }
      ],
      response_format: { type: "json_object" },
      max_tokens: 2048,
      temperature: 0.3, // Lower temperature for more consistent verification
    });
    
    const verification = JSON.parse(response.choices[0]?.message?.content || "{}");
    
    console.log(`✓ Verification complete - Correct: ${verification.isCorrect}, Confidence: ${verification.confidence}%`);
    if (verification.errors && verification.errors.length > 0) {
      console.log(`⚠️  Errors found:`, verification.errors);
    }
    if (verification.warnings && verification.warnings.length > 0) {
      console.log(`⚠️  Warnings:`, verification.warnings);
    }
    
    return {
      isValid: verification.isCorrect === true,
      errors: verification.errors || [],
      warnings: verification.warnings || [],
      confidence: verification.confidence || 0
    };
    
  } catch (error) {
    console.error('❌ Verification error:', error);
    // If verification fails, we'll log it but not block the solution
    return {
      isValid: true, // Assume valid if verification system fails
      errors: [],
      warnings: ['Verification system encountered an error'],
      confidence: 50
    };
  }
}

// Main validation orchestrator with retry capability
async function validateSolution(
  originalQuestion: string,
  solution: any,
  attemptNumber: number = 1,
  maxRetries: number = 2
): Promise<{ solution: any; validationPassed: boolean; validationDetails?: any }> {
  const timestamp = new Date().toISOString();
  console.log(`🎯 [${timestamp}] Starting solution validation (Attempt ${attemptNumber}/${maxRetries})...`);
  
  // Step 1: Structural validation
  const structureCheck = validateStructure(solution);
  if (!structureCheck.isValid) {
    console.error('❌ Structure validation failed:', structureCheck.errors);
    // Return a failed validation rather than throwing (more graceful)
    return {
      solution,
      validationPassed: false,
      validationDetails: {
        timestamp,
        attempt: attemptNumber,
        passed: false,
        confidence: 0,
        errors: ['Solution format is invalid: ' + structureCheck.errors.join(', ')],
        warnings: [],
        subject: solution.subject || 'Unknown',
        difficulty: solution.difficulty || 'Unknown'
      }
    };
  }
  console.log('✓ Structure validation passed');
  
  // Step 2: Cross-model verification
  const verification = await crossModelVerification(originalQuestion, solution);
  
  // Step 3: Determine if solution passes quality control
  const MIN_CONFIDENCE_THRESHOLD = 70;
  const passesQC = verification.isValid && verification.confidence >= MIN_CONFIDENCE_THRESHOLD;
  
  // Log validation metrics
  const validationLog = {
    timestamp,
    attempt: attemptNumber,
    passed: passesQC,
    confidence: verification.confidence,
    errors: verification.errors,
    warnings: verification.warnings,
    subject: solution.subject,
    difficulty: solution.difficulty
  };
  console.log('📊 Validation metrics:', JSON.stringify(validationLog, null, 2));
  
  if (passesQC) {
    console.log(`✅ Solution passed all validation checks (Confidence: ${verification.confidence}%)`);
    return { 
      solution, 
      validationPassed: true,
      validationDetails: validationLog
    };
  } else {
    // If validation failed and we have retries left, log warning but don't retry yet
    // (Retry logic would need to regenerate solution, which is expensive and complex)
    const errorSummary = verification.errors.length > 0 
      ? `Errors: ${verification.errors.join('; ')}` 
      : 'Low confidence score';
    
    console.log(`⚠️  Solution validation concerns (Confidence: ${verification.confidence}%)`);
    console.log(`    ${errorSummary}`);
    
    if (verification.warnings.length > 0) {
      console.log(`    Warnings: ${verification.warnings.join('; ')}`);
    }
    
    // Note: We return the solution even if validation has concerns
    // This prevents blocking users while still logging issues for improvement
    return { 
      solution, 
      validationPassed: false,
      validationDetails: validationLog
    };
  }
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
  "finalAnswer": "Plain text final answer",
  "visualAids": [
    {
      "type": "physics|geometry|graph|chart|illustration",
      "stepId": "1",
      "description": "Detailed description of what to visualize with all measurements and labels"
    }
  ]
}

**CRITICAL: visualAids array is REQUIRED for:**
- Physics: projectile motion, force diagrams, circuits, kinematics
- Geometry: shapes, angles, spatial relationships
- Data: surveys, percentages, comparing quantities, proportions
- Leave empty [] ONLY if truly no visual would help

📊 INTELLIGENT VISUAL AIDS - WHEN AND WHAT TYPE TO CREATE 📊

**🚨 ESSENTIAL VISUALS - ALWAYS CREATE for these classic scenarios:**

**PHYSICS - NEARLY MANDATORY:**
✓ **PROJECTILE MOTION** - Any problem with objects launched at angles (catapults, projectiles, balls thrown)
   → Show parabolic trajectory, launch angle, velocity components, max height, range
   → Tag: [DIAGRAM NEEDED: type=physics - Projectile motion showing parabolic arc from launch point at [angle]° with initial velocity [v₀], marking maximum height at apex, horizontal range, and ground level. Label velocity components, trajectory path, and key measurements.]

✓ **FORCE DIAGRAMS** - Any problem analyzing forces on an object (friction, tension, normal force)
   → Show object with all force vectors (magnitude + direction), coordinate system
   → Tag: [DIAGRAM NEEDED: type=physics - Free body diagram of [object] with force vectors: [list all forces with magnitudes and directions]. Include coordinate axes.]

✓ **KINEMATICS** - Motion problems with acceleration, velocity, position over time
   → Show motion diagram with position/velocity/acceleration vectors at key moments
   → Tag: [DIAGRAM NEEDED: type=physics - Motion diagram showing [object] at key time points with velocity and acceleration vectors. Mark initial and final positions.]

✓ **CIRCUITS** - Any electrical circuit problem
   → Show circuit schematic with components, current flow, voltage labels
   → Tag: [DIAGRAM NEEDED: type=physics - Circuit diagram with [components] connected in [series/parallel], showing current direction and voltage labels.]

**GEOMETRY - NEARLY MANDATORY:**
✓ Any problem with shapes, angles, areas, perimeters
✓ Spatial relationships between multiple geometric objects
✓ 3D geometry or perspective views

**DATA VISUALIZATION - NEARLY MANDATORY:**
✓ **SURVEYS & PERCENTAGES** - Any problem asking about percentages, surveys, or preferences
   → **MUST CREATE** a pie chart or bar chart comparing categories
   → Examples triggering this: "survey of students", "percentage of...", "what fraction preferred", "poll results"
   → Tag: [DIAGRAM NEEDED: type=chart - Pie chart showing [category names] with percentages: [list each category with its percentage]. Use distinct colors for each segment and label with both category name and percentage.]
   → EXAMPLE: For "survey of 200 students: Math 60, Science 50, English 40, History 30, Art 20" → ADD: [DIAGRAM NEEDED: type=chart - Pie chart showing subject preferences: Math 30%, Science 25%, English 20%, History 15%, Art 10%. Use distinct colors for each segment with labels.]

✓ **COMPARING QUANTITIES** - Problems comparing multiple values, populations, or measurements
   → Show bar chart or comparison chart
   → Tag: [DIAGRAM NEEDED: type=chart - Bar chart comparing [categories] with values: [list values]. Include labeled axes and value labels on each bar.]

✓ **PROPORTIONS & RATIOS** - Problems involving parts of a whole
   → Show pie chart or stacked bar chart
   → Tag: [DIAGRAM NEEDED: type=chart - Visual representation showing proportions of [total] divided into [parts with values/percentages].]

**SCREENING CRITERIA - For other cases, create visuals when they SIGNIFICANTLY enhance understanding:**

Consider creating a visual aid when:
✓ The problem involves spatial relationships that are hard to describe in words alone
✓ Lower grade levels (K-5, 6-8) - visuals help younger students grasp concepts better
✓ Complex multi-step processes benefit from a visual roadmap
✓ The visual would clarify confusion, not just repeat what words already convey

**TYPES OF VISUALS:**

1. **GEOMETRIC DIAGRAMS** - For shapes, angles, spatial relationships
   - Tag: [DIAGRAM NEEDED: type=geometry - detailed description with ALL dimensions, labels, spatial relationships]

2. **GRAPHS & COORDINATE PLANES** - For plotting, functions, data visualization
   - Tag: [DIAGRAM NEEDED: type=graph - equation/function with axes, labels, key points]

3. **CHARTS & DATA VISUALIZATION** - For comparing quantities, showing proportions
   - Tag: [DIAGRAM NEEDED: type=chart - data values, labels, chart type (bar/pie/line)]

4. **PHYSICS DIAGRAMS** - For forces, motion, circuits, energy
   - Tag: [DIAGRAM NEEDED: type=physics - physical setup, forces/components, labels]

5. **PROCESS ILLUSTRATIONS** - For sequential steps or transformations
   - Tag: [DIAGRAM NEEDED: type=illustration - what's shown, key elements, relationships]

**WHEN NOT TO CREATE VISUALS:**
✗ Pure algebraic manipulation where symbols are clear enough
✗ Simple word problems without spatial/physical elements
✗ When the description in words is already perfectly clear

**PLACEMENT:** Visual aids can appear in ANY step where they'd be most helpful, not just Step 1. Place them where understanding would benefit most.

**FORMAT EXAMPLE:**
"[DIAGRAM NEEDED: type=geometry - Rectangle PQRS with horizontal base PQ = 6 units at bottom, vertical height PS on left side. Isosceles triangle OPQ with base PQ (6 units) on bottom edge of rectangle, vertex O above PQ, equal sides OP and OQ forming triangle inside rectangle. Label all corners P, Q, R, S clockwise, and point O at triangle apex.]"

**DECISION FRAMEWORK:**
Ask yourself: "Would a student understand this BETTER with a visual, or is it already clear?"
- If visual is essential for understanding → CREATE IT
- If visual would be nice but not necessary → SKIP IT
- If visual would just repeat what's already clear → SKIP IT

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
    
    // Post-processing: Add missing visual aids for survey/data problems
    if (!result.visualAids || result.visualAids.length === 0) {
      const questionLower = question.toLowerCase();
      const isSurveyOrData = questionLower.includes('survey') || 
                             questionLower.includes('percentage') || 
                             questionLower.includes('poll') ||
                             questionLower.includes('preferred') ||
                             questionLower.includes('fraction of');
      
      if (isSurveyOrData && result.subject === 'Math') {
        console.log('📊 Detected survey/data problem - injecting default pie chart');
        result.visualAids = [{
          type: 'chart',
          stepId: '1',
          description: `Pie chart showing the distribution of responses with percentages for each category. Use distinct colors for each segment and label with both category name and percentage value.`
        }];
      }
    }
    
    // Process visualAids array to generate diagrams
    if (result.visualAids && Array.isArray(result.visualAids)) {
      for (const visualAid of result.visualAids) {
        const { type, stepId, description } = visualAid;
        const diagramDescription = `type=${type} - ${description}`;
        const diagramUrl = await generateDiagram(diagramDescription);
        
        if (diagramUrl) {
          // Find the step and add the image to its content
          const step = result.steps.find((s: any) => s.id === stepId);
          if (step) {
            step.content = `(IMAGE: ${description}](${diagramUrl})\n\n` + step.content;
          }
        }
      }
    }
    
    // Legacy support: Check if any step has old-style [DIAGRAM NEEDED: ...] tags
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
    
    // VALIDATE SOLUTION ACCURACY - Quality control check
    const { solution: validatedSolution, validationPassed, validationDetails } = await validateSolution(question, formattedResult);
    
    if (!validationPassed) {
      // Validation failed - do NOT return potentially incorrect solution to student
      console.error('❌ Solution failed validation - blocking delivery');
      console.error('Validation details:', validationDetails);
      
      return res.status(400).json({ 
        error: 'We encountered some concerns about the accuracy of this solution. Please try rephrasing your question or breaking it into smaller parts. If this persists, double-check the problem statement for any typos.',
        validationFailed: true,
        retryable: true
      });
    }
    
    console.log('✅ Analysis successful and validated');
    res.json(validatedSolution);
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
  "finalAnswer": "Plain text final answer",
  "visualAids": [
    {
      "type": "physics|geometry|graph|chart|illustration",
      "stepId": "1",
      "description": "Detailed description of what to visualize with all measurements and labels"
    }
  ]
}

**CRITICAL: visualAids array is REQUIRED for:**
- Physics: projectile motion, force diagrams, circuits, kinematics
- Geometry: shapes, angles, spatial relationships
- Data: surveys, percentages, comparing quantities, proportions
- Leave empty [] ONLY if truly no visual would help

📊 INTELLIGENT VISUAL AIDS - WHEN AND WHAT TYPE TO CREATE 📊

**🚨 ESSENTIAL VISUALS - ALWAYS CREATE for these classic scenarios:**

**PHYSICS - NEARLY MANDATORY:**
✓ **PROJECTILE MOTION** - Any problem with objects launched at angles (catapults, projectiles, balls thrown)
   → Show parabolic trajectory, launch angle, velocity components, max height, range
   → Tag: [DIAGRAM NEEDED: type=physics - Projectile motion showing parabolic arc from launch point at [angle]° with initial velocity [v₀], marking maximum height at apex, horizontal range, and ground level. Label velocity components, trajectory path, and key measurements.]

✓ **FORCE DIAGRAMS** - Any problem analyzing forces on an object (friction, tension, normal force)
   → Show object with all force vectors (magnitude + direction), coordinate system
   → Tag: [DIAGRAM NEEDED: type=physics - Free body diagram of [object] with force vectors: [list all forces with magnitudes and directions]. Include coordinate axes.]

✓ **KINEMATICS** - Motion problems with acceleration, velocity, position over time
   → Show motion diagram with position/velocity/acceleration vectors at key moments
   → Tag: [DIAGRAM NEEDED: type=physics - Motion diagram showing [object] at key time points with velocity and acceleration vectors. Mark initial and final positions.]

✓ **CIRCUITS** - Any electrical circuit problem
   → Show circuit schematic with components, current flow, voltage labels
   → Tag: [DIAGRAM NEEDED: type=physics - Circuit diagram with [components] connected in [series/parallel], showing current direction and voltage labels.]

**GEOMETRY - NEARLY MANDATORY:**
✓ Any problem with shapes, angles, areas, perimeters
✓ Spatial relationships between multiple geometric objects
✓ 3D geometry or perspective views

**DATA VISUALIZATION - NEARLY MANDATORY:**
✓ **SURVEYS & PERCENTAGES** - Any problem asking about percentages, surveys, or preferences
   → **MUST CREATE** a pie chart or bar chart comparing categories
   → Examples triggering this: "survey of students", "percentage of...", "what fraction preferred", "poll results"
   → Tag: [DIAGRAM NEEDED: type=chart - Pie chart showing [category names] with percentages: [list each category with its percentage]. Use distinct colors for each segment and label with both category name and percentage.]
   → EXAMPLE: For "survey of 200 students: Math 60, Science 50, English 40, History 30, Art 20" → ADD: [DIAGRAM NEEDED: type=chart - Pie chart showing subject preferences: Math 30%, Science 25%, English 20%, History 15%, Art 10%. Use distinct colors for each segment with labels.]

✓ **COMPARING QUANTITIES** - Problems comparing multiple values, populations, or measurements
   → Show bar chart or comparison chart
   → Tag: [DIAGRAM NEEDED: type=chart - Bar chart comparing [categories] with values: [list values]. Include labeled axes and value labels on each bar.]

✓ **PROPORTIONS & RATIOS** - Problems involving parts of a whole
   → Show pie chart or stacked bar chart
   → Tag: [DIAGRAM NEEDED: type=chart - Visual representation showing proportions of [total] divided into [parts with values/percentages].]

**SCREENING CRITERIA - For other cases, create visuals when they SIGNIFICANTLY enhance understanding:**

Consider creating a visual aid when:
✓ The problem involves spatial relationships that are hard to describe in words alone
✓ Lower grade levels (K-5, 6-8) - visuals help younger students grasp concepts better
✓ Complex multi-step processes benefit from a visual roadmap
✓ The visual would clarify confusion, not just repeat what words already convey

**TYPES OF VISUALS:**

1. **GEOMETRIC DIAGRAMS** - For shapes, angles, spatial relationships
   - Tag: [DIAGRAM NEEDED: type=geometry - detailed description with ALL dimensions, labels, spatial relationships]

2. **GRAPHS & COORDINATE PLANES** - For plotting, functions, data visualization
   - Tag: [DIAGRAM NEEDED: type=graph - equation/function with axes, labels, key points]

3. **CHARTS & DATA VISUALIZATION** - For comparing quantities, showing proportions
   - Tag: [DIAGRAM NEEDED: type=chart - data values, labels, chart type (bar/pie/line)]

4. **PHYSICS DIAGRAMS** - For forces, motion, circuits, energy
   - Tag: [DIAGRAM NEEDED: type=physics - physical setup, forces/components, labels]

5. **PROCESS ILLUSTRATIONS** - For sequential steps or transformations
   - Tag: [DIAGRAM NEEDED: type=illustration - what's shown, key elements, relationships]

**WHEN NOT TO CREATE VISUALS:**
✗ Pure algebraic manipulation where symbols are clear enough
✗ Simple word problems without spatial/physical elements
✗ When the description in words is already perfectly clear

**PLACEMENT:** Visual aids can appear in ANY step where they'd be most helpful, not just Step 1. Place them where understanding would benefit most.

**FORMAT EXAMPLE:**
"[DIAGRAM NEEDED: type=geometry - Rectangle PQRS with horizontal base PQ = 6 units at bottom, vertical height PS on left side. Isosceles triangle OPQ with base PQ (6 units) on bottom edge of rectangle, vertex O above PQ, equal sides OP and OQ forming triangle inside rectangle. Label all corners P, Q, R, S clockwise, and point O at triangle apex.]"

**DECISION FRAMEWORK:**
Ask yourself: "Would a student understand this BETTER with a visual, or is it already clear?"
- If visual is essential for understanding → CREATE IT
- If visual would be nice but not necessary → SKIP IT
- If visual would just repeat what's already clear → SKIP IT

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
    
    // Post-processing: Add missing visual aids for survey/data problems
    if (!result.visualAids || result.visualAids.length === 0) {
      const problemLower = result.problem.toLowerCase();
      const isSurveyOrData = problemLower.includes('survey') || 
                             problemLower.includes('percentage') || 
                             problemLower.includes('poll') ||
                             problemLower.includes('preferred') ||
                             problemLower.includes('fraction of');
      
      if (isSurveyOrData && result.subject === 'Math') {
        console.log('📊 Detected survey/data problem - injecting default pie chart');
        result.visualAids = [{
          type: 'chart',
          stepId: '1',
          description: `Pie chart showing the distribution of responses with percentages for each category. Use distinct colors for each segment and label with both category name and percentage value.`
        }];
      }
    }
    
    // Process visualAids array to generate diagrams
    if (result.visualAids && Array.isArray(result.visualAids)) {
      for (const visualAid of result.visualAids) {
        const { type, stepId, description } = visualAid;
        const diagramDescription = `type=${type} - ${description}`;
        const diagramUrl = await generateDiagram(diagramDescription);
        
        if (diagramUrl) {
          // Find the step and add the image to its content
          const step = result.steps.find((s: any) => s.id === stepId);
          if (step) {
            step.content = `(IMAGE: ${description}](${diagramUrl})\n\n` + step.content;
            console.log('✓ Diagram embedded:', diagramUrl);
          }
        }
      }
    }
    
    // Legacy support: Check if any step has old-style [DIAGRAM NEEDED: ...] tags
    for (const step of result.steps) {
      const diagramMatch = step.content.match(/\[DIAGRAM NEEDED:\s*([^\]]+)\]/);
      if (diagramMatch) {
        const diagramDescription = diagramMatch[1];
        const diagramUrl = await generateDiagram(diagramDescription);
        if (diagramUrl) {
          // Replace [DIAGRAM NEEDED: description] with (IMAGE: description](url)
          const imageTag = `(IMAGE: ${diagramDescription}](${diagramUrl})`;
          step.content = step.content.replace(diagramMatch[0], imageTag);
          console.log('✓ Diagram embedded:', diagramUrl);
        }
      }
    }
    
    // ENFORCE PROPER FORMATTING - Convert all fractions to {num/den} format
    const formattedResult = enforceResponseFormatting(result);
    
    // VALIDATE SOLUTION ACCURACY - Quality control check
    const problemText = `${formattedResult.problem}${problemNumber ? ` (Problem #${problemNumber})` : ''}`;
    const { solution: validatedSolution, validationPassed, validationDetails } = await validateSolution(problemText, formattedResult);
    
    if (!validationPassed) {
      // Validation failed - do NOT return potentially incorrect solution to student
      console.error('❌ Solution failed validation - blocking delivery');
      console.error('Validation details:', validationDetails);
      
      return res.status(400).json({ 
        error: 'We encountered some concerns about the accuracy of this solution. Please try retaking the photo with better lighting, or type the question manually for better results.',
        validationFailed: true,
        retryable: true
      });
    }
    
    console.log('✅ Image analysis successful and validated');
    res.json(validatedSolution);
  } catch (error) {
    console.error('Error analyzing image:', error);
    res.status(500).json({ error: 'Failed to analyze image' });
  }
});

app.post('/api/simplify-explanation', async (req, res) => {
  try {
    const { problem, subject, difficulty, steps } = req.body;
    console.log('Generating simplified explanations for', steps.length, 'steps');
    
    const result = await pRetry(
      async () => {
        try {
          const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              {
                role: "system",
                content: `You are an exceptional teacher helping a struggling student understand a problem. The student has seen the solution steps but still doesn't get it. Your job is to provide a MUCH SIMPLER, more intuitive explanation for each step.

Guidelines:
- Use everyday language and analogies
- Break down WHY we're doing each operation, not just WHAT we're doing
- Use relatable examples when possible
- Keep each explanation to 2-3 short sentences maximum
- Preserve math formatting: {num/den} for fractions, _subscript_, ^superscript^, [color:text] for highlighting
- Focus on the INTUITION and REASONING behind each step

Problem: ${problem}
Subject: ${subject}
Difficulty Level: ${difficulty}

For each step provided, return a simplified explanation that helps the student understand the underlying logic and reasoning.

IMPORTANT: Return ONLY a valid JSON array with this exact structure:
[
  {
    "stepNumber": 1,
    "simplifiedExplanation": "Plain language explanation here"
  },
  {
    "stepNumber": 2,
    "simplifiedExplanation": "Plain language explanation here"
  }
]

Do NOT include any text before or after the JSON array.`
              },
              {
                role: "user",
                content: `Here are the solution steps that need simplified explanations:

${steps.map((step: any, index: number) => `Step ${index + 1}: ${step.title}
${step.content}`).join('\n\n')}

Please provide a simplified, intuitive explanation for each step.`
              }
            ],
            max_tokens: 2000,
          });
          
          const content = response.choices[0]?.message?.content || '[]';
          
          // Parse JSON response
          try {
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
              throw new Error('No JSON array found in response');
            }
            const parsed = JSON.parse(jsonMatch[0]);
            return parsed;
          } catch (parseError: any) {
            console.error('Failed to parse simplified explanations:', content);
            throw new AbortError(parseError);
          }
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
    
    // ENFORCE PROPER FORMATTING on each explanation
    const formattedExplanations = result.map((item: any) => ({
      ...item,
      simplifiedExplanation: enforceProperFormatting(item.simplifiedExplanation)
    }));
    
    console.log('Simplified explanations generated');
    res.json({ simplifiedExplanations: formattedExplanations });
  } catch (error) {
    console.error('Error generating simplified explanations:', error);
    res.status(500).json({ error: 'Failed to generate simplified explanations' });
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
